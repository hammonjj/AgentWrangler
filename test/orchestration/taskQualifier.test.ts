/**
 * Qualification stage 2's runner and its place in `LocalEndpointService`
 * (plan §19.6, §19.9), against a fake harness: real scratch repos, real git,
 * the fixtures' real checks, and an "agent" that edits the repo the way a
 * scripted model would. No app-server, no model.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import type { LaunchRequest, SessionHandle, SessionLifecycle, SessionViewEvent } from '../../src/core/session/sessionHandle';
import { CodexHarness } from '../../src/orchestration/harness/codexHarness';
import type { AttemptLaunch } from '../../src/orchestration/harness/types';
import { LocalEndpointService, type EndpointSettings, type TaskQualifier } from '../../src/orchestration/local/localEndpointService';
import { loadFixtures, runTaskQualification, taskQualifier, type TaskQualifierDeps } from '../../src/orchestration/local/taskQualifier';
import type { ConvBlock } from '../../src/shared/conversation';
import type { TaskRun } from '../../src/shared/orchestration/localQualification';
import type { LocalCallRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
import { startFakeServer, type FakeServer } from './fakeOpenAIServer';
import { FIXTURES_DIR, REFERENCE_FIXES } from './qualificationFixtures';

type Behaviour = (cwd: string) => { ask?: boolean; fail?: boolean; edits?: Record<string, string>; toolCalls?: number; tokens?: { in: number; out: number } };

/** A session handle that plays one agent turn: edit the repo, then go idle with Codex-shaped usage. */
function fakeHandle(cwd: string, behave: Behaviour): SessionHandle & { ended: boolean } {
  const log: SessionViewEvent[] = [];
  const events = new Emitter<SessionViewEvent>();
  let lifecycle: SessionLifecycle = 'running';
  const blocks: ConvBlock[] = [];
  const h = {
    ended: false,
    get lifecycle() {
      return lifecycle;
    },
    get blocks() {
      return blocks;
    },
    pendingQuestion: undefined,
    pendingPlan: undefined,
    subscribe(from: number, l: (e: SessionViewEvent) => void) {
      log.slice(from).forEach(l);
      return events.event(l);
    },
    snapshot: () => ({ seq: log.length }),
    end: async () => {
      h.ended = true;
      lifecycle = 'ended';
    },
    interrupt: async () => 'applied' as const,
  };
  setTimeout(() => {
    const b = behave(cwd);
    for (const [file, text] of Object.entries(b.edits ?? {})) writeFileSync(path.join(cwd, file), text);
    for (let i = 0; i < (b.toolCalls ?? 2); i++) blocks.push({ kind: 'tool', id: `t${i}` } as unknown as ConvBlock);
    if (b.ask) {
      blocks.push({ kind: 'permission', id: 'p', state: 'pending' } as unknown as ConvBlock);
      return;
    }
    if (b.fail) {
      lifecycle = 'error';
      return;
    }
    const t = b.tokens ?? { in: 1200, out: 300 };
    const e: SessionViewEvent = {
      type: 'turnEnd',
      raw: { turn: { id: 'turn-1', status: 'completed' }, model: 'm', usageUpdate: { turnId: 'turn-1', tokenUsage: { last: { inputTokens: t.in, outputTokens: t.out }, total: { inputTokens: t.in, outputTokens: t.out } } } },
    } as SessionViewEvent;
    log.push(e);
    events.fire(e);
    lifecycle = 'idle';
  }, 5);
  return h as unknown as SessionHandle & { ended: boolean };
}

function fakeHarness(behave: Behaviour) {
  const launches: AttemptLaunch[] = [];
  const handles: (SessionHandle & { ended: boolean })[] = [];
  return {
    launches,
    handles,
    harness: {
      launch: async (req: AttemptLaunch) => {
        launches.push(req);
        const h = fakeHandle(req.cwd, behave);
        handles.push(h);
        return h;
      },
    },
  };
}

const fix: Behaviour = (cwd) => {
  const id = Object.keys(REFERENCE_FIXES).find((k) => existsSync(path.join(cwd, REFERENCE_FIXES[k].file)))!;
  return { edits: { [REFERENCE_FIXES[id].file]: REFERENCE_FIXES[id].text } };
};

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'aw-qualifier-test-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function deps(harness: TaskQualifierDeps['harness']): TaskQualifierDeps {
  return { harness, fixturesDir: FIXTURES_DIR, tmpRoot, pollMs: 5, settleMs: 10, runTimeoutMs: 5_000 };
}

