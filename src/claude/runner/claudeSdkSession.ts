/**
 * The execution half of a Claude Code session Agent Wrangler runs: the Agent
 * SDK's `Query`, the input queue feeding it, and the `canUseTool` resolvers of
 * the asks it is waiting on. Nothing else.
 *
 * This is the future session host (`docs/plans/session-lifecycle-architecture.md`
 * §5.1, Stage 1). Its whole surface is `src/shared/sessionProtocol.ts`: raw SDK
 * messages out, each numbered in a replayable log; raw permission results in;
 * a handful of control calls. It never builds a `ConvBlock`, never decides
 * anything, and never reads the filesystem. Turning its events into a pane is
 * `RunnerView`'s job, in the core. In Stage 3 this class moves into a detached
 * process and the same events cross a socket instead of a function call.
 *
 * No `vscode`, no Electron: `query` is injected, so it runs under vitest.
 */
import { randomUUID } from 'node:crypto';
import type { CanUseTool, Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Disposable } from '../../core/events';
import { InputQueue } from '../../core/runner/inputQueue';
import { SeqLog } from '../../core/session/seqLog';
import type { ClaudeLaunchPolicy } from '../../shared/launchPolicy';
import {
  emptyHostState,
  reduceHostSnapshot,
  type AskSettleReason,
  type ControlRequest,
  type HostEvent,
  type HostEventBody,
  type HostExit,
  type HostReplayState,
  type HostSnapshot,
  type HostState,
  type RawAsk,
  type RawPermissionResult,
  type RespondOutcome,
  type SendResult,
} from '../../shared/sessionProtocol';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeSessionOptions {
  cwd: string;
  /** Session id to continue. Its process must already be gone, or the transcript forks (spike S1). */
  resume?: string;
  /** Id for a *fresh* session, known before the first turn. Refused by the CLI if a transcript exists. */
  sessionId?: string;
  permissionMode?: string;
  model?: string;
  /** `low` | `medium` | `high` | `xhigh` | `max`, or absent for the CLI's default. Start-time only. */
  effort?: string;
  /** Tool rules and limits (`LaunchPolicy.claude`), applied as SDK options at start. */
  policy?: ClaudeLaunchPolicy;
}

/**
 * The SDK options a launch policy sets, and only those: nothing here can
 * change the permission mode, `canUseTool`, or turn on
 * `allowDangerouslySkipPermissions`. Empty for no policy.
 */
export function claudePolicyOptions(policy: ClaudeLaunchPolicy | undefined): Partial<Options> {
  if (!policy) return {};
  const out: Partial<Options> = {};
  if (policy.allowedTools?.length) out.allowedTools = [...policy.allowedTools];
  if (policy.disallowedTools?.length) out.disallowedTools = [...policy.disallowedTools];
  if (policy.maxTurns !== undefined) out.maxTurns = policy.maxTurns;
  if (policy.maxBudgetUsd !== undefined) out.maxBudgetUsd = policy.maxBudgetUsd;
  if (policy.fallbackModel) out.fallbackModel = policy.fallbackModel;
  if (policy.outputFormat) out.outputFormat = policy.outputFormat;
  return out;
}

export interface ClaudeSessionDeps {
  query: QueryFn;
  /** Absolute path of the `claude` to spawn. */
  binary: string;
  log: (msg: string) => void;
  /** Timers, injectable so the end sequence is testable without waiting. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Ring size in estimated bytes (default 16 MiB). */
  ringBytes?: number;
  /**
   * Extra SDK options, merged over the ones built here. The session host
   * passes an explicit `env` and its own `spawnClaudeCodeProcess` (so it knows
   * the agent's pid); in-process sessions pass nothing.
   */
  sdkOptions?: Partial<Options>;
}

/** The end sequence's timings (playbook §7.1). */
export const END_TIMINGS = {
  /** How long an interrupted turn gets to produce its `result`. */
  graceMs: 5000,
  /** After stdin closes, how long an idle CLI gets to exit on its own (~0.7 s measured). */
  eofWaitMs: 1000,
  /**
   * After the SDK's `close()` (SIGTERM, then its own SIGKILL 5 s later), how
   * long before giving up on it. Longer than the SDK's escalation, so the exit
   * we report is the child's, not a guess.
   */
  killWaitMs: 6000,
};

