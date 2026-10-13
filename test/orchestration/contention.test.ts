/**
 * Contention between tasks (#47, plan §13.4–13.5): overlapping predicted
 * scopes never run together unless both missions allow it, and a task whose
 * exclusive resource is leased elsewhere waits for it. Tables over the pure
 * scheduler, then a seeded simulation that checks both at every step, then
 * the scope measurement and the lease names.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULER_LIMITS,
  schedule,
  scopeOverlap,
  type CapacitySnapshot,
  type SchedMission,
  type SchedTask,
  type SchedulerAction,
} from '../../src/orchestration/engine/scheduler';
import { exclusiveLeaseNames, outOfScopeText, scopeCheck, wroteOutsideScope } from '../../src/orchestration/engine/contention';

const T0 = 1_800_000_000_000;
const REPO = '/Users/test/proj';

function task(id: string, over: Partial<SchedTask> = {}): SchedTask {
  return { id, key: id, state: 'pending', dependsOn: [], integrated: false, harness: 'claude-code', source: 'anthropic', attempts: 0, ...over };
}
function mission(id: string, tasks: SchedTask[], over: Partial<SchedMission> = {}): SchedMission {
  return { id, repo: REPO, state: 'running', priority: 0, createdAt: T0, planned: true, sharedTree: false, tasks, ...over };
}
const cap = (): CapacitySnapshot => ({ limits: { ...DEFAULT_SCHEDULER_LIMITS, global: 10, perRepo: 10 }, sources: {}, fleetPaused: false });
const scope = (...paths: string[]) => ({ paths, subsystems: [] as string[] });
const live = (id: string, over: Partial<SchedTask> = {}) => task(id, { state: 'running', attempts: 1, live: { id: `${id}-a1`, phase: 'agent' }, ...over });
const starts = (a: SchedulerAction[]) => a.filter((x) => x.kind === 'start').map((x) => (x as { taskId: string }).taskId);
const waits = (a: SchedulerAction[]) => a.filter((x): x is Extract<SchedulerAction, { kind: 'wait' }> => x.kind === 'wait');

describe('scopeOverlap', () => {
  it.each<[string, SchedTask['scope'], SchedTask['scope'], string | undefined]>([
    ['the same file', scope('src/a.ts'), scope('src/a.ts'), 'src/a.ts'],
    ['a file under a glob', scope('src/host/**'), scope('src/host/protocol.ts'), 'src/host/** and src/host/protocol.ts'],
    ['nested globs', scope('src/**'), scope('src/core/**'), 'src/** and src/core/**'],
    ['apart', scope('src/a/**'), scope('src/b/**'), undefined],
    ['a shared subsystem', { paths: [], subsystems: ['billing'] }, { paths: [], subsystems: ['billing'] }, 'the billing subsystem'],
    ['nothing predicted', scope(), scope('src/**'), undefined],
    ['no scope at all', undefined, scope('src/**'), undefined],
  ])('%s', (_n, a, b, expected) => {
    expect(scopeOverlap(a, b)).toBe(expected);
  });
});

describe('schedule: overlapping scopes (§13.4)', () => {
  it('a task whose scope overlaps a running one in the same repository waits, saying which and where', () => {
    const m = mission('m1', [live('A', { scope: scope('src/core/**') }), task('B', { scope: scope('src/core/store.ts') })]);
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(starts(out)).toEqual([]);
    expect(waits(out)).toEqual([
      { kind: 'wait', missionId: 'm1', taskId: 'B', reason: 'overlap', detail: 'its scope overlaps A, which is running (src/core/store.ts and src/core/**)' },
    ]);
  });

  it('two overlapping tasks ready at once: only the first starts', () => {
    const m = mission('m1', [task('A', { scope: scope('docs/**') }), task('B', { scope: scope('docs/README.md') }), task('C', { scope: scope('src/**') })]);
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(starts(out)).toEqual(['A', 'C']);
    expect(waits(out).map((w) => [w.taskId, w.reason])).toEqual([['B', 'overlap']]);
  });

  it('across missions in one repository too, and not across repositories', () => {
    const a = mission('m1', [live('A', { scope: scope('src/**') })]);
    const b = mission('m2', [task('B', { scope: scope('src/x.ts') })], { createdAt: T0 + 1 });
    expect(waits(schedule({ missions: [a, b] }, cap(), T0))[0]).toMatchObject({ taskId: 'B', reason: 'overlap', detail: expect.stringContaining('A (another mission)') });
    const elsewhere = { ...b, repo: '/Users/test/other' };
    expect(starts(schedule({ missions: [a, elsewhere] }, cap(), T0))).toEqual(['B']);
  });

  it('a verifying task still holds its scope: its work is not on the mission branch yet', () => {
    const m = mission('m1', [live('A', { state: 'verifying', scope: scope('src/**'), live: { id: 'a1', phase: 'verifying' } }), task('B', { scope: scope('src/x.ts') })]);
    expect(starts(schedule({ missions: [m] }, cap(), T0))).toEqual([]);
  });

  it('allowOverlap lets them run together, only when both missions allow it', () => {
    const a = mission('m1', [live('A', { scope: scope('src/**') })], { allowOverlap: true });
    const b = mission('m2', [task('B', { scope: scope('src/x.ts') })], { createdAt: T0 + 1, allowOverlap: true });
    expect(starts(schedule({ missions: [a, b] }, cap(), T0))).toEqual(['B']);
    expect(starts(schedule({ missions: [{ ...a, allowOverlap: false }, b] }, cap(), T0))).toEqual([]);
    const same = mission('m1', [live('A', { scope: scope('src/**') }), task('B', { scope: scope('src/x.ts') })], { allowOverlap: true });
    expect(starts(schedule({ missions: [same] }, cap(), T0))).toEqual(['B']);
  });

  it('a task with no predicted scope is not held back by one', () => {
    const m = mission('m1', [live('A', { scope: scope('src/**') }), task('B')]);
    expect(starts(schedule({ missions: [m] }, cap(), T0))).toEqual(['B']);
  });

  it('a retry is held the same way', () => {
    const m = mission('m1', [live('A', { scope: scope('src/**') }), task('B', { state: 'needs-human', attempts: 1, retry: { decisionId: 'd1' }, scope: scope('src/x.ts') })]);
    expect(waits(schedule({ missions: [m] }, cap(), T0))[0]).toMatchObject({ taskId: 'B', reason: 'overlap' });
  });
});

describe('schedule: exclusive resources (§13.5)', () => {
  it('a task whose resource is leased elsewhere waits, saying by whom; it is not counted against capacity', () => {
    const m = mission('m1', [task('U', { resourceWait: 'unity-editor:Game is in use by t2 of “Other”' }), task('V')]);
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(starts(out)).toEqual(['V']);
    expect(waits(out)).toEqual([{ kind: 'wait', missionId: 'm1', taskId: 'U', reason: 'resource', detail: 'unity-editor:Game is in use by t2 of “Other”' }]);
  });

  it('a paused fleet says so first: the lease is not the reason it waits', () => {
    const m = mission('m1', [task('U', { resourceWait: 'x is in use' })]);
    expect(waits(schedule({ missions: [m] }, { ...cap(), fleetPaused: true }, T0))[0].reason).toBe('fleet-paused');
  });
});

// ---------------------------------------------------------------------------
// Simulation: contention never runs two at once
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = ['src/a/**', 'src/a/x.ts', 'src/b/**', 'docs/**', 'docs/README.md', 'test/**', 'src/**'];
const RESOURCES = ['unity-editor:Game', 'db', 'port-3000'];

interface SimTask extends SchedTask {
  needs: string[];
  endsAt?: number;
}

/**
 * Missions in two repositories, tasks with random scopes and resources, run
 * to the end. Leases are a table the sim keeps, the way the core's service
 * would: a task's `resourceWait` comes from it, a start takes every lease the
 * task needs, an end gives them back. At every step: no two live tasks in a
 * repository overlap unless both missions allow it, and no lease has two holders.
 */
