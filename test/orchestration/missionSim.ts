/**
 * Whole-mission simulation (#48, plan §26.3): a mission's dependency graph and
 * a scripted behaviour for every attempt (`SimScenario`, the same data the
 * simulated harness plays) run to the end on a fake clock against the real
 * scheduler (`schedule`), the real escalation policy (`decideEscalation`) and
 * the real telemetry builders (`attemptRecord`, `escalationRecord`). Nothing
 * launches an agent, so nothing costs anything.
 *
 * `runMissionSim(spec)` checks the invariants after every step and throws,
 * naming the spec (and, for a generated one, its seed). `generateSpec(seed)`
 * makes a random one, deterministically.
 */
import { attemptRecord, escalationRecord } from '../../src/orchestration/engine/attemptRecord';
import { schedule, type CapacitySnapshot, type SchedMission, type SchedulerAction, type SchedulerLimits, DEFAULT_SCHEDULER_LIMITS } from '../../src/orchestration/engine/scheduler';
import { decideEscalation, limitsFor, pendingEscalation, type AttemptHistoryItem, type EscalationLimits, type ProbeRequest } from '../../src/orchestration/policy/escalation';
import type { Classification } from '../../src/orchestration/policy/outcome';
import { DEFAULT_TIERS, tierRank } from '../../src/shared/orchestration/catalog';
import { SIM_BEHAVIOURS, type SimAttempt, type SimScenario } from '../../src/shared/orchestration/simulation';
import type { AttemptRecord, EscalationRecord } from '../../src/shared/orchestration/telemetry';
import {
  EFFORT_LEVELS,
  type DependencyKind,
  type EffortLevel,
  type EscalationDecision,
  type ExecutionAttempt,
  type ExecutionTarget,
  type HarnessId,
  type Mission,
  type OutcomeCategory,
  type RouteCaps,
  type RouteDimension,
  type RoutingDecision,
  type RoutingMode,
  type Task,
  type TaskState,
  type TierName,
} from '../../src/shared/orchestration/types';
import { attempt as attemptFixture, mission as missionFixture, task as taskFixture } from './fixtures';

const T0 = 1_800_000_000_000;
const REPO = '/Users/test/proj';
const STEP_MS = 1000;
const MAX_STEPS = 40_000;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export interface SimTaskSpec {
  id: string;
  dependsOn?: { task: string; kind: DependencyKind }[];
  harness?: HarnessId;
}

/** One mission: its graph, its policy, and what each attempt does. */
export interface MissionSimSpec {
  name: string;
  /** The seed it was generated from, for a generated one. */
  seed?: number;
  mode?: RoutingMode;
  tasks: SimTaskSpec[];
  scenario: SimScenario;
  sharedTree?: boolean;
  limits?: Partial<EscalationLimits>;
  caps?: RouteCaps;
  pinned?: RouteDimension[];
  autoRecover?: boolean;
  /** Tiers no harness has a model for (the probe says no). */
  unavailableTiers?: TierName[];
  /** The scheduler's own limits, over the defaults. */
  scheduler?: Partial<SchedulerLimits>;
  /** Cancel the mission this many seconds in. */
  cancelAtSec?: number;
  /** What the run must end as (named regression scenarios). */
  expect?: { tasks?: Record<string, TaskState>; attempts?: Record<string, number>; mission?: 'completed' | 'cancelled' | 'stuck' };
}

export interface MissionSimResult {
  steps: number;
  endedAt: number;
  tasks: Record<string, TaskState>;
  attempts: Record<string, number>;
  /** Every telemetry record written, in order. */
  records: (AttemptRecord | EscalationRecord)[];
  /** One line per event, for comparing two runs. */
  trace: string[];
  maxParallel: number;
}