interface PendingAsk {
  ask: RawAsk;
  resolve: (result: PermissionResult) => void;
}

/** How many settled ask ids are remembered, so a late answer gets `stale` rather than `gone`. */
const SETTLED_MEMORY = 200;
/** How many sent message uuids are remembered for send idempotency. */
const SENT_MEMORY = 500;

export class ClaudeSdkSession {
  readonly cwd: string;
  readonly startedAt = Date.now();
  /** This `Query`'s identity: usage totals on its `result`s are cumulative within it. */
  readonly executionId = randomUUID();

  private readonly log: SeqLog<HostEvent>;
  private snap: HostReplayState = emptyHostState();
  /** This instance's event stream; seqs from another epoch mean nothing here. */
  readonly epoch = randomUUID();
  private input = new InputQueue<SDKUserMessage>();
  private query?: Query;
  private pending = new Map<string, PendingAsk>();
  private settled: string[] = [];
  private sentUuids: string[] = [];
  /** Counts `result` messages, so the end sequence can wait for "the turn ended". */
  private results = 0;
  private endPromise?: Promise<void>;
  /** Why the agent is going, once we started the ending (`end` → stopped, `terminate` → signal). */
  private endReason?: HostExit;
  /** Model and permission mode as last set through `control`: no event records them. */
  private controls: { model?: string; permissionMode?: string } = {};
  /**
   * Lets the owner add what only it knows to the exit record before it is
   * emitted: the host adds the agent process's own exit code, signal and stderr tail.
   */
  decorateExit?: (exit: HostExit) => HostExit;
  private exitWaiters: (() => void)[] = [];
  private turnWaiters: (() => void)[] = [];
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(
    private opts: ClaudeSessionOptions,
    private deps: ClaudeSessionDeps,
  ) {
    this.cwd = opts.cwd;
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = new SeqLog<HostEvent>({
      maxBytes: deps.ringBytes,
      onListenerError: (err) => deps.log(`session event listener failed: ${String(err)}`),
    });
    const initialId = opts.resume ?? opts.sessionId;
    if (initialId) this.emit({ type: 'sessionId', sessionId: initialId });
  }

  // ---- reading ----

  get state(): HostState {
    return this.snap.state;
  }

  get sessionId(): string | undefined {
    return this.snap.sessionId;
  }

  /** Current state plus the seq it is true at. Subscribe from `snapshot().seq` to follow on. */
  snapshot(): HostSnapshot {
    const evicted = this.log.evictedThrough;
    return {
      ...this.snap,
      pendingAsks: [...this.snap.pendingAsks],
      epoch: this.epoch,
      ring: { fromSeq: evicted, truncated: evicted > 0 },
      ...(this.controls.model !== undefined || this.controls.permissionMode !== undefined ? { controls: { ...this.controls } } : {}),
    };
  }

  /**
   * Every event after `fromSeq`, then live ones. `fromSeq = 0` from a
   * subscriber that has seen nothing. Throws `ResyncNeeded` when the gap has
   * been evicted from the ring.
   */
  subscribe(fromSeq: number, listener: (event: HostEvent) => void): Disposable {
    return this.log.subscribe(fromSeq, listener);
  }

  /**
   * The held events after `fromSeq`, without subscribing: what a host's
   * `messages` method pages through. Throws `ResyncNeeded` if the gap is gone.
   */
  eventsSince(fromSeq: number): HostEvent[] {
    return this.log.since(fromSeq);
  }

  /**
   * Stop now, for a signal to the host (logout, `kill`): no interrupt and no
   * grace for the turn. Stdin closes and the SDK's `close()` terminates the
   * child at once (playbook §7.1). Resolves true once the agent has exited,
   * false if it had not within `waitMs` (the host then kills it outright).
   */
  async terminate(waitMs: number, hostSignal?: string): Promise<boolean> {
    if (this.snap.state === 'exited') return true;
    this.endReason = { reason: 'signal', ...(hostSignal ? { hostSignal } : {}) };
    this.setState('ending');
    this.settleAll('agentExited', 'The session was closed.');
    this.input.close();
    try {
      this.query?.close();
    } catch {
      // already gone
    }
    if (!this.query) this.exit({});
    return this.waitForExit(waitMs);
  }

