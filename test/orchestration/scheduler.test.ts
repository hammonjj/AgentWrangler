/**
 * The mission scheduler (#45, plan §12.2–12.4) as tables: a snapshot of
 * missions, capacity and the clock → the actions. Then a seeded simulation
 * with a fake clock that runs random task graphs to the end and checks, at
 * every step, that nothing starts before its dependencies and that no
 * concurrency limit (global, per repository, per harness, per source, per
 * local endpoint, verification) is ever exceeded.
 */
import { describe, expect, it } from 'vitest';
import {
  criticalPaths,
  DEFAULT_SCHEDULER_LIMITS,
  parallelismBenefit,
  schedule,
  type CapacitySnapshot,
  type SchedMission,
  type SchedTask,
  type SchedulerAction,
  type SchedulerLimits,
} from '../../src/orchestration/engine/scheduler';
import type { HarnessId, ModelSourceId } from '../../src/shared/orchestration/types';

const T0 = 1_800_000_000_000;
const REPO = '/Users/test/proj';

function task(id: string, over: Partial<SchedTask> = {}): SchedTask {
  return { id, key: id, state: 'pending', dependsOn: [], integrated: false, harness: 'claude-code', source: 'anthropic', attempts: 0, ...over };
}

function mission(tasks: SchedTask[], over: Partial<SchedMission> = {}): SchedMission {
  return { id: 'm1', repo: REPO, state: 'running', priority: 0, createdAt: T0, planned: true, sharedTree: false, tasks, ...over };
}

function cap(over: Partial<CapacitySnapshot> = {}, limits: Partial<SchedulerLimits> = {}): CapacitySnapshot {
  return { limits: { ...DEFAULT_SCHEDULER_LIMITS, ...limits }, sources: {}, fleetPaused: false, ...over };
}

const code = (taskId: string) => ({ taskId, kind: 'code' as const });
const order = (taskId: string) => ({ taskId, kind: 'order' as const });
const done = (id: string, over: Partial<SchedTask> = {}) => task(id, { state: 'done', integrated: true, attempts: 1, ...over });
const running = (id: string, over: Partial<SchedTask> = {}) => task(id, { state: 'running', attempts: 1, live: { id: `${id}-a1`, phase: 'agent' }, ...over });

const starts = (actions: SchedulerAction[]) => actions.filter((a) => a.kind === 'start').map((a) => (a as { taskId: string }).taskId);
const kinds = (actions: SchedulerAction[], kind: SchedulerAction['kind']) => actions.filter((a) => a.kind === kind);

describe('schedule: readiness', () => {
  const diamond = (states: Partial<Record<'A' | 'B' | 'C' | 'D', Partial<SchedTask>>>) =>
    mission([
      task('A', states.A),
      task('B', { dependsOn: [code('A')], ...states.B }),
      task('C', { dependsOn: [code('A')], ...states.C }),
      task('D', { dependsOn: [code('B'), code('C')], ...states.D }),
    ]);

  it.each<[string, SchedMission, string[]]>([
    ['A → B, A → C, B + C → D: only A at first', diamond({}), ['A']],
    ['A done: B and C together', diamond({ A: { state: 'done', integrated: true, attempts: 1 } }), ['B', 'C']],
    [
      'B done, C running: D waits',
      diamond({ A: { state: 'done', integrated: true, attempts: 1 }, B: { state: 'done', integrated: true, attempts: 1 }, C: { state: 'running', attempts: 1, live: { id: 'c1', phase: 'agent' } } }),
      [],
    ],
    [
      'B and C done: D',
      diamond({ A: { state: 'done', integrated: true, attempts: 1 }, B: { state: 'done', integrated: true, attempts: 1 }, C: { state: 'done', integrated: true, attempts: 1 } }),
      ['D'],
    ],
    ['a code upstream done but not integrated: waits', mission([done('A', { integrated: false }), task('B', { dependsOn: [code('A')] })]), []],
    ['an order upstream done but not integrated: starts', mission([done('A', { integrated: false }), task('B', { dependsOn: [order('A')] })]), ['B']],
    ['an upstream waiting on the user: waits, not blocked', mission([task('A', { state: 'needs-human', attempts: 1 }), task('B', { dependsOn: [code('A')] })]), []],
    ['a task tried before with no step pending is the user’s', mission([task('A', { state: 'queued', attempts: 1 })]), []],
  ])('%s', (_name, m, expected) => {
    expect(starts(schedule({ missions: [m] }, cap(), T0))).toEqual(expected);
  });

  it('a done task on its own branch is integrated; in a shared tree it already is', () => {
    const m = mission([done('A', { integrated: false })]);
    expect(kinds(schedule({ missions: [m] }, cap(), T0), 'integrate')).toEqual([{ kind: 'integrate', missionId: 'm1', taskId: 'A' }]);
    expect(kinds(schedule({ missions: [{ ...m, sharedTree: true }] }, cap(), T0), 'integrate')).toEqual([]);
  });
});

