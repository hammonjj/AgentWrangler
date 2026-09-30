/**
 * Derived orchestration state (#101): the one place that turns missions,
 * proposals, tasks and a session's own signals into what every surface shows.
 * The contract is `docs/plans/status-contract.md` (#100); section numbers
 * below are its.
 *
 * Three outputs, all pure functions of their inputs:
 *
 * - **(a) a session row**: its primary `SessionStatus` (§5.1) plus a
 *   `WaitInfo` saying what it waits for, with source and certainty (§3);
 * - **(b) the origin's linked-work summary**: one `LinkedWork` per mission it
 *   delegated, keyed by mission id (§4, §6);
 * - **(c) mission and task row state**: `missionPhase` / `taskPhase`, which the
 *   Missions view shows, so the table, Missions and the conversation cannot
 *   disagree.
 *
 * Nothing here is stored. Every call rebuilds from the current mission records
 * and the session's current evidence (§7), so a duplicate or replayed event
 * re-derives the same result and a restart needs nothing cleared. Historical
 * assistant messages are never touched (H1): the summary is a separate value.
 * Nothing here, or anywhere this feeds, closes a GitHub issue (C3).
 *
 * No Node, no DOM: this is bundled into the main process and the webviews.
 */
import type { AgentSession, SessionStatus } from '../model';
import { summariseVerification } from './verification';
import type { ExecutionAttempt, Mission, MissionFinish, MissionState, Task } from './types';

// ---------------------------------------------------------------------------
// Vocabulary (§3, §4)
// ---------------------------------------------------------------------------

export type WaitReason =
  | 'permission'
  | 'user-question'
  | 'plan-approval'
  | 'user-reply'
  | 'awaiting-approval'
  | 'awaiting-children'
  | 'background'
  | 'resource'
  | 'rate-limit'
  | 'queued'
  | 'dependency'
  | 'verifying'
  | 'planning';

export type Certainty = 'verified' | 'inferred' | 'unknown';

export type WaitSource = 'hook' | 'pid-file' | 'transcript' | 'sdk' | 'codex-app-server' | 'codex-rollout' | 'mission';

/** K1: a wait is keyed by mission, and for a plan by the planner run it is about. */
export interface WaitRef {
  missionId: string;
  planRunId?: string;
  taskId?: string;
}

export interface WaitInfo {
  reason: WaitReason;
  certainty: Certainty;
  source: WaitSource;
  since: number;
  ref?: WaitRef;
  detail?: string;
}

/** Where a mission is, as the origin and the Missions view both read it (§4). */
export type LinkedPhase =
  | 'planning'
  | 'awaiting-approval'
  | 'needs-you'
  | 'awaiting-children'
  | 'running'
  | 'queued'
  | 'verifying'
  | 'paused'
  | 'ready-for-review'
  | 'integrated'
  | 'failed'
  | 'cancelled'
  /** A mission state this build does not know (U1): shown as unknown, never guessed. */
  | 'unknown';

/** Phases that are activity: nothing for the user, never Waiting, never counted (L2). */
export const ACTIVITY_PHASES: ReadonlySet<LinkedPhase> = new Set(['planning', 'awaiting-children', 'running', 'queued', 'verifying', 'paused']);
/** Phases that need the user (A2). */
export const NEEDS_YOU_PHASES: ReadonlySet<LinkedPhase> = new Set(['awaiting-approval', 'needs-you', 'ready-for-review', 'failed']);
/** Phases after which nothing more happens. */
export const TERMINAL_PHASES: ReadonlySet<LinkedPhase> = new Set(['integrated', 'failed', 'cancelled']);

/** How long a terminal mission stays in its origin's summary (L1). */
export const LINKED_TERMINAL_WINDOW_MS = 24 * 3_600_000;

/**
 * C1–C3 for a finished mission: where the branch went, whether the work was
 * checked, and who closes out. Three facts, never collapsed into one "done".
 */