const MODELS: Record<string, Partial<Record<TierName, string>>> = {
  'claude-code': { basic: 'haiku', standard: 'sonnet', expert: 'opus', frontier: 'fable' },
  codex: { basic: 'gpt-6-luna', standard: 'gpt-6-sol', expert: 'gpt-6-astra' },
};
const sourceOf = (h: HarnessId) => (h === 'codex' ? 'openai' : 'anthropic');
const targetFor = (harness: HarnessId, tier: TierName, effort: EffortLevel): ExecutionTarget => ({
  harness,
  source: sourceOf(harness),
  model: MODELS[harness][tier] ?? 'unknown',
  tier,
  effortNative: effort,
  location: 'hosted',
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** A small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** A random attempt: usually a failure of one of §26.3's behaviours, from a small pool of signatures so repeats happen. */
function randomAttempt(r: () => number): SimAttempt {
  const behaviour = pick(r, SIM_BEHAVIOURS.filter((b) => b !== 'edit' && b !== 'slow'));
  return {
    behaviour,
    signature: `sig-${Math.floor(r() * 3)}`,
    ...(behaviour === 'rate-limit' ? { retryAfterSec: pick(r, [10, 30, 120, 600]) } : {}),
    delayMs: 1000 * (3 + Math.floor(r() * 40)),
    turns: 1 + Math.floor(r() * 5),
    usage: { in: 1000 + Math.floor(r() * 20_000), out: 100 + Math.floor(r() * 2000) },
  };
}

/** A random mission, the same every time for one seed. */
export function generateSpec(seed: number): MissionSimSpec {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 8);
  const tasks: SimTaskSpec[] = [];
  for (let i = 0; i < n; i++) {
    const dependsOn = tasks.filter(() => r() < 0.35).map((t) => ({ task: t.id, kind: (r() < 0.8 ? 'code' : 'order') as DependencyKind }));
    tasks.push({ id: `t${i}`, dependsOn, harness: r() < 0.7 ? 'claude-code' : 'codex' });
  }
  const scenarioTasks: Record<string, SimAttempt[]> = {};
  for (const t of tasks) {
    // Three kinds of task: clean, a few failures then success, one that keeps failing the same way.
    const roll = r();
    if (roll < 0.6) continue;
    const length = 1 + Math.floor(r() * 4);
    const script = Array.from({ length }, () => randomAttempt(r));
    if (roll > 0.93) for (let i = 0; i < 6; i++) script.push({ ...script[script.length - 1] });
    scenarioTasks[t.id] = script;
  }
  const mode: RoutingMode = r() < 0.6 ? 'auto' : 'manual';
  const limits: Partial<EscalationLimits> = {};
  if (r() < 0.4) limits.qualityAttempts = 1 + Math.floor(r() * 4);
  if (r() < 0.3) limits.hardMaxAttempts = 2 + Math.floor(r() * 6);
  if (r() < 0.3) limits.tierSteps = Math.floor(r() * 3);
  if (r() < 0.3) limits.effortSteps = Math.floor(r() * 3);
  const caps: RouteCaps = {};
  if (r() < 0.3) caps.maxAttempts = 1 + Math.floor(r() * 6);
  if (r() < 0.3) caps.maxTier = pick(r, ['standard', 'expert'] as TierName[]);
  if (r() < 0.2) caps.maxEffort = pick(r, ['medium', 'high'] as EffortLevel[]);
  const pinned = (['tier', 'effort', 'harness', 'model'] as RouteDimension[]).filter(() => r() < 0.12);
  return {
    name: `generated-${seed}`,
    seed,
    mode,
    tasks,
    scenario: { tasks: scenarioTasks, default: { behaviour: 'edit', delayMs: 1000 * (3 + Math.floor(r() * 30)) } },
    sharedTree: r() < 0.3,
    limits,
    caps,
    pinned,
    autoRecover: r() < 0.4,
    unavailableTiers: r() < 0.2 ? [pick(r, ['expert', 'frontier'] as TierName[])] : [],
    scheduler: { global: 1 + Math.floor(r() * 3), perRepo: 1 + Math.floor(r() * 2) },
    ...(r() < 0.06 ? { cancelAtSec: 5 + Math.floor(r() * 120) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Behaviours → what the classifier would have said
// ---------------------------------------------------------------------------

type Outcome = { ok: true } | { ok: false; cls: Classification; backAt?: number };

/** What a scripted step ends as, given the attempts before it (a repeated signature is `quality-repeat`). */
function classify(step: SimAttempt, prev: AttemptHistoryItem | undefined, now: number): Outcome {
  const sig = (base: string) => `${base}:${step.signature ?? 'x'}`;
  const quality = (base: string): Outcome => {
    const signature = sig(base);
    const repeat = prev && prev.signature === signature && prev.status === 'failed';
    return { ok: false, cls: { category: repeat ? 'quality-repeat' : 'quality-new', signature, detail: `synthetic ${base}` } };
  };
  switch (step.behaviour) {
    case 'edit':
    case 'slow':
      return { ok: true };
    case 'fail':
      return quality('fail');
    case 'bad-structured-output':
      return quality('bad-output');
    case 'fail-verification':
      return quality('verify');
    case 'tool-failure':
      return { ok: false, cls: { category: 'infra', signature: sig('tool'), detail: 'a tool failed', retryable: true } };
    case 'rate-limit':
      return { ok: false, cls: { category: 'capacity', signature: 'rate-limit', detail: 'rate limited' }, backAt: now + 1000 * (step.retryAfterSec ?? 60) };
    case 'context-overflow':
      return { ok: false, cls: { category: 'context', signature: 'prompt_too_long', detail: 'context overflowed' } };
    case 'no-diff':
      return { ok: false, cls: { category: 'empty', signature: 'no-diff', detail: 'changed nothing' } };
    case 'timeout':
      return { ok: false, cls: { category: 'stuck', signature: 'wall-clock', detail: 'ran past its wall clock' } };
    case 'crash':
      return { ok: false, cls: { category: 'lost', signature: 'crash', detail: 'the agent process died' } };
    case 'question':
      return { ok: false, cls: { category: 'ambiguity', signature: 'question', detail: 'the agent asked a question' } };
    case 'permission':
      return { ok: false, cls: { category: 'policy', signature: 'permission', detail: 'a tool needed permission' } };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Live {
  attemptId: string;
  phase: 'agent' | 'verify-queued' | 'verifying';
  endsAt: number;
  outcome: Outcome;
  /** `fail-verification` ends at the checks, not at the agent. */
  failsAtVerify: boolean;
}

interface TaskRun {
  spec: SimTaskSpec;
  task: Task;
  route: { harness: HarnessId; tier: TierName; effort: EffortLevel };
  live?: Live;
  integrated: boolean;
  history: AttemptHistoryItem[];
}

export function runMissionSim(spec: MissionSimSpec): MissionSimResult {
  try {
    return run(spec);
  } catch (e) {
    const where = spec.seed !== undefined ? `seed ${spec.seed} (generateSpec(${spec.seed}))` : `scenario "${spec.name}"`;
    const err = e instanceof Error ? e : new Error(String(e));
    err.message = `${where}: ${err.message}`;
    throw err;
  }
}

function run(spec: MissionSimSpec): MissionSimResult {
  const r = rng((spec.seed ?? 1) ^ 0x9e3779b9);
  const mode = spec.mode ?? 'auto';
  const limits = limitsFor(mode, spec.limits);
  const caps = spec.caps ?? {};
  const pinned = spec.pinned ?? [];
  const schedLimits: SchedulerLimits = { ...DEFAULT_SCHEDULER_LIMITS, ...spec.scheduler };
  const unavailable = new Set(spec.unavailableTiers ?? []);
  const sharedTree = spec.sharedTree ?? false;

  const mission: Mission = missionFixture({
    id: `m-${spec.name}`,
    state: 'running',
    planApprovedAt: T0,
    tasks: [],
    policy: { mode, caps, frontierAllowed: true, autoRecover: spec.autoRecover ?? false },
  });
  const runs: TaskRun[] = spec.tasks.map((s) => {
    const t = taskFixture(s.id, {
      state: 'pending',
      dependsOn: (s.dependsOn ?? []).map((d) => ({ taskId: d.task, kind: d.kind })),
    });
    mission.tasks.push(t);
    return { spec: s, task: t, route: { harness: s.harness ?? 'claude-code', tier: 'standard', effort: 'medium' }, integrated: false, history: [] };
  });
  const byId = new Map(runs.map((x) => [x.task.id, x]));

  const records: (AttemptRecord | EscalationRecord)[] = [];
  const trace: string[] = [];
  const recordedAttempts = new Set<string>();
  const recordedDecisions = new Set<string>();
  const resumes = new Set<string>();
  const log = (now: number, line: string) => trace.push(`${Math.round((now - T0) / 1000)}s ${line}`);
  let seq = 0;
  let now = T0;
  let backoffUntil: Record<string, number> = {};
  let cancelled = false;
  let maxParallel = 0;
  let step = 0;

  const probe = (req: ProbeRequest) => {
    if (unavailable.has(req.tier)) return { ok: false as const, reason: `nothing at ${req.tier}` };
    const harness = Object.keys(MODELS).find((h) => (req.harness ? h === req.harness : true) && h !== req.notHarness && MODELS[h][req.tier]);
    if (!harness) return { ok: false as const, reason: `no harness has ${req.tier}` };
    if (req.largerContextThan !== undefined) return { ok: false as const, reason: 'no larger window' };
    return { ok: true as const, target: targetFor(harness as HarnessId, req.tier, 'medium') };
  };

  const scriptFor = (x: TaskRun, n: number): SimAttempt => spec.scenario.tasks?.[x.task.id]?.[n - 1] ?? spec.scenario.default ?? { behaviour: 'edit' };
  const attemptsOf = (x: TaskRun) => mission.attempts.filter((a) => a.taskId === x.task.id);

  // -- Telemetry: written when an attempt ends, and for each decision --
  const writeAttempt = (a: ExecutionAttempt) => {
    const rec = attemptRecord(mission, a, now);
    if (!rec) throw new Error(`no attempt record for ended attempt ${a.id}`);
    records.push(rec);
    recordedAttempts.add(a.id);
  };
  const writeDecision = (d: EscalationDecision) => {
    records.push(escalationRecord(mission, d, now));
    recordedDecisions.add(d.id);
  };

  const startAttempt = (x: TaskRun, retry?: EscalationDecision) => {
    const n = attemptsOf(x).length + 1;
    // The route this attempt runs on: the decision's delta applied to the last one.
    if (retry?.delta?.tier) x.route.tier = retry.delta.tier;
    if (retry?.delta?.effort) x.route.effort = retry.delta.effort;
    if (retry?.delta?.harness) x.route.harness = retry.delta.harness;
    if (retry?.target) x.route = { harness: retry.target.harness, tier: retry.target.tier, effort: retry.delta?.effort ?? x.route.effort };
    const id = `${x.task.id}-a${n}`;
    const decision: RoutingDecision = {
      id: `rd-${id}`,
      taskId: x.task.id,
      attemptN: n,
      mode,
      policyVersion: 'sim',
      requirement: { minTier: x.route.tier, maxTier: x.route.tier, effort: x.route.effort, needs: [], gates: [] },
      reasons: [],
      overrides: [],
      resolution: { target: targetFor(x.route.harness, x.route.tier, x.route.effort), candidates: [], catalogVersion: 'sim' },
      decidedBy: 'router',
      decidedAt: now,
    };
    mission.decisions.push(decision);
    // An auto-resume of a lost attempt is a continuation, not another try (§23.3).
    const resume = retry?.evidence.category === 'lost' && retry.action === 'retry-same';
    if (resume) resumes.add(id);
    const a: ExecutionAttempt = attemptFixture(id, x.task.id, {
      n,
      ...(resume ? { resumeOf: `${x.task.id}-a${n - 1}`, autoResumed: true } : {}),
      routingDecisionId: decision.id,
      state: 'running',
      createdAt: now,
      launchedAt: now,
      assignment: { mode: retry?.mode === 'continue' ? 'continue' : 'fresh', sessionIds: [`s-${id}`], harness: x.route.harness },
      timing: { queuedAt: retry?.notBefore !== undefined ? retry.notBefore : (x.task.escalations.at(-1)?.decidedAt ?? now) },
      ...(retry ? { escalation: { decisionId: retry.id, action: retry.action, step: retry.step ?? 0 } } : {}),
    });
    mission.attempts.push(a);
    x.task.attemptIds.push(id);
    x.task.state = 'running';
    const script = scriptFor(x, n);
    const prev = x.history.at(-1);
    const outcome = classify(script, prev, now);
    const failsAtVerify = script.behaviour === 'fail-verification';
    x.live = { attemptId: id, phase: 'agent', endsAt: now + (script.delayMs ?? 5000), outcome, failsAtVerify };
    log(now, `start ${id} ${x.route.harness}/${x.route.tier}/${x.route.effort} ${script.behaviour}`);
  };

  const endAttempt = (x: TaskRun, status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', cls?: Classification) => {
    const live = x.live!;
    const a = mission.attempts.find((y) => y.id === live.attemptId)!;
    a.endedAt = now;
    a.state = status;
    a.outcome = { status, ...(cls ? { category: cls.category, signature: cls.signature } : {}) };
    const turns = 1 + (a.n % 3);
    a.usage = { turns, costBasis: 'harness-estimate', costUsd: 0.01 * turns, inputTokens: 1000 * turns, outputTokens: 100 * turns, byModel: { [MODELS[x.route.harness][x.route.tier] ?? 'm']: { in: 1000 * turns, out: 100 * turns, costUsd: 0.01 * turns } } };
    x.live = undefined;
    x.history.push({ id: a.id, n: a.n, status, category: cls?.category, signature: cls?.signature, ...(resumes.has(a.id) ? { resume: true, autoResumed: true } : {}) });
    writeAttempt(a);
    log(now, `end ${a.id} ${status}${cls ? ` ${cls.category}` : ''}`);
  };

  const failAttempt = (x: TaskRun, out: Extract<Outcome, { ok: false }>) => {
    endAttempt(x, out.cls.category === 'lost' ? 'interrupted' : 'failed', out.cls);
    const failed = x.history.at(-1)!;
    if (out.backAt !== undefined) backoffUntil[sourceOf(x.route.harness)] = out.backAt;
    const input = {
      taskId: x.task.id,
      afterAttemptId: failed.id,
      classification: out.cls,
      history: x.history,
      decisions: x.task.escalations,
      route: { harness: x.route.harness, model: MODELS[x.route.harness][x.route.tier] ?? '', tier: x.route.tier, effort: x.route.effort, contextWindow: 200_000 },
      mode,
      pinned,
      caps,
      frontierAllowed: true,
      autoRecover: spec.autoRecover ?? false,
      lost: { resumable: true, autoResumable: true },
      tiers: DEFAULT_TIERS,
      sessionContinuable: true,
      effortMidSession: true,
      ...(out.backAt !== undefined ? { capacityBackAt: out.backAt } : {}),
      limits,
      probe,
      now,
      newId: () => `d${++seq}`,
      spentUsd: x.history.length * 0.01,
    };
    const priorDecisions = x.task.escalations.length;
    const before = { history: [...x.history], decisions: [...x.task.escalations] };
    const outcome = decideEscalation(input);
    for (const d of outcome.decisions) {
      x.task.escalations.push(d);
      writeDecision(d);
    }
    checkEscalation(spec, x.task.id, outcome.decisions, outcome.final, before, input.route, limits, caps, pinned, priorDecisions);
    const d = outcome.final;
    log(now, `escalate ${failed.id} -> ${d.action}${d.blockedBy ? ` (${d.blockedBy})` : ''}`);
    if (d.blockedBy || !['retry-same', 'continue-with-feedback', 'raise-effort', 'raise-tier', 'switch-harness', 'switch-model', 'wait'].includes(d.action)) {
      x.task.state = d.action === 'needs-human' ? 'needs-human' : 'failed';
    } else {
      x.task.state = d.action === 'wait' ? 'blocked' : 'queued';
    }
  };

  const snapshot = (): { missions: SchedMission[] } => ({
    missions: [
      {
        id: mission.id,
        repo: REPO,
        state: mission.state,
        priority: 0,
        createdAt: T0,
        planned: true,
        sharedTree,
        tasks: runs.map((x) => {
          const pending = pendingEscalation(x.task);
          return {
            id: x.task.id,
            key: x.task.key,
            state: x.task.state,
            dependsOn: x.task.dependsOn,
            integrated: x.integrated,
            harness: x.route.harness,
            source: sourceOf(x.route.harness),
            attempts: x.task.attemptIds.length,
            ...(x.live ? { live: { id: x.live.attemptId, phase: x.live.phase } } : {}),
            ...(pending ? { retry: { decisionId: pending.id, ...(pending.notBefore !== undefined ? { notBefore: pending.notBefore } : {}) } } : {}),
          };
        }),
      },
    ],
  });

  for (; step < MAX_STEPS; step++) {
    // The world moves: attempts end, verifications end.
    for (const x of runs) {
      const live = x.live;
      if (!live || live.endsAt > now) continue;
      if (live.phase === 'agent') {
        if (!live.outcome.ok && !live.failsAtVerify) {
          failAttempt(x, live.outcome);
        } else {
          live.phase = 'verify-queued';
          x.task.state = 'verifying';
        }
      } else if (live.phase === 'verifying') {
        if (!live.outcome.ok) failAttempt(x, live.outcome);
        else {
          endAttempt(x, 'succeeded');
          x.task.state = 'done';
          x.task.result = { summary: 'sim', acceptedAt: now } as unknown as Task['result'];
          x.integrated = sharedTree;
          log(now, `done ${x.task.id}`);
        }
      }
    }
    if (spec.cancelAtSec !== undefined && !cancelled && now - T0 >= spec.cancelAtSec * 1000) {
      cancelled = true;
      mission.state = 'cancelled';
      log(now, 'cancel mission');
    }

    const capacity: CapacitySnapshot = {
      limits: schedLimits,
      fleetPaused: false,
      sources: Object.fromEntries(Object.entries(backoffUntil).filter(([, until]) => until > now).map(([s, until]) => [s, { backoffUntil: until }])),
    };
    const snap = snapshot();
    const actions = schedule(snap, capacity, now);
    checkActions(spec, mission, runs, snap.missions[0], actions, capacity, now);

    let acted = false;
    for (const a of actions) {
      if (a.kind === 'wait' || a.kind === 'wake') continue;
      const x = 'taskId' in a ? byId.get(a.taskId) : undefined;
      if (a.kind === 'start' && x) {
        acted = true;
        const decision = a.retryOf ? x.task.escalations.find((d) => d.id === a.retryOf) : undefined;
        startAttempt(x, decision);
      } else if (a.kind === 'verify' && x?.live) {
        acted = true;
        x.live.phase = 'verifying';
        x.live.endsAt = now + 1000 * (1 + Math.floor(r() * 8));
        // A verification that fails: the outcome was decided at the start of the attempt.
        if (!x.live.failsAtVerify) x.live.outcome = { ok: true };
      } else if (a.kind === 'integrate' && x) {
        acted = true;
        x.integrated = true;
      } else if (a.kind === 'cancel' && x?.live) {
        acted = true;
        endAttempt(x, 'cancelled');
        x.task.state = 'cancelled';
      } else if (a.kind === 'block' && x) {
        acted = true;
        x.task.state = 'blocked';
      } else if (a.kind === 'unblock' && x) {
        acted = true;
        x.task.state = 'pending';
      } else if (a.kind === 'finish') {
        acted = true;
        mission.state = 'completed';
        log(now, 'finish');
      }
    }
    if (cancelled) for (const x of runs) if (!x.live && !['done', 'failed', 'cancelled', 'skipped'].includes(x.task.state)) x.task.state = 'cancelled';

    const parallel = runs.filter((x) => x.live?.phase === 'agent').length;
    maxParallel = Math.max(maxParallel, parallel);
    checkAfter(spec, mission, runs, schedLimits, sharedTree, parallel);

    // A timed wait (a backoff) is not rest: the scheduler says when it ends.
    const timers = runs.some((x) => x.live || pendingEscalation(x.task)) || actions.some((a) => a.kind === 'wake');
    if (!acted && !timers && mission.state !== 'running') break;
    if (!acted && !timers && quiescent(runs)) break;
    now += STEP_MS;
  }
  if (step >= MAX_STEPS) {
    const states = runs.map((x) => `${x.task.id}=${x.task.state}${x.live ? `/${x.live.phase}` : ''}`).join(' ');
    throw new Error(`did not settle in ${MAX_STEPS} steps (${states}); last events: ${trace.slice(-4).join(' | ')}`);
  }

  try {
    checkFinal(spec, mission, runs, records, recordedAttempts, recordedDecisions, limits, caps);
  } catch (e) {
    const states = runs.map((x) => `${x.task.id}=${x.task.state}`).join(' ');
    if (e instanceof Error) e.message += ` [mission ${mission.state}; ${states}; last events: ${trace.slice(-6).join(' | ')}]`;
    throw e;
  }
  const result: MissionSimResult = {
    steps: step,
    endedAt: now,
    tasks: Object.fromEntries(runs.map((x) => [x.task.id, x.task.state])),
    attempts: Object.fromEntries(runs.map((x) => [x.task.id, x.task.attemptIds.length])),
    records,
    trace,
    maxParallel,
  };
  checkExpect(spec, mission, result);
  return result;
}

/**
 * Nothing is running or queued, and every task is at rest: done, failed,
 * cancelled, skipped, blocked behind one that failed, waiting on a person
 * (`needs-human`), or pending behind a task that is.
 */
function quiescent(runs: TaskRun[]): boolean {
  return runs.every((x) => !x.live && REST.includes(x.task.state));
}
const REST: TaskState[] = ['done', 'failed', 'cancelled', 'skipped', 'blocked', 'needs-human', 'pending'];

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const STARTING = ['retry-same', 'continue-with-feedback', 'raise-effort', 'raise-tier', 'switch-harness', 'switch-model', 'wait'];
const QUALITY_EXEMPT: (OutcomeCategory | undefined)[] = ['infra', 'capacity', 'lost'];

/** Per escalation: it counted what it should, and passed no cap, limit or pin. */
function checkEscalation(
  spec: MissionSimSpec,
  taskId: string,
  decisions: EscalationDecision[],
  final: EscalationDecision,
  before: { history: AttemptHistoryItem[]; decisions: EscalationDecision[] },
  route: { tier: TierName; effort: EffortLevel; harness: HarnessId },
  limits: EscalationLimits,
  caps: RouteCaps,
  pinned: RouteDimension[],
  _prior: number,
): void {
  assert(final === decisions[decisions.length - 1], `${taskId}: the step taken is not the last decision`);
  for (const d of decisions.slice(0, -1)) assert(d.blockedBy, `${taskId}: a step before the last was neither taken nor blocked (${d.action})`);
  assert(!final.blockedBy, `${taskId}: the final step is blocked`);
  const history = [...before.history];
  const tries = history.filter((h) => !h.resume).length;
  const quality = history.filter((h) => !h.resume && !QUALITY_EXEMPT.includes(h.category)).length;
  if (!STARTING.includes(final.action)) return;
  // The one auto-resume of a lost attempt continues it; it is not another try, so no attempt cap applies (§23.3).
  if (final.evidence.category === 'lost') return;
  // A step that starts another attempt: the attempt's caps held when it was decided.
  assert(tries < limits.hardMaxAttempts, `${taskId}: ${final.action} after ${tries} attempts passes hardMaxAttempts ${limits.hardMaxAttempts}`);
  if (caps.maxAttempts !== undefined) assert(tries < caps.maxAttempts, `${taskId}: ${final.action} after ${tries} attempts passes the cap of ${caps.maxAttempts}`);
  const failed = decisions[0].evidence.category;
  const counts = !QUALITY_EXEMPT.includes(failed) && failed !== 'capacity';
  if (counts && ['continue-with-feedback', 'raise-effort', 'raise-tier', 'switch-harness', 'switch-model'].includes(final.action)) {
    assert(quality < limits.qualityAttempts, `${taskId}: ${final.action} after ${quality} quality attempts, limit ${limits.qualityAttempts}`);
  }
  const taken = (action: string) => before.decisions.filter((d) => d.action === action && !d.blockedBy).length;
  if (final.action === 'raise-tier') {
    assert(!pinned.includes('tier'), `${taskId}: raised the tier of a pinned task`);
    assert(taken('raise-tier') + 1 <= limits.tierSteps, `${taskId}: tier steps pass the limit ${limits.tierSteps}`);
    if (caps.maxTier) assert(tierRank(DEFAULT_TIERS, final.delta!.tier!) <= tierRank(DEFAULT_TIERS, caps.maxTier), `${taskId}: raised to ${final.delta!.tier}, past the cap ${caps.maxTier}`);
  }
  if (final.action === 'raise-effort') {
    assert(!pinned.includes('effort'), `${taskId}: raised the effort of a pinned task`);
    assert(taken('raise-effort') + 1 <= limits.effortSteps, `${taskId}: effort steps pass the limit ${limits.effortSteps}`);
    if (caps.maxEffort) assert(EFFORT_LEVELS.indexOf(final.delta!.effort!) <= EFFORT_LEVELS.indexOf(caps.maxEffort), `${taskId}: raised effort past the cap ${caps.maxEffort}`);
  }
  if (final.action === 'switch-harness') {
    assert(!pinned.includes('harness') && !pinned.includes('model'), `${taskId}: switched the harness of a pinned task`);
    assert(taken('switch-harness') + 1 <= limits.harnessSwitches, `${taskId}: harness switches pass the limit ${limits.harnessSwitches}`);
  }
  void spec;
  void route;
}

/** Per step: what the scheduler said, against the state it saw. */
function checkActions(spec: MissionSimSpec, mission: Mission, runs: TaskRun[], snap: SchedMission, actions: SchedulerAction[], capacity: CapacitySnapshot, now: number): void {
  const byId = new Map(runs.map((x) => [x.task.id, x]));
  const starts = actions.filter((a): a is Extract<SchedulerAction, { kind: 'start' }> => a.kind === 'start');
  for (const s of starts) {
    const x = byId.get(s.taskId)!;
    assert(mission.state === 'running', `${s.taskId} started in a ${mission.state} mission`);
    assert(!x.live, `${s.taskId} started with an attempt already live`);
    for (const d of x.task.dependsOn) {
      const up = byId.get(d.taskId)!;
      assert(up.task.state === 'done', `${s.taskId} started before ${d.taskId} was done (${up.task.state})`);
      if (d.kind === 'code') assert(up.integrated, `${s.taskId} started before ${d.taskId} was integrated`);
    }
    const until = capacity.sources[sourceOf(x.route.harness)]?.backoffUntil;
    assert(until === undefined || until <= now, `${s.taskId} started on a rate-limited source`);
    const pending = pendingEscalation(x.task);
    if (pending?.notBefore !== undefined) assert(pending.notBefore <= now, `${s.taskId} retried ${pending.notBefore - now}ms before its backoff ended`);
    if (x.task.attemptIds.length > 0) assert(!!s.retryOf, `${s.taskId} started again with no escalation step behind it`);
  }
  assert(new Set(starts.map((s) => s.taskId)).size === starts.length, 'a task was started twice in one step');
  void spec;
  void snap;
}

/** After applying a step. */
function checkAfter(spec: MissionSimSpec, mission: Mission, runs: TaskRun[], limits: SchedulerLimits, sharedTree: boolean, parallel: number): void {
  assert(parallel <= limits.global, `${parallel} agents at once, limit ${limits.global}`);
  assert(parallel <= limits.perRepo, `${parallel} agents in one repository, limit ${limits.perRepo}`);
  const verifying = runs.filter((x) => x.live?.phase === 'verifying').length;
  assert(verifying <= limits.verificationPerRepo, `${verifying} verifications at once`);
  if (sharedTree) assert(runs.filter((x) => x.live).length <= 1, 'two tasks of a shared-tree mission at once');
  for (const x of runs) {
    const active = mission.attempts.filter((a) => a.taskId === x.task.id && !a.endedAt);
    assert(active.length <= 1, `${x.task.id} has ${active.length} active attempts`);
    const tries = mission.attempts.filter((a) => a.taskId === x.task.id && !a.autoResumed).length;
    assert(tries <= limitsHard(spec), `${x.task.id} has ${tries} attempts, the most it may have is ${limitsHard(spec)}`);
  }
}

const limitsHard = (spec: MissionSimSpec): number => Math.min(limitsFor(spec.mode ?? 'auto', spec.limits).hardMaxAttempts, spec.caps?.maxAttempts ?? Infinity);

/** At the end: every escalation has an event, the telemetry is complete, and nothing was left half-done. */
function checkFinal(
  spec: MissionSimSpec,
  mission: Mission,
  runs: TaskRun[],
  records: (AttemptRecord | EscalationRecord)[],
  recordedAttempts: Set<string>,
  recordedDecisions: Set<string>,
  limits: EscalationLimits,
  caps: RouteCaps,
): void {
  void limits;
  void caps;
  const ids = records.map((r) => r.id);
  assert(new Set(ids).size === ids.length, 'a telemetry record id was written twice');
  const attemptRecs = new Map(records.filter((r): r is AttemptRecord => r.type === 'attempt').map((r) => [r.attemptId, r]));
  const escalationRecs = records.filter((r): r is EscalationRecord => r.type === 'escalation');
  for (const a of mission.attempts) {
    assert(a.endedAt !== undefined && a.outcome, `${a.id} never ended`);
    assert(recordedAttempts.has(a.id), `${a.id} has no attempt record`);
    const rec = attemptRecs.get(a.id)!;
    assert(rec.missionId === mission.id && rec.taskId === a.taskId && rec.n === a.n, `${a.id}: record names the wrong mission, task or number`);
    assert(rec.outcome === a.outcome.status, `${a.id}: record outcome ${rec.outcome} differs from ${a.outcome.status}`);
    assert(rec.startedAt !== undefined && rec.endedAt !== undefined && rec.endedAt >= rec.startedAt, `${a.id}: record has no sane start and end`);
    assert(rec.queuedAt === undefined || rec.startedAt === undefined || rec.queuedAt <= rec.startedAt + 1, `${a.id}: queued after it started`);
    assert(rec.activeMs !== undefined && rec.activeMs >= 0, `${a.id}: no active time`);
    assert(!!rec.target.model && !!rec.target.harness && !!rec.target.tier, `${a.id}: record has no target`);
    assert(rec.turns > 0 && Object.keys(rec.usage).length > 0, `${a.id}: record has no usage`);
    assert(rec.cost.basis !== undefined, `${a.id}: record has no cost basis`);
    if (a.outcome.status === 'failed' || a.outcome.status === 'interrupted') assert(rec.category === a.outcome.category && !!rec.signature, `${a.id}: failed record without category and signature`);
    if (a.escalation) {
      assert(rec.escalationStep === a.escalation.step && rec.escalationAction === a.escalation.action, `${a.id}: record lost its escalation step`);
      const d = mission.tasks.flatMap((t) => t.escalations).find((e) => e.id === a.escalation!.decisionId);
      assert(d && d.afterAttemptId === `${a.taskId}-a${a.n - 1}`, `${a.id}: started by a decision that did not follow the attempt before it`);
    } else assert(a.n === 1, `${a.id}: attempt ${a.n} has no escalation step behind it`);
  }
  // Every failed attempt has its escalation: skipped steps, then exactly one taken.
  for (const t of mission.tasks) {
    for (const a of mission.attempts.filter((x) => x.taskId === t.id && (x.outcome?.status === 'failed' || x.outcome?.status === 'interrupted'))) {
      const ds = t.escalations.filter((d) => d.afterAttemptId === a.id);
      assert(ds.length > 0, `${a.id} failed with no escalation decision`);
      assert(ds.filter((d) => !d.blockedBy).length === 1, `${a.id}: ${ds.filter((d) => !d.blockedBy).length} steps taken`);
    }
    for (const d of t.escalations) assert(recordedDecisions.has(d.id), `decision ${d.id} has no escalation record`);
  }
  assert(escalationRecs.length === mission.tasks.reduce((n, t) => n + t.escalations.length, 0), 'escalation records and decisions differ in number');
  for (const e of escalationRecs) assert(e.afterAttemptN >= 1 && !!e.action && !!e.category, `${e.id}: incomplete escalation record`);

  // Nothing is left half-done.
  for (const x of runs) {
    assert(!x.live, `${x.task.id} still has a live attempt`);
    const st = x.task.state;
    if (mission.state === 'cancelled') assert(['done', 'failed', 'cancelled', 'skipped'].includes(st), `${x.task.id} is ${st} in a cancelled mission`);
    else assert(REST.includes(st), `${x.task.id} ended ${st}`);
    if (st === 'blocked' && mission.state !== 'cancelled') {
      const broken = x.task.dependsOn.some((d) => ['failed', 'cancelled', 'skipped'].includes(runs.find((y) => y.task.id === d.taskId)!.task.state));
      assert(broken, `${x.task.id} is blocked and no upstream failed`);
    }
    // Liveness: a task left pending is waiting on an upstream that has not finished, or (one shared worktree) on a
    // task that was tried and is waiting for a person. Never on nothing.
    if (st === 'pending' && mission.state !== 'cancelled') {
      const waiting = x.task.dependsOn.some((d) => runs.find((y) => y.task.id === d.taskId)!.task.state !== 'done');
      const holder = spec.sharedTree && runs.some((y) => y !== x && y.task.attemptIds.length > 0 && !['done', 'failed', 'cancelled', 'skipped'].includes(y.task.state));
      assert(waiting || holder, `${x.task.id} was left pending with every dependency done`);
    }
    if (st === 'done') assert(x.integrated || !spec.sharedTree, `${x.task.id} is done but never integrated`);
  }
  const allDone = runs.every((x) => x.task.state === 'done');
  if (allDone && mission.state !== 'cancelled') assert(mission.state === 'completed', `every task is done but the mission is ${mission.state}`);
  if (!allDone && mission.state !== 'cancelled') assert(mission.state === 'running', `the mission is ${mission.state} with unfinished tasks`);
}

function checkExpect(spec: MissionSimSpec, mission: Mission, result: MissionSimResult): void {
  const e = spec.expect;
  if (!e) return;
  for (const [id, state] of Object.entries(e.tasks ?? {})) assert(result.tasks[id] === state, `${id} ended ${result.tasks[id]}, expected ${state}`);
  for (const [id, n] of Object.entries(e.attempts ?? {})) assert(result.attempts[id] === n, `${id} had ${result.attempts[id]} attempts, expected ${n}`);
  if (e.mission === 'completed') assert(mission.state === 'completed', `the mission ended ${mission.state}`);
  if (e.mission === 'cancelled') assert(mission.state === 'cancelled', `the mission ended ${mission.state}`);
  if (e.mission === 'stuck') assert(mission.state === 'running', `the mission ended ${mission.state}`);
}