describe('schedule: failed and invalid upstreams', () => {
  it.each<[string, SchedTask['state'], Partial<SchedTask>]>([
    ['failed', 'failed', {}],
    ['cancelled', 'cancelled', {}],
    ['skipped', 'skipped', {}],
    ['invalidated', 'done', { integrated: true, invalidated: true }],
  ])('an upstream %s blocks what depends on it, transitively only by waiting', (_name, state, over) => {
    const m = mission([task('A', { state, attempts: 1, ...over }), task('B', { dependsOn: [code('A')] }), task('C', { dependsOn: [code('B')] })]);
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(kinds(out, 'block')).toEqual([expect.objectContaining({ taskId: 'B', upstream: ['A'] })]);
    expect(starts(out)).toEqual([]);
  });

  it('an already blocked task is not blocked again', () => {
    const m = mission([task('A', { state: 'failed', attempts: 1 }), task('B', { state: 'blocked', dependsOn: [code('A')] })]);
    expect(schedule({ missions: [m] }, cap(), T0)).toEqual([]);
  });

  it('a blocked task whose upstream recovered is unblocked', () => {
    const m = mission([task('A', { state: 'needs-human', attempts: 1 }), task('B', { state: 'blocked', dependsOn: [code('A')] })]);
    expect(schedule({ missions: [m] }, cap(), T0)).toEqual([{ kind: 'unblock', missionId: 'm1', taskId: 'B' }]);
  });
});

describe('schedule: cancellation, pause and finish', () => {
  it('a cancelled mission’s live attempts are ended, and nothing starts', () => {
    const m = mission([running('A'), running('B'), task('C')], { state: 'cancelled' });
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(out).toEqual([
      { kind: 'cancel', missionId: 'm1', taskId: 'A', attemptId: 'A-a1' },
      { kind: 'cancel', missionId: 'm1', taskId: 'B', attemptId: 'B-a1' },
    ]);
  });

  it('a skipped task’s live attempt is ended, and frees its slot', () => {
    const m = mission([running('A', { state: 'skipped' }), task('B')]);
    const out = schedule({ missions: [m] }, cap({}, { global: 1 }), T0);
    expect(kinds(out, 'cancel')).toHaveLength(1);
    expect(starts(out)).toEqual(['B']);
  });

  it('a paused mission starts nothing; its running attempts carry on', () => {
    const m = mission([running('A'), task('B')], { state: 'paused' });
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(starts(out)).toEqual([]);
    expect(out).toEqual([expect.objectContaining({ kind: 'wait', taskId: 'B', reason: 'mission-paused' })]);
  });

  it('a paused fleet starts nothing anywhere', () => {
    const a = mission([task('A')]);
    const b = mission([task('B')], { id: 'm2', createdAt: T0 + 1, planned: false });
    const out = schedule({ missions: [a, b] }, cap({ fleetPaused: true }), T0);
    expect(starts(out)).toEqual([]);
    expect(kinds(out, 'wait').map((w) => (w as { reason: string }).reason)).toEqual(['fleet-paused', 'fleet-paused']);
  });

  it('a planned mission with every task done and integrated (or skipped) finishes', () => {
    expect(kinds(schedule({ missions: [mission([done('A'), task('B', { state: 'skipped' })])] }, cap(), T0), 'finish')).toHaveLength(1);
    // Not while a task is on its own branch still, nor when nothing was done, nor for a single task.
    expect(kinds(schedule({ missions: [mission([done('A', { integrated: false })])] }, cap(), T0), 'finish')).toHaveLength(0);
    expect(kinds(schedule({ missions: [mission([task('A', { state: 'skipped' })])] }, cap(), T0), 'finish')).toHaveLength(0);
    expect(kinds(schedule({ missions: [mission([done('A')], { planned: false })] }, cap(), T0), 'finish')).toHaveLength(0);
  });

  it('missions that are not running or paused are left alone', () => {
    for (const state of ['draft', 'plan-review', 'planning', 'review', 'completed'] as const) {
      expect(schedule({ missions: [mission([task('A')], { state })] }, cap(), T0)).toEqual([]);
    }
  });
});