export interface LinkedOutcome {
  /** C1: the branch went where the user chose (merge, pull request, keep). False for a discard. */
  integrated: boolean;
  finish?: MissionFinish;
  mergeCommit?: string;
  pullRequestUrl?: string;
  /** C2: every required task passed its checks. */
  verification: 'verified' | 'unverified' | 'failed';
  /** C2: `unverified` because the repository configures no checks. */
  noChecks?: boolean;
  /**
   * C3: closing out (an issue, follow-ups) is the user's. Agent Wrangler reads
   * and writes no issue state; #102 owns authorised closeout and fills this in.
   */
  closeout: 'yours';
}

/** Mission progress, from required tasks only (L4, A2). */
export interface LinkedProgress {
  done: number;
  /** Tasks minus skipped: the denominator. */
  required: number;
  running: number;
  needsYou: number;
  failed: number;
}

/** (c) One mission's state, as a row. */
export interface MissionPhaseView {
  phase: LinkedPhase;
  needsYou: boolean;
  terminal: boolean;
  /** Full-width text, without the "Delegated:" prefix: "running · 0/1 done". */
  text: string;
  /** The ≈300 px form: "Delegated · 0/1". */
  short: string;
  /** Tooltip: the reason behind the phase. */
  title: string;
  progress: LinkedProgress;
  /** K1: the key a wait on this mission carries. */
  ref: WaitRef;
  outcome?: LinkedOutcome;
  certainty: Certainty;
}

/** (b) One entry of an origin's linked-work summary. */
export interface LinkedWork extends MissionPhaseView {
  missionId: string;
  /** The mission's title. (It replaces the phase's tooltip, which is kept as `why`.) */
  title: string;
  /** The reason behind the phase: `MissionPhaseView.title`. */
  why: string;
  createdAt: number;
  /** The record's own sequence stamp: its last write. */
  updatedAt: number;
  /** K2: created during the origin's current turn, so that turn's prose may be about it. */
  keyed: boolean;
  /** K2 without a known turn start: the keying is estimated. */
  keyedEstimated?: boolean;
  /** For #102's handback: which origin turn this answers, when known. */
  originTurnStartedAt?: number;
}

// ---------------------------------------------------------------------------
// Proposals and delegations: the one definition of each (#81, #82)
// ---------------------------------------------------------------------------

/** Whether a mission's task is a proposal nobody has started or dropped yet. */
export function isOpenProposal(m: Mission): boolean {
  const task = m.tasks[0];
  return !!task?.recommendation && task.attemptIds.length === 0 && ['routed', 'needs-human'].includes(task.state);
}

/**
 * Whether a mission is a delegation (#82) whose card is a plan's: the planner
 * has not answered, could not plan it, or planned several tasks that wait for
 * review. One kept as one task is an open proposal instead.
 */
export function isOpenDelegation(m: Mission): boolean {
  return !!m.delegation && m.planned === true && ['planning', 'planning-failed', 'plan-review'].includes(m.state);
}

// ---------------------------------------------------------------------------
// (c) Mission and task phases
// ---------------------------------------------------------------------------

const KNOWN_MISSION_STATES: ReadonlySet<MissionState> = new Set([
  'draft', 'planning', 'planning-failed', 'plan-review', 'running', 'paused', 'finishing', 'review', 'completed', 'failed', 'cancelled',
]);

/** The task states `missionMetrics` counts as running; kept identical (L4). */
const RUNNING_TASK_STATES = new Set(['ready', 'assessing', 'routed', 'queued', 'running', 'verifying', 'integrating']);