describe('runTaskQualification', () => {
  it('runs every fixture k times, each in a fresh scratch repo, and passes a correct fix', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const f = fakeHarness(fix);
    const seen: TaskRun[] = [];
    const r = await runTaskQualification({ source: 'local:box', model: 'm', fixtures, k: 3, onRun: (x) => seen.push(x) }, deps(f.harness));
    expect(r.error).toBeUndefined();
    expect(r.runs).toHaveLength(fixtures.length * 3);
    expect(seen).toEqual(r.runs);
    expect(r.runs.every((x) => x.pass && x.testsPass && x.testsUntouched && x.diffInside)).toBe(true);
    expect(r.runs[0]).toMatchObject({ turns: 1, toolCalls: 2, inputTokens: 1200, outputTokens: 300 });
    expect(r.runs.map((x) => `${x.fixture}#${x.n}`).slice(0, 3)).toEqual([`${fixtures[0].id}#1`, `${fixtures[0].id}#2`, `${fixtures[0].id}#3`]);
    // A fresh repo each time, all removed afterwards; every session ended.
    expect(new Set(f.launches.map((l) => l.cwd)).size).toBe(f.launches.length);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(f.handles.every((h) => h.ended)).toBe(true);
  });

  it('launches as a routed attempt would: Codex, the local source and model, the attempt sandbox and prompt', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const f = fakeHarness(fix);
    await runTaskQualification({ source: 'local:box', model: 'm', fixtures: fixtures.slice(0, 1), k: 1 }, deps(f.harness));
    const [l] = f.launches;
    expect(l.target).toEqual({ harness: 'codex', model: 'm', source: 'local:box', effortNative: 'none' });
    expect(l.policy?.codex).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    expect(l.permissionMode).toBeUndefined();
    expect(l.prompt).toMatch(/^# Task: /);
    expect(l.prompt).toContain(fixtures[0].prompt);
    expect(l.prompt).toMatch(/Do not commit/);
    expect(l.origin).toMatchObject({ kind: 'orchestration', missionId: 'qualification', taskId: fixtures[0].id });
  });

  it('through Claude Code: acceptEdits, the fixture check allowed by name, and no deny over its own directory (#159)', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const f = fakeHarness(fix);
    const harness = { ...f.harness, id: 'claude-code' as const };
    const r = await runTaskQualification({ source: 'local:box', model: 'm', fixtures: fixtures.slice(0, 1), k: 1 }, deps(harness));
    expect(r.runs[0].pass).toBe(true);
    const [l] = f.launches;
    expect(l.target.harness).toBe('claude-code');
    expect(l.permissionMode).toBe('acceptEdits');
    expect(l.policy?.claude?.allowedTools).toContain(`Bash(${fixtures[0].check.join(' ')}:*)`);
    const denies = l.policy?.claude?.disallowedTools ?? [];
    expect(denies.filter((d) => /^(Edit|Write)\(/.test(d))).toEqual([`Edit(/${l.cwd}.primary/**)`, `Write(/${l.cwd}.primary/**)`]);
    expect(denies).toContain('Bash(git push:*)');
  });

  it('through CodexHarness, the thread gets the endpoint provider on top of the attempt sandbox', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const requests: LaunchRequest[] = [];
    const provider = { id: 'aw-box', name: 'Agent Wrangler: box', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32768 };
    const harness = new CodexHarness({
      sessions: {
        launch: async (req) => {
          requests.push(req);
          const h = fakeHandle(req.cwd, fix);
          return Object.assign(h, { send: async () => 'applied' as const, setEffort: async () => 'applied' as const });
        },
      },
      models: () => [],
      localProvider: (s, m) => (s === 'local:box' && m === 'm' ? provider : undefined),
    });
    const r = await runTaskQualification({ source: 'local:box', model: 'm', fixtures: fixtures.slice(0, 1), k: 1 }, deps(harness));
    expect(r.runs[0].pass).toBe(true);
    expect(requests[0]).toMatchObject({ provider: 'codex', model: 'm', policy: { codex: { sandbox: 'workspace-write', approvalPolicy: 'on-request', modelProvider: provider } } });
  });

  it('fails a run that edits the tests, one that writes outside the allowed paths, and one that leaves the bugs', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const one = fixtures.filter((x) => x.id === 'cart-total');
    const cases: [Behaviour, Partial<TaskRun>][] = [
      [() => ({ edits: { 'test/check.js': "console.log('ok');\n" } }), { pass: false, testsPass: true, testsUntouched: false, failure: 'changed a test file: test/check.js' }],
      [
        (cwd) => ({ edits: { ...fix(cwd).edits, 'NOTES.md': 'notes\n' } }),
        { pass: false, testsPass: true, testsUntouched: true, diffInside: false, failure: 'changed outside the allowed paths: NOTES.md' },
      ],
      [() => ({}), { pass: false, testsPass: false, testsUntouched: true, diffInside: true, failure: 'the check exited 1' }],
    ];
    for (const [behave, expected] of cases) {
      const r = await runTaskQualification({ source: 'local:box', model: 'm', fixtures: one, k: 1 }, deps(fakeHarness(behave).harness));
      expect(r.runs[0]).toMatchObject(expected);
    }
  });

  it('a run that asks for approval fails and is ended; a failed session is infra', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const one = fixtures.slice(0, 1);
    const asked = fakeHarness(() => ({ ask: true }));
    const r1 = await runTaskQualification({ source: 'local:box', model: 'm', fixtures: one, k: 1 }, deps(asked.harness));
    expect(r1.runs[0]).toMatchObject({ pass: false, failure: 'it asked for approval or input, and nobody answers during qualification' });
    expect(asked.handles[0].ended).toBe(true);
    const failed = await runTaskQualification({ source: 'local:box', model: 'm', fixtures: one, k: 1 }, deps(fakeHarness(() => ({ fail: true })).harness));
    expect(failed.runs[0]).toMatchObject({ pass: false, infra: true, failure: 'the session failed' });
  });

  it('stops, keeping nothing, when a run cannot be started', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    const r = await runTaskQualification(
      { source: 'local:box', model: 'm', fixtures, k: 3 },
      deps({ launch: async () => Promise.reject(new Error('The endpoint for local:box is not registered, or is off.')) }),
    );
    expect(r).toEqual({ runs: [], error: 'could not start a run: The endpoint for local:box is not registered, or is off.' });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});