describe('schedule: retries (#41)', () => {
  it('a pending step starts once its notBefore passes, and wakes the engine then', () => {
    const t = task('A', { state: 'blocked', attempts: 1, retry: { decisionId: 'd1', notBefore: T0 + 60_000 } });
    const early = schedule({ missions: [mission([t])] }, cap(), T0);
    expect(early).toEqual([
      expect.objectContaining({ kind: 'wait', reason: 'retry-delay', until: T0 + 60_000 }),
      { kind: 'wake', at: T0 + 60_000 },
    ]);
    expect(schedule({ missions: [mission([t])] }, cap(), T0 + 60_000)).toEqual([{ kind: 'start', missionId: 'm1', taskId: 'A', retryOf: 'd1' }]);
  });

  it('a retry goes through the same admission as a first attempt', () => {
    const t = task('A', { state: 'queued', attempts: 1, retry: { decisionId: 'd1' } });
    expect(starts(schedule({ missions: [mission([t])] }, cap({ fleetPaused: true }), T0))).toEqual([]);
    expect(starts(schedule({ missions: [mission([t])] }, cap({ sources: { anthropic: { windowPercent: 90 } } }), T0))).toEqual([]);
  });
});

describe('schedule: admission against usage windows and backoff (§12.4)', () => {
  const one = (sources: CapacitySnapshot['sources'], over: Partial<SchedMission> = {}, now = T0) =>
    schedule({ missions: [mission([task('A')], over)] }, cap({ sources }), now);

  it.each<[string, CapacitySnapshot['sources'], Partial<SchedMission>, string]>([
    ['below 85%: starts', { anthropic: { windowPercent: 84.9 } }, {}, 'start'],
    ['at 85%: waits', { anthropic: { windowPercent: 85 } }, {}, 'usage'],
    ['another source’s window does not hold this one', { openai: { windowPercent: 99 } }, {}, 'start'],
    ['a mission cap below the threshold holds it', { anthropic: { windowPercent: 60 } }, { maxWindowPercent: 50 }, 'usage'],
    ['a mission cap above the threshold does not lift it', { anthropic: { windowPercent: 90 } }, { maxWindowPercent: 95 }, 'usage'],
    ['a rate-limit backoff holds it', { anthropic: { backoffUntil: T0 + 1 } }, {}, 'backoff'],
    ['an expired backoff does not', { anthropic: { backoffUntil: T0 } }, {}, 'start'],
    ['an unknown source does not block', {}, {}, 'start'],
  ])('%s', (_name, sources, over, expected) => {
    const out = one(sources, over);
    const first = out[0] as { kind: string; reason?: string };
    expect(first.kind === 'start' ? 'start' : first.reason).toBe(expected);
  });

  it('a backoff wakes the engine when it ends', () => {
    expect(one({ anthropic: { backoffUntil: T0 + 5000 } })).toContainEqual({ kind: 'wake', at: T0 + 5000 });
  });
});