/** Required-task counts (L4). `missionMetrics` reads its counts from here, so the numbers agree. */
export function missionTaskCounts(m: Pick<Mission, 'tasks'>): LinkedProgress & { total: number; skipped: number; blocked: number; pending: number } {
  const count = (pred: (t: Task) => boolean) => m.tasks.filter(pred).length;
  const skipped = count((t) => t.state === 'skipped');
  return {
    total: m.tasks.length,
    skipped,
    required: m.tasks.length - skipped,
    done: count((t) => t.state === 'done'),
    running: count((t) => RUNNING_TASK_STATES.has(t.state)),
    needsYou: count((t) => t.state === 'needs-human'),
    failed: count((t) => t.state === 'failed'),
    blocked: count((t) => t.state === 'blocked'),
    pending: count((t) => t.state === 'pending'),
  };
}

function currentAttempt(m: Mission, t: Task): ExecutionAttempt | undefined {
  const id = t.attemptIds.at(-1);
  return id ? m.attempts.find((a) => a.id === id) : undefined;
}

/** C2 over the required tasks' current attempts. */
function outcomeOf(m: Mission): LinkedOutcome {
  const required = m.tasks.filter((t) => t.state !== 'skipped');
  let verification: LinkedOutcome['verification'] = required.length > 0 ? 'verified' : 'unverified';
  let noChecks = required.length > 0;
  for (const t of required) {
    const a = currentAttempt(m, t);
    const verdict = a ? summariseVerification(t.verification, a.verification).verdict : 'unverified';
    if (t.verification.stages.some((s) => s.required && s.strategy.startsWith('command:'))) noChecks = false;
    if (verdict === 'failed') verification = 'failed';
    else if (verdict !== 'passed' && verification !== 'failed') verification = 'unverified';
  }
  const integrated = m.state === 'completed' && m.finish !== undefined && m.finish !== 'discard';
  return {
    integrated,
    ...(m.finish ? { finish: m.finish } : {}),
    ...(m.finishResult?.mergeCommit ? { mergeCommit: m.finishResult.mergeCommit } : {}),
    ...(m.finishResult?.pullRequestUrl ? { pullRequestUrl: m.finishResult.pullRequestUrl } : {}),
    verification,
    ...(verification === 'unverified' && noChecks ? { noChecks: true } : {}),
    closeout: 'yours',
  };
}

function integratedText(o: LinkedOutcome): { text: string; short: string } {
  const where = o.finish === 'pull-request' ? 'PR opened' : o.finish === 'keep' ? 'kept on its branch' : 'merged';
  const checked = o.verification === 'verified' ? 'verified' : o.verification === 'failed' ? 'checks failed' : o.noChecks ? 'unverified (no checks configured)' : 'unverified';
  return {
    text: `${where} · ${checked} · closeout: yours`,
    short: o.finish === 'pull-request' ? 'PR opened' : o.finish === 'keep' ? 'Kept' : 'Merged',
  };
}

/**
 * (c) What a mission is doing, per the §4 table. Evaluated in the table's
 * order: an open proposal is awaiting approval whatever else is true of it,
 * so pending approval is never read as running.
 */