  // ---- commands ----

  start(): void {
    if (this.query || this.snap.state === 'exited') return;
    const options: Options = {
      cwd: this.opts.cwd,
      resume: this.opts.resume,
      sessionId: this.opts.resume ? undefined : this.opts.sessionId,
      // Free strings by the time they reach here (a setting, a dropdown built
      // from what the model advertised). An unknown value is the CLI's to reject.
      permissionMode: this.opts.permissionMode as Options['permissionMode'],
      model: this.opts.model,
      effort: this.opts.effort ? (this.opts.effort as Options['effort']) : undefined,
      pathToClaudeCodeExecutable: this.deps.binary,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      stderr: (data) => this.deps.log(`runner stderr: ${data.trim().slice(0, 400)}`),
      ...this.deps.sdkOptions,
      // Last, so nothing merged above can loosen a rule the launch asked for.
      ...claudePolicyOptions(this.opts.policy),
    };
    try {
      this.query = this.deps.query({ prompt: this.input, options });
    } catch (err) {
      this.exit({ reason: 'error', error: `Could not start Claude Code: ${String(err)}` });
      return;
    }
    void this.pump(this.query);
  }

  /**
   * Hand the CLI a user message. Idempotent on `message.uuid`: a client that
   * lost its connection mid-send can send again without the message arriving
   * twice. The uuid also becomes the transcript entry's uuid (spike S1), which
   * is what lets a reattaching client dedupe its own sends against the file.
   */
  send(message: SDKUserMessage): SendResult {
    const uuid = message.uuid;
    if (uuid && this.sentUuids.includes(uuid)) return { accepted: false, duplicate: true };
    if (this.snap.state === 'ending' || this.snap.state === 'exited' || this.input.isClosed) {
      return { accepted: false, duplicate: false };
    }
    if (uuid) remember(this.sentUuids, uuid, SENT_MEMORY);
    this.input.push(message);
    this.setState('running');
    return { accepted: true, duplicate: false };
  }

  /** Answer an ask with the result a client built. Settles it exactly once. */
  respondAsk(requestId: string, result: RawPermissionResult): RespondOutcome {
    const pending = this.pending.get(requestId);
    if (!pending) return this.settled.includes(requestId) ? 'stale' : 'gone';
    this.settle(requestId, 'responded', result.behavior === 'allow' ? 'allowed' : 'denied');
    pending.resolve(result as PermissionResult);
    return 'applied';
  }

  /**
   * The SDK `Query` calls a client may make. Rejects when there is no live
   * query, and with `UnknownControlOp` for an op this build does not have, so
   * a newer core can never mistake "not supported" for success.
   */
  async control(req: ControlRequest): Promise<unknown> {
    const q = this.query;
    if (!q) throw new Error('No live Claude Code process.');
    switch (req.op) {
      case 'interrupt':
        return q.interrupt();
      case 'setModel': {
        const result = await q.setModel(req.model);
        this.controls.model = req.model;
        return result;
      }
      case 'setPermissionMode': {
        const result = await q.setPermissionMode(req.mode as Parameters<Query['setPermissionMode']>[0]);
        this.controls.permissionMode = req.mode;
        return result;
      }
      case 'supportedModels':
        return q.supportedModels();
      case 'supportedCommands':
        return q.supportedCommands();
      case 'getContextUsage':
        return q.getContextUsage({ detail: 'summary' });
      default:
        throw new UnknownControlOp((req as { op?: unknown }).op);
    }
  }

  /**
   * End the agent (playbook §7.1, decided at CP0 from spike S1):
   *
   * 1. If a turn is running, interrupt it and wait up to `graceMs` for its
   *    `result`. Interrupting first is what keeps the in-flight reply: a
   *    SIGTERM mid-stream drops it from the transcript.
   * 2. Settle whatever asks are left, then close stdin. An idle CLI exits on
   *    EOF in under a second.
   * 3. If it has not, the SDK's `close()` terminates it, and we wait a little
   *    longer. Bare stdin EOF is never the whole plan: mid-turn the CLI ignores
   *    it until the turn ends, which can be a whole long Bash command.
   *
   * Resolves once the agent has exited, or the sequence has run out.
   */
  end(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.endPromise = this.runEnd(opts.graceMs ?? END_TIMINGS.graceMs);
    return this.endPromise;
  }

