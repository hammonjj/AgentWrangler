/**
 * The simulated agent: plays a scenario step (`src/shared/orchestration/simulation.ts`)
 * as the Agent SDK's messages (orchestration plan §26.3, #30).
 *
 * Two ways in, one player:
 * - `simulatedQuery` is a `QueryFn` for an in-process session: the Claude
 *   executor runs it exactly as it runs the SDK's `query`;
 * - `fakeQuery` (`AW_SESSION_HOST_FAKE=1`) hands a turn to `playSimStep` when
 *   the first prompt carries a script, so a hosted session plays the same
 *   scenario inside a real, detached session host.
 *
 * Files are really written into the session's cwd (the task's worktree), and
 * `result` messages carry running usage totals the way the CLI's do, so the
 * telemetry code downstream sees what it sees for a real agent. No network.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { isSafeRelativePath, readSimDirective, type SimAttempt, type SimStep, type SimUsage } from '../shared/orchestration/simulation';

/** The running totals a `result` reports: cumulative within one `Query`, like the CLI's. */
export interface SimTotals {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export function emptyTotals(): SimTotals {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

export interface SimTurnContext {
  cwd: string;
  sessionId: string;
  model: string;
  /** Mutated: this turn's usage is added. */
  totals: SimTotals;
  push: (message: unknown) => void;
  canUseTool?: CanUseTool;
  /** Resolves if the turn is interrupted. Fresh for each turn. */
  interrupted: Promise<void>;
  /** Make the agent process die now. Resolves once it has gone. */
  crash: () => Promise<void>;
  /** The `uuid` of the message this turn answers, echoed as `user_message_uuid(s)` like the CLI does. */
  messageUuid?: string;
}

/** What a turn with no usage of its own reports, so telemetry always has something to record. */
const DEFAULT_USAGE: SimUsage = { in: 1000, out: 100 };
const DEFAULT_COST = 0.001;

/**
 * Play one step. Resolves `crashed` when the agent died mid-turn (no result
 * was produced and the session is over), otherwise `done` once the turn's
 * `result` has been pushed.
 */
export async function playSimStep(step: SimStep, ctx: SimTurnContext, turn: number): Promise<'done' | 'crashed'> {
  const started = Date.now();
  let interrupted = false;
  void ctx.interrupted.then(() => (interrupted = true));
  const m = new Messages(ctx, turn);
  /** Wait, unless the turn is interrupted first. */
  const wait = async (ms: number): Promise<boolean> => {
    if (ms <= 0) return !interrupted;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ctx.interrupted, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    return !interrupted;
  };
  const finish = (fields: ResultFields = {}): 'done' => {
    ctx.push(m.result(step, started, interrupted ? { ...fields, interrupted: true } : fields));
    return 'done';
  };
  const text = (fallback: string) => step.text ?? fallback;

  if (!(await wait(step.delayMs ?? 0))) return finish();

  switch (step.behaviour) {
    case 'edit':
    case 'fail-verification':
      m.writeFiles(step.files ?? {});
      ctx.push(m.assistantText(text(step.behaviour === 'edit' ? 'Done.' : 'Done; the change is in place.')));
      return finish();

    case 'no-diff':
      ctx.push(m.assistantText(text('Nothing needed changing.')));
      return finish();

    case 'fail':
      ctx.push(m.assistantText(text('I could not complete this.')));
      return finish({ subtype: 'error_during_execution', errors: [step.signature ?? 'simulated failure'] });

    case 'timeout':
      // Working, and never done: only an interrupt ends it.
      ctx.push(m.assistantText(text('Working on it…')));
      await ctx.interrupted;
      return finish();

    case 'rate-limit': {
      const status = step.status ?? 429;
      const resetsAt = Math.floor(Date.now() / 1000) + (step.retryAfterSec ?? 60);
      ctx.push({ type: 'rate_limit_event', uuid: randomUUID(), session_id: ctx.sessionId, rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } });
      ctx.push(m.assistantText(`API Error: ${status} rate limit reached`, { error: 'rate_limit' }));
      return finish({ isError: true, apiErrorStatus: status, resultText: `API Error: ${status} rate limit reached`, noUsage: true });
    }

    case 'bad-structured-output': {
      const raw = step.raw ?? 'Here is the answer: {not json';
      ctx.push(m.assistantText(raw));
      return finish({ resultText: raw, structured: step.structured });
    }

    case 'slow': {
      const out = step.usage?.out ?? DEFAULT_USAGE.out;
      const rate = step.outTokPerSec && step.outTokPerSec > 0 ? step.outTokPerSec : 50;
      // Stream in ~10 chunks, spaced so the whole reply takes out / rate seconds.
      const chunks = Math.max(1, Math.min(10, out));
      const gap = (out / rate / chunks) * 1000;
      const reply = text('A slow reply.');
      for (let i = 0; i < chunks; i++) {
        if (!(await wait(gap))) return finish();
        ctx.push(m.delta(reply.slice(Math.floor((i * reply.length) / chunks), Math.floor(((i + 1) * reply.length) / chunks))));
      }
      ctx.push(m.assistantText(reply));
      return finish();
    }

    case 'context-overflow':
      ctx.push(m.assistantText('Prompt is too long', { error: 'invalid_request' }));
      return finish({ isError: true, resultText: 'Prompt is too long', terminalReason: 'prompt_too_long', noUsage: true });

    case 'tool-failure': {
      const tool = step.tool ?? { name: 'Bash', input: { command: 'npm test' } };
      m.toolCall(tool.name, tool.input, step.signature ?? 'simulated tool failure', true);
      ctx.push(m.assistantText(text('The tool failed; stopping here.')));
      return finish();
    }

    case 'crash':
      m.writeFiles(step.files ?? {});
      await ctx.crash();
      return 'crashed';

    case 'question': {
      const q = step.question ?? { question: 'Which approach should I take?', options: ['A', 'B'] };
      const input = {
        questions: [
          {
            question: q.question,
            header: q.header ?? 'Question',
            multiSelect: false,
            options: (q.options ?? ['Yes', 'No']).map((label) => ({ label, description: '' })),
          },
        ],
      };
      const decision = await m.ask('AskUserQuestion', input);
      if (decision.behavior !== 'allow') {
        ctx.push(m.assistantText('No answer; stopping.'));
        return finish();
      }
      const answers = (decision.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {};
      m.writeFiles(step.files ?? {});
      ctx.push(m.assistantText(text(`Answered: ${Object.values(answers).join(', ') || '(none)'}`)));
      return finish();
    }

    case 'permission': {
      const tool = step.tool ?? { name: 'Bash', input: { command: 'npm test' } };
      const decision = await m.ask(tool.name, tool.input);
      if (decision.behavior !== 'allow') {
        ctx.push(m.assistantText('Permission denied; stopping.'));
        return finish();
      }
      m.toolCall(tool.name, tool.input, 'ok', false);
      m.writeFiles(step.files ?? {});
      ctx.push(m.assistantText(text('Allowed, and done.')));
      return finish();
    }
  }
}

interface ResultFields {
  subtype?: 'success' | 'error_during_execution';
  isError?: boolean;
  resultText?: string;
  errors?: string[];
  apiErrorStatus?: number;
  terminalReason?: string;
  structured?: unknown;
  /** The request never ran: no tokens spent, the totals stay as they were. */
  noUsage?: boolean;
  interrupted?: boolean;
}

/** Builds the SDK's message shapes for one turn. */
class Messages {
  private lastText = '';
  constructor(
    private ctx: SimTurnContext,
    private turn: number,
  ) {}