export function missionPhase(m: Mission): MissionPhaseView {
  const counts = missionTaskCounts(m);
  const progress: LinkedProgress = { done: counts.done, required: counts.required, running: counts.running, needsYou: counts.needsYou, failed: counts.failed };
  const ofDone = `${progress.done}/${progress.required} done`;
  const run = m.planning?.at(-1);
  const baseRef: WaitRef = { missionId: m.id };
  const view = (phase: LinkedPhase, text: string, short: string, title: string, extra: Partial<MissionPhaseView> = {}): MissionPhaseView => ({
    phase,
    needsYou: NEEDS_YOU_PHASES.has(phase),
    terminal: TERMINAL_PHASES.has(phase),
    text,
    short,
    title,
    progress,
    ref: baseRef,
    certainty: 'verified',
    ...extra,
  });

  if (!KNOWN_MISSION_STATES.has(m.state)) {
    return view('unknown', `state unknown (${String(m.state)})`, '? unknown', 'Written by a build this one does not know; its state is not guessed.', { certainty: 'unknown' });
  }
  if (m.state === 'cancelled') return view('cancelled', 'cancelled', 'Cancelled', m.stateReason ?? 'Cancelled');
  if (m.state === 'failed') return view('failed', 'failed', 'Failed', m.stateReason ?? 'Failed');
  if (m.state === 'completed') {
    const outcome = outcomeOf(m);
    if (!outcome.integrated) return view('cancelled', 'discarded', 'Discarded', m.stateReason ?? 'Its result was discarded', { outcome });
    const t = integratedText(outcome);
    return view('integrated', t.text, t.short, [m.stateReason, 'Agent Wrangler closes no issue; closing out is yours.'].filter(Boolean).join(' · '), { outcome });
  }
  if (isOpenProposal(m)) {
    const task = m.tasks[0];
    const ref = { missionId: m.id, taskId: task.id };
    // Approved (#100's `startApproval`) but not launched: never "to start" again.
    if (m.startApproval) {
      if (task.state === 'needs-human') return view('needs-you', `${task.key} could not start`, `${task.key} needs you`, task.stateReason ?? 'Started, but its launch was refused', { ref });
      return view('running', `starting · ${ofDone}`, `Delegated · ${progress.done}/${progress.required}`, 'Started; its agent is launching', { ref });
    }
    return view('awaiting-approval', '1 task to start', 'Task to start', task.stateReason ?? 'A proposal waits for you to start it', { ref });
  }
  switch (m.state) {
    case 'planning':
      return view('planning', 'planning', 'Delegating', 'The planner is deciding whether it is one task or several', run ? { ref: { missionId: m.id, planRunId: run.id } } : {});
    case 'plan-review': {
      const n = m.tasks.length;
      return view('awaiting-approval', `plan of ${n} to approve`, 'Plan to approve', 'Nothing runs until you approve the plan', run ? { ref: { missionId: m.id, planRunId: run.id } } : {});
    }
    case 'planning-failed':
      return view('needs-you', 'could not be planned', 'Not planned', run?.reason ?? m.stateReason ?? 'Planning failed');
    case 'draft': {
      // Started (approval recorded) but not launched yet: running, never "to start" again.
      if (m.startApproval) return view('running', `starting · ${ofDone}`, `Delegated · ${progress.done}/${progress.required}`, 'Started; its agent is launching');
      return view('planning', 'routing', 'Delegating', 'Being assessed and routed; nothing to approve yet');
    }
    case 'paused':
      return view('paused', `paused · ${ofDone}`, 'Paused', m.stateReason ?? 'Paused: nothing new starts');
    case 'review':
      return view('ready-for-review', 'ready to merge', 'Ready to merge', m.stateReason ?? 'Every task is done; pick how to finish');
    case 'finishing':
      return view('verifying', `verifying · ${ofDone}`, 'Verifying', 'Checking the mission result');
    case 'running':
      break;
  }

  // Running: the most urgent task decides.
  const needing = m.tasks.find((t) => t.state === 'needs-human');
  if (needing) {
    return view('needs-you', `${needing.key} needs you`, `${needing.key} needs you`, needing.stateReason ?? `${needing.key} needs you`, { ref: { missionId: m.id, taskId: needing.id } });
  }
  const failedUpstream = m.tasks.find(
    (t) => t.state === 'blocked' && t.dependsOn.some((d) => ['failed', 'cancelled'].includes(m.tasks.find((x) => x.id === d.taskId)?.state ?? '')),
  );
  if (failedUpstream) {
    return view('needs-you', `${failedUpstream.key} blocked`, `${failedUpstream.key} blocked`, `${failedUpstream.key} depends on a task that did not finish`, { ref: { missionId: m.id, taskId: failedUpstream.id } });
  }
  const live = m.tasks.map((t) => ({ t, a: currentAttempt(m, t) }));
  const asking = live.find(({ a }) => a?.state === 'waiting-human');
  if (asking) {
    return view('awaiting-children', `worker asks · ${ofDone}`, 'Worker asks', `${asking.t.key}'s agent is asking something in its own conversation`, { ref: { missionId: m.id, taskId: asking.t.id } });
  }
  if (live.some(({ t, a }) => a?.state === 'verifying' || t.state === 'verifying' || t.state === 'integrating')) {
    return view('verifying', `verifying · ${ofDone}`, 'Verifying', 'Checking a task result');
  }
  if (live.some(({ a }) => a && ['created', 'launching', 'running', 'finishing'].includes(a.state))) {
    return view('running', `running · ${ofDone}`, `Delegated · ${progress.done}/${progress.required}`, `${progress.running} running`);
  }
  const queued = m.tasks.find((t) => t.state === 'queued' || t.state === 'blocked');
  if (queued) {
    const why = queued.stateReason ? ` (${queued.stateReason})` : '';
    return view('queued', `queued${why}`, 'Queued', `${queued.key} is waiting to start${why}`);
  }
  return view('running', `running · ${ofDone}`, `Delegated · ${progress.done}/${progress.required}`, 'Between tasks');
}

