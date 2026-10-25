/**
 * Scoped agent mission control (`docs/plans/agent-mission-control.md`).
 *
 * Two things, both pure:
 *
 * 1. **Inspection** (read-only, any agent): a mission as `aw missions` and
 *    `aw mission <id>` print it — its state, each task's state, verification
 *    checks and status, the branch, the diff stat against the base, and the
 *    one thing it is waiting on. Built from the same derivations the Missions
 *    page and the origin row read (`missionPhase`, `missionVerification`,
 *    `summariseVerification`), so the three cannot disagree.
 *
 * 2. **The grant decision** (opt-in, per durable agent, off by default): may
 *    this agent accept, finish or cancel this mission? Only when the grant is
 *    on, the mission's origin conversation belongs to the same agent, and its
 *    verification checks passed. A local merge is never done on the agent's
 *    word: it becomes a request the user confirms in the app.
 *
 * The decision is the scoped half of authorisation. `authorize()`
 * (`src/core/access.ts`) decides whether an agent principal may ask at all
 * (`mission.agent`); this decides whether it may ask about *this* mission. The
 * dispatcher calls both, in that order, and audits the outcome.
 *
 * No Node, no DOM: the core, the CLI's formatter and tests all read it.
 */
import { missionPhase, missionVerification, isOpenDelegation, isOpenProposal, taskPhase } from './delegatedState';
import { summariseVerification, type VerificationVerdict } from './verification';
import type { ExecutionAttempt, Mission, MissionFinish, MissionState, Task, TaskState } from './types';

export const MISSION_FINISHES: readonly MissionFinish[] = ['merge-local', 'pull-request', 'keep', 'discard'];

