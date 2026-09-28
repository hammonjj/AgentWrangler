/**
 * The mission scheduler (`docs/plans/intelligent-orchestration.md` §12.2–12.4,
 * §29 P9; #45): a pure step function from the state of every mission, the
 * machine's capacity and the clock to the actions the engine should take.
 *
 * Pure and deterministic: the same snapshot gives the same actions in the same
 * order, and nothing here reads a clock, a file or a service. The task runner
 * builds the snapshot from its missions (`missionsSnapshot`), calls `schedule`
 * on every event that could change the answer, and carries the actions out —
 * starting attempts only through its own launch path, which is the resolver
 * and the `AgentHarness`.
 *
 * What it decides (§12.3):
 *
 * - **Readiness.** A task may start when every `code` upstream is done and
 *   integrated, and every `order` upstream is done.
 * - **Failed and invalid upstreams** block the task (`block`); it comes back
 *   (`unblock`) when they are recovered.
 * - **Cancellation.** A live attempt of a cancelled mission, or of a task that
 *   was cancelled or skipped, is ended (`cancel`); its worktree is kept.
 * - **Retries.** A task's pending escalation step (#41) is a start like any
 *   other, through the same admission, once its `notBefore` has passed.
 * - **Pause.** Nothing starts while the fleet is paused, nor in a mission that
 *   is not `running`. Running attempts carry on (pausing their sessions is the
 *   engine's "Pause now", through `PauseService`).
 * - **Priority.** Longest remaining downstream path first (the critical path),
 *   then mission priority, then mission age, then plan order.
 * - **Concurrency.** Global, per repository, per harness, per source and per
 *   local endpoint (its free slots); verification has its own limit per
 *   repository. A mission on one shared worktree runs one task at a time.
 * - **Capacity waits and backoff.** A full source, a rate-limit backoff or a
 *   usage window at the admission threshold (85% by default, below the 98%
 *   auto-pause) is a `wait`, never a failure. `wake` says when the next timed
 *   wait ends.
 */
import type { DependencyKind, HarnessId, Millis, MissionState, ModelSourceId, TaskState } from '../../shared/orchestration/types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The machine-wide limits (§12.3). Absent per-harness / per-source entries mean no limit of their own. */
export interface SchedulerLimits {
  /** Orchestrated agents running at once, across every mission. */
  global: number;
  /** Agents running at once in one repository. */
  perRepo: number;
  perHarness: Partial<Record<HarnessId, number>>;
  perSource: Partial<Record<ModelSourceId, number>>;
  /** Verifications running at once in one repository (test suites contend for CPU, ports and caches). */
  verificationPerRepo: number;
  /** No new attempt on a source whose fullest usage window is at or above this, in percent (§12.4). */
  admissionPercent: number;
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  global: 3,
  perRepo: 2,
  perHarness: {},
  perSource: {},
  verificationPerRepo: 1,
  admissionPercent: 85,
};

/** What is known about one model source now. Anything absent is unknown, and unknown does not block. */
export interface SourceFacts {
  /** The fullest usage window, in percent. */
  windowPercent?: number;
  /** A rate limit: nothing new on this source before then. */
  backoffUntil?: Millis;
  /** A local endpoint's free slots, as read (attempts already running on it hold theirs). */
  freeSlots?: number;
}

export interface CapacitySnapshot {
  limits: SchedulerLimits;
  sources: Partial<Record<ModelSourceId, SourceFacts>>;
  /** `PauseService` says the fleet is paused. */
  fleetPaused: boolean;
}

/**
 * A task's live attempt, as far as capacity goes. `agent`: its session holds
 * an agent slot. `verify-queued`: the agent is finished and its checks wait
 * for a verification slot. `verifying`: its checks are running.
 */
export interface SchedAttempt {
  id: string;
  phase: 'agent' | 'verify-queued' | 'verifying';
}

export interface SchedTask {
  id: string;
  key: string;
  state: TaskState;
  dependsOn: { taskId: string; kind: DependencyKind }[];
  /** A done task whose result is on the mission branch. */
  integrated: boolean;
  /** An integrated upstream was rejected or reverted (§12.3): downstream waits for the user. */
  invalidated?: boolean;
  /** Where its next attempt would run: its route's harness and source. */
  harness: HarnessId;
  source: ModelSourceId;
  /** Attempts it has had. */
  attempts: number;
  live?: SchedAttempt;
  /** A pending escalation step (#41): the next attempt is its. */
  retry?: { decisionId: string; notBefore?: Millis };
}