/** (c) A task's row state within its mission. */
export type TaskPhase = 'to-start' | 'pending' | 'queued' | 'running' | 'worker-asks' | 'verifying' | 'needs-you' | 'done' | 'failed' | 'cancelled' | 'skipped';

export function taskPhase(m: Mission, t: Task): { phase: TaskPhase; needsYou: boolean } {
  const a = currentAttempt(m, t);
  const phase: TaskPhase = (() => {
    if (m.tasks[0]?.id === t.id && isOpenProposal(m)) return 'to-start';
    switch (t.state) {
      case 'done': return 'done';
      case 'failed': return 'failed';
      case 'cancelled': return 'cancelled';
      case 'skipped': return 'skipped';
      case 'needs-human': return 'needs-you';
      case 'verifying':
      case 'integrating': return 'verifying';
      case 'queued':
      case 'blocked': return 'queued';
      case 'pending':
      case 'ready':
      case 'assessing':
      case 'routed': return a ? 'running' : 'pending';
      default: break;
    }
    if (a?.state === 'waiting-human') return 'worker-asks';
    if (a?.state === 'verifying') return 'verifying';
    return 'running';
  })();
  return { phase, needsYou: phase === 'to-start' || phase === 'needs-you' };
}

// ---------------------------------------------------------------------------
// (b) The origin's linked-work summary
// ---------------------------------------------------------------------------

/** The session key a mission's origin names, as the store keys sessions. */
export function originKeyOf(origin: NonNullable<Mission['origin']>): string {
  return `${origin.provider}:${origin.sessionId}`.toLowerCase();
}

/** What the derivation reads off a session: its own evidence, nothing about missions. */
export type SessionEvidence = Pick<
  AgentSession,
  | 'key'
  | 'provider'
  | 'status'
  | 'statusIsEstimated'
  | 'lastActivityAt'
  | 'blockedReason'
  | 'pendingQuestion'
  | 'pendingPlan'
  | 'backgroundTasks'
  | 'rateLimit'
  | 'runnerOwned'
  | 'turnStartedAt'
  | 'progress'
  | 'statusUncertain'
>;

/**
 * K2: is this mission about the origin's current turn? A mission records the
 * turn it was created in (`origin.turnStartedAt`); a session reports when its
 * current turn began. A user prompt after the mission ends the tie (W4). With
 * no turn start known, every listed mission is keyed and the keying is
 * marked estimated.
 */
function keying(m: Mission, session: SessionEvidence): { keyed: boolean; estimated: boolean } {
  const turn = session.turnStartedAt ?? session.progress?.startedAtMs;
  if (turn === undefined) return { keyed: true, estimated: true };
  const stamp = m.origin?.turnStartedAt ?? m.createdAt;
  return { keyed: stamp >= turn, estimated: false };
}

/** L1: listed while not terminal, and for a day after. */
function listed(p: MissionPhaseView, m: Mission, nowMs: number): boolean {
  return !p.terminal || nowMs - m.updatedAt <= LINKED_TERMINAL_WINDOW_MS;
}