describe('schedule: concurrency', () => {
  const tasks = (n: number, over: (i: number) => Partial<SchedTask> = () => ({})) => Array.from({ length: n }, (_, i) => task(`t${i}`, over(i)));

  it.each<[string, SchedMission[], Partial<SchedulerLimits>, CapacitySnapshot['sources'], number]>([
    ['global default 3', [mission(tasks(5)), mission(tasks(5), { id: 'm2', repo: '/Users/test/other' })], { perRepo: 10 }, {}, 3],
    ['per repository default 2', [mission(tasks(5))], {}, {}, 2],
    ['per harness', [mission(tasks(4, (i) => ({ harness: (i % 2 ? 'codex' : 'claude-code') as HarnessId, source: (i % 2 ? 'openai' : 'anthropic') as ModelSourceId })))], { perRepo: 10, global: 10, perHarness: { codex: 1 } }, {}, 3],
    ['per source', [mission(tasks(4))], { perRepo: 10, global: 10, perSource: { anthropic: 1 } }, {}, 1],
    ['per local endpoint: its free slots', [mission(tasks(4, () => ({ harness: 'codex', source: 'local:box' })))], { perRepo: 10, global: 10 }, { 'local:box': { freeSlots: 2 } }, 2],
    ['a shared tree: one at a time', [mission(tasks(3), { sharedTree: true })], {}, {}, 1],
    ['a shared tree held by a task waiting on the user: none', [mission([task('h', { state: 'needs-human', attempts: 1 }), ...tasks(2)], { sharedTree: true })], {}, {}, 0],
    ['a shared tree held by a task waiting on its retry: only the retry', [mission([task('h', { state: 'queued', attempts: 1, retry: { decisionId: 'd' } }), ...tasks(2)], { sharedTree: true })], {}, {}, 1],
    ['running agents count', [mission([running('r1'), running('r2'), ...tasks(3)])], { global: 3, perRepo: 10 }, {}, 1],
    ['a mission cap on concurrent agents', [mission(tasks(3), { maxConcurrentAgents: 1 })], {}, {}, 1],
  ])('%s', (_name, missions, limits, sources, expected) => {
    expect(starts(schedule({ missions }, cap({ sources }, limits), T0))).toHaveLength(expected);
  });

  it('a verifying attempt holds no agent slot; a queued verification waits for its repository’s', () => {
    const m = mission([
      task('v1', { state: 'verifying', attempts: 1, live: { id: 'v1a', phase: 'verifying' } }),
      task('v2', { state: 'verifying', attempts: 1, live: { id: 'v2a', phase: 'verify-queued' } }),
      task('A'),
      task('B'),
    ]);
    const out = schedule({ missions: [m] }, cap(), T0);
    expect(starts(out)).toEqual(['A', 'B']);
    expect(kinds(out, 'verify')).toEqual([]);
    expect(kinds(out, 'wait')).toEqual([expect.objectContaining({ taskId: 'v2', reason: 'verification' })]);
    const other = mission([task('v3', { state: 'verifying', attempts: 1, live: { id: 'v3a', phase: 'verify-queued' } })], { id: 'm2', repo: '/Users/test/other' });
    expect(kinds(schedule({ missions: [m, other] }, cap(), T0), 'verify')).toEqual([{ kind: 'verify', missionId: 'm2', taskId: 'v3', attemptId: 'v3a' }]);
  });
});

describe('schedule: priority', () => {
  it('the longest remaining downstream path goes first', () => {
    // X → Y → Z is longer than W alone; with one slot, X starts.
    const m = mission([task('W'), task('X'), task('Y', { dependsOn: [code('X')] }), task('Z', { dependsOn: [code('Y')] })]);
    expect(criticalPaths(m).get('X')).toBe(3);
    expect(starts(schedule({ missions: [m] }, cap({}, { global: 1 }), T0))).toEqual(['X']);
  });

  it('then mission priority, then age', () => {
    const old = mission([task('A')], { id: 'old', createdAt: T0 });
    const young = mission([task('B')], { id: 'young', createdAt: T0 + 1, repo: '/Users/test/b' });
    const urgent = mission([task('C')], { id: 'urgent', createdAt: T0 + 2, priority: 1, repo: '/Users/test/c' });
    expect(starts(schedule({ missions: [young, urgent, old] }, cap({}, { global: 2 }), T0))).toEqual(['C', 'A']);
  });

  it('is deterministic: the same snapshot, in any order, gives the same actions', () => {
    const a = mission([task('A'), task('B')], { id: 'a' });
    const b = mission([task('C')], { id: 'b', repo: '/Users/test/b' });
    const x = schedule({ missions: [a, b] }, cap({}, { global: 2 }), T0);
    expect(schedule({ missions: [b, a] }, cap({}, { global: 2 }), T0)).toEqual(x);
    expect(schedule({ missions: [a, b] }, cap({}, { global: 2 }), T0)).toEqual(x);
  });
});