export function isMissionFinish(v: unknown): v is MissionFinish {
  return typeof v === 'string' && (MISSION_FINISHES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/**
 * What a mission is waiting on, in one word. An enumeration that may grow: a
 * reader that does not know a kind shows its `text`.
 */
export type MissionWaitKind =
  /** Something only the user can answer: a task needs a person, planning failed, a worker asks. */
  | 'needs-you'
  /** A single-task proposal with a recommended route, waiting for Run. */
  | 'route-proposed'
  /** A delegated plan of several tasks, waiting for review and approval. */
  | 'plan-proposal'
  /** The current attempt failed and nothing retried it. */
  | 'attempt-failed'
  /** A finished attempt waits to be accepted, or a finished mission waits for its finish choice. */
  | 'ready-for-review'
  /** An agent asked to merge locally; the user has not confirmed it yet. */
  | 'merge-confirmation'
  /** Planning, routing, running or verifying: nothing to do but wait. */
  | 'working'
  /** Finished, failed or cancelled. */
  | 'nothing';

export interface MissionWait {
  kind: MissionWaitKind;
  /** One line: "t1 attempt 2 failed — retry or skip it in the app". */
  text: string;
  /** The task it is about, when one is. */
  taskKey?: string;
}

export interface DiffStat {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface VerificationStageInspection {
  /** `command:test`, `diff-sanity`, `review`, … */
  strategy: string;
  required: boolean;
  /** `passed`, `failed`, `inconclusive`, `error`, `unavailable`; absent: not run (yet). */
  outcome?: string;
  summary?: string;
}

export interface TaskInspection {
  taskId: string;
  key: string;
  title: string;
  state: TaskState;
  stateReason?: string;
  /** The row phase the Missions page shows (`needs-you`, `running`, `done`, …). */
  phase: string;
  attempt?: { n: number; state: string };
  verification: {
    verdict: VerificationVerdict;
    summary: string;
    /** The plan's stages with what the current attempt got for each. Empty: no checks are configured. */
    stages: VerificationStageInspection[];
  };
  branch?: string;
  diff?: DiffStat;
}

export interface MissionInspection {
  missionId: string;
  title: string;
  state: MissionState;
  stateReason?: string;
  /** The phase text the Missions page and the origin row read ("ready to merge", "running · 1/2 done"). */
  phase: string;
  waitingOn: MissionWait;
  /** The repository's folder name only; never a full path. */
  repo: string;
  baseRef: string;
  branch?: string;
  /** Summed over the tasks' current attempts, each against the commit it started from. */
  diff?: DiffStat;
  /** C2: every required task's current attempt passed its checks. */
  verification: { verdict: 'verified' | 'unverified' | 'failed'; noChecks: boolean };
  finish?: MissionFinish;
  finishResult?: { mergeCommit?: string; pullRequestUrl?: string; note?: string };
  tasks: TaskInspection[];
  /** Relative to the agent asking: its own delegation, another's, or nobody's (no origin, or not a durable agent's). */
  origin: 'yours' | 'other' | 'none';
  createdAt: number;
  updatedAt: number;
}

export interface InspectContext {
  /** The durable agent holding the mission's origin conversation, if any. */
  missionAgentId?: string;
  /** The durable agent asking, if any. */
  callerAgentId?: string;
  /** A merge confirmation is waiting on the user for this mission. */
  pendingConfirmation?: boolean;
}

function currentAttempt(m: Mission, t: Task): ExecutionAttempt | undefined {
  const id = t.attemptIds.at(-1);
  return id ? m.attempts.find((a) => a.id === id) : undefined;
}

function diffOf(a: ExecutionAttempt | undefined): DiffStat | undefined {
  const g = a?.git;
  return g ? { commits: g.commits, filesChanged: g.filesChanged, insertions: g.insertions, deletions: g.deletions } : undefined;
}

function sumDiffs(diffs: (DiffStat | undefined)[]): DiffStat | undefined {
  const known = diffs.filter((d): d is DiffStat => d !== undefined);
  if (known.length === 0) return undefined;
  return known.reduce((s, d) => ({
    commits: s.commits + d.commits,
    filesChanged: s.filesChanged + d.filesChanged,
    insertions: s.insertions + d.insertions,
    deletions: s.deletions + d.deletions,
  }));
}

/** The task a finished, unaccepted attempt is waiting on, for Accept. */
function acceptable(m: Mission): Task[] {
  return m.tasks.filter((t) => t.state === 'needs-human' && currentAttempt(m, t)?.state === 'succeeded');
}

/** One task, as `aw mission <id>` prints it. */
export function taskInspection(m: Mission, t: Task): TaskInspection {
  const a = currentAttempt(m, t);
  const summary = summariseVerification(t.verification, a?.verification ?? []);
  const results = a?.verification ?? [];
  const stages = t.verification.stages.map((s): VerificationStageInspection => {
    const r = results.find((x) => x.strategy === s.strategy && x.state === 'finished');
    return {
      strategy: s.strategy,
      required: s.required,
      ...(r?.outcome ? { outcome: r.outcome } : {}),
      ...(r?.summary ? { summary: r.summary } : {}),
    };
  });
  const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
  const branch = t.result?.branch ?? wt?.branch;
  const diff = diffOf(a);
  return {
    taskId: t.id,
    key: t.key,
    title: t.title,
    state: t.state,
    ...(t.stateReason ? { stateReason: t.stateReason } : {}),
    phase: taskPhase(m, t).phase,
    ...(a ? { attempt: { n: a.n, state: a.state } } : {}),
    verification: { verdict: a ? summary.verdict : 'unverified', summary: a ? summary.summary : 'Not run yet.', stages },
    ...(branch ? { branch } : {}),
    ...(diff ? { diff } : {}),
  };
}

/** What the mission is waiting on (needs you, route proposed, plan proposal, attempt failed, ready for review, …). */
export function missionWait(m: Mission, pendingConfirmation = false): MissionWait {
  if (['completed', 'cancelled', 'failed'].includes(m.state)) return { kind: 'nothing', text: m.state === 'completed' ? 'finished' : m.state };
  if (pendingConfirmation) return { kind: 'merge-confirmation', text: 'a local merge an agent asked for — the user confirms or declines it in the Missions page' };
  if (isOpenProposal(m) && !m.startApproval) {
    const t = m.tasks[0];
    return t.state === 'routed'
      ? { kind: 'route-proposed', text: 'route proposed — the user starts it (Run task) in the app', taskKey: t.key }
      : { kind: 'needs-you', text: 'no route recommended — the user picks one in the app', taskKey: t.key };
  }
  if (isOpenDelegation(m)) {
    if (m.state === 'plan-review') return { kind: 'plan-proposal', text: `plan of ${m.tasks.length} task(s) — the user reviews and approves it in the app` };
    if (m.state === 'planning-failed') return { kind: 'needs-you', text: 'could not be planned — plan again or write the plan in the app' };
    return { kind: 'working', text: 'planning' };
  }
  if (m.state === 'plan-review') return { kind: 'plan-proposal', text: 'plan review — nothing runs until the user approves it' };
  if (m.state === 'planning-failed') return { kind: 'needs-you', text: 'could not be planned' };
  if (m.state === 'review') {
    if (m.pendingFinish?.uncertain) return { kind: 'needs-you', text: `finish outcome unknown: ${m.pendingFinish.uncertain.why}` };
    if (m.pendingFinish) return { kind: 'working', text: 'finishing' };
    return { kind: 'ready-for-review', text: 'accepted, not merged yet — choose merge, pull request, keep or discard' };
  }
  for (const t of m.tasks) {
    if (t.state !== 'needs-human') continue;
    const a = currentAttempt(m, t);
    if (a?.state === 'succeeded') return { kind: 'ready-for-review', text: `${t.key} finished — accept it (or retry)`, taskKey: t.key };
    if (a?.state === 'failed') return { kind: 'attempt-failed', text: `${t.key} attempt ${a.n} failed — retry, skip or cancel`, taskKey: t.key };
    return { kind: 'needs-you', text: `${t.key} needs you${t.stateReason ? `: ${t.stateReason}` : ''}`, taskKey: t.key };
  }
  const asking = m.tasks.find((t) => currentAttempt(m, t)?.state === 'waiting-human');
  if (asking) return { kind: 'needs-you', text: `${asking.key}'s agent is asking something in its own conversation`, taskKey: asking.key };
  if (m.state === 'paused') return { kind: 'needs-you', text: 'paused — resume it in the app' };
  return { kind: 'working', text: missionPhase(m).text };
}

export function missionInspection(m: Mission, ctx: InspectContext = {}): MissionInspection {
  const tasks = m.tasks.map((t) => taskInspection(m, t));
  const branch = m.planned ? (m.integration !== 'none' ? m.integration.branch : undefined) : (tasks[0]?.branch ?? m.worktrees.at(-1)?.branch);
  const diff = sumDiffs(m.tasks.filter((t) => t.state !== 'skipped').map((t) => diffOf(currentAttempt(m, t))));
  const origin: MissionInspection['origin'] =
    ctx.missionAgentId === undefined ? 'none' : ctx.callerAgentId !== undefined && ctx.callerAgentId === ctx.missionAgentId ? 'yours' : 'other';
  return {
    missionId: m.id,
    title: m.title,
    state: m.state,
    ...(m.stateReason ? { stateReason: m.stateReason } : {}),
    phase: missionPhase(m).text,
    waitingOn: missionWait(m, ctx.pendingConfirmation === true),
    repo: m.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? '',
    baseRef: m.base.ref,
    ...(branch ? { branch } : {}),
    ...(diff ? { diff } : {}),
    verification: missionVerification(m),
    ...(m.finish ? { finish: m.finish } : {}),
    ...(m.finishResult ? { finishResult: m.finishResult } : {}),
    tasks,
    origin,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The grant decision
// ---------------------------------------------------------------------------

/** What a granted agent may ask for. Nothing else exists on this path. */
export type AgentMissionAct =
  /** Accept a finished attempt; optionally choose how to finish in the same step (a single-task mission then leaves review at once). */
  | { kind: 'accept'; taskId?: string; finish?: MissionFinish }
  | { kind: 'finish'; how: MissionFinish }
  | { kind: 'cancel' };

export type GrantRefusal =
  /** The conversation asking is not a durable agent's, so there is nobody to grant. */
  | 'not-an-agent'
  /** The agent's grant is off (the default). */
  | 'grant-off'
  /** The mission was delegated by another conversation, or by nobody's. */
  | 'wrong-origin'
  /** The mission (or the task) has not passed its verification checks. */
  | 'unverified'
  /** Not something that can be done to this mission now (wrong state, nothing to accept, a finish under way). */
  | 'not-available';

export type GrantDecision = { ok: true; needsConfirmation: boolean; taskId?: string } | { ok: false; code: GrantRefusal; reason: string };

export interface GrantInput {
  /** The durable agent asking, and whether its grant is on. Undefined: the conversation is not an agent's. */
  caller: { agentId: string; granted: boolean } | undefined;
  /** The durable agent holding the mission's origin conversation, or undefined. */
  missionAgentId: string | undefined;
  mission: Mission;
  act: AgentMissionAct;
}

const refuse = (code: GrantRefusal, reason: string): GrantDecision => ({ ok: false, code, reason });

/** A finish that would move the base branch: only ever on the user's confirmation. */
export function needsUserConfirmation(how: MissionFinish | undefined): boolean {
  return how === 'merge-local';
}

/**
 * May this agent do this to this mission? Checked in a fixed order, so the
 * reason given is the first thing that is wrong: who is asking, the grant,
 * whose mission it is, whether it can be done now, and whether it passed.
 */
export function grantDecision(input: GrantInput): GrantDecision {
  const { caller, mission: m, act } = input;
  if (!caller) return refuse('not-an-agent', 'This conversation is not a durable agent’s, so no grant applies. The user can act on the mission in the Missions page.');
  if (!caller.granted) {
    return refuse('grant-off', 'Mission control is off for this agent. The user can turn it on in Preferences → Agents and status → Agent mission control, or act in the Missions page.');
  }
  if (input.missionAgentId === undefined || input.missionAgentId !== caller.agentId) {
    return refuse('wrong-origin', 'This mission was not delegated by this agent. An agent may only act on missions it delegated itself.');
  }
  switch (act.kind) {
    case 'accept': {
      if (act.finish !== undefined && !isMissionFinish(act.finish)) return refuse('not-available', `Unknown finish "${String(act.finish)}".`);
      const ready = acceptable(m);
      const task = act.taskId !== undefined ? m.tasks.find((t) => t.id === act.taskId) : ready.length === 1 ? ready[0] : undefined;
      if (act.taskId !== undefined && !task) return refuse('not-available', 'No such task in this mission.');
      if (!task) {
        return refuse('not-available', ready.length === 0 ? 'There is no finished attempt to accept.' : `${ready.length} tasks are ready; name one with --task.`);
      }
      if (!ready.includes(task)) return refuse('not-available', `${task.key} has no finished attempt to accept.`);
      const a = currentAttempt(m, task);
      const verdict = summariseVerification(task.verification, a?.verification ?? []).verdict;
      if (verdict !== 'passed') {
        return refuse('unverified', `${task.key} is ${verdict}, not verified. An agent never accepts an unverified result; the user decides in the Missions page.`);
      }
      return { ok: true, needsConfirmation: needsUserConfirmation(act.finish), taskId: task.id };
    }
    case 'finish': {
      if (!isMissionFinish(act.how)) return refuse('not-available', `Unknown finish "${String(act.how)}".`);
      if (m.state !== 'review') return refuse('not-available', `The mission is ${m.state}, not ready for review: there is nothing to finish yet.`);
      if (m.pendingFinish) return refuse('not-available', 'A finish is already under way for this mission.');
      if (missionVerification(m).verdict !== 'verified') return refuse('unverified', 'The mission is not verified. An agent never finishes an unverified mission; the user decides in the Missions page.');
      return { ok: true, needsConfirmation: needsUserConfirmation(act.how) };
    }
    case 'cancel': {
      if (['completed', 'cancelled', 'failed'].includes(m.state)) return refuse('not-available', `The mission is already ${m.state}.`);
      if (m.pendingFinish) return refuse('not-available', 'A finish is under way for this mission.');
      if (missionVerification(m).verdict !== 'verified') return refuse('unverified', 'The mission is not verified. An agent never acts on an unverified mission; the user can cancel it in the Missions page.');
      return { ok: true, needsConfirmation: false };
    }
    default:
      return refuse('not-available', 'Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Audit and confirmations (what the Missions page shows)
// ---------------------------------------------------------------------------

/** One line of the grant's audit trail. Ids, names the user gave, and reasons we wrote; never prompts or transcript text. */
export interface MissionGrantAuditEntry {
  id: string;
  at: number;
  /** Absent for a grant switched on or off (no mission). */
  missionId?: string;
  agentId: string;
  agentName: string;
  /** `accept`, `finish`, `cancel`, `grant` (switched on or off), `confirm` (the user's answer to a merge request). */
  act: 'accept' | 'finish' | 'cancel' | 'grant' | 'confirm';
  how?: MissionFinish;
  /**
   * `done`: carried out. `requested`: a merge waits for the user. `refused`:
   * the grant decision said no (`code`). `failed`: allowed, but the action
   * itself did not go through. `confirmed`/`declined`: the user's answer.
   * `on`/`off`: the grant switched.
   */
  outcome: 'done' | 'requested' | 'refused' | 'failed' | 'confirmed' | 'declined' | 'stale' | 'on' | 'off';
  code?: GrantRefusal;
  reason?: string;
}

/** A local merge an agent asked for, waiting for the user's yes or no. */
export interface MissionConfirmationRequest {
  id: string;
  missionId: string;
  agentId: string;
  agentName: string;
  how: MissionFinish;
  at: number;
  state: 'pending' | 'confirmed' | 'declined' | 'stale';
  answeredAt?: number;
}

/** What the Missions page shows under a mission: a pending request with its two buttons, and the latest audit lines. */
export interface MissionAgentActivityView {
  pending?: { requestId: string; agentName: string; how: MissionFinish; at: number };
  audit: { at: number; agentName: string; text: string; tone: 'ok' | 'refused' | 'pending' }[];
}

const ACT_VERB: Record<MissionGrantAuditEntry['act'], string> = {
  accept: 'accept',
  finish: 'finish',
  cancel: 'cancel',
  grant: 'grant',
  confirm: 'merge',
};

const FINISH_WORD: Record<MissionFinish, string> = {
  'merge-local': 'merge locally',
  'pull-request': 'open a pull request',
  keep: 'keep the branch',
  discard: 'discard',
};

/** One audit entry as the Missions page lists it: "accepted t1 and opened a pull request", "refused: unverified". */
export function auditLine(e: MissionGrantAuditEntry): { text: string; tone: 'ok' | 'refused' | 'pending' } {
  const what = e.act === 'finish' && e.how ? FINISH_WORD[e.how] : e.act === 'accept' && e.how ? `accept and ${FINISH_WORD[e.how]}` : ACT_VERB[e.act];
  switch (e.outcome) {
    case 'done':
      return { text: `${what}: done`, tone: 'ok' };
    case 'requested':
      return { text: `asked to ${what}: waiting for your confirmation`, tone: 'pending' };
    case 'refused':
      return { text: `${what}: refused (${e.code ?? 'refused'})`, tone: 'refused' };
    case 'failed':
      return { text: `${what}: failed${e.reason ? ` — ${e.reason}` : ''}`, tone: 'refused' };
    case 'confirmed':
      return { text: 'you confirmed the merge', tone: 'ok' };
    case 'declined':
      return { text: 'you declined the merge', tone: 'refused' };
    case 'stale':
      return { text: `merge request withdrawn${e.reason ? ` — ${e.reason}` : ''}`, tone: 'refused' };
    case 'on':
      return { text: 'mission control turned on', tone: 'ok' };
    case 'off':
      return { text: 'mission control turned off', tone: 'refused' };
  }
}

/** The agent activity for one mission: its pending request, and its newest audit lines first (at most `limit`). */
export function agentActivityOf(
  missionId: string,
  audit: readonly MissionGrantAuditEntry[],
  requests: readonly MissionConfirmationRequest[],
  limit = 6,
): MissionAgentActivityView | undefined {
  const lines = audit.filter((e) => e.missionId === missionId);
  const pending = requests.find((r) => r.missionId === missionId && r.state === 'pending');
  if (lines.length === 0 && !pending) return undefined;
  return {
    ...(pending ? { pending: { requestId: pending.id, agentName: pending.agentName, how: pending.how, at: pending.at } } : {}),
    audit: lines
      .slice(-limit)
      .reverse()
      .map((e) => ({ at: e.at, agentName: e.agentName, ...auditLine(e) })),
  };
}

/** A grant per durable agent, as stored. Absent agent: off. */
export interface MissionGrantRecord {
  agentId: string;
  grantedAt: number;
}

/** What Preferences lists: every durable agent, and whether its grant is on. */
export interface MissionGrantAgentView {
  agentId: string;
  name: string;
  role?: string;
  granted: boolean;
  grantedAt?: number;
}