  // ---- internals ----

  private async runEnd(graceMs: number): Promise<void> {
    if (this.snap.state === 'exited') return;
    const busy = this.snap.state === 'running' || this.pending.size > 0;
    this.endReason ??= { reason: 'stopped' };
    this.setState('ending');
    const q = this.query;
    if (!q) {
      this.exit({});
      return;
    }
    if (busy) {
      const before = this.results;
      // Not awaited on its own: a CLI that cannot answer (SIGSTOPped by Pause,
      // wedged) would hold `end` forever. The grace period bounds it either way.
      q.interrupt().catch((err) => this.deps.log(`runner interrupt during end failed: ${String(err)}`));
      await this.waitUntil(() => this.results > before || this.snap.state === 'exited', this.turnWaiters, graceMs);
    }
    this.settleAll('agentExited', 'The session was closed.');
    this.input.close();
    if (await this.waitForExit(END_TIMINGS.eofWaitMs)) return;
    try {
      q.close();
    } catch {
      // already gone
    }
    if (await this.waitForExit(END_TIMINGS.killWaitMs)) return;
    this.deps.log('runner did not confirm its exit after close(); treating it as ended');
    this.exit({});
  }

  private canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = options.requestId;
      if (this.snap.state === 'ending' || this.snap.state === 'exited') {
        resolve({ behavior: 'deny', message: 'The session was closed.' });
        return;
      }
      const ask: RawAsk = {
        requestId,
        toolName,
        input,
        toolUseId: options.toolUseID,
        suggestions: options.suggestions as unknown[] | undefined,
        title: options.title,
        description: options.description,
        // Everything else the SDK said about the ask, as it said it (minus the signal).
        options: Object.fromEntries(Object.entries(options).filter(([k, v]) => k !== 'signal' && typeof v !== 'function')),
      };
      this.pending.set(requestId, { ask, resolve });
      this.emit({ type: 'ask', ask });
      this.setState('running');