/**
 * Keep the newest record per mission id: out-of-order and duplicate
 * deliveries collapse to the latest write (`updatedAt`, ties keep the one
 * already held). The runner has one writer per mission, so its order is total.
 */
export function latestMissions(records: Iterable<Mission>): Mission[] {
  const byId = new Map<string, Mission>();
  for (const m of records) {
    const held = byId.get(m.id);
    if (!held || m.updatedAt > held.updatedAt) byId.set(m.id, m);
  }
  return [...byId.values()];
}

/** (b) Every mission this session delegated, oldest first (L1), each with its phase and keying. */
export function linkedWorkFor(session: SessionEvidence, missions: readonly Mission[], nowMs: number): LinkedWork[] {
  const key = session.key.toLowerCase();
  const out: LinkedWork[] = [];
  for (const m of latestMissions(missions)) {
    if (!m.origin || originKeyOf(m.origin) !== key) continue;
    const p = missionPhase(m);
    if (!listed(p, m, nowMs)) continue;
    const k = keying(m, session);
    out.push({
      ...p,
      missionId: m.id,
      title: m.title,
      why: p.title,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      keyed: k.keyed,
      ...(k.estimated ? { keyedEstimated: true } : {}),
      ...(m.origin.turnStartedAt !== undefined ? { originTurnStartedAt: m.origin.turnStartedAt } : {}),
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.missionId.localeCompare(b.missionId));
}

/** A4: the entry the row chip shows — needs-you before activity, then newest — and how many others. */
export function headlineOf(linked: readonly LinkedWork[]): { entry: LinkedWork; more: number } | undefined {
  if (linked.length === 0) return undefined;
  const rank = (w: LinkedWork) => (w.needsYou ? 0 : ACTIVITY_PHASES.has(w.phase) ? 1 : 2);
  const entry = [...linked].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)[0];
  return { entry, more: linked.length - 1 };
}

/** "Delegated: running · 0/1 done", for the row and the conversation's summary strip. */
export function linkedWorkText(w: LinkedWork): string {
  return `Delegated: ${w.text}`;
}

// ---------------------------------------------------------------------------
// (a) The session row (§5.1)
// ---------------------------------------------------------------------------

export interface DerivedSessionState {
  status: SessionStatus;
  wait?: WaitInfo;
  linked: LinkedWork[];
  /** Counts toward attention (the badge): a real user action is outstanding on this row. */
  needsUser: boolean;
}

function evidenceSource(s: SessionEvidence): WaitSource {
  if (s.provider === 'codex') return s.runnerOwned ? 'codex-app-server' : 'codex-rollout';
  return s.statusIsEstimated ? 'transcript' : 'hook';
}

function certaintyOf(s: SessionEvidence): Certainty {
  if (s.statusUncertain) return 'unknown';
  return s.statusIsEstimated ? 'inferred' : 'verified';
}

/** P1's reason: which kind of prompt the provider reported. */
function promptReason(s: SessionEvidence): WaitReason {
  if (s.pendingPlan) return 'plan-approval';
  if (s.pendingQuestion) return 'user-question';
  const r = (s.blockedReason ?? '').toLowerCase();
  if (r === 'plan approval' || r === 'exitplanmode') return 'plan-approval';
  if (r === 'answer' || r === 'question' || r === 'input' || r === 'askuserquestion' || r.includes('elicitation')) return 'user-question';
  return 'permission';
}

/** The quiet reason a linked phase gives a row that is not waiting on the user. */
function activityReason(p: LinkedPhase): WaitReason | undefined {
  switch (p) {
    case 'planning':
      return 'planning';
    case 'queued':
      return 'queued';
    case 'verifying':
      return 'verifying';
    case 'running':
    case 'awaiting-children':
    case 'paused':
      return 'awaiting-children';
    default:
      return undefined;
  }
}

function missionWait(w: LinkedWork, reason: WaitReason): WaitInfo {
  return {
    reason,
    certainty: w.keyedEstimated ? 'inferred' : w.certainty,
    source: 'mission',
    since: w.updatedAt,
    ref: w.ref,
    detail: linkedWorkText(w),
  };
}

/** The most urgent of several keyed missions, the approval ones first, then newest. */
function mostUrgent(ws: LinkedWork[]): LinkedWork {
  const rank = (w: LinkedWork) => (w.phase === 'awaiting-approval' ? 0 : 1);
  return [...ws].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)[0];
}