describe('parallelismBenefit', () => {
  it('is Σ active time over wall clock', () => {
    expect(parallelismBenefit([{ activeMs: 60 }, { activeMs: 60 }], 60)).toBe(2);
    expect(parallelismBenefit([], 60)).toBeUndefined();
    expect(parallelismBenefit([{ activeMs: 10 }], 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Simulation with a fake clock
// ---------------------------------------------------------------------------

/** A small seeded PRNG (mulberry32), so a failure names its seed. */
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

const SOURCES: { harness: HarnessId; source: ModelSourceId }[] = [
  { harness: 'claude-code', source: 'anthropic' },
  { harness: 'codex', source: 'openai' },
  { harness: 'codex', source: 'local:box' },
];

interface SimTask extends SchedTask {
  endsAt?: number;
  verifyEndsAt?: number;
  startedAt?: number;
}

/** A random acyclic mission: each task depends on a few earlier ones. */
function randomMission(r: () => number, id: string, repo: string, createdAt: number): SchedMission & { tasks: SimTask[] } {
  const n = 2 + Math.floor(r() * 6);
  const tasks: SimTask[] = [];
  for (let i = 0; i < n; i++) {
    const deps = tasks.filter(() => r() < 0.35).map((t) => (r() < 0.8 ? code(t.id) : order(t.id)));
    const route = SOURCES[Math.floor(r() * SOURCES.length)];
    tasks.push(task(`${id}-t${i}`, { dependsOn: deps, ...route }));
  }
  return mission(tasks, { id, repo, createdAt, sharedTree: r() < 0.3, priority: Math.floor(r() * 2) });
}

/**
 * Runs missions to the end against the scheduler: a start becomes a live
 * agent for a random while, then a queued verification, then done (and, off
 * a shared tree, integrated a step later). Usage windows and backoffs move
 * with the clock; the fleet is paused now and then. Every step's actions are
 * checked against the state they were computed from.
 */
function simulate(seed: number): { steps: number; maxParallel: number } {
  const r = rng(seed);
  const repos = ['/Users/test/a', '/Users/test/b'];
  const missions: (SchedMission & { tasks: SimTask[] })[] = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => randomMission(r, `m${i}`, repos[i % 2], T0 + i));
  const limits: SchedulerLimits = { ...DEFAULT_SCHEDULER_LIMITS, perHarness: { codex: 2 }, perSource: { openai: 1 } };
  const SLOTS = 1;
  let now = T0;
  let fleetPausedUntil = 0;
  let backoffUntil = 0;
  let window = 50;
  let maxParallel = 0;
  let steps = 0;
  const all = (): { m: SchedMission; t: SimTask }[] => missions.flatMap((m) => m.tasks.map((t) => ({ m, t: t as SimTask })));
  for (; steps < 5000; steps++) {
    if (all().every(({ t }) => t.state === 'done' && (t.integrated || false))) break;
    // The world moves.
    if (r() < 0.02) fleetPausedUntil = now + 30_000;
    if (r() < 0.02) backoffUntil = now + 20_000;
    window = Math.max(0, Math.min(100, window + (r() - 0.5) * 20));
    for (const { m, t } of all()) {
      if (t.live?.phase === 'agent' && t.endsAt! <= now) {
        t.live = { id: t.live.id, phase: 'verify-queued' };
        t.state = 'verifying';
      } else if (t.live?.phase === 'verifying' && t.verifyEndsAt! <= now) {
        t.live = undefined;
        t.state = 'done';
        t.integrated = m.sharedTree;
      }
    }
    const localBusy = all().filter(({ t }) => t.live?.phase === 'agent' && t.source === 'local:box').length;
    const capacity: CapacitySnapshot = {
      limits,
      fleetPaused: now < fleetPausedUntil,
      sources: {
        anthropic: { windowPercent: window, ...(backoffUntil > now ? { backoffUntil } : {}) },
        openai: { windowPercent: 100 - window },
        'local:box': { freeSlots: SLOTS - localBusy },
      },
    };
    const actions = schedule({ missions }, capacity, now);
    const started = actions.filter((a): a is Extract<SchedulerAction, { kind: 'start' }> => a.kind === 'start');
    // Invariants, against the state the step saw.
    for (const s of started) {
      const m = missions.find((x) => x.id === s.missionId)!;
      const t = m.tasks.find((x) => x.id === s.taskId)!;
      expect(capacity.fleetPaused, `seed ${seed}: start while the fleet is paused`).toBe(false);
      expect(t.live, `seed ${seed}: ${t.id} started twice`).toBeUndefined();
      for (const d of t.dependsOn) {
        const u = m.tasks.find((x) => x.id === d.taskId)!;
        expect(u.state, `seed ${seed}: ${t.id} started before ${u.id}`).toBe('done');
        if (d.kind === 'code') expect(u.integrated, `seed ${seed}: ${t.id} started before ${u.id} was integrated`).toBe(true);
      }
      const src = capacity.sources[t.source];
      if (src?.windowPercent !== undefined) expect(src.windowPercent).toBeLessThan(limits.admissionPercent);
      if (src?.backoffUntil !== undefined) expect(src.backoffUntil).toBeLessThanOrEqual(now);
    }
    // Apply.
    for (const a of actions) {
      const m = missions.find((x) => 'missionId' in a && x.id === a.missionId);
      const t = m?.tasks.find((x) => 'taskId' in a && x.id === a.taskId) as SimTask | undefined;
      if (a.kind === 'start' && t) {
        t.state = 'running';
        t.attempts += 1;
        t.live = { id: `${t.id}-a${t.attempts}`, phase: 'agent' };
        t.startedAt = now;
        t.endsAt = now + 1000 * (5 + Math.floor(r() * 60));
      } else if (a.kind === 'verify' && t) {
        t.live = { id: t.live!.id, phase: 'verifying' };
        t.verifyEndsAt = now + 1000 * (1 + Math.floor(r() * 10));
      } else if (a.kind === 'integrate' && t) {
        t.integrated = true;
      }
    }
    // Limits hold after applying.
    const live = all().filter(({ t }) => t.live?.phase === 'agent');
    const count = (f: (x: { m: SchedMission; t: SchedTask }) => boolean) => live.filter(f).length;
    maxParallel = Math.max(maxParallel, live.length);
    expect(live.length, `seed ${seed}: global`).toBeLessThanOrEqual(limits.global);
    for (const repo of repos) {
      expect(count(({ m }) => m.repo === repo), `seed ${seed}: per repo`).toBeLessThanOrEqual(limits.perRepo);
      const verifying = all().filter(({ m, t }) => m.repo === repo && t.live?.phase === 'verifying').length;
      expect(verifying, `seed ${seed}: verification per repo`).toBeLessThanOrEqual(limits.verificationPerRepo);
    }
    expect(count(({ t }) => t.harness === 'codex'), `seed ${seed}: per harness`).toBeLessThanOrEqual(2);
    expect(count(({ t }) => t.source === 'openai'), `seed ${seed}: per source`).toBeLessThanOrEqual(1);
    expect(count(({ t }) => t.source === 'local:box'), `seed ${seed}: per endpoint`).toBeLessThanOrEqual(SLOTS);
    for (const m of missions) if (m.sharedTree) expect(m.tasks.filter((t) => t.live).length, `seed ${seed}: shared tree`).toBeLessThanOrEqual(1);
    now += 1000;
  }
  expect(all().every(({ t }) => t.state === 'done'), `seed ${seed}: every mission finishes`).toBe(true);
  return { steps, maxParallel };
}

describe('schedule: simulation with a fake clock', () => {
  it('never starts before dependencies, never exceeds a limit, and always finishes (150 seeds)', () => {
    let parallel = 0;
    for (let seed = 1; seed <= 150; seed++) parallel = Math.max(parallel, simulate(seed).maxParallel);
    // It does run things side by side.
    expect(parallel).toBeGreaterThan(1);
  }, 60_000);

  it('A → B, A → C, B + C → D: B and C run together, D only after both', () => {
    const m = mission([task('A'), task('B', { dependsOn: [code('A')] }), task('C', { dependsOn: [code('A')] }), task('D', { dependsOn: [code('B'), code('C')] })]);
    const log: string[] = [];
    let now = T0;
    const ends = new Map<string, number>([['A', 3], ['B', 5], ['C', 8], ['D', 2]]);
    const endAt = new Map<string, number>();
    for (let i = 0; i < 40 && !m.tasks.every((t) => t.state === 'done' && t.integrated); i++) {
      for (const t of m.tasks) {
        if (t.live && endAt.get(t.id)! <= now) {
          t.live = undefined;
          t.state = 'done';
          log.push(`${now - T0}: ${t.id} done`);
        }
      }
      for (const a of schedule({ missions: [m] }, cap(), now)) {
        const t = 'taskId' in a ? m.tasks.find((x) => x.id === a.taskId)! : undefined;
        if (a.kind === 'start' && t) {
          t.state = 'running';
          t.attempts = 1;
          t.live = { id: `${t.id}1`, phase: 'agent' };
          endAt.set(t.id, now + ends.get(t.id)!);
          log.push(`${now - T0}: ${t.id} start`);
        } else if (a.kind === 'integrate' && t) {
          t.integrated = true;
        }
      }
      now += 1;
    }
    // Each done task is integrated in the step that sees it, and its downstream starts in the next.
    expect(log).toEqual(['0: A start', '3: A done', '4: B start', '4: C start', '9: B done', '12: C done', '13: D start', '15: D done']);
  });
});
