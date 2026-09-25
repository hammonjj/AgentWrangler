/**
 * The simulated harness (#30, plan §26.3): every scenario behaviour, played
 * through the real launch path (`SimulatedHarness` → the Claude Code adapter
 * → `SessionExecutors.launch` → `RunnerService` → `RunnerView` over
 * `ClaudeSdkSession`), with the SDK's `query` replaced by `simulatedQuery`.
 * No network, no processes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../../src/core/session/sessionHandle';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { TelemetryLog } from '../../src/core/telemetry/telemetryLog';
import { TurnTelemetry } from '../../src/core/telemetry/turnTelemetry';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import type { AttemptLaunch } from '../../src/orchestration/harness/types';
import { parseSimScenario, readSimDirective, SIM_BEHAVIOURS, type SimScenario } from '../../src/shared/orchestration/simulation';
import type { TurnRecord } from '../../src/shared/orchestration/telemetry';

const SCENARIO = parseSimScenario(
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'every-behaviour.scenario.json'), 'utf8')),
);

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let worktree: string;
beforeEach(() => {
  worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sim-')));
});
afterEach(() => fs.rmSync(worktree, { recursive: true, force: true }));

interface Rig {
  harness: SimulatedHarness;
  registry: SessionRegistry;
  launches: number;
  turnEnds: Map<SessionHandle, unknown[]>;
}

function rig(scenario: SimScenario = SCENARIO): Rig {
  const registry = new SessionRegistry(memento());
  const { sessions } = createSimulatedExecutors({ registry });
  const r: Rig = { harness: undefined as never, registry, launches: 0, turnEnds: new Map() };
  const counted = {
    launch: (req: Parameters<typeof sessions.launch>[0]) => {
      r.launches++;
      return sessions.launch(req);
    },
  };
  r.harness = new SimulatedHarness({ scenario, sessions: counted });
  return r;
}

function request(taskId: string, n = 1): AttemptLaunch {
  return {
    cwd: worktree,
    prompt: `Do task ${taskId}`,
    target: { harness: 'claude-code', model: 'claude-haiku-4-5', effortNative: 'low' },
    origin: { kind: 'orchestration', missionId: 'm1', taskId, attemptId: `${taskId}-a${n}` },
    permissionMode: 'default',
  };
}

async function launch(r: Rig, taskId: string): Promise<{ handle: SessionHandle; ends: unknown[] }> {
  const handle = await r.harness.launch(request(taskId));
  const ends: unknown[] = [];
  handle.onTurnEnd((raw) => ends.push(raw));
  r.turnEnds.set(handle, ends);
  return { handle, ends };
}

const pending = (h: SessionHandle, kind: string) =>
  h.blocks.find((b) => b.kind === kind && (b as { state?: string }).state === 'pending') as { requestId: string } | undefined;

describe('SimulatedHarness', () => {
  it('scripts every behaviour the plan lists, from data', () => {
    const covered = new Set(Object.values(SCENARIO.tasks ?? {}).flatMap((a) => a.map((s) => s.behaviour)));
    expect([...covered].sort()).toEqual([...SIM_BEHAVIOURS].sort());
  });

  it('launches through SessionExecutors with the target, origin and a pre-assigned id, and writes real files', async () => {
    const r = rig();
    const { handle, ends } = await launch(r, 'edit');
    await until(() => ends.length === 1, 3000, 'the turn to end');

    expect(r.launches).toBe(1);
    expect(handle.provider).toBe('claude');
    expect(handle.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const record = r.registry.get(handle.sessionId);
    expect(record).toMatchObject({
      provider: 'claude',
      cwd: worktree,
      state: 'live',
      launch: { model: 'claude-haiku-4-5', effort: 'low', permissionMode: 'default' },
      origin: { kind: 'orchestration', missionId: 'm1', taskId: 'edit', attemptId: 'edit-a1' },
    });
    expect(fs.readFileSync(path.join(worktree, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(fs.readFileSync(path.join(worktree, 'notes/readme.md'), 'utf8')).toBe('hello\n');
    expect(ends[0]).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.05,
      modelUsage: { 'claude-haiku-4-5': { inputTokens: 12000, outputTokens: 900, cacheReadInputTokens: 4000 } },
    });
    expect(handle.lifecycle).toBe('idle');
    // The pane shows the real prompt, after the script.
    const user = handle.blocks.find((b) => b.kind === 'user') as { text: string };
    expect(readSimDirective(user.text)?.prompt).toBe('Do task edit');
    await handle.end();
  });

  it('fail: an execution error carrying the signature', async () => {
    const { ends } = await launch(rig(), 'fail');
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ subtype: 'error_during_execution', is_error: true, errors: ['build: cannot find module'] });
  });

  it('timeout: no result until an interrupt ends the turn', async () => {
    const { handle, ends } = await launch(rig(), 'timeout');
    await until(() => handle.lifecycle === 'running');
    await new Promise((r) => setTimeout(r, 50));
    expect(ends).toEqual([]);
    await handle.interrupt();
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
  });

  it('rate-limit: a 429 on the result and a rejected rate-limit event', async () => {
    const { ends } = await launch(rig(), 'rate-limit');
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ subtype: 'success', is_error: true, api_error_status: 429 });
  });

  it('bad-structured-output: success whose output is not JSON', async () => {
    const { ends } = await launch(rig(), 'bad-structured-output');
    await until(() => ends.length === 1);
    const result = (ends[0] as { result: string }).result;
    expect(result).toBe('sure! {"tier":');
    expect(() => JSON.parse(result)).toThrow();
  });

  it('slow: streams at the scripted rate', async () => {
    const started = Date.now();
    const { ends } = await launch(rig(), 'slow');
    await until(() => ends.length === 1);
    // 20 tokens at 100/s is 200 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(ends[0]).toMatchObject({ subtype: 'success', result: 'slowly, slowly' });
  });

  it('context-overflow: prompt_too_long', async () => {
    const { ends } = await launch(rig(), 'context-overflow');
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ is_error: true, terminal_reason: 'prompt_too_long', result: 'Prompt is too long' });
  });

  it('tool-failure: a failed tool call, then the turn ends', async () => {
    const { handle, ends } = await launch(rig(), 'tool-failure');
    await until(() => ends.length === 1);
    expect(handle.blocks.some((b) => b.kind === 'tool')).toBe(true);
    expect(ends[0]).toMatchObject({ subtype: 'success', is_error: false });
  });

  it('fail-verification: writes the failing code and reports success', async () => {
    const { ends } = await launch(rig(), 'fail-verification');
    await until(() => ends.length === 1);
    expect(fs.readFileSync(path.join(worktree, 'src/parser.ts'), 'utf8')).toContain('s.length - 1');
    expect(ends[0]).toMatchObject({ subtype: 'success', is_error: false });
  });

  it('no-diff: success without touching the worktree', async () => {
    const { ends } = await launch(rig(), 'no-diff');
    await until(() => ends.length === 1);
    expect(fs.readdirSync(worktree)).toEqual([]);
    expect(ends[0]).toMatchObject({ subtype: 'success', is_error: false });
  });

  it('crash: partial files, no result, and the session fails', async () => {
    const r = rig();
    const { handle, ends } = await launch(r, 'crash');
    await until(() => handle.lifecycle === 'error', 3000, 'the crash');
    expect(ends).toEqual([]);
    expect(fs.readFileSync(path.join(worktree, 'src/half.ts'), 'utf8')).toBe('export const half =');
    expect(r.registry.get(handle.sessionId)?.state).toBe('failed');
  });

  it('question: asks, waits, and carries on with the answer', async () => {
    const { handle, ends } = await launch(rig(), 'question');
    await until(() => handle.pendingQuestion !== undefined, 3000, 'the question');
    expect(handle.pendingQuestion?.questions[0]).toMatchObject({ question: 'Which parser?', options: [{ label: 'hand-written' }, { label: 'generated' }] });
    expect(ends).toEqual([]);
    expect(await handle.answer(handle.pendingQuestion!.requestId, { 'Which parser?': 'generated' })).toBe('applied');
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ subtype: 'success', result: 'Answered: generated' });
  });

  it('permission: asks for the tool; allowed, it runs and writes', async () => {
    const { handle, ends } = await launch(rig(), 'permission');
    await until(() => pending(handle, 'permission') !== undefined, 3000, 'the permission prompt');
    expect(fs.existsSync(path.join(worktree, 'dist/out.js'))).toBe(false);
    expect(await handle.decide(pending(handle, 'permission')!.requestId, 'allow')).toBe('applied');
    await until(() => ends.length === 1);
    expect(fs.readFileSync(path.join(worktree, 'dist/out.js'), 'utf8')).toBe('built\n');
  });

  it('permission: denied, it stops without writing', async () => {
    const { handle, ends } = await launch(rig(), 'permission');
    await until(() => pending(handle, 'permission') !== undefined);
    await handle.decide(pending(handle, 'permission')!.requestId, 'deny');
    await until(() => ends.length === 1);
    expect(fs.existsSync(path.join(worktree, 'dist/out.js'))).toBe(false);
    expect(ends[0]).toMatchObject({ result: 'Permission denied; stopping.' });
  });

  it('plays a task\'s attempts in launch order, then the default, then refuses', async () => {
    const r = rig({
      tasks: { t: [{ behaviour: 'fail', signature: 'first' }, { behaviour: 'no-diff', text: 'second' }] },
    });
    const first = await launch(r, 't');
    await until(() => first.ends.length === 1);
    const second = await launch(r, 't');
    await until(() => second.ends.length === 1);
    expect(first.ends[0]).toMatchObject({ errors: ['first'] });
    expect(second.ends[0]).toMatchObject({ result: 'second' });
    await expect(r.harness.launch(request('t', 3))).rejects.toThrow(/no scripted attempt 3 for task t/);
    expect(r.launches).toBe(2);

    const withDefault = rig({ default: { behaviour: 'no-diff', text: 'default' } });
    const d = await launch(withDefault, 'anything');
    await until(() => d.ends.length === 1);
    expect(d.ends[0]).toMatchObject({ result: 'default' });
  });

  it('follow-up messages play the follow-up steps, with running usage totals', async () => {
    const { handle, ends } = await launch(
      rig({ tasks: { t: [{ behaviour: 'no-diff', usage: { in: 100, out: 10 }, followUps: [{ behaviour: 'edit', files: { 'b.txt': 'b' }, usage: { in: 50, out: 5 } }] }] } }),
      't',
    );
    await until(() => ends.length === 1);
    await handle.send('now do it');
    await until(() => ends.length === 2);
    expect(fs.readFileSync(path.join(worktree, 'b.txt'), 'utf8')).toBe('b');
    const usage = (e: unknown) => Object.values((e as { modelUsage: Record<string, { inputTokens: number }> }).modelUsage)[0].inputTokens;
    expect([usage(ends[0]), usage(ends[1])]).toEqual([100, 150]);
  });

  it('refuses a target for another harness, and a script that writes outside the worktree', async () => {
    const r = rig({ default: { behaviour: 'no-diff' } });
    await expect(r.harness.launch({ ...request('t'), target: { harness: 'codex', model: 'x', effortNative: 'none' } })).rejects.toThrow(/cannot launch a codex target/);
    expect(() => parseSimScenario({ default: { behaviour: 'edit', files: { '../escape.txt': 'x' } } })).toThrow(/inside the worktree/);
    expect(() => parseSimScenario({ default: { behaviour: 'teleport' } })).toThrow(/unknown behaviour/);
  });

  it('feeds turn telemetry the same events a real session does', async () => {
    const telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sim-tel-'));
    try {
      const registry = new SessionRegistry(memento());
      const { sessions } = createSimulatedExecutors({ registry });
      const records: TurnRecord[] = [];
      const telemetry = new TurnTelemetry({
        sessions,
        log: new TelemetryLog(telemetryDir),
        enabled: () => true,
        registry,
        onRecord: (rec) => records.push(rec),
      });
      const harness = new SimulatedHarness({ scenario: SCENARIO, sessions });
      const handle = await harness.launch(request('edit'));
      await until(() => records.length === 1, 3000, 'a telemetry record');
      expect(records[0]).toMatchObject({
        sessionId: handle.sessionId,
        harness: 'claude-code',
        modelsUsed: { 'claude-haiku-4-5': { in: 12000, out: 900, cacheRead: 4000 } },
        costUsd: 0.05,
        numTurns: 3,
        isError: false,
        effort: { requested: 'low' },
        toolCalls: { Write: 2 },
      });
      telemetry.dispose();
      await handle.end();
    } finally {
      fs.rmSync(telemetryDir, { recursive: true, force: true });
    }
  });
});