/** The quiet activity a row carries for keyed work still going (§3: busy/done carry linked activity only). */
function quietActivity(keyed: LinkedWork[]): WaitInfo | undefined {
  const going = keyed.filter((w) => !w.terminal && !w.needsYou && activityReason(w.phase) !== undefined);
  if (going.length === 0) return undefined;
  const newest = [...going].sort((a, b) => b.createdAt - a.createdAt)[0];
  return missionWait(newest, activityReason(newest.phase)!);
}

/**
 * (a) The row's primary status and wait reason, per §5.1, with linked work
 * beside it. `session.status` is the provider's reading of the conversation's
 * own turn (P1–P4, P7 are decided there); this adds W3 and the reasons.
 */
export function deriveSessionState(session: SessionEvidence, missions: readonly Mission[], nowMs: number): DerivedSessionState {
  const linked = linkedWorkFor(session, missions, nowMs);
  const keyed = linked.filter((w) => w.keyed);
  const source = evidenceSource(session);
  const certainty = certaintyOf(session);
  const since = session.lastActivityAt;
  const result = (status: SessionStatus, wait?: WaitInfo): DerivedSessionState => ({
    status,
    ...(wait ? { wait } : {}),
    linked,
    needsUser: status === 'blocked' || status === 'waiting',
  });

  // P7
  if (session.status === 'ended') return result('ended');

  // P1 (W1: a verified prompt beats everything inferred).
  if (session.status === 'blocked') {
    return result('blocked', { reason: promptReason(session), certainty, source: session.pendingPlan || session.pendingQuestion ? 'sdk' : source, since, ...(session.blockedReason ? { detail: session.blockedReason } : {}) });
  }

  const rateLimit: WaitInfo | undefined = session.rateLimit
    ? { reason: 'rate-limit', certainty: session.rateLimit.category === 'unknown' ? 'unknown' : 'inferred', source, since, detail: session.rateLimit.reason }
    : undefined;

  // P2, P3
  if (session.status === 'busy') {
    if (session.backgroundTasks) {
      const n = session.backgroundTasks.subagents + session.backgroundTasks.shells + session.backgroundTasks.other;
      return result('busy', { reason: 'background', certainty, source, since, detail: `${n} in background` });
    }
    return result('busy', rateLimit ?? quietActivity(keyed));
  }

  // P4, with the quiet-wait rule (§7): a legitimate quiet wait is not a stall.
  if (session.status === 'stuck') {
    if (rateLimit) return result('busy', rateLimit);
    const quiet = quietActivity(keyed);
    if (quiet) return result('busy', quiet);
    return result('stuck');
  }

  // P5 / P6 with W3.
  if (session.status === 'waiting') {
    if (keyed.length === 0) return result('waiting', { reason: 'user-reply', certainty: certainty === 'verified' ? 'inferred' : certainty, source, since });
    const asks = keyed.filter((w) => w.needsYou);
    if (asks.length > 0) {
      const w = mostUrgent(asks);
      return result('waiting', missionWait(w, w.phase === 'awaiting-approval' ? 'awaiting-approval' : 'user-reply'));
    }
    // W3: every keyed mission has moved on to a phase that needs nothing from you.
    return result('done', quietActivity(keyed));
  }

  // P6
  return result('done', quietActivity(keyed));
}

const ACTIVITY_WAITS: ReadonlySet<WaitReason> = new Set(['awaiting-children', 'planning', 'queued', 'verifying', 'background', 'resource', 'rate-limit']);

