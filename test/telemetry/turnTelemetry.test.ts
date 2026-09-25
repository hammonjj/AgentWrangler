import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import { SessionViewBase } from '../../src/core/session/sessionView';
import type { SessionHandle, SessionLifecycle, SessionProvider } from '../../src/core/session/sessionHandle';
import { TelemetryLog } from '../../src/core/telemetry/telemetryLog';
import { TurnTelemetry, type TurnTelemetryDeps } from '../../src/core/telemetry/turnTelemetry';
import type { BlockPatch, ComposerState, ConvBlock } from '../../src/shared/conversation';
import type { TurnRecord } from '../../src/shared/orchestration/telemetry';

/** Content that must never reach a record. */
const PROMPT = 'SYNTHETIC-PROMPT-TEXT-7f3a';
const FILE_BODY = 'SYNTHETIC-FILE-CONTENT-91c2';

class FakeHandle extends SessionViewBase {
  lifecycle: SessionLifecycle = 'idle';
  composer: ComposerState = { permissionMode: 'auto', slashCommands: [], busy: false, queued: 0, effort: 'high' };
  blocks: ConvBlock[] = [];
  origin?: unknown;
  constructor(
    readonly provider: SessionProvider,
    public sessionId: string,
    readonly startedAt = Date.now(),
  ) {
    super();
  }
  protected get truncatedView(): boolean {
    return false;
  }
  append(...blocks: ConvBlock[]): void {
    this.blocks.push(...blocks);
    this.emitAppend(blocks);
  }
  patchBlock(patch: BlockPatch): void {
    this.emitPatch(patch);
  }
  turnEnd(raw: unknown, segment?: string): void {
    this.emitTurnEnd(raw, segment);
  }
  clear(newId: string): void {
    this.sessionId = newId;
    this.emitReset();
  }
}

function claudeResult(uuid: string, cost: number, input: number, output: number) {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    session_id: 'sess-1',
    is_error: false,
    duration_ms: 4000,
    duration_api_ms: 3000,
    num_turns: 2,
    total_cost_usd: cost,
    result: PROMPT,
    modelUsage: { 'claude-opus': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost, webSearchRequests: 0, contextWindow: 1, maxOutputTokens: 1 } },
  };
}