export interface SchedMission {
  id: string;
  repo: string;
  state: MissionState;
  /** Higher runs first, after the critical path. */
  priority: number;
  createdAt: Millis;
  /** A plan of tasks (#43), rather than a single task. */
  planned: boolean;
  /** Its tasks run in one worktree, so one at a time; a done task is integrated. */
  sharedTree: boolean;
  /** Mission cap (§12.4): stop starting work when a usage window reaches this. */
  maxWindowPercent?: number;
  /** Mission cap (§10.2): orchestrated agents running at once, across every mission. */
  maxConcurrentAgents?: number;
  /** In plan order. */
  tasks: SchedTask[];
}

export interface MissionsSnapshot {
  missions: SchedMission[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type WaitReason =
  | 'fleet-paused'
  | 'mission-paused'
  | 'shared-tree'
  | 'retry-delay'
  | 'backoff'
  | 'usage'
  | 'concurrency'
  | 'endpoint-slots'
  | 'verification';

export type SchedulerAction =
  | { kind: 'start'; missionId: string; taskId: string; retryOf?: string }
  | { kind: 'verify'; missionId: string; taskId: string; attemptId: string }
  | { kind: 'wait'; missionId: string; taskId: string; reason: WaitReason; detail: string; until?: Millis }
  | { kind: 'block'; missionId: string; taskId: string; upstream: string[]; detail: string }
  | { kind: 'unblock'; missionId: string; taskId: string }
  | { kind: 'cancel'; missionId: string; taskId: string; attemptId: string }
  | { kind: 'integrate'; missionId: string; taskId: string }
  | { kind: 'finish'; missionId: string }
  | { kind: 'wake'; at: Millis };

// ---------------------------------------------------------------------------
// The step function
// ---------------------------------------------------------------------------

const ENDED: readonly TaskState[] = ['done', 'failed', 'cancelled', 'skipped'];
const FAILED_UPSTREAM: readonly TaskState[] = ['failed', 'cancelled', 'skipped'];
/** A first attempt may start from these. */
const STARTABLE: readonly TaskState[] = ['pending', 'ready', 'queued'];
const ACTIVE_MISSION: readonly MissionState[] = ['running', 'paused'];

/** The upstreams that stop a task for good until something changes: failed, cancelled, skipped or invalidated. */
function brokenUpstreams(m: SchedMission, t: SchedTask): SchedTask[] {
  return t.dependsOn
    .map((d) => m.tasks.find((u) => u.id === d.taskId))
    .filter((u): u is SchedTask => !!u && (FAILED_UPSTREAM.includes(u.state) || (u.state === 'done' && !!u.invalidated)));
}

/** Every dependency lets the task start (§12.3): `code` done and integrated, `order` done. */
export function dependenciesMet(m: SchedMission, t: SchedTask): boolean {
  return t.dependsOn.every((d) => {
    const u = m.tasks.find((x) => x.id === d.taskId);
    if (!u || u.state !== 'done' || u.invalidated) return false;
    return d.kind === 'order' || u.integrated;
  });
}

/**
 * The longest path of unfinished tasks from each task to the end of the
 * graph, counting the task itself (§12.3's priority). Done and skipped tasks
 * count 0. The graph is acyclic (plan validation); a cycle counts once.
 */
export function criticalPaths(m: SchedMission): Map<string, number> {
  const down = new Map<string, string[]>();
  for (const t of m.tasks) for (const d of t.dependsOn) down.set(d.taskId, [...(down.get(d.taskId) ?? []), t.id]);
  const memo = new Map<string, number>();
  const byId = new Map(m.tasks.map((t) => [t.id, t]));
  const visit = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = byId.get(id);
    const own = t && (t.state === 'done' || t.state === 'skipped') ? 0 : 1;
    const tail = Math.max(0, ...(down.get(id) ?? []).map((c) => visit(c, seen)));
    seen.delete(id);
    memo.set(id, own + tail);
    return own + tail;
  };
  for (const t of m.tasks) visit(t.id, new Set());
  return memo;
}

interface Candidate {
  m: SchedMission;
  t: SchedTask;
  path: number;
  order: number;
  retryOf?: string;
  notBefore?: Millis;
  /** In a shared tree: the task whose work is in it now, if another. */
  heldBy?: string;
}

/**
 * The task whose work a shared tree holds: one running, or one tried and not
 * yet finished (waiting on the user, or on its retry). Nothing else starts
 * on top of it.
 */
function treeHolder(m: SchedMission): SchedTask | undefined {
  if (!m.sharedTree) return undefined;
  return m.tasks.find((t) => t.live) ?? m.tasks.find((t) => t.attempts > 0 && !ENDED.includes(t.state));
}

/** Critical path, then mission priority, then mission age, then plan order; ids break any tie. */
function byPriority(a: Candidate, b: Candidate): number {
  return (
    b.path - a.path ||
    b.m.priority - a.m.priority ||
    a.m.createdAt - b.m.createdAt ||
    a.order - b.order ||
    (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0)
  );
}

class Counter {
  private readonly counts = new Map<string, number>();
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  add(key: string): void {
    this.counts.set(key, this.get(key) + 1);
  }
}

/**
 * One scheduling step (§12.2): what to do now, given every mission, the
 * capacity and the clock. Starts are admitted in priority order and counted
 * as they are, so one step never overfills a limit.
 */
export function schedule(state: MissionsSnapshot, capacity: CapacitySnapshot, now: Millis): SchedulerAction[] {
  const out: SchedulerAction[] = [];
  const limits = capacity.limits;
  const agents = new Counter();
  const verifying = new Counter();
  const liveMissions = new Set<string>();
  const wakes: Millis[] = [];
  const candidates: Candidate[] = [];
  const verifyQueue: Candidate[] = [];
  const missions = [...state.missions].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

  // What is running now, and what must stop.
  for (const m of missions) {
    for (const t of m.tasks) {
      const a = t.live;
      if (!a) continue;
      if (m.state === 'cancelled' || t.state === 'cancelled' || t.state === 'skipped') {
        out.push({ kind: 'cancel', missionId: m.id, taskId: t.id, attemptId: a.id });
        continue;
      }
      liveMissions.add(m.id);
      if (a.phase === 'agent') {
        agents.add('*');
        agents.add(`repo:${m.repo}`);
        agents.add(`harness:${t.harness}`);
        agents.add(`source:${t.source}`);
      } else if (a.phase === 'verifying') {
        verifying.add(m.repo);
      }
    }
  }

  for (const m of missions) {
    if (!ACTIVE_MISSION.includes(m.state)) continue;
    const paths = criticalPaths(m);
    const holder = treeHolder(m);
    let open = false;
    m.tasks.forEach((t, order) => {
      const path = paths.get(t.id) ?? 1;
      const heldBy = holder && holder.id !== t.id ? holder.key : undefined;
      if (t.live?.phase === 'verify-queued') verifyQueue.push({ m, t, path, order });
      if (!ENDED.includes(t.state)) open = true;
      if (t.live || ENDED.includes(t.state)) return;
      if (t.retry) {
        candidates.push({ m, t, path, order, retryOf: t.retry.decisionId, notBefore: t.retry.notBefore, heldBy });
        return;
      }
      // Tried before and no step pending: the user decides what happens next (retry, resume, accept, skip).
      if (t.attempts > 0) return;
      // Routed and waiting for the user's word (`assisted`), or handed to them: theirs too.
      if (!STARTABLE.includes(t.state) && t.state !== 'blocked') return;
      const broken = brokenUpstreams(m, t);
      if (broken.length > 0) {
        if (t.state === 'pending' || t.state === 'queued') {
          const detail = `upstream ${broken.map((u) => `${u.key} ${u.state === 'done' ? 'invalidated' : u.state}`).join(', ')}`;
          out.push({ kind: 'block', missionId: m.id, taskId: t.id, upstream: broken.map((u) => u.id), detail });
        }
        return;
      }
      if (t.state === 'blocked') {
        out.push({ kind: 'unblock', missionId: m.id, taskId: t.id });
        return; // pending again; a start waits for the next step, which sees it so
      }
      if (!STARTABLE.includes(t.state)) return;
      if (!dependenciesMet(m, t)) return;
      candidates.push({ m, t, path, order, heldBy });
    });
    // Done tasks on their own branches go onto the mission branch (#46 carries it out).
    if (!m.sharedTree) {
      for (const t of m.tasks) if (t.state === 'done' && !t.integrated && !t.invalidated) out.push({ kind: 'integrate', missionId: m.id, taskId: t.id });
    }
    const finished = m.tasks.every((t) => t.state === 'skipped' || (t.state === 'done' && t.integrated && !t.invalidated));
    if (m.planned && m.state === 'running' && !open && finished && !liveMissions.has(m.id) && m.tasks.some((t) => t.state === 'done')) {
      out.push({ kind: 'finish', missionId: m.id });
    }
  }

  // Verification first: it frees agent slots' worth of work, and never takes one.
  verifyQueue.sort(byPriority);
  for (const c of verifyQueue) {
    if (verifying.get(c.m.repo) >= limits.verificationPerRepo) {
      out.push({ kind: 'wait', missionId: c.m.id, taskId: c.t.id, reason: 'verification', detail: `another verification is running in this repository (limit ${limits.verificationPerRepo})` });
      continue;
    }
    verifying.add(c.m.repo);
    out.push({ kind: 'verify', missionId: c.m.id, taskId: c.t.id, attemptId: c.t.live!.id });
  }

  candidates.sort(byPriority);
  for (const c of candidates) {
    const why = refusal(c, capacity, agents, liveMissions, now);
    if (why) {
      out.push({ kind: 'wait', missionId: c.m.id, taskId: c.t.id, ...why });
      if (why.until !== undefined) wakes.push(why.until);
      continue;
    }
    agents.add('*');
    agents.add(`repo:${c.m.repo}`);
    agents.add(`harness:${c.t.harness}`);
    agents.add(`source:${c.t.source}`);
    agents.add(`slots:${c.t.source}`);
    liveMissions.add(c.m.id);
    out.push({ kind: 'start', missionId: c.m.id, taskId: c.t.id, ...(c.retryOf ? { retryOf: c.retryOf } : {}) });
  }

  const next = wakes.filter((w) => w > now).sort((a, b) => a - b)[0];
  if (next !== undefined) out.push({ kind: 'wake', at: next });
  return out;
}

/** Why a candidate may not start now, or undefined when it may. Checked in §12.3's order: nothing, then time, then budget, then slots. */
function refusal(
  c: Candidate,
  capacity: CapacitySnapshot,
  agents: Counter,
  liveMissions: ReadonlySet<string>,
  now: Millis,
): { reason: WaitReason; detail: string; until?: Millis } | undefined {
  const { m, t } = c;
  const limits = capacity.limits;
  if (capacity.fleetPaused) return { reason: 'fleet-paused', detail: 'every agent is paused; nothing starts until they are resumed' };
  if (m.state !== 'running') return { reason: 'mission-paused', detail: 'the mission is paused; nothing new starts until it is resumed' };
  if (c.heldBy) return { reason: 'shared-tree', detail: `${c.heldBy} holds the mission worktree until it is finished` };
  if (m.sharedTree && liveMissions.has(m.id)) return { reason: 'shared-tree', detail: 'another task of this mission is using its worktree' };
  if (c.notBefore !== undefined && c.notBefore > now) return { reason: 'retry-delay', detail: 'its retry waits out a backoff', until: c.notBefore };
  const src = capacity.sources[t.source];
  if (src?.backoffUntil !== undefined && src.backoffUntil > now) {
    return { reason: 'backoff', detail: `${t.source} is rate-limited`, until: src.backoffUntil };
  }
  const threshold = Math.min(limits.admissionPercent, m.maxWindowPercent ?? Infinity);
  if (src?.windowPercent !== undefined && src.windowPercent >= threshold) {
    return { reason: 'usage', detail: `the ${t.source} usage window is at ${Math.round(src.windowPercent)}%; new work starts below ${threshold}%` };
  }
  if (agents.get('*') >= limits.global) return { reason: 'concurrency', detail: `${limits.global} agents are running (the most at once)` };
  if (m.maxConcurrentAgents !== undefined && agents.get('*') >= m.maxConcurrentAgents) {
    return { reason: 'concurrency', detail: `the mission caps concurrent agents at ${m.maxConcurrentAgents}` };
  }
  if (agents.get(`repo:${m.repo}`) >= limits.perRepo) return { reason: 'concurrency', detail: `${limits.perRepo} agents are running in this repository` };
  const perHarness = limits.perHarness[t.harness];
  if (perHarness !== undefined && agents.get(`harness:${t.harness}`) >= perHarness) {
    return { reason: 'concurrency', detail: `${perHarness} ${t.harness} agents are running` };
  }
  const perSource = limits.perSource[t.source];
  if (perSource !== undefined && agents.get(`source:${t.source}`) >= perSource) {
    return { reason: 'concurrency', detail: `${perSource} agents are running on ${t.source}` };
  }
  if (src?.freeSlots !== undefined && agents.get(`slots:${t.source}`) >= src.freeSlots) {
    return { reason: 'endpoint-slots', detail: `every slot on ${t.source} is busy` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Telemetry (§17: parallelism benefit)
// ---------------------------------------------------------------------------

/**
 * Σ attempt active time / mission wall clock (§17). Above 1 means tasks ran
 * side by side. Undefined until something has run.
 */
export function parallelismBenefit(attempts: readonly { activeMs?: number }[], wallClockMs: number): number | undefined {
  const active = attempts.reduce((s, a) => s + (a.activeMs ?? 0), 0);
  if (wallClockMs <= 0 || active <= 0) return undefined;
  return active / wallClockMs;
}