// ---- In the service ----

function settings(initial: Record<string, unknown> = {}): EndpointSettings & { doc: Record<string, unknown>; writes: string[] } {
  const doc: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  const changed = new Emitter<string>();
  return {
    doc,
    writes,
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: async (key, value) => {
      writes.push(key);
      if (value === undefined) delete doc[key];
      else doc[key] = JSON.parse(JSON.stringify(value));
      changed.fire(key);
    },
    onDidChange: (listener) => changed.event((key) => listener((k) => k === key)),
  };
}

function storage() {
  const data: Record<string, unknown> = {};
  return { data, get: <T>(k: string, d: T): T => (k in data ? (JSON.parse(JSON.stringify(data[k])) as T) : d), update: (k: string, v: unknown) => void (data[k] = v) };
}

describe('LocalEndpointService: stage 2', () => {
  let servers: FakeServer[] = [];
  let services: LocalEndpointService[] = [];
  beforeEach(() => {
    servers = [];
    services = [];
  });
  afterEach(async () => {
    for (const s of services) s.dispose();
    await Promise.all(servers.map((s) => s.close()));
  });

  async function setUp(opts: { responses: boolean; qualifier?: TaskQualifier; store?: ReturnType<typeof storage> }) {
    const s = await startFakeServer({ models: ['m'], responses: opts.responses });
    servers.push(s);
    const st = settings();
    const store = opts.store ?? storage();
    const telemetry: TelemetryRecord[] = [];
    const svc = new LocalEndpointService({ settings: st, storage: store, telemetry: { append: (r) => (telemetry.push(r), true) } });
    services.push(svc);
    if (opts.qualifier) svc.useTaskQualifier(opts.qualifier);
    await svc.apply({ op: 'add', url: s.url, name: 'box' });
    return { svc, settings: st, store, telemetry };
  }

  it('an endpoint without /v1/responses is not runnable: no pass rate stored, the runner never called', async () => {
    let called = 0;
    const { svc, telemetry } = await setUp({
      responses: false,
      qualifier: async () => (called++, { runs: [], k: 3 }),
    });
    const r = await svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' });
    expect(r).toEqual({ ok: false, lines: ['Tasks: not runnable: no /v1/responses'] });
    expect(called).toBe(0);
    const q = svc.taskQualification('box', 'm');
    expect(q).toMatchObject({ runnable: false, reason: 'no /v1/responses' });
    expect(q && 'passed' in q).toBe(false);
    expect(telemetry.some((t) => t.type === 'local-call' && t.qualificationStage === 2)).toBe(false);
    expect(svc.view()[0].models[0].tasks).toBe('Tasks: not runnable: no /v1/responses');
  });

  it('runs the fixtures through the qualifier, stores measured results with stage 1, records each run, and never sets a tier', async () => {
    const store = storage();
    const f = fakeHarness(fix);
    const { svc, settings: st, telemetry } = await setUp({
      responses: true,
      store,
      qualifier: taskQualifier({ ...deps(f.harness), k: 1 }),
    });
    const r = await svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' });
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toMatch(new RegExp(`^Tasks ${fixtures.length}/${fixtures.length} passed \\(k=1, measured\\)`));
    expect(f.launches.every((l) => l.target.source === 'local:box' && l.target.model === 'm')).toBe(true);

    const recs = telemetry.filter((t): t is LocalCallRecord => t.type === 'local-call');
    expect(recs).toHaveLength(fixtures.length);
    expect(recs[0]).toMatchObject({ purpose: 'qualification', qualificationStage: 2, source: 'local:box', model: 'm', ok: true, run: 1, inputTokens: 1200, outputTokens: 300 });
    expect(recs.map((x) => x.fixture).sort()).toEqual(fixtures.map((x) => x.id).sort());

    // Persisted with stage 1's results, and read back after a restart.
    expect((store.data['agentWrangler.localEndpoints'] as { tasks: Record<string, unknown> }).tasks.box).toBeDefined();
    const again = new LocalEndpointService({ settings: st, storage: store });
    services.push(again);
    expect(again.taskQualification('box', 'm')).toMatchObject({ runnable: true, passed: fixtures.length });

    // Only the endpoint registry was written: no tier, no model policy.
    expect(new Set(st.writes)).toEqual(new Set(['orchestration.localEndpoints']));
    expect(st.doc['orchestration.models']).toBeUndefined();
  });

  it('shows progress while running, and refuses a second run of the same model', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc } = await setUp({
      responses: true,
      qualifier: async ({ onStart, onRun }) => {
        onStart(6);
        onRun({ fixture: 'a', n: 1, pass: true, testsPass: true, testsUntouched: true, diffInside: true, turns: 1, toolCalls: 1, wallMs: 10 });
        await gate;
        return { runs: [{ fixture: 'a', n: 1, pass: true, testsPass: true, testsUntouched: true, diffInside: true, turns: 1, toolCalls: 1, wallMs: 10 }], k: 3, error: 'cancelled' };
      },
    });
    const running = svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' });
    await new Promise((r) => setTimeout(r, 20));
    expect(svc.view()[0].models[0].tasksRunning).toBe('Running tasks: 1/6 done, 1 passed');
    expect(await svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' })).toEqual({ ok: false, lines: ['Already running.'] });
    expect(await svc.apply({ op: 'qualify', id: 'box', model: 'm' })).toEqual({ ok: false, lines: ['Already running.'] });
    release();
    const r = await running;
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/stopped: cancelled$/);
    expect(svc.view()[0].models[0].tasksRunning).toBeUndefined();
  });

  it('Cancel ends the run in progress, starts no more, and leaves the last result in place (#160)', async () => {
    const store = storage();
    const f = fakeHarness(fix);
    const { svc } = await setUp({ responses: true, store, qualifier: taskQualifier({ ...deps(f.harness), k: 1 }) });
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    // A first, complete result.
    expect((await svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' })).ok).toBe(true);
    const before = svc.taskQualification('box', 'm');
    expect(before).toMatchObject({ passed: fixtures.length });

    // A second stage whose agent never finishes its turn: cancel it mid-run.
    const handles: (SessionHandle & { ended: boolean })[] = [];
    const hanging = {
      launch: async (req: AttemptLaunch) => {
        const h = fakeHandle(req.cwd, () => ({}));
        // Its turn never ends: without a turnEnd the run is never finished.
        (h as unknown as { subscribe: unknown }).subscribe = () => ({ dispose: () => undefined });
        handles.push(h);
        return h;
      },
    };
    svc.useTaskQualifier(taskQualifier({ ...deps(hanging), k: 1 }));
    const running = svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' });
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.view()[0].models[0].tasksRunning).toBeDefined();
    expect(await svc.apply({ op: 'cancelQualifyTasks', id: 'box', model: 'm' })).toEqual({ ok: true, lines: ['Cancelling: the current run is being ended.'] });
    const r = await running;
    expect(r).toEqual({ ok: false, lines: ['Cancelled after 0 runs. The last result stands.'] });
    expect(handles).toHaveLength(1);
    expect(handles[0].ended).toBe(true);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(svc.taskQualification('box', 'm')).toEqual(before);
    expect(svc.view()[0].models[0].tasksRunning).toBeUndefined();
    expect(await svc.apply({ op: 'cancelQualifyTasks', id: 'box', model: 'm' })).toEqual({ ok: false, lines: ['Task qualification is not running.'] });
  });

  it('without a qualifier, says so and stores nothing', async () => {
    const { svc } = await setUp({ responses: true });
    const r = await svc.apply({ op: 'qualifyTasks', id: 'box', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/not available/);
    expect(svc.taskQualification('box', 'm')).toBeUndefined();
  });
});