      // An interrupt, or the CLI giving up on the ask, aborts it. Settle rather
      // than leave a card whose buttons can no longer do anything.
      const onAbort = () => {
        if (!this.pending.has(requestId)) return;
        this.settle(requestId, 'aborted');
        resolve({ behavior: 'deny', message: 'The request was cancelled.' });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });

  private async pump(query: Query): Promise<void> {
    try {
      for await (const msg of query) this.onMessage(msg);
      this.exit({});
    } catch (err) {
      // A forced close during `end` surfaces as the iterator throwing. That is
      // the ending we asked for, not a failure.
      this.exit(this.snap.state === 'ending' ? {} : { reason: 'error', error: String(err) });
    }
  }

  private onMessage(msg: unknown): void {
    // Once the exit is reported, nothing more is: a client must be able to
    // treat `exit` as the last event.
    if (this.snap.state === 'exited') return;
    const m = msg as {
      type?: string;
      subtype?: string;
      session_id?: unknown;
      message?: { content?: unknown };
      queued_turn_count?: unknown;
    };
    if (typeof m.session_id === 'string' && m.session_id && m.session_id !== this.snap.sessionId) {
      this.emit({ type: 'sessionId', sessionId: m.session_id });
    }
    this.emit({ type: 'message', msg });

    if (m.type === 'system' && m.subtype === 'init') {
      if (this.snap.state === 'starting') this.setState('idle');
    } else if (m.type === 'result') {
      this.results++;
      // Open asks are left alone: one can belong to a background task, or to
      // the next turn already under way. The SDK's abort signal settles the
      // ones the CLI gives up on. A queued message means another turn is
      // starting, so the session is still running.
      const queued = typeof m.queued_turn_count === 'number' ? m.queued_turn_count : 0;
      this.setState(queued > 0 ? 'running' : 'idle');
      flush(this.turnWaiters);
    } else if (m.type === 'user') {
      this.settleAnsweredElsewhere(m.message?.content);
    } else if ((m.type === 'assistant' || m.type === 'stream_event') && this.snap.state === 'idle') {
      this.setState('running');
    }
  }

  /**
   * A `tool_result` for a tool whose ask is still pending means the tool was
   * decided without us: AW's own permission hook raced `canUseTool` and won,
   * which the CLI allows and which leaves the SDK's promise hanging
   * (remote-agent-control.md §0.1). Settle the ask so its card does not stay
   * "pending" for a tool that has already run. Resolving the SDK's promise now
   * is harmless: the CLI discards a late answer.
   */
  private settleAnsweredElsewhere(content: unknown): void {
    if (this.pending.size === 0 || !Array.isArray(content)) return;
    for (const part of content) {
      const p = part as { type?: string; tool_use_id?: unknown; is_error?: unknown };
      if (p?.type !== 'tool_result' || typeof p.tool_use_id !== 'string') continue;
      for (const [requestId, pending] of [...this.pending]) {
        if (pending.ask.toolUseId !== p.tool_use_id) continue;
        // A successful result means it was allowed. An error result is either
        // a refusal or an allowed tool that failed, which cannot be told apart
        // reliably, so no outcome is claimed.
        this.settle(requestId, 'answeredElsewhere', p.is_error === true ? undefined : 'allowed');
        pending.resolve({ behavior: 'deny', message: 'Answered outside Agent Wrangler.' });
      }
    }
  }

  private settle(requestId: string, reason: AskSettleReason, outcome?: 'allowed' | 'denied'): void {
    if (!this.pending.delete(requestId)) return;
    remember(this.settled, requestId, SETTLED_MEMORY);
    this.emit({ type: 'askSettled', requestId, reason, ...(outcome ? { outcome } : {}) });
  }

  private settleAll(reason: AskSettleReason, message: string): void {
    for (const [requestId, p] of [...this.pending]) {
      this.settle(requestId, reason);
      p.resolve({ behavior: 'deny', message });
    }
  }

  private exit(exit: HostExit): void {
    if (this.snap.state === 'exited') return;
    // Anything still parked on a human would otherwise hold the process open.
    this.settleAll('agentExited', 'The session was closed.');
    this.input.close();
    // Why, unless the caller said: the end we started (stopped, signal), or on its own.
    const why: HostExit = { reason: 'ended', ...this.endReason, ...exit };
    if (why.reason === undefined) why.reason = 'ended';
    this.emit({ type: 'exit', exit: this.decorateExit?.(why) ?? why });
    flush(this.exitWaiters);
    flush(this.turnWaiters);
  }

  private setState(next: HostState): void {
    const cur = this.snap.state;
    if (cur === next || cur === 'exited') return;
    // Once ending, the only way on is out.
    if (cur === 'ending' && next !== 'exited') return;
    this.emit({ type: 'state', state: next });
  }

  private emit(body: HostEventBody): void {
    // Folded in before any listener runs: a listener may read the snapshot,
    // or cause another event, and either must see this one already applied.
    this.log.push(body, (event) => {
      this.snap = reduceHostSnapshot(this.snap, event);
    });
  }

  private waitForExit(ms: number): Promise<boolean> {
    return this.waitUntil(() => this.snap.state === 'exited', this.exitWaiters, ms);
  }

  /** Resolves true as soon as `done()` holds (checked when `waiters` are flushed), false after `ms`. */
  private waitUntil(done: () => boolean, waiters: (() => void)[], ms: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const timer = this.setT(() => {
        if (finished) return;
        finished = true;
        resolve(done());
      }, ms);
      const check = () => {
        if (finished) return;
        if (!done()) {
          waiters.push(check);
          return;
        }
        finished = true;
        this.clearT(timer);
        resolve(true);
      };
      waiters.push(check);
    });
  }
}

/** A `control` op this build does not have. The host answers it with -32601. */
export class UnknownControlOp extends Error {
  constructor(readonly op: unknown) {
    super(`no control op ${String(op)}`);
  }
}

function remember(list: string[], id: string, max: number): void {
  list.push(id);
  if (list.length > max) list.splice(0, list.length - max);
}

function flush(waiters: (() => void)[]): void {
  const now = waiters.splice(0);
  for (const w of now) w();
}