  private base() {
    return { uuid: randomUUID(), session_id: this.ctx.sessionId, parent_tool_use_id: null };
  }

  assistantText(text: string, extra: Record<string, unknown> = {}): unknown {
    this.lastText = text;
    return {
      type: 'assistant',
      ...this.base(),
      ...extra,
      message: { id: `sim-${this.turn}-${randomUUID()}`, role: 'assistant', model: this.ctx.model, content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    };
  }

  delta(text: string): unknown {
    return { type: 'stream_event', ...this.base(), event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } };
  }

  toolCall(name: string, input: Record<string, unknown>, output: string, isError: boolean): void {
    const id = `toolu_sim_${randomUUID().slice(0, 8)}`;
    this.ctx.push({
      type: 'assistant',
      ...this.base(),
      message: { id: `sim-${this.turn}-${id}`, role: 'assistant', model: this.ctx.model, content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
    });
    this.ctx.push({
      type: 'user',
      ...this.base(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, ...(isError ? { is_error: true } : {}) }] },
    });
  }

  /** Write (or delete) files in the cwd, each shown as a `Write` tool call. */
  writeFiles(files: Record<string, string | null>): void {
    const root = path.resolve(this.ctx.cwd);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.resolve(root, rel);
      if (!isSafeRelativePath(rel) || !abs.startsWith(root + path.sep)) throw new Error(`simulated agent: refusing to write outside the worktree: ${rel}`);
      if (content === null) {
        fs.rmSync(abs, { force: true });
        this.toolCall('Bash', { command: `rm ${rel}` }, '', false);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        this.toolCall('Write', { file_path: abs, content }, `File written: ${rel}`, false);
      }
    }
  }

  /** Ask through `canUseTool`, as the CLI does. An interrupt aborts the ask. */
  async ask(toolName: string, input: Record<string, unknown>): Promise<{ behavior: string; updatedInput?: unknown }> {
    if (!this.ctx.canUseTool) return { behavior: 'allow', updatedInput: input };
    const abort = new AbortController();
    void this.ctx.interrupted.then(() => abort.abort());
    try {
      return (await this.ctx.canUseTool(toolName, input, {
        signal: abort.signal,
        toolUseID: `toolu_sim_${this.turn}`,
        requestId: `sim-${randomUUID()}`,
      } as never)) as { behavior: string; updatedInput?: unknown };
    } catch {
      return { behavior: 'deny' };
    }
  }