/**
 * The session with the derivation applied: what the store hands every
 * surface. `linked` and `wait` are replaced, never merged, so nothing stale
 * survives a re-derivation.
 */
export function withDerivedState<T extends SessionEvidence>(session: T, missions: readonly Mission[], nowMs: number): T & { wait?: WaitInfo; linked?: LinkedWork[] } {
  const d = deriveSessionState(session, missions, nowMs);
  const { wait: _wait, linked: _linked, ...rest } = session as T & { wait?: WaitInfo; linked?: LinkedWork[] };
  return {
    ...(rest as T),
    status: d.status,
    ...(d.wait ? { wait: d.wait } : {}),
    ...(d.linked.length > 0 ? { linked: d.linked } : {}),
  };
}

/**
 * Whether a row that just became notable may toast (§10). Not a Done while its
 * delegated work is still going (awaiting children, planning, verifying): that
 * Done would be early. Not a Waiting for an approval the mission's own notice
 * already announced (A3: one ask, one notice). N2 (attempt sessions) is the
 * caller's, which knows which sessions are attempts.
 */
export function toastAllowed(session: { status: SessionStatus; wait?: WaitInfo }): boolean {
  if (session.status === 'done') return session.wait === undefined || !ACTIVITY_WAITS.has(session.wait.reason);
  if (session.status === 'waiting') return session.wait?.reason !== 'awaiting-approval';
  return true;
}

/**
 * Attention (§10, A3): rows that need the user, plus missions that need the
 * user and are not already counted through a row keyed to them. Each ask
 * counts once.
 */
export function attentionCount(sessions: readonly (SessionEvidence & { wait?: WaitInfo; archived?: boolean })[], missions: readonly Mission[]): number {
  let n = 0;
  const counted = new Set<string>();
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.status !== 'blocked' && s.status !== 'waiting') continue;
    n++;
    if (s.wait?.ref) counted.add(s.wait.ref.missionId);
  }
  for (const m of latestMissions(missions)) {
    if (counted.has(m.id)) continue;
    if (missionPhase(m).needsYou) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Notices (N1)
// ---------------------------------------------------------------------------

export interface LinkedNotice {
  /** The dedupe key (N1): one notice per key, ever, per run of the app. */
  key: string;
  missionId: string;
  title: string;
  body: string;
}

/**
 * Mission notices the runner does not already send: the integrated one (§10:
 * "merged; not verified; issue not closed"). `seen` holds the dedupe keys
 * already sent. A state that already held when the app started is marked
 * seen and not sent (§7): `initial` marks everything present on the first
 * call, and `sinceMs` (the app's start) catches missions that load from disk
 * after it, whose last write is older.
 */
export function linkedNotices(
  missions: readonly Mission[],
  seen: ReadonlySet<string>,
  opts: { initial?: boolean; sinceMs?: number } = {},
): { notices: LinkedNotice[]; seen: Set<string> } {
  const next = new Set(seen);
  const notices: LinkedNotice[] = [];
  for (const m of latestMissions(missions)) {
    const p = missionPhase(m);
    if (p.phase !== 'integrated' || !p.outcome) continue;
    const key = `${m.id}:integrated`;
    if (next.has(key)) continue;
    next.add(key);
    if (opts.initial || (opts.sinceMs !== undefined && m.updatedAt < opts.sinceMs)) continue;
    const o = p.outcome;
    const where = o.finish === 'pull-request' ? 'Pull request opened' : o.finish === 'keep' ? 'Kept on its branch' : 'Merged';
    const checked = o.verification === 'verified' ? 'verified' : o.verification === 'failed' ? 'checks failed' : 'not verified';
    notices.push({ key, missionId: m.id, title: `Delegated work finished: ${m.title}`, body: `${where}; ${checked}; issue not closed by Agent Wrangler.` });
  }
  return { notices, seen: next };
}