let dir: string;
let handles: FakeHandle[];
let changed: Emitter<void>;
let enabled: boolean;
let applied: Record<string, string>;
let notes: { id: string; effort?: string }[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-telemetry-'));
  handles = [];
  changed = new Emitter<void>();
  enabled = true;
  applied = {};
  notes = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sink(now = () => 1_790_000_000_000): TurnTelemetry {
  const deps: TurnTelemetryDeps = {
    sessions: { list: () => handles as unknown as SessionHandle[], onDidChange: (l) => changed.event(l) },
    log: new TelemetryLog(dir),
    enabled: () => enabled,
    appliedEffort: (id) => applied[id],
    registry: {
      get: (id) => ({ v: 1, sessionId: id ?? '', provider: 'claude', cwd: '/Users/test/proj', launch: { effort: 'high' }, state: 'live', createdAt: 0, lastShownAt: 0, updatedAt: 0 }),
      noteApplied: (id, a) => void notes.push({ id, ...a }),
    },
    now,
  };
  return new TurnTelemetry(deps);
}

function records(): TurnRecord[] {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
  return files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

function add(h: FakeHandle): FakeHandle {
  handles.push(h);
  changed.fire();
  return h;
}

describe('TurnTelemetry', () => {
  it('records a Claude turn with usage, effort, tools, asks and waiting time, and nothing said', () => {
    let clock = 1_790_000_000_000;
    const t = sink(() => clock);
    const h = add(new FakeHandle('claude', 'sess-1'));
    applied['sess-1'] = 'medium';
    h.append({ kind: 'user', id: 'u1', text: PROMPT });
    h.append({ kind: 'tool', id: 'b1', toolUseId: 'x', name: 'Read', inputPreview: FILE_BODY, input: { file: FILE_BODY }, state: 'done' });
    h.append({ kind: 'tool', id: 'b2', toolUseId: 'y', name: 'Read', inputPreview: 'b', state: 'done' });
    h.append({ kind: 'permission', id: 'p1', requestId: 'r', toolName: 'Bash', body: PROMPT, state: 'pending' });
    clock += 5000;
    h.patchBlock({ id: 'p1', block: { state: 'allowed' } });
    h.turnEnd(claudeResult('res-1', 0.12, 1000, 100), 'exec-A');
    const [r] = records();
    expect(r).toMatchObject({
      type: 'turn',
      id: 'res-1',
      sessionId: 'sess-1',
      harness: 'claude-code',
      source: 'anthropic',
      modelsUsed: { 'claude-opus': { in: 1000, out: 100, costUsd: 0.12 } },
      costUsd: 0.12,
      costBasis: 'harness-estimate',
      effort: { requested: 'high', applied: 'medium' },
      permissionMode: 'auto',
      durationMs: 4000,
      apiMs: 3000,
      toolCalls: { Read: 2 },
      permissionAsks: 1,
      waitedOnHumanMs: 5000,
      isError: false,
    });
    expect(notes).toEqual([{ id: 'sess-1', effort: 'medium' }]);
    const text = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(FILE_BODY);
    t.dispose();
  });

  it('differences turns within an execution, and starts again on a new one (migration)', () => {
    const t = sink();
    const h = add(new FakeHandle('claude', 'sess-1'));
    h.turnEnd(claudeResult('res-1', 0.1, 100, 10), 'exec-A');
    h.turnEnd(claudeResult('res-2', 0.3, 300, 30), 'exec-A');
    h.turnEnd(claudeResult('res-3', 0.05, 50, 5), 'exec-B');
    expect(records().map((r) => r.costUsd)).toEqual([0.1, 0.2, 0.05]);
    expect(records().some((r) => r.usageUnknown)).toBe(false);
    t.dispose();
  });

  it('/clear resets the totals without losing the turn', () => {
    const t = sink();
    const h = add(new FakeHandle('claude', 'sess-1'));
    h.turnEnd(claudeResult('res-1', 0.5, 500, 50), 'exec-A');
    h.clear('sess-2');
    h.turnEnd(claudeResult('res-2', 0.1, 100, 10), 'exec-A');
    expect(records().map((r) => [r.sessionId, r.costUsd])).toEqual([['sess-1', 0.5], ['sess-2', 0.1]]);
    t.dispose();
  });

  it('after a restart, the replayed last turn records once and the next may cover a gap', () => {
    const first = sink();
    const h = add(new FakeHandle('claude', 'sess-1'));
    h.turnEnd(claudeResult('res-1', 0.1, 100, 10), 'host-1');
    first.dispose();
    handles = [];

    // A new app run: a new view over the same host replays its last result.
    const second = sink();
    const again = add(new FakeHandle('claude', 'sess-1'));
    again.turnEnd(claudeResult('res-1', 0.1, 100, 10), 'host-1');
    again.turnEnd(claudeResult('res-4', 0.4, 400, 40), 'host-1');
    const all = records();
    expect(all.map((r) => r.id)).toEqual(['res-1', 'res-4']);
    expect(all[1]).toMatchObject({ costUsd: 0.3, coversGap: true });
    second.dispose();
  });

  it('marks the first turn of a session already running before it looked (no baseline)', () => {
    const t = sink(() => 2_000);
    const h = add(new FakeHandle('claude', 'sess-1', 1_000));
    h.turnEnd(claudeResult('res-1', 1.5, 9000, 900), 'host-9');
    expect(records()[0]).toMatchObject({ coversGap: true, costUsd: 1.5 });
    t.dispose();
  });

  it('a turn that ended before the sink followed the handle is still recorded', () => {
    const h = new FakeHandle('claude', 'sess-1');
    handles.push(h);
    h.turnEnd(claudeResult('res-1', 0.1, 100, 10), 'exec-A');
    const t = sink();
    expect(records().map((r) => r.id)).toEqual(['res-1']);
    t.dispose();
  });

  it('writes nothing while off, and does not count the off period as one turn when back on', () => {
    const t = sink();
    const h = add(new FakeHandle('claude', 'sess-1'));
    enabled = false;
    h.turnEnd(claudeResult('res-1', 0.1, 100, 10), 'exec-A');
    expect(fs.readdirSync(dir)).toEqual([]);
    enabled = true;
    h.turnEnd(claudeResult('res-2', 0.15, 150, 15), 'exec-A');
    expect(records().map((r) => r.costUsd)).toEqual([0.05]);
    t.dispose();
  });

  it('records a Codex turn from the usage update the runner attaches', () => {
    const t = sink();
    const h = add(new FakeHandle('codex', 'thread-1'));
    const b = (i: number, o: number) => ({ totalTokens: i + o, inputTokens: i, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: o, reasoningOutputTokens: 3 });
    h.turnEnd({
      threadId: 'thread-1',
      model: 'gpt-x',
      turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 900, items: [{ text: PROMPT }] },
      usageUpdate: { turnId: 'turn-1', tokenUsage: { total: b(100, 10), last: b(100, 10), modelContextWindow: 1 } },
    });
    expect(records()[0]).toMatchObject({
      id: 'turn-1',
      harness: 'codex',
      source: 'openai',
      modelsUsed: { 'gpt-x': { in: 100, out: 10, thinking: 3 } },
      costBasis: 'none',
      durationMs: 900,
      terminalReason: 'completed',
      isError: false,
    });
    expect(records()[0].costUsd).toBeUndefined();
    expect(JSON.stringify(records())).not.toContain(PROMPT);
    t.dispose();
  });

  it('says why when a turn has no usage', () => {
    const t = sink();
    const h = add(new FakeHandle('codex', 'thread-1'));
    h.turnEnd({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'x' } } });
    expect(records()[0]).toMatchObject({ modelsUsed: {}, usageUnknown: 'no token usage reported', isError: true });
    t.dispose();
  });

  it('tags a turn with its attempt when the session is orchestrated', () => {
    const t = sink();
    const h = new FakeHandle('claude', 'sess-1');
    h.origin = { kind: 'orchestration', missionId: 'm', taskId: 't', attemptId: 'att-1' };
    add(h);
    h.turnEnd(claudeResult('res-1', 0.1, 100, 10), 'exec-A');
    expect(records()[0].attemptId).toBe('att-1');
    t.dispose();
  });
});