function simulate(seed: number): { steps: number; overlapWaits: number; resourceWaits: number } {
  const r = rng(seed);
  const repos = ['/Users/test/a', '/Users/test/b'];
  const missions = Array.from({ length: 2 + Math.floor(r() * 3) }, (_, i) => {
    const tasks: SimTask[] = Array.from({ length: 2 + Math.floor(r() * 5) }, (_, j) => ({
      ...task(`m${i}-t${j}`),
      ...(r() < 0.85 ? { scope: { paths: PATHS.filter(() => r() < 0.25), subsystems: r() < 0.2 ? ['billing'] : [] } } : {}),
      needs: RESOURCES.filter(() => r() < 0.2),
    }));
    // What the engine tells the scheduler a task needs.
    for (const t of tasks) if (t.needs.length > 0) t.resources = t.needs;
    return mission(`m${i}`, tasks, { repo: repos[i % 2], createdAt: T0 + i, allowOverlap: r() < 0.25 }) as SchedMission & { tasks: SimTask[] };
  });
  const held = new Map<string, string>(); // `${repo}|${resource}` → task id
  let now = T0;
  let overlapWaits = 0;
  let resourceWaits = 0;
  let steps = 0;
  const all = () => missions.flatMap((m) => m.tasks.map((t) => ({ m, t: t as SimTask })));
  for (; steps < 3000; steps++) {
    if (all().every(({ t }) => t.state === 'done')) break;
    for (const { m, t } of all()) {
      if (t.live && t.endsAt! <= now) {
        t.live = undefined;
        t.state = 'done';
        t.integrated = true;
        for (const n of t.needs) if (held.get(`${m.repo}|${n}`) === t.id) held.delete(`${m.repo}|${n}`);
      }
      const other = t.needs.map((n) => held.get(`${m.repo}|${n}`)).find((h) => h !== undefined && h !== t.id);
      t.resourceWait = !t.live && other ? `held by ${other}` : undefined;
    }
    const actions = schedule({ missions }, cap(), now);
    for (const a of actions) {
      if (a.kind === 'wait' && a.reason === 'overlap') overlapWaits++;
      if (a.kind === 'wait' && a.reason === 'resource') resourceWaits++;
      if (a.kind !== 'start') continue;
      const m = missions.find((x) => x.id === a.missionId)!;
      const t = m.tasks.find((x) => x.id === a.taskId)! as SimTask;
      // The atomic acquire the engine does at launch: the scheduler's word is checked, not trusted.
      for (const n of t.needs) {
        const h = held.get(`${m.repo}|${n}`);
        expect(h === undefined || h === t.id, `seed ${seed}: ${t.id} started while ${h} holds ${n}`).toBe(true);
        held.set(`${m.repo}|${n}`, t.id);
      }
      t.state = 'running';
      t.attempts = 1;
      t.live = { id: `${t.id}-a1`, phase: 'agent' };
      t.endsAt = now + 1_000 + Math.floor(r() * 20_000);
    }
    // Invariant: live tasks in one repository never overlap, unless both missions allow it.
    const liveNow = all().filter(({ t }) => t.live);
    for (const x of liveNow) {
      for (const y of liveNow) {
        if (x.t.id >= y.t.id || x.m.repo !== y.m.repo) continue;
        if (x.m.allowOverlap && y.m.allowOverlap) continue;
        expect(scopeOverlap(x.t.scope, y.t.scope), `seed ${seed} step ${steps}: ${x.t.id} and ${y.t.id} overlap`).toBeUndefined();
      }
    }
    now += 1_000 + Math.floor(r() * 4_000);
  }
  expect(all().every(({ t }) => t.state === 'done'), `seed ${seed}: did not finish`).toBe(true);
  return { steps, overlapWaits, resourceWaits };
}