  result(step: SimStep, started: number, f: ResultFields): unknown {
    const t = this.ctx.totals;
    if (!f.noUsage) {
      const u = step.usage ?? DEFAULT_USAGE;
      t.in += u.in;
      t.out += u.out;
      t.cacheRead += u.cacheRead ?? 0;
      t.cacheWrite += u.cacheWrite ?? 0;
      t.costUsd = Math.round((t.costUsd + (step.costUsd ?? DEFAULT_COST)) * 1e9) / 1e9;
    }
    const interrupted = f.interrupted === true;
    const subtype = interrupted ? 'error_during_execution' : (f.subtype ?? 'success');
    const isError = interrupted || subtype !== 'success' || f.isError === true;
    const duration = Date.now() - started;
    const turnUsage = step.usage ?? DEFAULT_USAGE;
    return {
      type: 'result',
      subtype,
      is_error: isError,
      ...(subtype === 'success' ? { result: f.resultText ?? this.lastText } : { errors: interrupted ? ['interrupted'] : (f.errors ?? []) }),
      ...(f.apiErrorStatus !== undefined ? { api_error_status: f.apiErrorStatus } : {}),
      ...(f.terminalReason ? { terminal_reason: f.terminalReason } : {}),
      ...(f.structured !== undefined ? { structured_output: f.structured } : {}),
      num_turns: step.turns ?? 1,
      duration_ms: duration,
      duration_api_ms: duration,
      stop_reason: isError ? null : 'end_turn',
      total_cost_usd: t.costUsd,
      // Per turn, main loop only, as the CLI reports it.
      usage: f.noUsage
        ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : {
            input_tokens: turnUsage.in,
            output_tokens: turnUsage.out,
            cache_read_input_tokens: turnUsage.cacheRead ?? 0,
            cache_creation_input_tokens: turnUsage.cacheWrite ?? 0,
          },
      // Cumulative within the Query, per model.
      modelUsage: {
        [this.ctx.model]: {
          inputTokens: t.in,
          outputTokens: t.out,
          cacheReadInputTokens: t.cacheRead,
          cacheCreationInputTokens: t.cacheWrite,
          webSearchRequests: 0,
          costUSD: t.costUsd,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
      permission_denials: [],
      queued_turn_count: 0,
      ...(this.ctx.messageUuid ? { user_message_uuid: this.ctx.messageUuid, user_message_uuids: [this.ctx.messageUuid] } : {}),
      uuid: randomUUID(),
      session_id: this.ctx.sessionId,
    };
  }
}

/** What a later message does when the script has nothing more for it. */
const NOTHING_MORE: SimStep = { behaviour: 'no-diff', text: 'Nothing more to do.' };

/** The step for the `turn`th message (0-based) of an attempt. */
export function simStepFor(attempt: SimAttempt, turn: number): SimStep {
  if (turn === 0) return attempt;
  return attempt.followUps?.[turn - 1] ?? NOTHING_MORE;
}

function textOf(msg: SDKUserMessage): string {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('');
  }
  return '';
}

/**
 * An in-process stand-in for the SDK's `query` that plays the script the
 * first prompt carries (`withSimDirective`). A prompt without one is answered
 * `echo: <text>`, which keeps an unscripted session harmless.
 */
export function simulatedQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query {
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  const sessionId = options.resume ?? options.sessionId ?? randomUUID();
  const model = options.model ?? 'claude-simulated';
  const cwd = options.cwd ?? process.cwd();
  const totals = emptyTotals();
  const push = (m: unknown) => {
    if (done) return;
    out.push(m);
    wake?.();
    wake = undefined;
  };
  const finish = (err?: Error) => {
    if (done) return;
    done = true;
    failure = err;
    wake?.();
    wake = undefined;
  };
  let onInterrupt: (() => void) | undefined;

  void (async () => {
    let attempt: SimAttempt | undefined;
    let turn = 0;
    try {
      for await (const msg of prompt) {
        if (done) break;
        const text = textOf(msg);
        if (turn === 0) {
          push({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd, permissionMode: options.permissionMode ?? 'default', tools: [] });
          attempt = readSimDirective(text)?.attempt;
        }
        const step = attempt ? simStepFor(attempt, turn) : { behaviour: 'no-diff' as const, text: `echo: ${text}` };
        const interrupted = new Promise<void>((r) => (onInterrupt = r));
        const how = await playSimStep(step, {
          cwd,
          sessionId,
          model,
          totals,
          push,
          canUseTool: options.canUseTool,
          interrupted,
          crash: async () => finish(new Error('Claude Code process exited with code 1')),
          messageUuid: typeof (msg as { uuid?: unknown }).uuid === 'string' ? (msg as { uuid: string }).uuid : undefined,
        }, turn);
        onInterrupt = undefined;
        turn++;
        if (how === 'crashed') return;
      }
      finish();
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  const stream = (async function* () {
    for (;;) {
      if (out.length > 0) {
        yield out.shift();
        continue;
      }
      if (done) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((r) => (wake = r));
    }
  })();

  return Object.assign(stream, {
    interrupt: async () => {
      onInterrupt?.();
    },
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    supportedModels: async () => [{ value: model, displayName: 'Simulated' }],
    supportedCommands: async () => [],
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 200_000 }),
    close: () => finish(),
  }) as unknown as Query;
}