describe('simulation', () => {
  it('over 200 seeds: overlapping tasks never run together, a lease never has two holders, and every mission finishes', () => {
    let overlapWaits = 0;
    let resourceWaits = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = simulate(seed);
      overlapWaits += r.overlapWaits;
      resourceWaits += r.resourceWaits;
    }
    // The tables above are not the only cases exercised: both kinds of wait happened, often.
    expect(overlapWaits).toBeGreaterThan(50);
    expect(resourceWaits).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Scope accuracy and lease names
// ---------------------------------------------------------------------------

describe('scopeCheck', () => {
  it('measures the share of changed files inside the predicted scope', () => {
    expect(scopeCheck(['src/a.ts', 'src/b.ts', 'docs/x.md', 'README.md'], ['src/**'])).toEqual({
      accuracy: 0.5,
      changed: 4,
      outside: ['docs/x.md', 'README.md'],
      outsideCount: 2,
    });
  });

  it('says nothing when nothing was predicted or nothing changed', () => {
    expect(scopeCheck(['src/a.ts'], [])).toBeUndefined();
    expect(scopeCheck([], ['src/**'])).toBeUndefined();
  });

  it('flags only an attempt that wrote mostly outside its scope', () => {
    expect(wroteOutsideScope(scopeCheck(['src/a.ts', 'src/b.ts', 'src/c.ts', 'package.json'], ['src/**']))).toBe(false);
    const wild = scopeCheck(['a', 'b', 'c', 'd', 'e', 'f', 'src/x.ts'], ['src/**'])!;
    expect(wroteOutsideScope(wild)).toBe(true);
    expect(outOfScopeText(wild)).toBe("6 of 7 changed files are outside the task's predicted scope (a, b, c, d, e, and 1 more)");
  });
});

describe('exclusiveLeaseNames', () => {
  const policy = {
    exclusive: [
      { id: 'unity-editor:Game', paths: ['Game/**'] },
      { id: 'app-install' },
    ],
  };

  it('needs a resource whose paths the scope reaches, and every resource that has no paths', () => {
    expect(exclusiveLeaseNames(policy, ['Game/Assets/x.cs'])).toEqual(['app-install', 'unity-editor:Game']);
    expect(exclusiveLeaseNames(policy, ['docs/**'])).toEqual(['app-install']);
  });

  it('adds what the assessment required, without its prefix, and ignores other needs', () => {
    expect(exclusiveLeaseNames({ exclusive: [] }, [], ['edit', 'shell', 'exclusive:db', 'exclusive:'])).toEqual(['db']);
    expect(exclusiveLeaseNames(undefined, ['x'])).toEqual([]);
  });
});
