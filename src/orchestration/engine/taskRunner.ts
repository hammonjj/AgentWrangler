/**
 * Runs a task: an objective, acceptance criteria and a route the user picked
 * become a worktree and branch of their own, an attempt in a session host,
 * and in the end a branch with a diff (`docs/plans/intelligent-orchestration.md`
 * §7.5, §23, §29 P3; #33).
 *
 * Single-task missions only: no planner, no mission branch, no verification
 * (#35) and no routing (#38). What it does own is the part that has to be
 * right from the start, because it is where orchestration state meets #4's
 * session lifecycle:
 *
 * - **Write-ahead** (§23.2). The attempt is saved `launching`, with its
 *   Claude session id chosen in advance, before `SessionExecutors.launch` is
 *   called; the worktree is saved `creating` before any git work. A crash in
 *   between leaves a record that says what happened, never an unowned session.
 * - **Finishing is read from the handle**, not only from a turn-end event:
 *   idle, nothing pending, nothing in the background, and a turn seen to end
 *   (or a recovery, when it may have ended while the core was away) (§7.5).
 * - **Recovery** (§23.3) runs once #4 has adopted hosts and rejoined Codex
 *   threads. It reattaches live attempts, and gives interrupted ones Resume
 *   attempt and Retry fresh. It never resumes by itself, except once under a
 *   mission's `autoRecover`, and never after a host crash.
 *
 * Every mutation of a mission runs through a per-mission queue, so one
 * writer at a time; the store is written after every change.
 *
 * **Planned missions** (#43, §29 P8) are the same machinery with more than one
 * task. They are written by hand (the planner is #44), edited in plan review
 * (`domain/plan.ts`), and nothing about them runs until the user presses
 * Approve and start (`approvePlan`), in any routing mode. Then their tasks run
 * one at a time in dependency order, in **one mission worktree on the mission
 * branch** (`aw/<mission>/mission`): each attempt starts from the head the
 * task before it left, so a `code` dependency holds without a merge. A task
 * whose checks pass is done by verification and the next starts; anything
 * else waits for the user, as a single task does. A fresh retry keeps the
 * rejected work on its own branch and restarts from the pre-task commit on
 * `aw/<mission>/<task>-a<n>`, in the same tree.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Disposable } from '../../core/events';
import type { LaunchDefaults } from '../../core/launchDefaults';
import type { SessionExecutors } from '../../core/session/sessionExecutors';
import type { SessionHandle, SessionViewEvent } from '../../core/session/sessionHandle';
import type { SessionRecord, SessionRegistry } from '../../core/session/sessionRegistry';
import type { PermissionModeName } from '../../shared/conversation';
import type { LaunchPolicy } from '../../shared/launchPolicy';
import { DEFAULT_REPO_POLICY } from '../../shared/orchestration/repoPolicy';
import type { TaskFinalRecord, TelemetryRecord, TurnRecord } from '../../shared/orchestration/telemetry';
import { TELEMETRY_SCHEMA_VERSION } from '../../shared/orchestration/telemetry';
import type { PlanEdit, PlanTaskDraft } from '../../shared/orchestration/plan';
import {
  EFFORT_LEVELS,
  LAUNCHING_ACTIONS,
  isOrchestrationOrigin,
  type AttemptState,
  type EffortLevel,
  type EscalationDecision,
  type RouteDimension,
  type RouteRequirement,
  type ExecutionAttempt,
  type ExecutionPolicy,
  type ExecutionTarget,
  type HarnessId,
  type Mission,
  type MissionFinish,
  type ModelSourceId,
  type OrchestrationOrigin,
  type OutcomeCategory,
  type PolicyChange,
  type PolicyLayers,
  type RoutePins,
  type RouteRecommendation,
  type RoutingDecision,
  type RoutingReason,
  type TaskAssessment,
  type Task,
  type TaskKind,
  type TaskState,
  type VerificationResult,
  type WorktreeAssignment,
} from '../../shared/orchestration/types';
import { ulid } from '../domain/ids';
import { dependenciesSatisfied, taskMachine, transitionAttempt, transitionMission, transitionTask } from '../domain/lifecycles';
import { applyPlanEdit, executionOrder, planIssues, tasksFromDraft, type PlanContext } from '../domain/plan';
import { MissionFinisher } from './missionFinish';
import type { AgentHarness } from '../harness/types';
import type { Assessor } from '../policy/assessor';
import type { LoadedRepoPolicy, RepoPolicyStore } from '../policy/repoPolicyStore';
import type { MissionStore } from '../store/missionStore';
import { slugify, taskBranch } from '../worktrees/naming';
import { nodeExec, type Exec } from '../worktrees/exec';
import type { WorktreeManager } from '../worktrees/worktreeManager';
import type { Reviewer } from '../verify/reviewer';
import { Verifier } from '../verify/verifier';
import { buildVerificationPlan, summariseVerification } from '../../shared/orchestration/verification';
import { isEndpointSource } from '../../shared/orchestration/localEndpoints';
import type { HealthState } from '../../shared/orchestration/sourceHealth';
import type { LocalRunMetrics } from '../../shared/orchestration/telemetry';
import { DEFAULT_TIERS, isKnown, nativeEffortFor, tierRank } from '../../shared/orchestration/catalog';
import {
  admissionRefusal,
  asTaskOverrides,
  checkPolicyEdit,
  compactPolicy,
  conflictText,
  missionLayer,
  missionLayers,
  pinnedDimensions,
  policyContextFor,
  policyDiff,
  resolveEffectivePolicy,
  scopeName,
  taskLayer,
  validateExecutionPolicy,
  type AdmissionFacts,
  type EffectivePolicy,
  type PolicyContext,
} from '../../shared/orchestration/executionPolicy';
import { resolveRoute, type ResolverSnapshot } from '../policy/resolver';
import { compareRoutes, recommendRoute } from '../policy/recommend';
import { changesRoute, decideEscalation, limitsFor, type EscalationInput, type EscalationLimits, type ProbeAnswer, type ProbeRequest } from '../policy/escalation';
import { classifyOutcome, type Classification } from '../policy/outcome';
import { attemptRecord, addTurnUsage, escalationRecord, routingRecord, waitedMs } from './attemptRecord';
import { attemptLaunchPolicy, attemptPermissionMode, attemptPrompt } from './attemptPolicy';
import { sessionVerdict, turnFailure, turnMessageIds, type HandleView, type SessionVerdict } from './sessionVerdict';

/** What the user picked: harness, model, effort and (Claude) permission mode (#33 "manual route"). */
export interface TaskRoute {
  harness: HarnessId;
  /**
   * Where the model runs, when it is not the harness's own login: a
   * registered endpoint's `local:<id>` (#51). Absent: the harness's source.
   */
  source?: ModelSourceId;
  /** Empty or absent: the harness's own default model. */
  model?: string;
  /** The model's native effort level. Empty or absent: none is sent. */
  effort?: string;
  /** Claude only. Absent: `auto`, capped by the app's default (§24.1). */
  permissionMode?: PermissionModeName;
}

export interface NewTask {
  /** Any folder inside the repository; the task runs against its primary checkout. */
  folder: string;
  title?: string;
  objective: string;
  acceptanceCriteria: string[];
  /**
   * What sort of work it is, which decides its verification plan (#35).
   *
   * Defaults to `feature`: until the assessor exists (#37) nothing can tell,
   * and a person who asked an agent to go and do something in a worktree is
   * expecting files to change — which is why an empty diff has always failed
   * a task here.
   */
  kind?: TaskKind;
  route: TaskRoute;
  /** What the branch is cut from. Default: the primary checkout's `HEAD`. */
  baseRef?: string;
  /** The conversation that handed it off (`aw task`), where its proposal is shown (#81). */
  origin?: Mission['origin'];
  /**
   * The mission's policy, frozen when it is recorded (§10.2): caps, preferences
   * and exclusions the router and resolver honour. `mode` is set by the entry
   * point — `start` is `manual`, `propose` is `assisted` — not by this field.
   */
  policy?: ExecutionPolicy;
}

/** A task the router is to propose a route for (`assisted`, #38): everything but the route. */
export type NewTaskDraft = Omit<NewTask, 'route'>;

/**
 * A mission the user writes by hand (#43): an objective and a plan of tasks,
 * recorded straight into plan review. Nothing runs until `approvePlan`.
 */
export interface NewMission {
  folder: string;
  title?: string;
  objective: string;
  /** The plan. Absent or empty: one task, the objective itself, to be edited in review. */
  tasks?: PlanTaskDraft[];
  baseRef?: string;
  /** Caps, preferences and `maxTasks` (default 8, never above 12). `mode` is always `manual` in P8. */
  policy?: ExecutionPolicy;
}

/** What the user did with an `assisted` proposal: took it (no route), or changed it (their route). */
export interface ProposalChoice {
  route?: TaskRoute;
}

/** A refusal or failure the user should read. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

/** What can be done with a task now. The launcher's task menu offers these (#34 draws them properly). */
export type TaskAction = 'show-session' | 'open-diff' | 'accept' | 'resume' | 'retry' | 'recreate-worktree' | 'skip' | 'edit-policy' | 'cancel';

export interface TaskRunnerDeps {
  store: Pick<MissionStore, 'save' | 'loadActive'>;
  harnesses: ReadonlyMap<HarnessId, AgentHarness>;
  sessions: Pick<SessionExecutors, 'get' | 'onDidChange'>;
  registry: Pick<SessionRegistry, 'all' | 'get'> & Partial<Pick<SessionRegistry, 'restoreOrigin'>>;
  repoPolicies: Pick<RepoPolicyStore, 'forFolder'>;
  /** A worktree manager for a repository under its policy, recording every assignment through `record`. */
  openWorktrees: (policy: LoadedRepoPolicy, record: (a: WorktreeAssignment) => void) => Promise<WorktreeManager>;
  launchDefaults: Pick<LaunchDefaults, 'for'>;
  /** Why an attempt on this harness cannot start now (G1: Claude attempts need session hosts), or undefined. */
  cannotLaunch?: (harness: HarnessId) => string | undefined;
  /**
   * Describes what the work is like (#37). Absent: tasks run unassessed, as
   * they did before P5. It never gates a launch — the route here is the
   * user's, so the assessment is recorded beside the running attempt, for the
   * strip, the telemetry and (from #38) the shadow router.
   */
  assessor?: Pick<Assessor, 'assess'>;
  /** The catalog's tier for a model, recorded on the routing decision as history. */
  tierOf?: (source: ModelSourceId, model: string) => string | undefined;
  /**
   * The global scope's pins, caps, preferences and exclusions (§10.2, #40),
   * read when a mission is recorded and frozen into it. Absent: none.
   */
  globalPolicy?: () => ExecutionPolicy | undefined;
  /**
   * The catalog and source health the resolver decides against (#38), read
   * fresh for every recommendation. Absent: no recommendations — `manual`
   * attempts record no shadow and `propose` refuses.
   */
  routing?: { snapshot(): ResolverSnapshot };
  /**
   * The registered local endpoints (#51). A running attempt on one whose
   * server stops answering is ended as `infra` and, where the route allows,
   * failed over to another model of the same tier. Absent: no local models.
   */
  local?: {
    /** Read the endpoint's health now. */
    check(source: ModelSourceId): Promise<HealthState>;
    /** Fires when an endpoint is read as `down`. */
    onDown(listener: (source: ModelSourceId) => void): Disposable;
    /** What an attempt record says about the endpoint and model (runtime, device, context window). */
    facts?(source: ModelSourceId, model: string): Omit<LocalRunMetrics, 'source'> | undefined;
  };
  /** `attempt` records go here (the telemetry log); turn records carry the attempt id already (#27). */
  telemetry?: { append(record: TelemetryRecord): boolean };
  /** Every turn record as it is written, to sum each attempt's usage. */
  onTurnRecord?: (listener: (record: TurnRecord) => void) => Disposable;
  notify?: (notice: { title: string; body: string; onClick?: () => void }) => void;
  /** Where diffs are written for the user to open. */
  diffsDir: string;
  /** Where verification writes each stage's output: `<logsDir>/<attemptId>/<stage>.log` (#35). */
  logsDir: string;
  /** How verification commands are run. Injected so a test can script pass, fail, flaky and timeout. */
  exec?: Exec;
  /** The review-agent verifier (#36). Absent: `review` stages are `unavailable`. */
  reviewer?: Pick<Reviewer, 'review'>;
  /** Asked to open a diff file once one is written for a notification click. */
  openFile?: (file: string) => void;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  /** How long an idle, finished-looking session must stay so before the attempt finishes. */
  settleMs?: number;
  /** How long plan review waits after an edit before assessing the changed tasks (default 800 ms). */
  previewDelayMs?: number;
  /** §15.3's limits over the defaults for the mission's mode (#41): tests shorten the waits and the wall clock. */
  escalationLimits?: Partial<EscalationLimits>;
  log?: (msg: string) => void;
}

const SOURCE: Record<string, ModelSourceId> = { 'claude-code': 'anthropic', codex: 'openai' };
const PROVIDER: Record<string, 'claude' | 'codex'> = { 'claude-code': 'claude', codex: 'codex' };
const TASK_KEY = 't1';
/** What a resumed attempt is told. */
const CONTINUE_PROMPT =
  'Agent Wrangler lost track of this session and has resumed it. Carry on with the task where you left off; say so and stop when it is done.';
const DEFAULT_SETTLE_MS = 2000;
/** The outcome signature of an attempt whose local model server went away (#51). */
export const LOCAL_SERVER_LOST = 'local-server-lost';
const LOCAL_SERVER_LOST_TEXT = 'its local model server stopped answering';
/** Attempts a task may have, in all, before failover stops trying (when the mission sets no `maxAttempts`). */
const DEFAULT_MAX_ATTEMPTS = 3;
const END_SESSION_WAIT_MS = 15_000;
/** Attempt states in which a session is (or is about to be) the attempt's. */
const LIVE: readonly AttemptState[] = ['launching', 'running', 'waiting-human', 'finishing', 'verifying'];

interface Watcher {
  missionId: string;
  attemptId: string;
  handle: SessionHandle;
  sub: Disposable;
  /** A turn of this attempt ended while watched, or this watch began as a recovery. */
  turnEnded: boolean;
  lastTurn?: unknown;
  /** When the session first looked finished in the current stretch. */
  finishedSince?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Fires when the attempt's active time would reach its wall clock (§15.3). */
  clock?: ReturnType<typeof setTimeout>;
  queued: boolean;
  /** Reattached at start-up, and not yet checked for a prompt that never arrived. */
  checkPrompt: boolean;
}

export class TaskRunner implements Disposable {
  private readonly missions = new Map<string, Mission>();
  private readonly watchers = new Map<string, Watcher>();
  /** Session ids this runner ended itself: their `stopped` is not a person's. */
  private readonly stoppedByUs = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly managers = new Map<string, Promise<WorktreeManager>>();
  private readonly emitter = new Emitter<void>();
  private readonly subs: Disposable[] = [];
  /** A mission worktree being created, before its mission has it on record: assignment id → mission id. */
  private readonly worktreeOwners = new Map<string, string>();
  /** Plan review's pending preview assessments, per mission. */
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Escalation steps waiting to run (a backoff, capacity coming back), by decision id (#41). */
  private readonly escalationTimers = new Map<string, { missionId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly now: () => number;
  private readonly random: (bytes: number) => Uint8Array;
  private readonly settleMs: number;
  private readonly log: (msg: string) => void;
  private disposed = false;

  readonly onDidChange = (listener: () => void): Disposable => this.emitter.event(listener);

  constructor(private readonly deps: TaskRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? ((n) => randomBytes(n));
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    this.log = deps.log ?? (() => undefined);
    this.subs.push(deps.sessions.onDidChange(() => this.pokeAll()));
    if (deps.onTurnRecord) this.subs.push(deps.onTurnRecord((r) => this.onTurnRecord(r)));
    if (deps.local) this.subs.push(deps.local.onDown((source) => this.onLocalDown(source)));
  }

  // ---- Reading ----

  /** Every mission this runner knows, newest first. */
  list(): Mission[] {
    return [...this.missions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(missionId: string): Mission | undefined {
    return this.missions.get(missionId);
  }

  /**
   * The task the mission is on: its only task, or in a planned mission the
   * first one in run order that is not finished (§29 P8: one at a time).
   */
  currentTask(m: Mission): Task {
    if (m.tasks.length <= 1 || !isPlanned(m)) return m.tasks[0];
    const order = executionOrder(m.tasks);
    return order.find((t) => !['done', 'skipped', 'cancelled', 'failed'].includes(t.state)) ?? order.at(-1) ?? m.tasks[0];
  }

  /** The current task's current attempt. */
  currentAttempt(m: Mission, taskId?: string): ExecutionAttempt | undefined {
    const task = taskId ? m.tasks.find((t) => t.id === taskId) : this.currentTask(m);
    const id = task?.attemptIds.at(-1);
    return id ? m.attempts.find((a) => a.id === id) : undefined;
  }

  /** The session the current (or the named) task's current attempt runs in, if one is live here. */
  handleOf(missionId: string, taskId?: string): SessionHandle | undefined {
    const m = this.missions.get(missionId);
    const a = m && this.currentAttempt(m, taskId);
    const id = a?.assignment.sessionIds.at(-1);
    return id ? this.deps.sessions.get(id) : undefined;
  }

  /** What the user can do with the mission's current task now (or with the named one). */
  actions(missionId: string, taskId?: string): TaskAction[] {
    const m = this.missions.get(missionId);
    if (!m) return [];
    const current = this.currentTask(m);
    const task = (taskId && m.tasks.find((t) => t.id === taskId)) || current;
    const a = this.currentAttempt(m, task.id);
    const out: TaskAction[] = [];
    if (this.handleOf(missionId, task.id)) out.push('show-session');
    const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (a?.git && a.git.filesChanged > 0 && wt && wt.state !== 'removed') out.push('open-diff');
    // Only the task the mission is on can be acted on: the rest have finished or have not started.
    const live = task.id === current.id && ['running', 'paused'].includes(m.state);
    // A proposal nobody has started (#38) is started from the launcher's task menu, not retried.
    if (task.state === 'needs-human' && task.attemptIds.length > 0 && (live || !isPlanned(m))) {
      if (a?.state === 'succeeded') out.push('accept');
      if (a?.state === 'interrupted' && a.resumable && wt?.state !== 'missing') out.push('resume');
      if (wt?.state === 'missing') out.push('recreate-worktree');
      out.push('retry');
    }
    // Skipping is for a task in a plan: the mission carries on without it.
    if (isPlanned(m) && live && ['needs-human', 'blocked'].includes(task.state)) out.push('skip');
    // Pins and caps can change until the mission ends; a change reaches the next attempt (#40).
    if (!['completed', 'cancelled', 'failed', 'review'].includes(m.state)) out.push('edit-policy', 'cancel');
    return out;
  }

  /** The plan's problems as review shows them (§11.2), for a planned mission. */
  planIssues(missionId: string): ReturnType<typeof planIssues> {
    const m = this.missions.get(missionId);
    return m ? planIssues(m) : [];
  }

  // ---- Starting ----

  /**
   * Start a task: record the mission, make its worktree and branch, launch its
   * first attempt. Resolves once the session is launched. Throws `TaskError`
   * for anything the user can fix (no repository, no harness, hosts off); a
   * mission that got as far as being recorded stays recorded, saying why.
   */
  async start(req: NewTask): Promise<Mission> {
    this.checkRoute(req.route);
    const id = await this.record(req, {
      ...req.policy,
      mode: 'manual',
    }, { pins: routePins(req.route) });
    await this.queue(id, () => this.launch(id, { mode: 'fresh', route: req.route }));
    this.scheduleAssessment(id);
    return this.missions.get(id)!;
  }

  /**
   * `assisted` (§10.1, #38): record the task, assess it, and route it — but
   * launch nothing. Resolves with the proposal once the assessment is in
   * (one structured call, or the rules alone at low confidence when it fails),
   * with the task `routed`, or `needs-human` when the proposal says a person
   * must decide (a cap below what the work needs, a plan-first gate, nothing
   * allowed that can run it). `startProposed` launches it; `cancel` drops it.
   */
  async propose(req: NewTaskDraft): Promise<{ mission: Mission; recommendation: RouteRecommendation }> {
    if (!this.deps.assessor) throw new TaskError('Proposing a route needs the assessor, which is not running.');
    if (!this.deps.routing) throw new TaskError('Proposing a route needs the model catalog, which is not available.');
    const id = await this.record(req, { ...req.policy, mode: 'assisted' });
    try {
      return await this.queue(id, async () => {
        let m = this.need(id);
        const tid = m.tasks[0].id;
        const now = this.now();
        for (const to of ['ready', 'assessing'] as TaskState[]) {
          m = this.patchTask(m, tid, (t) => transitionTask(m, t, to, { now, reason: to === 'assessing' ? 'assessing before it is routed' : undefined }));
        }
        this.put(m);
        await this.assess(id, tid);
        m = this.need(id);
        const assessment = latestAssessment(m, tid);
        const rec = assessment && this.recommendationFor(m, tid, assessment);
        if (!rec) throw new TaskError('The task could not be routed: no assessment or no catalog.');
        const at = this.now();
        m = this.patchTask(m, tid, (t) => transitionTask(m, { ...t, recommendation: rec }, 'routed', { now: at, reason: 'route proposed; waiting for you to accept or change it' }));
        if (rec.verdict !== 'route') m = this.patchTask(m, tid, (t) => transitionTask(m, t, 'needs-human', { now: at, reason: rec.note ?? 'a person has to decide the route' }));
        this.put(m);
        this.log(`task ${id}: proposed ${rec.requirement.minTier}/${rec.requirement.effort} → ${rec.resolution.target?.model ?? rec.verdict}`);
        return { mission: this.need(id), recommendation: rec };
      });
    } catch (e) {
      // A proposal that could not be made is not left looking like one waiting for the user.
      await this.cancel(id).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Launch an `assisted` task: on the proposal as offered (one click), or on
   * the route the user changed it to, which is recorded as a labelled
   * disagreement (§10.1). A changed route may not break the mission's tier cap
   * (§10.2: a pin that violates a cap is refused when it is set).
   */
  startProposed(missionId: string, choice: ProposalChoice = {}): Promise<Mission> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      const task = m.tasks[0];
      const rec = task.recommendation;
      if (!rec || task.attemptIds.length > 0 || !['routed', 'needs-human'].includes(task.state)) {
        throw new TaskError('There is no proposal waiting to be started.');
      }
      let route = choice.route;
      const accepted = !route;
      if (!route) {
        const t = rec.resolution.target;
        if (!t || rec.verdict === 'blocked') throw new TaskError(rec.note ?? 'There is no recommended route to accept; pick one.');
        route = { harness: t.harness, model: t.model, ...(isEndpointSource(t.source) ? { source: t.source } : {}), ...(t.effortNative !== 'none' ? { effort: t.effortNative } : {}) };
      }
      this.checkRoute(route);
      // The route becomes the task's pins, which may break no cap at any
      // scope (§10.2): refused here, naming both, before anything is changed.
      const overrides = { ...task.overrides, pins: routePins(route) };
      const conflicts = checkPolicyEdit(missionLayers(m, task), 'task', taskLayer(overrides), this.policyContext());
      if (conflicts.length > 0) throw new TaskError(conflictText(conflicts));
      this.put(this.patchTask(m, task.id, (t) => ({ ...t, overrides })));
      if (!accepted) this.writeProposalOverride(m, rec, route);
      await this.launch(missionId, { mode: 'fresh', route, taskId: task.id, routing: { recommendation: rec, offered: true, accepted } });
      return this.need(missionId);
    });
  }

  /** Record a new single-task mission, not yet started. */
  private async record(req: NewTaskDraft, policy: ExecutionPolicy, overrides?: Task['overrides']): Promise<string> {
    const objective = req.objective.trim();
    if (!objective) throw new TaskError('A task needs an objective.');
    const loaded = this.deps.repoPolicies.forFolder(req.folder);
    if (!loaded) throw new TaskError(`${req.folder} is not in a git repository. A task runs in a worktree of one.`);
    // The policy layers, frozen here (§10.2): the global defaults and the
    // repository's policy as they are now, and what this mission and task set.
    // Anything that conflicts is refused before a mission exists.
    const ctx = this.policyContext();
    const shape = validateExecutionPolicy(policy, { tiers: ctx.tiers });
    if (!shape.ok) throw new TaskError(`The mission's policy is not valid: ${shape.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    const policyLayers: PolicyLayers = {};
    const global = compactPolicy(this.deps.globalPolicy?.());
    const repo = compactPolicy(loaded.policy.routing);
    const own = compactPolicy(shape.policy);
    if (global) policyLayers.global = global;
    if (repo) policyLayers.repo = repo;
    if (own) policyLayers.mission = own;
    const withTask = resolveEffectivePolicy(missionLayers({ policy: {}, policyLayers }, { overrides }), ctx);
    if (withTask.conflicts.length > 0) throw new TaskError(conflictText(withTask.conflicts));
    const effective = resolveEffectivePolicy(missionLayers({ policy: {}, policyLayers }), ctx).policy;
    const manager = await this.manager(loaded);
    const baseRef = req.baseRef?.trim() || 'HEAD';
    const baseCommit = await manager.resolveCommit(baseRef).catch((e: Error) => {
      throw new TaskError(`Cannot start from ${baseRef}: ${e.message}`);
    });
    const now = this.now();
    const id = this.id();
    const title = (req.title?.trim() || firstLine(objective)).slice(0, 120);
    const task: Task = {
      id: this.id(),
      key: TASK_KEY,
      title,
      objective,
      acceptanceCriteria: req.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
      scope: { paths: [], subsystems: [], confidence: 'low' },
      dependsOn: [],
      ...(overrides ? { overrides } : {}),
      // Built from the repository's own policy, and frozen on the task: the
      // checks a result is judged by must be the ones that were in force when
      // it started, not whatever the policy says by the time it finishes (#35).
      kindHint: req.kind ?? 'feature',
      ...(req.kind ? {} : { kindDefaulted: true }),
      verification: buildVerificationPlan({
        kind: req.kind ?? 'feature',
        policy: loaded.policy,
        criteria: req.acceptanceCriteria.filter((c) => c.trim()).length,
      }),
      revision: 1,
      state: 'pending',
      assessmentIds: [],
      attemptIds: [],
      escalations: [],
      createdBy: 'user',
    };
    const mission: Mission = {
      id,
      v: 1,
      title,
      objective,
      repoRoot: manager.repoRoot,
      base: { ref: baseRef, commit: baseCommit },
      integration: 'none',
      policy: effective,
      policyLayers,
      policyChanges: [],
      state: 'draft',
      source: { kind: 'user', trusted: true },
      ...(req.origin ? { origin: { ...req.origin } } : {}),
      tasks: [task],
      assessments: [],
      decisions: [],
      attempts: [],
      worktrees: [],
      createdAt: now,
      updatedAt: now,
    };
    this.put(mission);
    this.log(`task ${id}: recorded in ${mission.repoRoot} (${effective.mode ?? 'manual'} routing)`);
    return id;
  }

  // ---- Policy (§10.2, #40) ----

  /** The policy the task's next attempt would run under, with where each value came from and any conflict. */
  effectivePolicy(missionId: string): EffectivePolicy | undefined {
    const m = this.missions.get(missionId);
    return m ? this.effective(m) : undefined;
  }

  /**
   * Replace the mission's own layer, or the task's overrides.
   *
   * Refused — with a `TaskError` naming both scopes — when the new layer is
   * malformed, when a pin in it breaks a cap at any scope, or when it would
   * leave a pin elsewhere breaking a cap it sets (§10.2: a validation error
   * at the time it is set, never resolved silently). Nothing changes then.
   *
   * On a started mission the change applies to attempts not yet started: a
   * running attempt keeps the policy it launched with and is not restarted.
   * It is recorded as a `PolicyChange` (shown in the mission header) and as
   * `override` and `policy-change` telemetry. On a proposal nobody has
   * started, the proposal is routed again under the new policy.
   */
  setPolicy(missionId: string, scope: 'mission' | 'task', next: ExecutionPolicy | undefined, opts: { reason?: string; taskId?: string } = {}): Promise<Mission> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      if (['completed', 'cancelled', 'failed', 'review'].includes(m.state)) throw new TaskError('The task has finished; its policy no longer changes anything.');
      const ctx = this.policyContext();
      const shape = validateExecutionPolicy(next ?? {}, {
        tiers: ctx.tiers,
        ...(scope === 'task' ? { allowed: ['pins', 'caps', 'preferences', 'exclusions'] } : {}),
      });
      if (!shape.ok) throw new TaskError(shape.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      const layer = compactPolicy(shape.policy);
      // A planned mission's task scope is the task that runs next, unless one is named.
      const task = (opts.taskId ? m.tasks.find((t) => t.id === opts.taskId) : undefined) ?? this.currentTask(m);
      const conflicts = checkPolicyEdit(missionLayers(m, task), scope, layer, ctx);
      if (conflicts.length > 0) throw new TaskError(conflictText(conflicts));
      const before = scope === 'mission' ? missionLayer(m) : taskLayer(task.overrides);
      const diff = policyDiff(before, layer);
      if (diff.length === 0) return m;

      const now = this.now();
      if (scope === 'mission') {
        const layers: PolicyLayers = { ...(m.policyLayers ?? {}), mission: layer };
        if (!layer) delete layers.mission;
        m = { ...m, policyLayers: layers, policy: resolveEffectivePolicy(missionLayers({ policy: {}, policyLayers: layers }), ctx).policy };
      } else {
        m = this.patchTask(m, task.id, (t) => {
          const { overrides: _old, ...rest } = t;
          const overrides = asTaskOverrides(layer);
          return overrides ? { ...rest, overrides } : rest;
        });
      }
      const started = m.state !== 'draft' || task.attemptIds.length > 0;
      let change: PolicyChange | undefined;
      if (started) {
        change = {
          id: this.id(),
          at: now,
          by: 'user',
          scope,
          ...(scope === 'task' ? { taskId: task.id } : {}),
          fields: diff.map((d) => d.field),
          before: before ?? {},
          changed: layer ?? {},
          appliesFromAttempt: task.attemptIds.length + 1,
          ...(opts.reason ? { reason: opts.reason } : {}),
        };
        m = { ...m, policyChanges: [...m.policyChanges, change] };
      } else if (task.recommendation && task.attemptIds.length === 0) {
        m = this.reproposed(m);
      }
      this.put(m);
      this.log(`task ${missionId}: ${scope} policy changed (${diff.map((d) => d.field).join(', ')})${change ? `, from attempt ${change.appliesFromAttempt}` : ''}`);
      this.writeTelemetry(m, {
        v: 1,
        type: 'override',
        id: `override:${change?.id ?? this.id()}`,
        at: now,
        missionId: m.id,
        ...(scope === 'task' ? { taskId: task.id } : {}),
        scope,
        by: 'user',
        via: 'editor',
        changes: diff,
        missionState: m.state,
      });
      if (change) {
        this.writeTelemetry(m, {
          v: 1,
          type: 'policy-change',
          id: `policy-change:${change.id}`,
          at: now,
          missionId: m.id,
          ...(change.taskId ? { taskId: change.taskId } : {}),
          scope,
          fields: change.fields,
          revision: m.policyChanges.length,
          appliesFromAttempt: change.appliesFromAttempt,
          runningAttempts: m.attempts.filter((a) => LIVE.includes(a.state)).length,
        });
      }
      return m;
    });
  }

  /** A proposal nobody has started, routed again under the policy as it now is. */
  private reproposed(m: Mission): Mission {
    const rec = this.recommendationFor(m);
    if (!rec) return m;
    const now = this.now();
    // A proposal is a single-task mission.
    const tid = m.tasks[0].id;
    m = this.patchTask(m, tid, (t) => ({ ...t, recommendation: rec }));
    if (rec.verdict !== 'route' && m.tasks[0].state === 'routed') {
      m = this.patchTask(m, tid, (t) => transitionTask(m, t, 'needs-human', { now, reason: rec.note ?? 'a person has to decide the route' }));
    } else if (rec.verdict === 'route' && m.tasks[0].state === 'needs-human') {
      m = this.patchTask(m, tid, (t) => ({ ...t, stateReason: 'route proposed under the changed policy; waiting for you to accept or change it' }));
    }
    return m;
  }

  /** The tiers and models pins and caps are checked against: the router's catalog, or the default tiers. */
  private policyContext(): PolicyContext {
    try {
      const catalog = this.deps.routing?.snapshot().catalog;
      if (catalog) return policyContextFor(catalog);
    } catch (e) {
      this.log(`policy: could not read the catalog: ${errorText(e)}`);
    }
    return {
      tiers: DEFAULT_TIERS,
      model: (pins) => {
        const model = pins.model?.trim();
        if (!model) return undefined;
        const source = pins.source ?? SOURCE[pins.harness ?? ''];
        const tier = source ? this.deps.tierOf?.(source, model) : undefined;
        return { label: model, ...(tier ? { tier } : {}), ...(source ? { source } : {}) };
      },
    };
  }

  /** Every layer resolved for the task: what its next attempt runs under. */
  private effective(m: Mission, task: Task = this.currentTask(m), ctx: PolicyContext = this.policyContext()): EffectivePolicy {
    return resolveEffectivePolicy(missionLayers(m, task), ctx);
  }

  /**
   * A route with the policy's pins applied (§10.2): a pinned dimension
   * replaces the route's, so a pin set after the last attempt reaches the
   * next one. A pinned effort is sent as the model's own level for it.
   */
  private withPins(route: TaskRoute, pins: RoutePins | undefined): TaskRoute {
    if (!pins) return route;
    const out: TaskRoute = { ...route };
    if (pins.harness && pins.harness !== route.harness) {
      out.harness = pins.harness;
      if (!pins.model) delete out.model;
      delete out.permissionMode;
    }
    if (pins.model) out.model = pins.model;
    if (pins.effort && (!route.effort || awEffort(route.effort) !== pins.effort || out.model !== route.model)) {
      const native = this.nativeEffort(out, pins.effort);
      if (native) out.effort = native;
      else delete out.effort;
    }
    return out;
  }

  /** The model's own level for an AW effort level, from the catalog; the level itself when the model is unknown. */
  private nativeEffort(route: TaskRoute, level: EffortLevel): string | undefined {
    const source = SOURCE[route.harness] ?? route.harness;
    const alias = route.model?.trim() || (route.harness === 'claude-code' ? 'default' : '');
    let entry;
    try {
      entry = alias ? this.deps.routing?.snapshot().catalog.entries.find((e) => e.descriptor.source === source && e.aliases.includes(alias)) : undefined;
    } catch {
      entry = undefined;
    }
    if (!entry) return level;
    const native = nativeEffortFor(entry, level);
    return native === 'none' ? undefined : native;
  }

  /** What the count caps are checked against for the task's next attempt. */
  private admissionFacts(m: Mission, route: TaskRoute, resume: boolean, task: Task = this.currentTask(m)): AdmissionFacts {
    const liveAgents = [...this.missions.values()].reduce((n, x) => n + x.attempts.filter((a) => LIVE.includes(a.state)).length, 0);
    const costs = m.attempts.filter((a) => a.taskId === task.id && a.usage?.costUsd !== undefined).map((a) => a.usage!.costUsd!);
    let windowPercent: number | undefined;
    try {
      const pct = this.deps.routing?.snapshot().sources[SOURCE[route.harness] ?? route.harness]?.capacity.windowPercent;
      if (pct && isKnown(pct)) windowPercent = pct.value;
    } catch {
      windowPercent = undefined;
    }
    return {
      // A resume carries on an interrupted attempt; it is not another try at the
      // task. Escalation's "continue with feedback" is (#41).
      attemptsSoFar: resume ? 0 : m.attempts.filter((a) => a.taskId === task.id && !a.resumeOf).length,
      liveAgents,
      ...(costs.length > 0 ? { spentUsd: costs.reduce((s, c) => s + c, 0) } : {}),
      ...(windowPercent !== undefined ? { windowPercent } : {}),
    };
  }

  /** An `assisted` proposal the user changed: an `override` at task scope, from the recommendation to their route. */
  private writeProposalOverride(m: Mission, rec: RouteRecommendation, route: TaskRoute): void {
    const t = rec.resolution.target;
    const changes: { field: string; from?: string; to?: string }[] = [];
    const add = (field: string, from: string | undefined, to: string | undefined) => {
      if ((from ?? '') !== (to ?? '')) changes.push({ field, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    };
    add('pins.harness', t?.harness, route.harness);
    add('pins.model', t?.model, route.model?.trim() || undefined);
    add('pins.effort', t ? rec.requirement.effort : undefined, route.effort?.trim() ? awEffort(route.effort) : undefined);
    if (changes.length === 0) return;
    this.writeTelemetry(m, {
      v: 1,
      type: 'override',
      id: `override:${this.id()}`,
      at: this.now(),
      missionId: m.id,
      taskId: m.tasks[0].id,
      scope: 'task',
      by: 'user',
      via: 'proposal',
      changes,
      missionState: m.state,
    });
  }

  private writeTelemetry(m: Mission, record: TelemetryRecord): void {
    try {
      this.deps.telemetry?.append(record);
    } catch (e) {
      this.log(`task ${m.id}: could not write its ${record.type} record: ${String(e)}`);
    }
  }

  /** Resume an interrupted attempt: the same session id, through #4's Resume (orphan sweep first). */
  resume(missionId: string, opts: { auto?: boolean } = {}): Promise<void> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      const task = this.currentTask(m);
      const prev = this.currentAttempt(m, task.id);
      if (!prev || prev.state !== 'interrupted' || !prev.resumable) throw new TaskError('There is no interrupted attempt to resume.');
      // An automatic resume queued behind a Cancel (or anything else) must not revive the task.
      if (task.state !== 'needs-human' || !['running', 'paused'].includes(m.state)) throw new TaskError('The task is no longer waiting to be resumed.');
      await this.launch(missionId, { mode: 'continue', resumeOf: prev, auto: opts.auto });
    });
  }

  /**
   * Start again from the base, keeping the last attempt's work for comparison:
   * a new worktree and branch for a single task, or in a planned mission the
   * same tree on a new `-a<n>` branch cut at the commit the task started from.
   */
  retry(missionId: string): Promise<void> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      const task = this.currentTask(m);
      const prev = this.currentAttempt(m, task.id);
      if (task.state !== 'needs-human') throw new TaskError('The task is not waiting for a decision.');
      if (prev && LIVE.includes(prev.state)) {
        // Held by something this build cannot follow: give it up, without touching it.
        m = this.endAttempt(m, prev.id, 'cancelled', { status: 'cancelled' }, 'given up for a fresh retry');
        this.put(m);
      }
      await this.endSession(m, prev);
      if (isPlanned(m)) {
        if (prev) await this.releaseTree(missionId, prev.id);
        m = await this.restartTree(missionId, task.id, prev);
      } else {
        m = await this.retainTree(this.missions.get(missionId)!, prev);
      }
      await this.launch(missionId, { mode: 'fresh', route: this.routeFor(m, task.id, prev), taskId: task.id });
    });
  }

  /**
   * Accept the result: the task is done. A single task's mission goes to
   * review (merge, pull request, keep or discard); a planned mission carries
   * on with its next task. Commits anything the session did after the attempt
   * finished first, so the branch is the result.
   */
  accept(missionId: string): Promise<void> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      const task = this.currentTask(m);
      const a = this.currentAttempt(m, task.id);
      const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
      if (!a || a.state !== 'succeeded' || !wt || task.state !== 'needs-human') throw new TaskError('There is no finished attempt to accept.');
      const manager = await this.managerFor(m);
      // A missing tree has nothing more to commit; any other failure is the user's to see, not to lose.
      const extra = wt.state === 'missing' ? undefined : await manager.commitAll(wt, `aw: ${task.key}: changes after attempt ${a.n}`).catch((e: Error) => {
        throw new TaskError(`Could not commit the changes made after the attempt, so nothing was accepted: ${e.message}`);
      });
      const stats = await manager.diffStats(measured(wt, a));
      if (extra || stats.headCommit !== a.git?.headCommit) {
        m = this.patchAttempt(m, a.id, (x) => ({ ...x, flags: { ...x.flags, userEditedBranch: true } }));
        this.put(m);
      }
      if (isPlanned(m)) {
        await this.markDone(missionId, task.id, 'user', 'accepted by the user');
        await this.endSession(this.need(missionId), a);
        await this.launchNext(missionId);
        return;
      }
      const now = this.now();
      m = this.patchTask(m, task.id, (t) => transitionTask(m, { ...t, result: { branch: wt.branch, commit: stats.headCommit, acceptedBy: 'user' } }, 'done', { now, reason: 'accepted by the user' }));
      m = transitionMission(m, 'finishing', { now });
      m = transitionMission(m, 'review', { now, reason: 'accepted; merge, open a pull request, keep or discard the branch' });
      this.put(m);
      this.writeTaskFinal(m, task.id);
      await this.endSession(m, a);
    });
  }

  /** Stop the mission: its session is ended, its worktrees and branches are kept. */
  cancel(missionId: string): Promise<void> {
    this.clearEscalations(missionId);
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      const a = this.currentAttempt(m);
      if (a && LIVE.includes(a.state)) {
        m = this.endAttempt(m, a.id, 'cancelled', { status: 'cancelled' }, 'cancelled by the user');
        this.put(m);
      }
      await this.endSession(m, a);
      m = await this.retainTree(this.missions.get(missionId)!, a);
      const now = this.now();
      const ended: string[] = [];
      for (const t of m.tasks) {
        if (['done', 'failed', 'cancelled', 'skipped'].includes(t.state)) continue;
        m = this.patchTask(m, t.id, (x) => transitionTask(m, x, 'cancelled', { now, reason: 'cancelled by the user' }));
        ended.push(t.id);
      }
      if (!['completed', 'failed', 'cancelled'].includes(m.state)) m = transitionMission(m, 'cancelled', { now, reason: 'cancelled by the user' });
      this.put(m);
      for (const id of ended) this.writeTaskFinal(m, id);
    });
  }

  // ---- Planned missions (#43) ----

  /**
   * Record a mission written by hand, straight into plan review. The plan is
   * validated first — a cycle, a dangling edge or too many tasks refuses it,
   * saying which — and **nothing runs**: not an attempt, not a worktree.
   * Preview assessments start in the background.
   */
  async createMission(req: NewMission): Promise<Mission> {
    const objective = req.objective.trim();
    if (!objective) throw new TaskError('A mission needs an objective.');
    const loaded = this.deps.repoPolicies.forFolder(req.folder);
    if (!loaded) throw new TaskError(`${req.folder} is not in a git repository. A mission runs in a worktree of one.`);
    const manager = await this.manager(loaded);
    // The branch the primary checkout is on, by name, so review knows what to merge into.
    const baseRef = req.baseRef?.trim() || (await manager.primaryBranch()) || 'HEAD';
    const baseCommit = await manager.resolveCommit(baseRef).catch((e: Error) => {
      throw new TaskError(`Cannot start from ${baseRef}: ${e.message}`);
    });
    const now = this.now();
    const title = (req.title?.trim() || firstLine(objective)).slice(0, 120);
    // The policy layers, frozen here as `record` freezes them (§10.2, #40).
    const ctx = this.policyContext();
    const shape = validateExecutionPolicy(req.policy ?? {}, { tiers: ctx.tiers });
    if (!shape.ok) throw new TaskError(`The mission's policy is not valid: ${shape.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    const policyLayers: PolicyLayers = {};
    const global = compactPolicy(this.deps.globalPolicy?.());
    const repo = compactPolicy(loaded.policy.routing);
    const own = compactPolicy(shape.policy);
    if (global) policyLayers.global = global;
    if (repo) policyLayers.repo = repo;
    if (own) policyLayers.mission = own;
    const layered = resolveEffectivePolicy(missionLayers({ policy: {}, policyLayers }), ctx);
    if (layered.conflicts.length > 0) throw new TaskError(conflictText(layered.conflicts));
    // P8 routes by hand (the launcher's route, or a task's pin); the router's view is a preview.
    const policy: ExecutionPolicy = { ...layered.policy, mode: 'manual' };
    const drafts = req.tasks && req.tasks.length > 0 ? req.tasks : [{ title, objective, acceptanceCriteria: [] }];
    const built = tasksFromDraft(drafts, policy, this.planContext(loaded.policy));
    if (!built.ok) throw new TaskError(`The plan was refused: ${built.problems.join('; ')}.`);
    let mission: Mission = {
      id: this.id(),
      v: 1,
      title,
      objective,
      repoRoot: manager.repoRoot,
      base: { ref: baseRef, commit: baseCommit },
      integration: 'none',
      policy,
      policyLayers,
      policyChanges: [],
      state: 'draft',
      planned: true,
      source: { kind: 'user', trusted: true },
      tasks: built.tasks,
      assessments: [],
      decisions: [],
      attempts: [],
      worktrees: [],
      createdAt: now,
      updatedAt: now,
    };
    mission = transitionMission(mission, 'plan-review', { now, reason: 'written by you: review the plan, then approve and start it' });
    this.put(mission);
    this.log(`mission ${mission.id}: recorded with ${mission.tasks.length} task(s) in ${mission.repoRoot}, waiting for review`);
    this.schedulePreview(mission.id);
    return mission;
  }

  /**
   * One plan-review edit (§11.2): edit, merge, split, reorder, delete, change
   * a dependency, set pins and caps. The whole plan is validated after it, and
   * an edit that would leave a cycle (shown as its path) or break the cap is
   * refused with nothing changed.
   */
  editPlan(missionId: string, edit: PlanEdit): Promise<Mission> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      if (!m.planned) throw new TaskError('Only a planned mission has a plan to edit.');
      const loaded = this.deps.repoPolicies.forFolder(m.repoRoot);
      const r = applyPlanEdit(m, edit, this.planContext(loaded?.policy ?? DEFAULT_REPO_POLICY));
      if (!r.ok) throw new TaskError(`That change was refused: ${r.problems.join('; ')}.`);
      this.put(r.mission);
      this.schedulePreview(missionId);
      return this.need(missionId);
    });
  }

  /**
   * Approve and start (§11.2, §18.4): the only way a planned mission's work
   * begins, in every routing mode. Refused while the plan has an error or a
   * blocker. `route` is the launcher's: what tasks without a pin run on.
   */
  approvePlan(missionId: string, route: TaskRoute): Promise<Mission> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      if (m.state !== 'plan-review' || !m.planned) throw new TaskError('The plan is not waiting for approval.');
      const stops = planIssues(m).filter((i) => i.level !== 'warning');
      if (stops.length > 0) throw new TaskError(`The plan cannot start yet: ${stops.map((i) => i.text).join('; ')}.`);
      this.checkRoute(route);
      const now = this.now();
      m = {
        ...m,
        planApprovedAt: now,
        defaultRoute: { harness: route.harness, ...(route.model?.trim() ? { model: route.model.trim() } : {}), ...(route.effort?.trim() ? { effort: route.effort.trim() } : {}) },
      };
      m = transitionMission(m, 'running', { now, reason: 'plan approved' });
      this.put(m);
      this.log(`mission ${missionId}: plan approved; ${m.tasks.length} task(s) to run in order`);
      await this.launchNext(missionId);
      return this.need(missionId);
    });
  }

  /** Leave a task out of a planned mission and carry on with the rest. Its work, if any, is kept on a branch of its own. */
  skip(missionId: string, taskId?: string): Promise<void> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      if (!isPlanned(m)) throw new TaskError('Only a task in a plan can be skipped.');
      const task = (taskId && m.tasks.find((t) => t.id === taskId)) || this.currentTask(m);
      if (!['needs-human', 'blocked', 'pending'].includes(task.state)) throw new TaskError(`${task.key} is ${task.state}; it cannot be skipped now.`);
      // A capacity wait is `blocked`: skipping the task drops its pending step.
      this.clearEscalations(missionId);
      const a = this.currentAttempt(m, task.id);
      if (a && LIVE.includes(a.state)) {
        m = this.endAttempt(m, a.id, 'cancelled', { status: 'cancelled' }, 'skipped by the user');
        this.put(m);
      }
      await this.endSession(m, a);
      if (a) {
        await this.releaseTree(missionId, a.id);
        await this.setAside(missionId, task.id, a);
      }
      m = this.need(missionId);
      m = this.patchTask(m, task.id, (t) => transitionTask(m, t, 'skipped', { now: this.now(), reason: 'skipped by the user' }));
      this.put(m);
      this.writeTaskFinal(m, task.id);
      await this.launchNext(missionId);
    });
  }

  /**
   * Mission review's buttons (§13.3, §18.4) for a mission whose result is one
   * branch — a single task's, or a planned mission's mission branch: merge it
   * into the base in the primary checkout (`--no-ff`, refused unless that
   * checkout is on the base and clean), push it and open a pull request, keep
   * it, or discard it (its trees go; its branches stay, so nothing is lost).
   */
  finishMission(missionId: string, how: MissionFinish): Promise<Mission> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      if (m.state !== 'review') throw new TaskError('The mission is not waiting for review.');
      const branch = resultBranch(m);
      if (!branch) throw new TaskError('The mission has no result branch.');
      const manager = await this.managerFor(m);
      const finisher = new MissionFinisher({ exec: this.deps.exec ?? nodeExec, repoRoot: m.repoRoot, log: this.log });
      let result: Mission['finishResult'];
      let removeInto: string | undefined;
      switch (how) {
        case 'merge-local': {
          const r = await finisher.mergeLocal({ branch, baseRef: m.base.ref, message: `Merge ${branch}: ${m.title}` });
          if (!r.ok) throw new TaskError(r.why);
          result = { mergeCommit: r.mergeCommit, note: `merged into ${r.into}` };
          removeInto = r.into;
          break;
        }
        case 'pull-request': {
          const r = await finisher.openPullRequest({ branch, baseRef: m.base.ref, title: m.title, body: pullRequestBody(m) });
          if (!r.ok) throw new TaskError(r.why);
          result = { pullRequestUrl: r.url };
          break;
        }
        case 'keep':
          result = { note: `kept on ${branch}` };
          break;
        case 'discard':
          result = { note: `discarded; the branches are kept until you delete them` };
          break;
      }
      // Tidy up what can be tidied without losing anything; a refusal only means a tree stays.
      for (const wt of this.need(missionId).worktrees) {
        if (wt.state === 'removed' || wt.state === 'creating' || wt.state === 'in-use') continue;
        try {
          if (removeInto) {
            const out = await manager.remove(wt, { mergedInto: removeInto });
            if (!out.removed) await manager.release(wt, 'retained').catch(() => undefined);
          } else if (how === 'discard') {
            const head = await manager.headOf(wt).catch(() => undefined);
            if (head) await manager.remove(wt, { mergedInto: head, deleteBranch: false });
          } else if (wt.state === 'ready') {
            await manager.release(wt, 'retained');
          }
        } catch (e) {
          this.log(`mission ${missionId}: could not tidy ${wt.branch}: ${errorText(e)}`);
        }
      }
      m = { ...this.need(missionId), finish: how, finishResult: result };
      m = transitionMission(m, how === 'discard' ? 'cancelled' : 'completed', { now: this.now(), reason: result?.note ?? how });
      this.put(m);
      this.log(`mission ${missionId}: finished (${how})`);
      return m;
    });
  }

  /**
   * Start whatever the plan says is next, one task at a time (§29 P8). Runs
   * inside the mission's queue. Finishes the mission once every task is done
   * or skipped; waits (tasks `blocked`) when what is left needs a task that
   * failed, was skipped or was cancelled.
   */
  private async launchNext(missionId: string): Promise<void> {
    let m = this.need(missionId);
    if (!isPlanned(m) || m.state !== 'running' || this.disposed) return;
    // Nothing runs before approval, however this was reached.
    if (m.planApprovedAt === undefined) throw new TaskError('Nothing runs before the plan is approved.');
    const busy: TaskState[] = ['ready', 'assessing', 'routed', 'queued', 'running', 'verifying', 'integrating', 'needs-human'];
    // A task waiting out a rate limit is `blocked`, and it is still this mission's task in hand.
    if (m.tasks.some((t) => busy.includes(t.state) || pendingEscalation(t))) return;
    const now = this.now();
    const open = executionOrder(m.tasks).filter((t) => t.state === 'pending' || t.state === 'blocked');
    if (open.length === 0) {
      if (m.tasks.every((t) => t.state === 'done' || t.state === 'skipped')) {
        m = transitionMission(m, 'finishing', { now });
        m = transitionMission(m, 'review', { now, reason: 'every task is done: merge, open a pull request, keep or discard the mission branch' });
        this.put(m);
        this.notify(m, 'is ready for review', `${m.tasks.filter((t) => t.state === 'done').length} task(s) done on ${resultBranch(m) ?? 'the mission branch'}.`);
      }
      return;
    }
    const next = open.find((t) => dependenciesSatisfied(m, t));
    if (!next) {
      for (const t of open) {
        const waiting = t.dependsOn.map((d) => m.tasks.find((x) => x.id === d.taskId)).filter((u) => u && u.state !== 'done').map((u) => `${u!.key} (${u!.state})`);
        const reason = `waiting on ${waiting.join(', ')}`;
        m = this.patchTask(m, t.id, (x) => (x.state === 'pending' ? transitionTask(m, x, 'blocked', { now, reason }) : { ...x, stateReason: reason }));
      }
      this.put(m);
      this.notify(m, 'needs you', 'What is left depends on a task that did not finish. Skip it, or cancel the mission.');
      return;
    }
    const route = this.routeFor(m, next.id);
    const capped = this.capRefusal(m, next.id, route);
    if (capped) {
      this.put(this.failBeforeLaunch(m, next.id, capped));
      this.notify(this.need(missionId), 'needs you', `${next.key}: ${capped}`);
      return;
    }
    try {
      await this.launch(missionId, { mode: 'fresh', route, taskId: next.id });
    } catch (e) {
      // `launch` has already left the task waiting on the user, saying why.
      this.log(`mission ${missionId}: ${next.key} could not start: ${errorText(e)}`);
      this.notify(this.need(missionId), 'needs you', `${next.key} could not start: ${errorText(e)}`);
    }
  }

  /**
   * The route a task runs on: its own pins, over the mission's default route
   * (the launcher's, at approval). A retry runs on what the last attempt ran on.
   */
  private routeFor(m: Mission, taskId: string, prev?: ExecutionAttempt): TaskRoute {
    if (prev) return routeOf(m, prev);
    const task = m.tasks.find((t) => t.id === taskId);
    const base = m.defaultRoute ?? { harness: 'claude-code' };
    const pins = task?.overrides?.pins;
    if (!pins) return { ...base };
    const harness = pins.harness ?? base.harness;
    const sameHarness = harness === base.harness;
    const model = pins.model ?? (sameHarness ? base.model : undefined);
    const sameModel = sameHarness && model === base.model;
    const effort = pins.effort ? this.plannedEffort(harness, model, pins.effort) : sameModel ? base.effort : undefined;
    return { harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  /** AW's effort level as the model's own, through the catalog when it knows the model. */
  private plannedEffort(harness: HarnessId, model: string | undefined, level: EffortLevel): string | undefined {
    const source = SOURCE[harness] ?? harness;
    const alias = model || (harness === 'claude-code' ? 'default' : '');
    const entry = alias ? this.deps.routing?.snapshot().catalog.entries.find((e) => e.descriptor.source === source && e.aliases.includes(alias)) : undefined;
    const native = entry ? nativeEffortFor(entry, level) : level === 'max' && harness === 'codex' ? 'xhigh' : level;
    return native === 'none' ? undefined : native;
  }

  /** Why a task's route breaks its caps, if it does (§10.2): the caps of every scope, as #40 combines them. */
  private capRefusal(m: Mission, taskId: string, route: TaskRoute): string | undefined {
    const task = m.tasks.find((t) => t.id === taskId);
    const caps = (task ? this.effective(m, task).policy.caps : m.policy.caps) ?? {};
    const tiers = this.deps.routing?.snapshot().catalog.tiers;
    if (caps.maxTier && tiers) {
      const target = this.targetFor(route);
      const cap = tierRank(tiers, caps.maxTier);
      if (cap >= 0 && tierRank(tiers, target.tier) > cap) return `${target.model || 'the default model'} is ${target.tier}, above its cap of ${caps.maxTier}; pin a model within the cap`;
    }
    if (caps.maxEffort && route.effort && EFFORT_LEVELS.indexOf(awEffort(route.effort)) > EFFORT_LEVELS.indexOf(caps.maxEffort)) {
      return `effort ${route.effort} is above its cap of ${caps.maxEffort}; pin a lower effort`;
    }
    return undefined;
  }

  /** The mission's one worktree, on the mission branch: created (write-ahead) the first time a task needs it. */
  private async missionTree(missionId: string, manager: WorktreeManager): Promise<WorktreeAssignment> {
    let m = this.need(missionId);
    const existing = m.integration !== 'none' ? m.worktrees.find((w) => w.id === (m.integration as { worktreeId: string }).worktreeId) : undefined;
    if (existing && existing.state !== 'removed') {
      if (existing.state === 'missing') throw new TaskError('The mission’s worktree has gone; recreate it from its branch, or cancel the mission.');
      // Recorded but never finished (a crash mid-create): finish it.
      return existing.state === 'creating' ? manager.create(existing) : existing;
    }
    const planned = manager.plan({ id: this.id(), missionSlug: missionSlug(m), purpose: 'integration', baseCommit: m.base.commit });
    this.worktreeOwners.set(planned.id, missionId);
    m = { ...m, integration: { branch: planned.branch, worktreeId: planned.id }, worktrees: [...m.worktrees, planned] };
    this.put(m);
    return manager.create(planned);
  }

  /**
   * Before a fresh retry in the mission tree: commit what the last attempt
   * left, keep its work on a branch of its own, and put the tree on a new
   * `-a<n>` branch at the commit the task started from.
   */
  private async restartTree(missionId: string, taskId: string, prev: ExecutionAttempt | undefined): Promise<Mission> {
    let m = this.need(missionId);
    const task = m.tasks.find((t) => t.id === taskId)!;
    const wt = m.integration !== 'none' ? m.worktrees.find((w) => w.id === (m.integration as { worktreeId: string }).worktreeId) : undefined;
    if (!wt || wt.state === 'missing' || wt.state === 'removed' || m.integration === 'none') {
      throw new TaskError('The mission’s worktree has gone; recreate it from its branch, or cancel the mission.');
    }
    const manager = await this.managerFor(m);
    await manager.commitAll(wt, `aw: ${task.key}: attempt ${prev?.n ?? 0}, not accepted`).catch((e: Error) => {
      throw new TaskError(`Could not commit what the last attempt left, so nothing was reset: ${e.message}`);
    });
    const from = prev?.startCommit ?? (await manager.headOf(wt));
    const slug = missionSlugOf(m);
    const n = task.attemptIds.length + 1;
    m = this.need(missionId);
    const current = m.worktrees.find((w) => w.id === wt.id)!;
    await manager.restartOn(current, {
      branch: taskBranch(slug, task.key, n),
      from,
      resetBranch: m.integration === 'none' ? undefined : m.integration.branch,
      keepAs: taskBranch(slug, task.key, prev?.n ?? 1),
    });
    return this.need(missionId);
  }

  /** A skipped task's work comes off the mission branch (kept on its own), so the next task starts clean. */
  private async setAside(missionId: string, taskId: string, a: ExecutionAttempt): Promise<void> {
    const m = this.need(missionId);
    const task = m.tasks.find((t) => t.id === taskId)!;
    const wt = m.worktrees.find((w) => w.id === a.worktreeId);
    if (!wt || m.integration === 'none' || !a.startCommit || wt.state === 'missing' || wt.state === 'removed') return;
    const manager = await this.managerFor(m);
    await manager.commitAll(wt, `aw: ${task.key}: attempt ${a.n}, skipped`).catch((e: Error) => {
      throw new TaskError(`Could not commit what the attempt left, so nothing was skipped: ${e.message}`);
    });
    await manager.setAside(this.need(missionId).worktrees.find((w) => w.id === wt.id)!, {
      branch: m.integration.branch,
      resetTo: a.startCommit,
      keepAs: taskBranch(missionSlugOf(m), task.key, a.n),
    });
  }

  /**
   * A planned mission's task is done: back on the mission branch if it ran on
   * a retry branch (a fast-forward: the mission branch is still at the commit
   * the task started from), with its result recorded.
   */
  private async markDone(missionId: string, taskId: string, acceptedBy: 'verification' | 'user', reason: string): Promise<void> {
    let m = this.need(missionId);
    const a = this.currentAttempt(m, taskId);
    let wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (!a || !wt) throw new TaskError('The task has no worktree to take its result from.');
    const manager = await this.managerFor(m);
    if (m.integration !== 'none' && wt.branch !== m.integration.branch) {
      try {
        wt = await manager.returnTo(wt, m.integration.branch);
      } catch (e) {
        m = this.need(missionId);
        this.put(this.patchTask(m, taskId, (t) => ({ ...t, stateReason: `could not move the mission branch on: ${errorText(e)}` })));
        throw new TaskError(`Could not move the mission branch to the task’s result: ${errorText(e)}`);
      }
    }
    const head = await manager.headOf(wt);
    m = this.need(missionId);
    const now = this.now();
    m = this.patchTask(m, taskId, (t) => transitionTask(m, { ...t, result: { branch: wt!.branch, commit: head, acceptedBy } }, 'done', { now, reason }));
    this.put(m);
    this.writeTaskFinal(m, taskId);
  }

  /** What plan editing needs from outside: fresh ids, the checks a task gets under the repository's policy, the clock. */
  private planContext(policy: import('../../shared/orchestration/repoPolicy').RepoPolicy): PlanContext {
    return {
      newId: () => this.id(),
      verification: (kind, criteria) => buildVerificationPlan({ kind, policy, criteria }),
      now: this.now(),
    };
  }

  /** Preview assessments for plan review, a moment after the last edit (§11.2). */
  private schedulePreview(missionId: string): void {
    if (this.disposed) return;
    clearTimeout(this.previewTimers.get(missionId));
    const timer = setTimeout(() => {
      this.previewTimers.delete(missionId);
      void this.preview(missionId).catch((e) => this.log(`mission ${missionId}: preview failed: ${errorText(e)}`));
    }, this.deps.previewDelayMs ?? 800);
    this.previewTimers.set(missionId, timer);
  }

  /**
   * Assess every task whose content changed, outside the mission's queue (a
   * model call must not hold up the next edit), then route each from its
   * newest assessment. An assessment for a revision that has since been
   * edited again is dropped: the next preview makes the right one.
   */
  private async preview(missionId: string): Promise<void> {
    const m = this.missions.get(missionId);
    if (!m || m.state !== 'plan-review' || this.disposed) return;
    const assessor = this.deps.assessor;
    if (assessor) {
      const stale = m.tasks.filter((t) => !m.assessments.some((x) => x.taskId === t.id && x.taskRevision === t.revision));
      const results = await Promise.all(stale.map((t) => assessor.assess(this.assessInput(m, t)).then((a) => ({ t, a }))));
      await this.queue(missionId, async () => {
        let cur = this.need(missionId);
        for (const { t, a } of results) {
          const task = cur.tasks.find((x) => x.id === t.id);
          if (!task || task.revision !== t.revision || cur.assessments.some((x) => x.id === a.id)) continue;
          cur = this.patchTask({ ...cur, assessments: [...cur.assessments, a] }, t.id, (x) => ({ ...x, assessmentIds: [...x.assessmentIds, a.id] }));
        }
        this.put(cur);
      });
    }
    await this.queue(missionId, async () => {
      let cur = this.need(missionId);
      if (cur.state !== 'plan-review') return;
      let changed = false;
      for (const t of cur.tasks) {
        const latest = latestAssessment(cur, t.id);
        if (!latest || latest.taskRevision !== t.revision || t.recommendation?.assessmentId === latest.id) continue;
        const rec = this.recommendationFor(cur, t.id, latest);
        if (!rec) continue;
        cur = this.patchTask(cur, t.id, (x) => ({ ...x, recommendation: rec }));
        changed = true;
      }
      if (changed) this.put(cur);
    });
  }

  /** A `task-final` record (§16.2), once per task that got somewhere: at least one attempt, or done. */
  private writeTaskFinal(m: Mission, taskId: string): void {
    const record = taskFinalRecord(m, taskId, this.now());
    if (!record) return;
    try {
      this.deps.telemetry?.append(record);
    } catch (e) {
      this.log(`mission ${m.id}: could not write its task-final record: ${String(e)}`);
    }
  }

  /** Put a vanished worktree back from its surviving branch (§23.3 step 5). */
  recreateWorktree(missionId: string): Promise<void> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      const a = this.currentAttempt(m);
      const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
      if (!wt || wt.state !== 'missing') throw new TaskError('The task’s worktree is not missing.');
      await (await this.managerFor(m)).recreate(wt);
    });
  }

  /** Write the current (or the named) task's current attempt's diff to a file and return its path. */
  diff(missionId: string, taskId?: string): Promise<string> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      const a = this.currentAttempt(m, taskId);
      const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
      if (!a || !wt) throw new TaskError('The task has no branch yet.');
      const text = await (await this.managerFor(m)).diffText(measured(wt, a));
      fs.mkdirSync(this.deps.diffsDir, { recursive: true });
      const file = path.join(this.deps.diffsDir, `${m.id}-a${a.n}.diff`);
      fs.writeFileSync(file, text, 'utf8');
      return file;
    });
  }

  // ---- Recovery (§23.3) ----

  /**
   * The start-up pass. Call once, after #4's startup has settled: hosts
   * adopted (their handles may still be `connecting`) and Codex threads
   * rejoined.
   */
  async recover(): Promise<void> {
    const found: string[] = [];
    for (const loaded of this.deps.store.loadActive()) {
      if (!('mission' in loaded)) {
        this.log(`task ${loaded.id}: unreadable, left alone: ${loaded.unreadable}`);
        continue;
      }
      // One started in this run before recovery got here is already followed live.
      if (this.missions.has(loaded.mission.id)) continue;
      this.missions.set(loaded.mission.id, loaded.mission);
      found.push(loaded.mission.id);
    }
    await Promise.all(found.map((id) => this.queue(id, () => this.recoverMission(id)).catch((e) => this.log(`task ${id}: recovery failed: ${String(e)}`))));
    this.emitter.fire();
  }

  private async recoverMission(id: string): Promise<void> {
    let m = this.need(id);
    const branchGone = new Set<string>();
    // Worktrees first (step 5): an attempt is judged knowing whether its tree is still there.
    if (m.worktrees.some((w) => w.state !== 'removed')) {
      try {
        const items = await (await this.managerFor(m)).reconcile(m.worktrees);
        for (const it of items) {
          if (it.action === 'unexpected-commits') this.log(`task ${id}: ${it.assignment.branch} has commits made outside any attempt`);
          if (it.action === 'missing' && !it.recreatable) branchGone.add(it.assignment.id);
        }
      } catch (e) {
        this.log(`task ${id}: could not check its worktrees: ${String(e)}`);
      }
      m = this.need(id);
    }
    const a = this.currentAttempt(m);
    if (a && (a.state === 'finishing' || a.state === 'verifying')) {
      // The core stopped part-way through finishing: finishing again is safe.
      await this.finish(id, a.id);
      return;
    }
    if (a && LIVE.includes(a.state)) {
      const found = this.findSession(a);
      if (found.record && !isOrchestrationOrigin(found.record.origin)) this.deps.registry.restoreOrigin?.(found.record.sessionId, originOf(m, a));
      if (found.record && !a.assignment.sessionIds.some((s) => sameId(s, found.record!.sessionId))) {
        m = this.patchAttempt(m, a.id, (x) => ({ ...x, assignment: { ...x.assignment, sessionIds: [...x.assignment.sessionIds, found.record!.sessionId] } }));
        this.put(m);
      }
      const verdict = sessionVerdict({
        record: found.record,
        handle: found.handle ? handleView(found.handle) : undefined,
        attempt: a.state,
        hasSession: a.assignment.sessionIds.length > 0,
        // A turn may have ended while the core was away, so an idle session is done.
        // One whose prompt never arrived is `starting`, not idle (`resendPromptIfLost`).
        turnEnded: true,
        stoppedByUs: false,
      });
      this.log(`task ${id}: attempt ${a.n} ${a.state} → ${verdict.kind}${'reason' in verdict ? ` (${verdict.reason})` : ''}`);
      if (found.handle && (verdict.kind === 'running' || verdict.kind === 'waiting-human' || verdict.kind === 'finished')) {
        this.watch(id, a.id, found.handle, { recovered: true, turnSeen: (a.turnsSeen ?? 0) > 0 });
      }
      await this.apply(id, a.id, verdict);
      return;
    }
    const task = this.currentTask(m);
    // An escalation step that was waiting when the core stopped: it runs when it was due, or now.
    const pending = pendingEscalation(task);
    if (pending && m.state === 'running') {
      this.log(`task ${id}: ${task.key} resumes its pending ${pending.action}`);
      this.scheduleEscalation(id, pending);
      return;
    }
    const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (wt?.state === 'missing' && task.state === 'needs-human') {
      const why = branchGone.has(wt.id) ? 'its worktree and branch have gone; retry it fresh' : 'its worktree has gone; recreate it from its branch, or retry';
      this.put(this.patchTask(m, task.id, (t) => ({ ...t, stateReason: why })));
    }
    // A planned mission stopped between one task finishing and the next starting: start it now.
    if (isPlanned(m) && m.state === 'running') await this.launchNext(id);
    if (m.planned && m.state === 'plan-review') this.schedulePreview(id);
  }

  /**
   * The first send is not awaited, so a core that quits within a moment of
   * launching can let go of the session before the prompt reached its host.
   * The session then waits in `starting` with nothing to do. Send the prompt
   * again under its original id: a host that already has it answers
   * `duplicate` and nothing is sent twice.
   */
  private async resendPromptIfLost(m: Mission, a: ExecutionAttempt, handle: SessionHandle): Promise<void> {
    const promptId = a.sentIds?.[0];
    const wt = m.worktrees.find((w) => w.id === a.worktreeId);
    if ((a.turnsSeen ?? 0) > 0 || !promptId || !wt) return;
    const task = m.tasks.find((t) => t.id === a.taskId) ?? m.tasks[0];
    const prompt = a.assignment.mode === 'continue' ? CONTINUE_PROMPT : attemptPrompt(task, { harness: a.assignment.harness, branch: wt.branch, mission: missionContext(m, task) });
    this.log(`task ${m.id}: attempt ${a.n} had no turn seen before the restart; sending its prompt again (deduplicated by id)`);
    try {
      await handle.send(prompt, undefined, { clientMessageId: promptId });
    } catch (e) {
      this.log(`task ${m.id}: ${String(e)}`);
    }
  }

  /** The attempt's session: registry records by `origin.attemptId`, newest run first; failing that, its ids. */
  private findSession(a: ExecutionAttempt): { record?: SessionRecord; handle?: SessionHandle } {
    const byOrigin = this.deps.registry
      .all()
      .filter((r) => isOrchestrationOrigin(r.origin) && r.origin.attemptId === a.id)
      .sort((x, y) => (y.liveSince ?? y.createdAt) - (x.liveSince ?? x.createdAt));
    let record: SessionRecord | undefined = byOrigin[0];
    if (!record) {
      for (const sid of [...a.assignment.sessionIds].reverse()) {
        record = this.deps.registry.get(sid) as SessionRecord | undefined;
        if (record) break;
      }
    }
    const handle = this.deps.sessions.get(record?.sessionId ?? a.assignment.sessionIds.at(-1));
    return { record, handle };
  }

  // ---- Launching ----

  private checkRoute(route: TaskRoute): AgentHarness {
    const harness = this.deps.harnesses.get(route.harness);
    if (!harness) throw new TaskError(`No ${route.harness} harness to run the task with.`);
    const why = this.deps.cannotLaunch?.(route.harness);
    if (why) throw new TaskError(why);
    return harness;
  }

  /**
   * Launch a task's next attempt. Runs inside the mission's queue.
   * `fresh`: a new session in a new worktree (the first, or `-a<n>`), or in a
   * planned mission in the mission's one tree, from wherever it now stands.
   * `continue`: the interrupted attempt's session, resumed in its own tree.
   */
  private async launch(missionId: string, opts: LaunchOptions): Promise<void> {
    let m = this.need(missionId);
    const resumeOf = opts.mode === 'continue' && 'resumeOf' in opts ? opts.resumeOf : undefined;
    const continues = opts.mode === 'continue' && 'continues' in opts ? opts.continues : undefined;
    const prevAttempt = resumeOf ?? continues;
    const escalation = 'escalation' in opts ? opts.escalation : undefined;
    const taskId = prevAttempt ? prevAttempt.taskId : (opts as { taskId?: string }).taskId ?? this.currentTask(m).id;
    const task = m.tasks.find((t) => t.id === taskId);
    if (!task) throw new TaskError('That task is no longer in the mission.');
    // The one gate that holds whatever called this: a planned mission's work waits for Approve and start.
    if (m.planned && m.planApprovedAt === undefined) throw new TaskError('Nothing runs before the plan is approved.');
    const planned = isPlanned(m);
    const n = task.attemptIds.length + 1;
    const prevDecision = resumeOf ? m.decisions.find((d) => d.id === resumeOf.routingDecisionId) : undefined;
    // The policy as it is now, not as it was at the last attempt: a change
    // since then applies from this one (§10.2). Pins replace the route's own
    // dimensions; a conflict or a spent count cap stops it here.
    const eff = this.effective(m, task);
    const route: TaskRoute = this.withPins(resumeOf ? routeFromDecision(prevDecision, resumeOf) : (opts as { route: TaskRoute }).route, eff.policy.pins);
    let harness: AgentHarness;
    let loaded: LoadedRepoPolicy;
    try {
      if (eff.conflicts.length > 0) throw new TaskError(conflictText(eff.conflicts));
      const refusal = admissionRefusal(eff, this.admissionFacts(m, route, !!resumeOf, task));
      if (refusal) throw new TaskError(refusal);
      harness = this.checkRoute(route);
      const policy = this.deps.repoPolicies.forFolder(m.repoRoot);
      if (!policy) throw new TaskError(`${m.repoRoot} is no longer a git repository.`);
      loaded = policy;
    } catch (e) {
      // Nothing was started; a first attempt that never got going leaves the task waiting on the user.
      if (task.attemptIds.length === 0) this.put(this.failBeforeLaunch(m, task.id, errorText(e)));
      else if (e instanceof TaskError) this.put(this.patchTask(m, task.id, (t) => ({ ...t, stateReason: e.message })));
      throw e;
    }
    const now = this.now();
    // Check the task can take an attempt now, before any worktree is made or taken:
    // a throw after that would leave the tree held by nothing.
    this.advanceTaskToRunning(m, task.id, now);

    // The worktree: recorded `creating` before any git work (§23.2).
    const manager = await this.manager(loaded);
    let wt: WorktreeAssignment;
    let startCommit: string;
    if (prevAttempt) {
      const prev = m.worktrees.find((w) => w.id === prevAttempt.worktreeId);
      if (!prev || prev.state === 'missing' || prev.state === 'removed') throw new TaskError('The attempt’s worktree has gone; recreate it or retry fresh.');
      wt = prev;
      // Carrying on the same work on the same branch: measured from where the task's work began.
      startCommit = prevAttempt.startCommit ?? prev.baseCommit;
    } else {
      try {
        if (planned) {
          // One tree for the whole mission: each task starts from what the one before it left.
          wt = await this.missionTree(missionId, manager);
          startCommit = await manager.headOf(wt);
        } else {
          const plan = manager.plan({ id: this.id(), missionSlug: missionSlug(m), purpose: 'task', taskKey: task.key, taskId: task.id, attempt: n, baseCommit: m.base.commit });
          wt = await manager.create(plan);
          startCommit = plan.baseCommit;
        }
      } catch (e) {
        m = this.need(missionId);
        if (task.attemptIds.length === 0) this.put(this.failBeforeLaunch(m, task.id, `could not create its worktree: ${errorText(e)}`));
        throw new TaskError(`Could not create the task’s worktree: ${errorText(e)}`);
      }
    }
    // Already `in-use` only when letting go of it failed after the last attempt; it is ours either way.
    if (wt.state !== 'in-use') wt = await manager.markInUse(wt);
    m = this.need(missionId);

    // The routing decision, immutable (§7.2). Beside a route the user picked,
    // what the router would have picked, whenever there is an assessment to route from.
    const routing: DecisionRouting = {
      ...((opts.mode === 'fresh' ? opts.routing : undefined) ?? { recommendation: this.recommendationFor(m, task.id), offered: false, accepted: false }),
      ...(escalation ? { escalation, prevDecidedBy: this.decisionOf(m, escalation.afterAttemptId)?.decidedBy } : {}),
    };
    const decision = this.decision(m, task, n, route, harness, routing);
    const provider = PROVIDER[route.harness] ?? 'claude';
    const preassigned = harness.capabilities().preassignedSessionId;
    const sessionIds = prevAttempt ? [...prevAttempt.assignment.sessionIds] : preassigned ? [randomUUID()] : [];
    const promptId = randomUUID();
    const attempt: ExecutionAttempt = {
      id: this.id(),
      taskId: task.id,
      n,
      routingDecisionId: decision.id,
      startCommit,
      repoPolicyVersion: loaded.version,
      assignment: { mode: opts.mode, sessionIds, harness: route.harness },
      worktreeId: wt.id,
      state: 'created',
      verification: [],
      flags: {},
      sentIds: [promptId],
      turnsSeen: 0,
      timing: { queuedAt: now },
      createdAt: now,
      ...(resumeOf ? { resumeOf: resumeOf.id, ...('auto' in opts && opts.auto ? { autoResumed: true } : {}) } : {}),
      ...(continues ? { continues: continues.id } : {}),
      ...(escalation?.step !== undefined ? { escalation: { decisionId: escalation.id, action: escalation.action, step: escalation.step } } : {}),
    };
    m = { ...m, decisions: [...m.decisions, decision], attempts: [...m.attempts, attempt] };
    m = this.patchTask(m, task.id, (t) => ({ ...t, attemptIds: [...t.attemptIds, attempt.id] }));
    m = this.advanceTaskToRunning(m, task.id, now);
    if (m.state === 'draft') m = transitionMission(m, 'running', { now, reason: 'a single task started directly' });
    m = this.patchAttempt(m, attempt.id, (x) => transitionAttempt(m, x, 'launching', { now }));
    // Write-ahead: the attempt, its session id and origin are on disk before anything starts.
    this.put(m);
    this.writeRouting(m, decision);

    const policy: LaunchPolicy = attemptLaunchPolicy({ harness: route.harness, primaryRoot: m.repoRoot, repoPolicy: loaded.policy });
    const feedback = opts.mode === 'fresh' ? opts.feedback : undefined;
    const prompt = resumeOf
      ? CONTINUE_PROMPT
      : continues
        ? (opts as { message: string }).message
        : attemptPrompt(task, { harness: route.harness, branch: wt.branch, mission: missionContext(m, task) }) + (feedback ? `\n\n## An earlier attempt\n${feedback}` : '');
    // Escalation's "continue" (§15.2): the failed attempt's session is still
    // here and idle, so the failure goes to it as its next message. Watched
    // from now, so the turns it already finished are not read as this attempt's.
    const live = continues ? this.continuableHandle(continues) : undefined;
    if (live) {
      this.watch(missionId, attempt.id, live, { recovered: false, fromNow: true });
      let outcome: string;
      try {
        outcome = await live.send(prompt, undefined, { clientMessageId: promptId });
      } catch (e) {
        outcome = errorText(e);
      }
      if (outcome !== 'applied') {
        this.unwatch(attempt.id);
        m = this.need(missionId);
        this.put(this.endAttempt(m, attempt.id, 'failed', { status: 'failed', category: 'infra', signature: 'launch-failed' }, `could not carry on its session: ${outcome}`));
        await this.releaseTree(missionId, attempt.id);
        throw new TaskError(`Could not carry on the session: ${outcome}`);
      }
      m = this.need(missionId);
      const cur = m.attempts.find((x) => x.id === attempt.id);
      if (cur?.state === 'launching') this.put(this.patchAttempt(m, attempt.id, (x) => transitionAttempt(m, x, 'running', { now: this.now() })));
      this.log(`task ${missionId}: attempt ${n} carries on session ${sessionIds.at(-1)} in ${wt.path}`);
      return;
    }
    let handle: SessionHandle;
    try {
      handle = await harness.launch({
        cwd: wt.path,
        prompt,
        promptId,
        target: { harness: route.harness, source: decision.resolution.target.source, model: route.model ?? '', effortNative: route.effort?.trim() || 'none' },
        origin: originOf(m, attempt),
        permissionMode: provider === 'claude' ? decisionMode(decision) : undefined,
        ...(prevAttempt ? { resume: sessionIds.at(-1) } : sessionIds[0] ? { sessionId: sessionIds[0] } : {}),
        policy,
      });
    } catch (e) {
      m = this.need(missionId);
      m = this.endAttempt(m, attempt.id, 'failed', { status: 'failed', category: 'infra', signature: 'launch-failed' }, `could not start: ${errorText(e)}`);
      this.put(m);
      await this.releaseTree(missionId, attempt.id);
      throw new TaskError(`Could not start the attempt: ${errorText(e)}`);
    }
    m = this.need(missionId);
    const id = handle.sessionId;
    if (id && !sessionIds.some((s) => sameId(s, id))) {
      m = this.patchAttempt(m, attempt.id, (x) => ({ ...x, assignment: { ...x.assignment, sessionIds: [...x.assignment.sessionIds, id] } }));
    }
    m = this.patchAttempt(m, attempt.id, (x) => transitionAttempt(m, x, 'running', { now: this.now() }));
    this.put(m);
    this.log(`task ${missionId}: attempt ${n} running in ${wt.path}${id ? ` as ${id}` : ''}`);
    this.watch(missionId, attempt.id, handle, { recovered: false });
  }

  /** The task's path to `running` for its next attempt, through the states §7.5 says it passes. */
  private advanceTaskToRunning(m: Mission, taskId: string, now: number): Mission {
    const steps: Partial<Record<TaskState, TaskState[]>> = {
      pending: ['ready', 'assessing', 'routed', 'queued', 'running'],
      // A planned task whose upstream has since come good.
      blocked: ['ready', 'assessing', 'routed', 'queued', 'running'],
      // An `assisted` task, proposed and now accepted or changed (#38).
      routed: ['queued', 'running'],
      'needs-human': ['queued', 'running'],
      queued: ['running'],
    };
    const state = m.tasks.find((t) => t.id === taskId)?.state;
    const path = state && steps[state];
    if (!path) throw new TaskError(`The task is ${state ?? 'gone'}; it cannot start an attempt.`);
    for (const to of path) {
      m = this.patchTask(m, taskId, (t) =>
        transitionTask(m, t, to, {
          now,
          reason:
            to === 'routed'
              ? 'route picked by the user'
              : to === 'assessing'
                ? this.deps.assessor
                  ? 'manual route: assessed beside the attempt'
                  : 'manual route: not assessed'
                : undefined,
        }),
      );
    }
    return m;
  }

  /** A first attempt that could not even be launched: the task waits for the user. */
  private failBeforeLaunch(m: Mission, taskId: string, why: string): Mission {
    const now = this.now();
    if (m.state === 'draft') m = transitionMission(m, 'running', { now });
    // Routed, then handed to the user (§7.5 `routed → needs-human`), from wherever it got to.
    for (const to of ['ready', 'assessing', 'routed', 'needs-human'] as TaskState[]) {
      const state = m.tasks.find((t) => t.id === taskId)?.state;
      if (!state || state === 'needs-human') break;
      if (!taskMachine.can(state, to)) continue;
      m = this.patchTask(m, taskId, (t) => transitionTask(m, t, to, { now }));
    }
    return this.patchTask(m, taskId, (t) => ({ ...t, stateReason: why }));
  }

  /**
   * What a route the user named resolves to: the catalog entry that has the
   * model as an alias (the harness's own default, for an empty model), or the
   * bare route when the catalog has never seen it.
   */
  private targetFor(route: TaskRoute): ExecutionTarget {
    const source = route.source ?? SOURCE[route.harness] ?? route.harness;
    const model = route.model?.trim() ?? '';
    const alias = model || (route.harness === 'claude-code' ? 'default' : '');
    const entry = alias
      ? this.deps.routing?.snapshot().catalog.entries.find((e) => e.descriptor.source === source && e.aliases.includes(alias))
      : undefined;
    const tier = entry?.tier ?? ((model && this.deps.tierOf?.(source, model)) || 'unassigned');
    return {
      harness: route.harness,
      source,
      model,
      ...(entry?.descriptor.resolvedId ? { resolvedModel: entry.descriptor.resolvedId } : {}),
      tier,
      effortNative: route.effort?.trim() || 'none',
      location: entry?.descriptor.location ?? 'hosted',
    };
  }

  private decision(m: Mission, task: Task, n: number, route: TaskRoute, harness: AgentHarness, routing: DecisionRouting): RoutingDecision {
    const rec = routing.recommendation;
    const accepted = routing.accepted && !!rec?.resolution.target;
    const target: ExecutionTarget = accepted ? rec!.resolution.target! : { ...this.targetFor(route), harness: harness.id };
    const appDefault = this.deps.launchDefaults.for('claude').permissionMode;
    const permissionMode = PROVIDER[route.harness] === 'claude' ? attemptPermissionMode(route.permissionMode, appDefault) : undefined;
    const inputs = permissionMode ? { inputs: { permissionMode } } : {};
    const cmp = rec ? compareRoutes(rec.resolution.target, target, routing.offered) : undefined;
    const mode = m.policy.mode ?? 'manual';
    let reasons: RoutingReason[];
    const esc = routing.escalation;
    if (accepted && routing.failover) reasons = rec!.reasons.map((r, i) => (i === 0 && permissionMode ? { ...r, inputs: { ...r.inputs, permissionMode } } : r));
    else if (accepted) reasons = [...rec!.reasons, { ruleId: 'assisted.accepted', text: 'Recommendation accepted.', ...inputs }];
    else if (esc) reasons = [{ ruleId: `escalation.${esc.action}`, text: esc.reason, ...inputs }];
    else if (routing.offered && cmp) reasons = [{ ruleId: 'assisted.changed', text: `Changed from the recommendation: ${cmp.changed.join(', ') || 'nothing'}.`, ...inputs }];
    else reasons = [{ ruleId: 'manual', text: 'Route picked by the user.', ...inputs }];
    // A step that changed the route was escalation's choice; one that kept it is still whoever picked it.
    const byEscalation = !accepted && !!esc && changesRoute(esc.action);
    const decidedBy: RoutingDecision['decidedBy'] = accepted || byEscalation ? 'router' : esc ? (routing.prevDecidedBy ?? 'user') : 'user';
    return {
      id: this.id(),
      taskId: task.id,
      attemptN: n,
      mode,
      ...(rec ? { assessmentId: rec.assessmentId } : {}),
      policyVersion: accepted ? rec!.policyVersion : byEscalation ? 'escalation' : 'manual',
      requirement: accepted
        ? rec!.requirement
        : { minTier: target.tier, maxTier: target.tier, effort: awEffort(route.effort), needs: [], gates: [] },
      reasons,
      overrides: cmp?.changed ?? [],
      resolution: accepted
        ? { target, candidates: rec!.resolution.candidates, catalogVersion: rec!.resolution.catalogVersion, ...(rec!.resolution.note ? { note: rec!.resolution.note } : {}) }
        : { target, candidates: [{ target, verdict: 'chosen', reason: byEscalation ? `escalation: ${esc!.action}` : 'picked by the user' }], catalogVersion: byEscalation && esc!.target ? 'escalation' : 'manual' },
      ...(rec ? { shadow: rec, agreement: cmp!.agreement } : {}),
      policyRevision: m.policyChanges.length,
      decidedBy,
      decidedAt: this.now(),
    };
  }

  // ---- Recommendation (#38) ----

  /**
   * What the router and resolver would pick for this task now, from its newest
   * assessment and a fresh snapshot. Undefined when there is no assessment or
   * no catalog. Never throws: a routing bug must not stop a launch.
   */
  private recommendationFor(
    m: Mission,
    taskId: string = this.currentTask(m).id,
    assessment: TaskAssessment | undefined = latestAssessment(m, taskId),
  ): RouteRecommendation | undefined {
    if (!assessment || !this.deps.routing) return undefined;
    try {
      // Every scope's controls apply (§10.2), the task's own caps from plan
      // review included. In `manual`, the task's pins are the route the user
      // picked, so the shadow leaves them out: it is what the router would
      // have picked instead, under the same policy.
      const task = m.tasks.find((t) => t.id === taskId);
      const mode = m.policy.mode ?? 'manual';
      const forTask = task && mode === 'manual' && task.overrides?.pins ? { overrides: { ...task.overrides, pins: undefined } } : task;
      const policy = { ...resolveEffectivePolicy(missionLayers(m, forTask), this.policyContext()).policy, mode };
      return recommendRoute(assessment, policy, this.deps.routing.snapshot(), this.now());
    } catch (e) {
      this.log(`task ${m.id}: could not route: ${errorText(e)}`);
      return undefined;
    }
  }

  /**
   * The shadow for a `manual` decision made before its task was assessed:
   * filled in once, when the assessment lands (the one exception to a
   * decision's immutability, `RoutingDecision`). The attempt may have ended by
   * then; its record is still what the comparison report reads.
   */
  private fillShadow(missionId: string): void {
    let m = this.need(missionId);
    const a = this.currentAttempt(m);
    const d = a && m.decisions.find((x) => x.id === a.routingDecisionId);
    if (!a || !d || d.shadow || d.mode !== 'manual') return;
    const rec = this.recommendationFor(m, a.taskId);
    if (!rec) return;
    const cmp = compareRoutes(rec.resolution.target, d.resolution.target, false);
    const filled: RoutingDecision = { ...d, assessmentId: rec.assessmentId, shadow: rec, agreement: cmp.agreement, overrides: cmp.changed };
    m = { ...m, decisions: m.decisions.map((x) => (x.id === d.id ? filled : x)) };
    this.put(m);
    this.writeRouting(m, filled);
    this.log(`task ${missionId}: shadow ${rec.requirement.minTier}/${rec.requirement.effort} → ${rec.resolution.target?.model ?? rec.verdict} (${cmp.agreement})`);
  }

  private writeRouting(m: Mission, d: RoutingDecision): void {
    const record = routingRecord(m, d, this.now());
    if (!record) return;
    try {
      this.deps.telemetry?.append(record);
    } catch (e) {
      this.log(`task ${m.id}: could not write its routing record: ${String(e)}`);
    }
  }

  // ---- Assessment (#37) ----

  /**
   * Describe the work, beside the attempt that is already running.
   *
   * It runs after the launch, not before it, and it is never awaited by
   * anything the user is waiting on: the route is the user's here (§9.1
   * `manual`), so nothing about this attempt depends on the answer, and a
   * classifier that made "Start task" wait on a model call would be a worse
   * app for no routing gain. `assess` never rejects (§8.3), but the queue and
   * the store can, so the whole thing is caught and logged.
   */
  private scheduleAssessment(missionId: string): void {
    if (!this.deps.assessor || this.disposed) return;
    void this.queue(missionId, () => this.assess(missionId)).catch((e) => this.log(`task ${missionId}: assessment failed: ${errorText(e)}`));
  }

  private async assess(missionId: string, taskId?: string): Promise<void> {
    const assessor = this.deps.assessor;
    const before = this.missions.get(missionId);
    if (!assessor || !before || this.disposed) return;
    const task = (taskId && before.tasks.find((t) => t.id === taskId)) || this.currentTask(before);
    // Immutable records: one assessment per task revision, and it is not made twice.
    if (before.assessments.some((a) => a.taskId === task.id && a.taskRevision === task.revision)) return;
    const assessment = await assessor.assess(this.assessInput(before, task));
    // The mission moved on while the model was thinking; take it as it is now.
    const m = this.missions.get(missionId);
    if (!m || m.assessments.some((a) => a.id === assessment.id)) return;
    const next = this.patchTask({ ...m, assessments: [...m.assessments, assessment] }, task.id, (t) =>
      t.assessmentIds.includes(assessment.id) ? t : { ...t, assessmentIds: [...t.assessmentIds, assessment.id] },
    );
    this.put(next);
    const d = assessment.dimensions;
    this.log(
      `task ${missionId}: assessed ${assessment.kind.value}, complexity ${d.complexity.value}, risk ${d.risk.value}, verifiability ${d.verifiability.value} (${assessment.confidence} confidence)`,
    );
    // In `manual`, the router runs in shadow beside the route the user picked (§27.3).
    this.fillShadow(missionId);
  }

  /** What the assessor is told about a task: its own words, and the checks it will face. */
  private assessInput(m: Mission, task: Task): Parameters<Assessor['assess']>[0] {
    const loaded = this.deps.repoPolicies.forFolder(m.repoRoot);
    return {
      taskId: task.id,
      taskRevision: task.revision,
      task: {
        objective: task.objective,
        acceptanceCriteria: task.acceptanceCriteria,
        scope: task.scope,
        // A defaulted kind is the runner's guess, not the user's: the assessor decides it.
        kindHint: task.kindDefaulted ? undefined : task.kindHint,
        verification: task.verification,
        createdBy: task.createdBy,
      },
      repoRoot: m.repoRoot,
      policy: loaded?.policy ?? DEFAULT_REPO_POLICY,
      repoPolicyVersion: loaded?.version ?? 'default',
      upstream: [],
    };
  }

  // ---- Watching ----

  private watch(missionId: string, attemptId: string, handle: SessionHandle, opts: { recovered: boolean; turnSeen?: boolean; fromNow?: boolean }): void {
    this.unwatch(attemptId);
    const w: Watcher = {
      missionId,
      attemptId,
      handle,
      sub: { dispose: () => undefined },
      turnEnded: opts.recovered,
      queued: false,
      checkPrompt: opts.recovered && opts.turnSeen !== true,
    };
    const listener = (e: SessionViewEvent) => {
      if (e.type === 'turnEnd') this.onTurnEnd(w, e.raw);
      this.poke(w);
    };
    // From the start of the handle's log for a fresh launch, so its first turn
    // is never missed; from now for a reattached one (its old turns ended long
    // ago) and for a session an escalation carries on (they were another attempt's).
    try {
      w.sub = handle.subscribe(opts.recovered || opts.fromNow ? handle.snapshot().seq : 0, listener);
    } catch {
      w.sub = handle.subscribe(handle.snapshot().seq, listener);
    }
    this.watchers.set(attemptId, w);
    this.poke(w);
  }

  private unwatch(attemptId: string): void {
    const w = this.watchers.get(attemptId);
    if (!w) return;
    w.sub.dispose();
    clearTimeout(w.timer);
    clearTimeout(w.clock);
    this.watchers.delete(attemptId);
  }

  private pokeAll(): void {
    for (const w of this.watchers.values()) this.poke(w);
  }

  /** Look at the attempt again, soon, once. */
  private poke(w: Watcher): void {
    if (w.queued || this.disposed) return;
    w.queued = true;
    queueMicrotask(() => {
      w.queued = false;
      if (this.watchers.get(w.attemptId) !== w) return;
      void this.queue(w.missionId, () => this.evaluate(w)).catch((e) => this.log(`task ${w.missionId}: ${String(e)}`));
    });
  }

  private onTurnEnd(w: Watcher, raw: unknown): void {
    w.turnEnded = true;
    w.lastTurn = raw;
    const m = this.missions.get(w.missionId);
    const a = m?.attempts.find((x) => x.id === w.attemptId);
    if (!m || !a) return;
    const sent = new Set((a.sentIds ?? []).map((s) => s.toLowerCase()));
    const ids = turnMessageIds(raw);
    const turnsSeen = (a.turnsSeen ?? 0) + 1;
    // A turn caused by a message the orchestrator did not send was the user's (§16.3).
    // Codex echoes no ids: more turns than sends is the tell.
    const intervened = ids ? ids.some((id) => !sent.has(id)) : a.assignment.harness === 'codex' && turnsSeen > sent.size;
    this.put(this.patchAttempt(m, a.id, (x) => ({ ...x, turnsSeen, flags: intervened ? { ...x.flags, userIntervened: true } : x.flags })));
  }

  /** Read the session and move the attempt along. Runs in the mission's queue. */
  private async evaluate(w: Watcher): Promise<void> {
    if (this.watchers.get(w.attemptId) !== w) return;
    const m = this.missions.get(w.missionId);
    const a = m?.attempts.find((x) => x.id === w.attemptId);
    if (!m || !a || !LIVE.includes(a.state)) return this.unwatch(w.attemptId);
    // A `/clear` gives the session a new id; the attempt keeps every id it has had.
    const current = w.handle.sessionId;
    if (current && !a.assignment.sessionIds.some((s) => sameId(s, current))) {
      this.put(this.patchAttempt(m, a.id, (x) => ({ ...x, assignment: { ...x.assignment, sessionIds: [...x.assignment.sessionIds, current] } })));
    }
    const sid = current ?? a.assignment.sessionIds.at(-1);
    const record = sid ? (this.deps.registry.get(sid) as SessionRecord | undefined) : undefined;
    const handle = (sid ? this.deps.sessions.get(sid) : undefined) ?? w.handle;
    // Once a reattached handle has caught up with its host (§23.3: `connecting` is still live).
    if (w.checkPrompt && handle.lifecycle !== 'connecting') {
      w.checkPrompt = false;
      // `starting` after catching up: the agent never got a message (a session
      // that had one is idle, running or asking). Only then is re-sending safe:
      // a view marks itself running on send and a `duplicate` would not undo it.
      if (handle.lifecycle === 'starting') void this.resendPromptIfLost(m, a, handle);
    }
    const verdict = sessionVerdict({
      record,
      handle: handleView(handle),
      attempt: a.state,
      hasSession: a.assignment.sessionIds.length > 0,
      turnEnded: w.turnEnded,
      stoppedByUs: !!sid && this.stoppedByUs.has(sid.toLowerCase()),
    });
    if (verdict.kind === 'finished') {
      const now = this.now();
      w.finishedSince ??= now;
      const left = this.settleMs - (now - w.finishedSince);
      // A background task or a follow-up can start another turn right after one
      // ends; the session has to stay finished for a moment to count.
      if (left > 0) {
        clearTimeout(w.timer);
        w.timer = setTimeout(() => this.poke(w), left);
        return;
      }
    } else {
      w.finishedSince = undefined;
    }
    // The wall clock (§15.3): active time only, so a wait on a person does not count.
    if (verdict.kind === 'running' && a.launchedAt !== undefined && a.state !== 'waiting-human') {
      const now = this.now();
      const limit = this.limits(m).wallClockMs;
      const active = now - a.launchedAt - waitedMs(a, now);
      if (active >= limit) return this.overran(w, a, active, limit);
      clearTimeout(w.clock);
      w.clock = setTimeout(() => this.poke(w), Math.max(50, limit - active));
    }
    await this.apply(w.missionId, w.attemptId, verdict);
  }

  /**
   * An attempt past its wall clock (§15.2 `stuck`): interrupt it, end it as
   * `stuck`, and let escalation decide (one fresh try, then a person).
   */
  private async overran(w: Watcher, a: ExecutionAttempt, activeMs: number, limitMs: number): Promise<void> {
    this.unwatch(a.id);
    this.log(`task ${w.missionId}: attempt ${a.n} ran ${Math.round(activeMs / 1000)}s, past its wall clock; interrupting it`);
    await bounded(w.handle.interrupt().catch(() => undefined), END_SESSION_WAIT_MS);
    const cls = classifyOutcome({ overran: { activeMs, limitMs } })!;
    let m = this.need(w.missionId);
    m = this.endAttempt(m, a.id, 'failed', { status: 'failed', category: cls.category, signature: cls.signature }, cls.detail);
    this.put(m);
    await this.releaseTree(w.missionId, a.id);
    await this.escalate(w.missionId, a.id, cls, { what: 'was stopped' });
  }

  /** Act on a verdict. Runs in the mission's queue. */
  private async apply(missionId: string, attemptId: string, v: SessionVerdict): Promise<void> {
    let m = this.need(missionId);
    const a = m.attempts.find((x) => x.id === attemptId);
    if (!a || !LIVE.includes(a.state)) return;
    const now = this.now();
    switch (v.kind) {
      case 'ignore':
        return;
      case 'running': {
        let next = m;
        if (a.state === 'launching') next = this.patchAttempt(next, a.id, (x) => transitionAttempt(next, x, 'running', { now }));
        if (a.state === 'waiting-human') {
          // Someone answered: that is the user taking part (§16.3).
          next = this.patchAttempt(next, a.id, (x) => ({ ...closeWait(transitionAttempt(next, x, 'running', { now }), now), flags: { ...x.flags, userIntervened: true } }));
        }
        if (!!a.flags.hostUnreachable !== !!v.unreachable) {
          next = this.patchAttempt(next, a.id, (x) => ({ ...x, flags: { ...x.flags, hostUnreachable: v.unreachable || undefined }, stateReason: v.unreachable ? 'its session host is not answering' : undefined }));
        }
        if (next !== m) this.put(next);
        return;
      }
      case 'waiting-human': {
        if (a.state === 'waiting-human') return;
        let next = m;
        if (a.state === 'launching') next = this.patchAttempt(next, a.id, (x) => transitionAttempt(next, x, 'running', { now }));
        next = this.patchAttempt(next, a.id, (x) => ({ ...transitionAttempt(next, x, 'waiting-human', { now, reason: 'waiting for an answer' }), timing: { ...x.timing, waitingSince: now } }));
        this.put(next);
        this.notify(next, 'needs you', 'The task’s agent is asking something.', 'show-session');
        return;
      }
      case 'finished': {
        const lastTurn = this.watchers.get(a.id)?.lastTurn;
        this.unwatch(a.id);
        await this.finish(missionId, a.id, lastTurn);
        return;
      }
      case 'held': {
        if (m.tasks.find((t) => t.id === a.taskId)?.state === 'needs-human') return;
        m = this.patchTask(m, a.taskId, (t) => transitionTask(m, t, 'needs-human', { now, reason: v.reason }));
        m = this.patchAttempt(m, a.id, (x) => ({ ...x, stateReason: v.reason }));
        this.put(m);
        this.notify(m, 'needs you', `Its session is ${v.reason}.`);
        return;
      }
      case 'interrupted': {
        this.unwatch(a.id);
        m = this.endAttempt(m, a.id, 'interrupted', { status: 'interrupted', category: 'lost', signature: v.reason }, v.reason, { resumable: v.resumable });
        this.put(m);
        if (v.unexpected) this.log(`task ${missionId}: attempt ${a.n} lost its session record, which should not happen once #72 keeps live records`);
        await this.releaseTree(missionId, a.id);
        // One automatic Resume under `autoRecover`, never after a host crash; otherwise the user's (§23.3).
        const cls = classifyOutcome({ session: { state: 'interrupted', endedReason: v.reason } })!;
        await this.escalate(missionId, a.id, cls, { what: 'was interrupted' }, { resumable: v.resumable, autoResumable: v.autoResumable });
        return;
      }
      case 'cancelled':
        this.unwatch(a.id);
        m = this.patchAttempt(m, a.id, (x) => ({ ...x, flags: { ...x.flags, tookOver: true } }));
        m = this.endAttempt(m, a.id, 'cancelled', { status: 'cancelled' }, v.reason);
        this.put(m);
        await this.releaseTree(missionId, a.id);
        this.notify(this.need(missionId), 'stopped', `Its session was ${v.reason}.`);
        return;
      case 'failed': {
        this.unwatch(a.id);
        const lost = await this.localServerLost(m, a, v.category);
        const cls: Classification = lost
          ? classifyOutcome({ localServerLost: true })!
          : { category: v.category, signature: v.reason, detail: `its agent failed (${v.reason})` };
        m = this.need(missionId);
        m = this.endAttempt(m, a.id, 'failed', { status: 'failed', category: cls.category, signature: cls.signature }, lost ? LOCAL_SERVER_LOST_TEXT : v.reason);
        this.put(m);
        await this.releaseTree(missionId, a.id);
        if (lost && (await this.failover(missionId, a.id))) return;
        await this.escalate(missionId, a.id, cls, { what: 'failed' });
        return;
      }
    }
  }

  // ---- Escalation (#41, §15) ----

  /** §15.3's limits for the mission's mode. */
  private limits(m: Mission): EscalationLimits {
    return limitsFor(m.policy.mode ?? 'manual', this.deps.escalationLimits);
  }

  private decisionOf(m: Mission, attemptId: string | undefined): RoutingDecision | undefined {
    const a = attemptId ? m.attempts.find((x) => x.id === attemptId) : undefined;
    return a ? m.decisions.find((d) => d.id === a.routingDecisionId) : undefined;
  }

  /**
   * An attempt has failed and been ended: decide the next step by rule
   * (`decideEscalation`), record every step (skipped ones too) on the task
   * and as telemetry, then act. A step that starts an attempt leaves the task
   * `queued` (or `blocked`, waiting out a rate limit) and runs when it is
   * due, in a later step of the mission's queue; anything else leaves it with
   * the user, saying why. Runs in the mission's queue.
   */
  private async escalate(
    missionId: string,
    attemptId: string,
    cls: Classification,
    notice: { what: string; click?: 'open-diff' | 'show-session' },
    lost?: { resumable: boolean; autoResumable: boolean },
  ): Promise<void> {
    let m = this.need(missionId);
    const a = m.attempts.find((x) => x.id === attemptId);
    const task = a && m.tasks.find((t) => t.id === a.taskId);
    // Cancelled, skipped or otherwise moved on while the attempt was ending: nothing to decide.
    if (!a || !task || task.state !== 'needs-human' || m.state !== 'running' || this.disposed) return;
    let outcome: ReturnType<typeof decideEscalation>;
    try {
      outcome = decideEscalation(this.escalationInput(m, task, a, cls, lost));
    } catch (e) {
      // A bug here must not leave the task looking busy: it stays with the user.
      this.log(`task ${missionId}: escalation failed: ${errorText(e)}`);
      this.notify(m, notice.what, `${capitalise(cls.detail)}. Retry it, or cancel it.`, notice.click);
      return;
    }
    const { final } = outcome;
    const now = this.now();
    const autoResume = cls.category === 'lost' && final.action === 'retry-same';
    const launching = !final.blockedBy && LAUNCHING_ACTIONS.includes(final.action) && !autoResume;
    m = this.patchTask(m, task.id, (t) => ({ ...t, escalations: [...t.escalations, ...outcome.decisions] }));
    if (launching) {
      m = this.patchTask(m, task.id, (t) => transitionTask(m, t, 'queued', { now, reason: pendingText(final, now) }));
      if (final.action === 'wait') m = this.patchTask(m, task.id, (t) => transitionTask(m, t, 'blocked', { now, reason: pendingText(final, now) }));
    } else if (!autoResume) {
      m = this.patchTask(m, task.id, (t) => ({ ...t, stateReason: final.reason }));
    }
    this.put(m);
    for (const d of outcome.decisions) this.writeTelemetry(m, escalationRecord(m, d, now));
    this.log(
      `task ${missionId}: attempt ${a.n} ${cls.category} (${cls.signature}) → ${outcome.decisions.map((d) => (d.blockedBy ? `${d.action}✗${d.blockedBy}` : d.action)).join(' → ')}`,
    );
    if (autoResume) {
      // After this step, in the same queue: never inside it.
      void this.resume(missionId, { auto: true }).catch((e) => this.log(`task ${missionId}: automatic resume failed: ${String(e)}`));
      return;
    }
    if (launching) {
      this.scheduleEscalation(missionId, final);
      // A step that spends more (a bigger route) or waits a while is worth a word; a plain retry is not.
      if (changesRoute(final.action) || final.action === 'wait') this.notify(m, 'is escalating', final.reason, 'show-session');
      return;
    }
    this.notify(m, notice.what, final.reason, notice.click);
  }

  /** Everything `decideEscalation` needs, from the mission as it is now. */
  private escalationInput(
    m: Mission,
    task: Task,
    a: ExecutionAttempt,
    cls: Classification,
    lost: { resumable: boolean; autoResumable: boolean } | undefined,
  ): EscalationInput {
    const eff = this.effective(m, task);
    const policy = eff.policy;
    const mode = m.policy.mode ?? 'manual';
    const d = this.decisionOf(m, a.id);
    const target = d?.resolution.target;
    let snapshot: ResolverSnapshot | undefined;
    try {
      snapshot = this.deps.routing?.snapshot();
    } catch {
      snapshot = undefined;
    }
    const entry = target ? snapshot?.catalog.entries.find((e) => e.descriptor.source === target.source && (e.aliases.includes(target.model || 'default') || e.descriptor.modelId === target.model)) : undefined;
    const window = entry?.descriptor.contextWindow;
    const route = {
      harness: target?.harness ?? a.assignment.harness,
      model: target?.model ?? '',
      tier: target?.tier ?? 'unassigned',
      // What AW asked for: the level sent, or for a routed decision its requirement; unknown when nothing was sent.
      effort: target && target.effortNative !== 'none' ? awEffort(target.effortNative) : d?.decidedBy === 'router' ? d.requirement.effort : undefined,
      ...(window && isKnown(window) ? { contextWindow: window.value } : {}),
    };
    const history = task.attemptIds
      .map((id) => m.attempts.find((x) => x.id === id))
      .filter((x): x is ExecutionAttempt => !!x && !!x.outcome)
      .map((x) => ({
        id: x.id,
        n: x.n,
        status: x.outcome!.status,
        category: x.outcome!.category,
        signature: x.outcome!.signature,
        resume: !!x.resumeOf,
        autoResumed: x.autoResumed,
      }));
    const harness = this.deps.harnesses.get(route.harness);
    const caps = policy.caps ?? {};
    const costs = m.attempts.filter((x) => x.taskId === task.id && x.usage?.costUsd !== undefined).map((x) => x.usage!.costUsd!);
    const pinnedBy: Partial<Record<RouteDimension, string>> = {};
    for (const dim of ['harness', 'model', 'effort'] as const) if (eff.from[`pins.${dim}`]) pinnedBy[dim] = scopeName(eff.from[`pins.${dim}`]!);
    if (pinnedBy.model) pinnedBy.tier = pinnedBy.model;
    const cappedBy: EscalationInput['cappedBy'] = {};
    for (const k of Object.keys(caps) as (keyof typeof caps)[]) if (eff.from[`caps.${k}`]) cappedBy[k] = scopeName(eff.from[`caps.${k}`]!);
    return {
      taskId: task.id,
      afterAttemptId: a.id,
      classification: cls,
      history,
      decisions: task.escalations,
      route,
      mode,
      pinned: pinnedDimensions(policy),
      pinnedBy,
      caps,
      cappedBy,
      // Mission-wide switches: a task's overrides cannot set them, so the mission's resolved policy has them.
      frontierAllowed: m.policy.frontierAllowed === true,
      autoRecover: m.policy.autoRecover === true,
      ...(lost ? { lost } : {}),
      tiers: snapshot?.catalog.tiers ?? DEFAULT_TIERS,
      ...(costs.length > 0 ? { spentUsd: costs.reduce((s, c) => s + c, 0) } : {}),
      sessionContinuable: cls.category !== 'stuck' && this.sessionContinuable(a),
      effortMidSession: (harness?.capabilities().midSessionEffortChange ?? 'none') !== 'none',
      ...(target && snapshot?.sources[target.source]?.capacity.backoffUntil !== undefined ? { capacityBackAt: snapshot.sources[target.source].capacity.backoffUntil } : {}),
      limits: this.limits(m),
      probe: (req) => this.probeRoute(policy, route.effort, snapshot, req),
      now: this.now(),
      newId: () => this.id(),
    };
  }

  /** The failed attempt's session can take another message: idle here, or on record and resumable by its harness. */
  private sessionContinuable(a: ExecutionAttempt): boolean {
    if (this.continuableHandle(a)) return true;
    const sid = a.assignment.sessionIds.at(-1);
    const record = sid ? (this.deps.registry.get(sid) as SessionRecord | undefined) : undefined;
    const harness = this.deps.harnesses.get(a.assignment.harness);
    return !!record && record.state !== 'failed' && !!harness?.capabilities().resume;
  }

  /** The attempt's session, live here, idle and asking nothing: it can be sent the next message now. */
  private continuableHandle(a: ExecutionAttempt): SessionHandle | undefined {
    const sid = a.assignment.sessionIds.at(-1);
    const h = sid ? this.deps.sessions.get(sid) : undefined;
    if (!h || h.lifecycle !== 'idle' || !h.canSend) return undefined;
    return handleView(h).pendingAsk ? undefined : h;
  }

  /** Is there a model the policy allows to move to? Answered from a resolver snapshot (§9.4). */
  private probeRoute(policy: ExecutionPolicy, effort: EffortLevel | undefined, snapshot: ResolverSnapshot | undefined, req: ProbeRequest): ProbeAnswer {
    if (!snapshot) return { ok: false, reason: 'there is no model catalog to choose from.' };
    const { effort: _effort, ...pins } = policy.pins ?? {};
    const requirement: RouteRequirement = {
      minTier: req.tier,
      maxTier: req.tier,
      effort: effort ?? 'medium',
      needs: req.largerContextThan !== undefined ? [`context:${req.largerContextThan + 1}`] : [],
      gates: [],
    };
    const res = resolveRoute(requirement, snapshot, {
      caps: policy.caps,
      preferences: policy.preferences,
      exclusions: { ...policy.exclusions, harnesses: [...(policy.exclusions?.harnesses ?? []), ...(req.notHarness ? [req.notHarness] : [])] },
      pins: { ...pins, ...(req.harness ? { harness: req.harness } : {}) },
      allowEscalationTiers: req.escalationTier === true,
    });
    if (res.outcome === 'resolved' && res.target) return { ok: true, target: res.target };
    return { ok: false, reason: res.note ?? 'nothing the policy allows.' };
  }

  /** Run a pending step when it is due. */
  private scheduleEscalation(missionId: string, d: EscalationDecision): void {
    if (this.disposed) return;
    const had = this.escalationTimers.get(d.id);
    if (had) clearTimeout(had.timer);
    const delay = Math.max(0, (d.notBefore ?? 0) - this.now());
    const timer = setTimeout(() => {
      this.escalationTimers.delete(d.id);
      void this.queue(missionId, () => this.runEscalation(missionId, d.id)).catch((e) => this.log(`task ${missionId}: escalation step failed: ${errorText(e)}`));
    }, delay);
    this.escalationTimers.set(d.id, { missionId, timer });
  }

  private clearEscalations(missionId?: string): void {
    for (const [id, t] of this.escalationTimers) {
      if (missionId !== undefined && t.missionId !== missionId) continue;
      clearTimeout(t.timer);
      this.escalationTimers.delete(id);
    }
  }

  /**
   * Carry out a pending step. Checked again first — the user may have
   * cancelled, skipped, retried or changed the policy meanwhile — and then:
   * `continue` sends the failure to the failed attempt's session (live, or
   * resumed), `fresh` ends that session, keeps its worktree and branch, and
   * starts a new attempt from the task's start in a fresh one (§15.2). Runs
   * in the mission's queue.
   */
  private async runEscalation(missionId: string, decisionId: string): Promise<void> {
    let m = this.missions.get(missionId);
    const task = m?.tasks.find((t) => t.escalations.some((d) => d.id === decisionId));
    const d = task && pendingEscalation(task);
    if (!m || !task || !d || d.id !== decisionId || m.state !== 'running' || this.disposed) return;
    const prev = m.attempts.find((a) => a.id === d.afterAttemptId);
    if (!prev) return;
    if (task.state === 'blocked') {
      m = this.patchTask(m, task.id, (t) => transitionTask(m!, t, 'queued', { now: this.now(), reason: `${d.action}: starting` }));
      this.put(m);
    }
    const route = this.escalatedRoute(m, prev, d);
    const message = escalationMessage(task, prev, d);
    let mode = d.mode ?? 'fresh';
    const live = this.continuableHandle(prev);
    if (mode === 'continue' && !live && !this.sessionContinuable(prev)) mode = 'fresh';
    if (mode === 'continue' && d.action === 'raise-effort') {
      // Raised in the running session where the harness can (§6.4); otherwise a fresh session at the new level.
      const applied = live && route.effort ? await live.setEffort(route.effort).catch(() => 'unsupported' as const) : 'unsupported';
      if (applied !== 'applied') mode = 'fresh';
    }
    // The count caps as they are now (§10.2): a cap set or tightened while the step waited still holds.
    const eff = this.effective(m, task);
    const refusal = eff.conflicts.length > 0 ? conflictText(eff.conflicts) : admissionRefusal(eff, this.admissionFacts(m, this.withPins(route, eff.policy.pins), false, task));
    if (refusal) return this.stopEscalation(missionId, task.id, d, refusal, eff.conflicts.length > 0 ? 'pin' : 'cap');
    this.log(`task ${missionId}: ${task.key} ${d.action} (${mode}) after attempt ${prev.n}`);
    try {
      if (mode === 'continue') {
        await this.launch(missionId, { mode: 'continue', continues: prev, route, escalation: d, message });
      } else {
        await this.endSession(this.need(missionId), prev);
        if (isPlanned(this.need(missionId))) {
          await this.releaseTree(missionId, prev.id);
          await this.restartTree(missionId, task.id, prev);
        } else {
          await this.retainTree(this.need(missionId), prev);
        }
        await this.launch(missionId, { mode: 'fresh', route, taskId: task.id, escalation: d, feedback: message });
      }
    } catch (e) {
      m = this.need(missionId);
      const t = m.tasks.find((x) => x.id === task.id)!;
      const newest = m.attempts.find((a) => a.id === t.attemptIds.at(-1));
      if (newest && newest.id !== prev.id && newest.state === 'failed') {
        // The step's own attempt could not start: an infra failure with its own counter.
        await this.escalate(missionId, newest.id, { category: 'infra', signature: newest.outcome?.signature ?? 'launch-failed', detail: `it could not start (${errorText(e)})` }, { what: 'failed' });
        return;
      }
      // Refused before any attempt existed (the harness is gone, the worktree is gone): the user decides.
      this.stopEscalation(missionId, t.id, d, `The ${d.action} could not start: ${errorText(e)}`);
    }
  }

  /** A pending step that cannot run: recorded as a stop, and the task goes to the user saying why. */
  private stopEscalation(missionId: string, taskId: string, d: EscalationDecision, reason: string, blockedBy?: EscalationDecision['blockedBy']): void {
    let m = this.need(missionId);
    const now = this.now();
    const stop: EscalationDecision = {
      id: this.id(),
      taskId,
      afterAttemptId: d.afterAttemptId,
      evidence: d.evidence,
      action: 'stop',
      ...(blockedBy ? { blockedBy } : {}),
      reason,
      decidedAt: now,
    };
    const state = m.tasks.find((x) => x.id === taskId)?.state;
    if (state === 'blocked') m = this.patchTask(m, taskId, (x) => transitionTask(m, x, 'queued', { now }));
    if (state !== 'queued' && state !== 'blocked') return;
    m = this.patchTask(m, taskId, (x) => transitionTask(m, { ...x, escalations: [...x.escalations, stop] }, 'needs-human', { now, reason }));
    this.put(m);
    this.writeTelemetry(m, escalationRecord(m, stop, now));
    this.log(`task ${missionId}: ${d.action} stopped: ${reason}`);
    this.notify(m, 'needs you', reason);
  }

  /** The route a step runs on: the failed attempt's, with the step's change. */
  private escalatedRoute(m: Mission, prev: ExecutionAttempt, d: EscalationDecision): TaskRoute {
    const base = routeOf(m, prev);
    const t = d.target;
    if (t) {
      // A new model keeps "no effort sent" when the last route sent none.
      const effort = base.effort && t.effortNative !== 'none' ? t.effortNative : undefined;
      return {
        harness: t.harness,
        ...(isEndpointSource(t.source) ? { source: t.source } : {}),
        model: t.model,
        ...(effort ? { effort } : {}),
        ...(t.harness === base.harness && base.permissionMode ? { permissionMode: base.permissionMode } : {}),
      };
    }
    if (d.delta?.effort) {
      const native = this.nativeEffort(base, d.delta.effort);
      return native ? { ...base, effort: native } : base;
    }
    return base;
  }

  // ---- Local endpoints (#51) ----

  /**
   * Whether an `infra` failure on a local model was its server going away:
   * the endpoint does not answer a health read now. Anything else (a turn
   * that failed with the server up) stays the failure it was.
   */
  private async localServerLost(m: Mission, a: ExecutionAttempt, category: OutcomeCategory | undefined): Promise<boolean> {
    if (category !== 'infra' || !this.deps.local) return false;
    const source = m.decisions.find((d) => d.id === a.routingDecisionId)?.resolution.target.source;
    if (!isEndpointSource(source)) return false;
    const state = await this.deps.local.check(source!).catch((): HealthState => 'unknown');
    return state === 'down' || state === 'degraded';
  }

  /**
   * An endpoint was just read as `down`: every attempt running on it has lost
   * its model mid-attempt. Ended as `infra` rather than left to a harness that
   * may retry for minutes, then failed over where the route allows.
   */
  private onLocalDown(source: ModelSourceId): void {
    for (const m of this.missions.values()) {
      const a = this.currentAttempt(m);
      if (!a || !['launching', 'running', 'waiting-human'].includes(a.state)) continue;
      const d = m.decisions.find((x) => x.id === a.routingDecisionId);
      if (d?.resolution.target.source !== source) continue;
      void this.queue(m.id, () => this.serverLost(m.id, a.id)).catch((e) => this.log(`task ${m.id}: ${errorText(e)}`));
    }
  }

  private async serverLost(missionId: string, attemptId: string): Promise<void> {
    let m = this.need(missionId);
    const a = m.attempts.find((x) => x.id === attemptId);
    if (!a || !['launching', 'running', 'waiting-human'].includes(a.state)) return;
    this.log(`task ${missionId}: attempt ${a.n} lost its local model server`);
    await this.endSession(m, a);
    m = this.need(missionId);
    m = this.endAttempt(m, a.id, 'failed', { status: 'failed', category: 'infra', signature: LOCAL_SERVER_LOST }, LOCAL_SERVER_LOST_TEXT);
    this.put(m);
    await this.releaseTree(missionId, a.id);
    if (await this.failover(missionId, a.id)) return;
    await this.escalate(missionId, a.id, classifyOutcome({ localServerLost: true })!, { what: 'failed' });
  }

  /** Why the task may not fail over on its own, or undefined when it may. */
  private failoverBlocked(m: Mission, d: RoutingDecision, task: Task): string | undefined {
    if (m.state !== 'running' || task.state !== 'needs-human') return 'the task is not waiting';
    // A route the user picked by hand is theirs to change, unless they opted into automatic recovery.
    if (d.decidedBy !== 'router' && m.policy.autoRecover !== true) return 'the route was picked by hand';
    const max = m.policy.caps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (task.attemptIds.length >= max) return `it has had ${task.attemptIds.length} of ${max} attempts`;
    if (!this.deps.routing) return 'there is no catalog to fail over with';
    return undefined;
  }

  /**
   * Failover within the tier (§9.4 step 5): the same requirement pinned to
   * the tier that ran, re-resolved against a fresh snapshot with the failed
   * source excluded. Never a different tier: a failover must not quietly
   * change capability. True when a new attempt was launched.
   */
  private async failover(missionId: string, failedAttemptId: string): Promise<boolean> {
    let m = this.need(missionId);
    const failed = m.attempts.find((x) => x.id === failedAttemptId);
    const d = failed && m.decisions.find((x) => x.id === failed.routingDecisionId);
    const task = failed && m.tasks.find((x) => x.id === failed.taskId);
    if (!failed || !d || !task) return false;
    const blocked = this.failoverBlocked(m, d, task);
    if (blocked) {
      this.log(`task ${missionId}: no failover: ${blocked}`);
      return false;
    }
    const from = d.resolution.target;
    const requirement = { ...d.requirement, minTier: from.tier, maxTier: from.tier };
    const snapshot = this.deps.routing!.snapshot();
    const res = resolveRoute(requirement, snapshot, {
      caps: m.policy.caps,
      preferences: m.policy.preferences,
      exclusions: { ...m.policy.exclusions, sources: [...(m.policy.exclusions?.sources ?? []), from.source] },
    });
    if (res.outcome !== 'resolved' || !res.target) {
      this.log(`task ${missionId}: no failover: ${res.note ?? `nothing else at ${from.tier}`}`);
      return false;
    }
    const t = res.target;
    const recommendation: RouteRecommendation = {
      assessmentId: d.assessmentId ?? d.shadow?.assessmentId ?? '',
      policyVersion: 'failover',
      requirement,
      reasons: [
        {
          ruleId: 'failover.infra',
          text: `${from.model} lost its server mid-attempt; failing over to another ${from.tier} model.`,
          inputs: { from: from.source, tier: from.tier },
        },
      ],
      verdict: 'route',
      resolution: { target: t, candidates: res.candidates, catalogVersion: res.catalogVersion, ...(res.note ? { note: res.note } : {}) },
      at: this.now(),
    };
    const route: TaskRoute = {
      harness: t.harness,
      ...(isEndpointSource(t.source) ? { source: t.source } : {}),
      model: t.model,
      ...(t.effortNative !== 'none' ? { effort: t.effortNative } : {}),
      permissionMode: decisionMode(d),
    };
    // The task's pins (#40) name the route that lost its server; launch applies
    // pins over the route, so they move with the failover. A pin or cap at a
    // wider scope that forbids the new route stops the failover instead.
    const overrides = { ...task.overrides, pins: routePins(route) };
    const conflicts = checkPolicyEdit(missionLayers(m, task), 'task', taskLayer(overrides), this.policyContext());
    if (conflicts.length > 0) {
      this.log(`task ${missionId}: no failover: ${conflictText(conflicts)}`);
      return false;
    }
    m = await this.retainTree(m, failed);
    // Every step is an escalation event (§15.3), this one included.
    const priorSteps = task.escalations.filter((x) => !x.blockedBy && x.step !== undefined).length;
    const step: EscalationDecision = {
      id: this.id(),
      taskId: task.id,
      afterAttemptId: failed.id,
      evidence: { category: 'infra', signature: LOCAL_SERVER_LOST, repeats: 1 },
      action: 'switch-model',
      delta: { harness: t.harness },
      reason: `${capitalise(LOCAL_SERVER_LOST_TEXT)}: failing over to ${t.model}, same tier (${t.tier}).`,
      decidedAt: this.now(),
      mode: 'fresh',
      target: t,
      step: priorSteps + 1,
    };
    m = this.patchTask(m, task.id, (x) => ({ ...x, overrides, escalations: [...x.escalations, step] }));
    this.put(m);
    this.writeTelemetry(m, escalationRecord(m, step, this.now()));
    this.log(`task ${missionId}: failing over from ${from.model} to ${t.model} (${t.tier})`);
    try {
      await this.launch(missionId, { mode: 'fresh', route, taskId: task.id, routing: { recommendation, offered: false, accepted: true, failover: true }, escalation: step });
    } catch (e) {
      this.log(`task ${missionId}: failover could not start: ${errorText(e)}`);
      return false;
    }
    this.notify(this.need(missionId), 'failed over', `${capitalise(LOCAL_SERVER_LOST_TEXT)}; carrying on with ${t.model}.`, 'show-session');
    return true;
  }

  /** What an attempt record says about a run on a local endpoint (§19.4). */
  private localMetrics(m: Mission, a: ExecutionAttempt, activeMs: number | undefined, queueMs: number | undefined): LocalRunMetrics | undefined {
    const d = m.decisions.find((x) => x.id === a.routingDecisionId);
    const t = d?.resolution.target;
    if (!d || !t || !isEndpointSource(t.source)) return undefined;
    const out: LocalRunMetrics = { source: t.source, ...this.deps.local?.facts?.(t.source, t.model) };
    if (queueMs !== undefined) out.queueMs = queueMs;
    const tokens = a.usage?.outputTokens;
    if (tokens && activeMs && activeMs > 0) {
      // Through a harness nothing reports decode speed; this is output over active time, and says so.
      out.outTokPerSec = Math.round((tokens / (activeMs / 1000)) * 10) / 10;
      out.tokPerSecFrom = 'attempt';
    }
    const avoided = this.hostedEquivalent(d, a);
    if (avoided) {
      out.apiEquivalentUsd = avoided.usd;
      out.apiEquivalentModel = avoided.model;
    }
    return out;
  }

  /**
   * **An estimate:** what the hosted route the router would otherwise have
   * picked — the same requirement with every endpoint excluded — would have
   * cost for this attempt's tokens, at that model's price table. Undefined
   * when there is no such route or it has no price.
   */
  private hostedEquivalent(d: RoutingDecision, a: ExecutionAttempt): { usd: number; model: string } | undefined {
    const u = a.usage;
    if (!this.deps.routing || !u || (u.inputTokens === undefined && u.outputTokens === undefined)) return undefined;
    try {
      const snap = this.deps.routing.snapshot();
      const endpoints = [...new Set(snap.catalog.entries.map((e) => e.descriptor.source).filter((s) => isEndpointSource(s)))];
      const res = resolveRoute(d.requirement, snap, { exclusions: { sources: endpoints, disableLocal: true } });
      const t = res.target;
      if (!t) return undefined;
      const entry = snap.catalog.entries.find((e) => e.descriptor.source === t.source && e.aliases.includes(t.model));
      const p = entry?.descriptor.price;
      if (!p) return undefined;
      const cached = u.cacheReadTokens ?? 0;
      const fresh = Math.max(0, (u.inputTokens ?? 0) - (p.cacheReadPerMTok !== undefined ? cached : 0));
      const usd = (fresh * p.inPerMTok + (u.outputTokens ?? 0) * p.outPerMTok + (p.cacheReadPerMTok !== undefined ? cached * p.cacheReadPerMTok : 0)) / 1e6;
      return { usd: Math.round(usd * 1e6) / 1e6, model: entry.descriptor.resolvedId ?? entry.descriptor.modelId };
    } catch {
      return undefined;
    }
  }

  /**
   * The attempt's work is over: commit what it left, measure the branch,
   * and hand the result to the user. Safe to run again after a crash part-way.
   * No verification until #35, so the task waits for the user's review.
   */
  private async finish(missionId: string, attemptId: string, lastTurn?: unknown): Promise<void> {
    let m = this.need(missionId);
    let a = m.attempts.find((x) => x.id === attemptId)!;
    const now = this.now();
    if (a.state === 'running' || a.state === 'waiting-human' || a.state === 'launching') {
      if (a.state === 'launching') m = this.patchAttempt(m, a.id, (x) => transitionAttempt(m, x, 'running', { now }));
      if (a.state === 'waiting-human') m = this.patchAttempt(m, a.id, (x) => closeWait(transitionAttempt(m, x, 'running', { now }), now));
      m = this.patchAttempt(m, a.id, (x) => transitionAttempt(m, x, 'finishing', { now }));
      this.put(m);
    }
    a = m.attempts.find((x) => x.id === attemptId)!;
    const task = m.tasks.find((t) => t.id === a.taskId)!;
    // Only the turn this core saw end: after a restart there may be none, and then nothing says it failed.
    const failure = turnFailure(lastTurn);
    const tree = m.worktrees.find((w) => w.id === a.worktreeId);
    if (!tree) {
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: 'infra', signature: 'no-worktree' }, 'its worktree record has gone'));
      return;
    }
    // Measured from where the attempt started: in a mission tree, the task before it's result.
    const wt = measured(tree, a);
    let stats: Awaited<ReturnType<WorktreeManager['diffStats']>>;
    try {
      const manager = await this.managerFor(m);
      if (wt.state !== 'missing') await manager.commitAll(wt, `aw: ${task.key}: attempt ${a.n}`);
      stats = await manager.diffStats(wt);
    } catch (e) {
      m = this.need(missionId);
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: 'infra', signature: 'git' }, `could not record its result: ${errorText(e)}`));
      await this.releaseTree(missionId, a.id);
      this.notify(this.need(missionId), 'failed', 'Its changes could not be committed; they are still in its worktree.');
      return;
    }
    m = this.need(missionId);
    m = this.patchAttempt(m, a.id, (x) => ({ ...x, git: { baseCommit: wt.baseCommit, ...stats } }));
    this.put(m);
    // The two ways an attempt is over before anything is worth checking. Both
    // release the tree first: there is nothing to run in it.
    const gates = this.decisionOf(m, a.id)?.requirement.gates ?? [];
    if (failure) {
      m = await this.releaseTree(missionId, a.id);
      const lost = await this.localServerLost(m, a, failure.category);
      m = this.need(missionId);
      const cls = classifyOutcome({ lastTurn, localServerLost: lost })!;
      const why = lost ? LOCAL_SERVER_LOST_TEXT : `its last turn ended in an error (${failure.signature})`;
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: cls.category, signature: cls.signature }, why));
      if (lost && (await this.failover(missionId, a.id))) return;
      await this.escalate(missionId, a.id, cls, { what: 'failed' });
      return;
    }
    if (stats.filesChanged === 0) {
      m = await this.releaseTree(missionId, a.id);
      const cls = classifyOutcome({ lastTurn, filesChanged: 0, gates })!;
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: cls.category, signature: cls.signature }, 'the attempt changed nothing'));
      await this.escalate(missionId, a.id, cls, { what: 'changed nothing' });
      return;
    }

    // Verification runs while the worktree is still this attempt's: the
    // commands run *in* it, so releasing it first would be handing the tree
    // back and then using it anyway.
    a = m.attempts.find((x) => x.id === attemptId)!;
    if (a.state === 'finishing') {
      m = this.patchAttempt(m, a.id, (x) => transitionAttempt(m, x, 'verifying', { now: this.now() }));
      this.put(m);
    }
    const results = await this.verify(missionId, attemptId, wt, stats.headCommit);
    m = this.need(missionId);
    m = this.patchAttempt(m, a.id, (x) => ({ ...x, verification: results }));
    this.put(m);
    m = await this.releaseTree(missionId, a.id);

    const plan = task.verification;
    const verdict = summariseVerification(plan, results);
    this.log(`task ${missionId}: attempt ${a.n} ${verdict.verdict}: ${verdict.summary}`);
    if (verdict.verdict === 'failed') {
      // New or a repeat: the same signature as the task's last failed attempt (§15.2).
      const cls = classifyOutcome({
        lastTurn,
        gates,
        filesChanged: stats.filesChanged,
        verification: { verdict: 'failed', signature: verdict.signature, summary: verdict.summary },
        previousSignature: previousFailure(m, task, a.id)?.outcome?.signature,
      })!;
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: cls.category, signature: cls.signature }, `verification failed: ${verdict.summary}`));
      await this.escalate(missionId, a.id, cls, { what: 'failed verification', click: 'open-diff' });
      return;
    }
    // In a planned mission a pass is the result (§7.2: done by verification),
    // and the next task starts from it; nobody is asked.
    if (isPlanned(m) && verdict.verdict === 'passed') {
      m = this.endAttempt(m, a.id, 'succeeded', { status: 'succeeded' }, `passed: ${verdict.summary}`, {}, { hold: true });
      this.put(m);
      try {
        await this.markDone(missionId, task.id, 'verification', `passed its checks: ${verdict.summary}`);
      } catch (e) {
        // The result stands; only moving the mission branch on failed. The user decides.
        m = this.need(missionId);
        this.put(this.patchTask(m, task.id, (t) => (t.state === 'verifying' ? transitionTask(m, t, 'needs-human', { now: this.now(), reason: errorText(e) }) : t)));
        this.notify(this.need(missionId), 'needs you', `${task.key} passed, but ${errorText(e)}`);
        return;
      }
      await this.endSession(this.need(missionId), a);
      this.log(`mission ${missionId}: ${task.key} done (${stats.commits} commit(s), ${stats.filesChanged} file(s))`);
      await this.launchNext(missionId);
      return;
    }
    // Everything else is the user's call. `passed` is a result they can accept
    // with confidence; `unverified`, `inconclusive` and `error` are results
    // nothing could vouch for, and each says which it is rather than all three
    // arriving as the same bland "ready for review".
    m = this.endAttempt(m, a.id, 'succeeded', { status: 'succeeded' }, `${verdict.verdict}: ${verdict.summary}`);
    this.put(m);
    this.log(`task ${missionId}: attempt ${a.n} finished: ${stats.commits} commit(s), ${stats.filesChanged} file(s)`);
    const headline = verdict.verdict === 'passed' ? 'passed its checks' : `is ready for review (${verdict.verdict})`;
    this.notify(m, headline, `${verdict.summary} — ${stats.filesChanged} file(s) on ${wt.branch}. Click to open the diff.`, 'open-diff');
  }

  /**
   * Run the task's verification plan against an attempt's worktree.
   *
   * Every failure here is the verifier's, not the agent's: if verification
   * itself cannot run, the attempt is not failed for it (§14.3). An empty plan
   * gives an empty list, which `summariseVerification` reads as `unverified` —
   * a repository with no checks produces results nobody has vouched for, and
   * that is exactly what the user is told.
   */
  private async verify(
    missionId: string,
    attemptId: string,
    wt: WorktreeAssignment,
    headCommit: string | undefined,
  ): Promise<VerificationResult[]> {
    const m = this.need(missionId);
    const a = m.attempts.find((x) => x.id === attemptId)!;
    const task = m.tasks.find((t) => t.id === a.taskId)!;
    if (task.verification.stages.length === 0) return [];
    const loaded = this.deps.repoPolicies.forFolder(m.repoRoot);
    if (!loaded) return [];
    try {
      const manager = await this.managerFor(m);
      const verifier = new Verifier({
        exec: this.deps.exec ?? nodeExec,
        logsDir: this.deps.logsDir,
        withBaseCheckout: (base, fn) => manager.withBaseCheckout(base, fn),
        diffText: () => manager.diffText(wt),
        changedFiles: () => manager.changedFiles(wt),
        reviewer: this.deps.reviewer,
        now: this.now,
        log: this.log,
      });
      const assessment = m.assessments.filter((x) => x.taskId === task.id).at(-1);
      return await verifier.run(task.verification, {
        attemptId: a.id,
        task,
        policy: loaded.policy,
        worktree: wt,
        headCommit,
        ...(assessment
          ? { assessment: { risk: assessment.dimensions.risk.value, verifiability: assessment.dimensions.verifiability.value } }
          : {}),
      });
    } catch (e) {
      this.log(`task ${missionId}: verification could not run: ${errorText(e)}`);
      return [
        {
          strategy: 'verification',
          state: 'finished',
          outcome: 'error',
          summary: `verification could not run: ${errorText(e)}`,
          startedAt: this.now(),
        },
      ];
    }
  }

  /**
   * End an attempt (terminal state, outcome, telemetry) and move its task to
   * `needs-human` — or, with `hold`, leave a succeeded one `verifying` for
   * the caller to mark done. Returns the mission; the caller saves it.
   */
  private endAttempt(
    m: Mission,
    attemptId: string,
    to: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
    outcome: { status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; category?: OutcomeCategory; signature?: string },
    reason: string,
    extra: Partial<ExecutionAttempt> = {},
    opts: { hold?: boolean } = {},
  ): Mission {
    const now = this.now();
    m = this.patchAttempt(m, attemptId, (x) => ({ ...transitionAttempt(m, closeWait(x, now), to, { now, reason }), outcome, ...extra }));
    const taskId = m.attempts.find((x) => x.id === attemptId)!.taskId;
    const task = m.tasks.find((t) => t.id === taskId)!;
    if (task.state === 'running' || task.state === 'verifying') {
      if (to === 'succeeded' && task.state === 'running') m = this.patchTask(m, taskId, (t) => transitionTask(m, t, 'verifying', { now }));
      const userStop = to === 'cancelled' && (reason === 'cancelled by the user' || reason === 'skipped by the user');
      if (!userStop && !(opts.hold && to === 'succeeded')) {
        m = this.patchTask(m, taskId, (t) => transitionTask(m, t, 'needs-human', { now, reason }));
      }
    } else if (task.state === 'needs-human') {
      m = this.patchTask(m, taskId, (t) => ({ ...t, stateReason: reason }));
    }
    const a = m.attempts.find((x) => x.id === attemptId)!;
    const record = attemptRecord(m, a, now);
    const local = record && this.localMetrics(m, a, record.activeMs, record.queueMs);
    if (record && local) record.local = local;
    if (record) {
      try {
        this.deps.telemetry?.append(record);
      } catch (e) {
        this.log(`task ${m.id}: could not write its attempt record: ${String(e)}`);
      }
    }
    return m;
  }

  // ---- Worktrees and sessions ----

  private async releaseTree(missionId: string, attemptId: string): Promise<Mission> {
    const m = this.need(missionId);
    const a = m.attempts.find((x) => x.id === attemptId);
    const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (wt?.state === 'in-use') {
      try {
        await (await this.managerFor(m)).release(wt, 'ready');
      } catch (e) {
        this.log(`task ${missionId}: could not let go of its worktree: ${String(e)}`);
      }
    }
    return this.need(missionId);
  }

  /** Keep the last attempt's tree for comparison when a fresh one takes over. */
  private async retainTree(m: Mission, a: ExecutionAttempt | undefined): Promise<Mission> {
    const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (wt && (wt.state === 'ready' || wt.state === 'in-use')) {
      try {
        await (await this.managerFor(m)).release(wt, 'retained');
      } catch (e) {
        this.log(`task ${m.id}: could not keep its worktree: ${String(e)}`);
      }
    }
    return this.need(m.id);
  }

  /** End the attempt's session, if it is still live here: the task can no longer use it (§7.5). */
  private async endSession(m: Mission, a: ExecutionAttempt | undefined): Promise<void> {
    if (!a) return;
    this.unwatch(a.id);
    const id = a.assignment.sessionIds.at(-1);
    const handle = id ? this.deps.sessions.get(id) : undefined;
    if (!id || !handle) return;
    this.stoppedByUs.add(id.toLowerCase());
    // Bounded: this runs in the mission's queue, and a host that is not
    // answering must not hold every later step of the mission behind it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), END_SESSION_WAIT_MS)));
    try {
      const how = await Promise.race([handle.end().then(() => 'ended' as const), bound]);
      if (how === 'timeout') this.log(`task ${m.id}: its session did not end within ${END_SESSION_WAIT_MS / 1000}s; carrying on`);
    } catch (e) {
      this.log(`task ${m.id}: could not end its session: ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private manager(loaded: LoadedRepoPolicy): Promise<WorktreeManager> {
    const key = `${loaded.repo.primaryRoot}\0${loaded.version}`;
    let p = this.managers.get(key);
    if (!p) {
      p = this.deps.openWorktrees(loaded, (a) => this.recordWorktree(a));
      p.catch(() => this.managers.delete(key));
      this.managers.set(key, p);
    }
    return p;
  }

  private managerFor(m: Mission): Promise<WorktreeManager> {
    const loaded = this.deps.repoPolicies.forFolder(m.repoRoot);
    if (!loaded) return Promise.reject(new TaskError(`${m.repoRoot} is no longer a git repository.`));
    return this.manager(loaded);
  }

  /** The worktree manager's write-ahead: every assignment it records lands in its mission. */
  private recordWorktree(a: WorktreeAssignment): void {
    const owner = this.worktreeOwners.get(a.id);
    for (const m of this.missions.values()) {
      // A task's tree by its task; the mission tree (no task) by its id, or by who asked for it.
      if (m.id !== owner && !m.worktrees.some((w) => w.id === a.id) && !(a.taskId && m.tasks.some((t) => t.id === a.taskId))) continue;
      const has = m.worktrees.some((w) => w.id === a.id);
      this.put({ ...m, worktrees: has ? m.worktrees.map((w) => (w.id === a.id ? a : w)) : [...m.worktrees, a] });
      return;
    }
  }

  // ---- Usage (§16.2) ----

  private onTurnRecord(r: TurnRecord): void {
    if (!r.attemptId) return;
    for (const m of this.missions.values()) {
      let a = m.attempts.find((x) => x.id === r.attemptId);
      if (!a) continue;
      // An ended attempt is never reopened: turns after it (the user carrying on) are not its.
      // A session escalation carried on keeps the failed attempt's origin, so
      // its turns name that attempt; they are the live attempt's that continues it (#41).
      if (!LIVE.includes(a.state)) {
        const ended = a;
        a = m.attempts.find((x) => LIVE.includes(x.state) && x.continues === ended.id && x.assignment.sessionIds.some((s) => sameId(s, r.sessionId)));
        if (!a) return;
      }
      const attempt = a;
      void this.queue(m.id, async () => {
        const cur = this.need(m.id);
        // Checked again here: the attempt may have ended (and its record been written) while this waited.
        if (!LIVE.includes(cur.attempts.find((x) => x.id === attempt.id)?.state ?? 'failed')) return;
        const source = cur.decisions.find((d) => d.id === attempt.routingDecisionId)?.resolution.target.source;
        // A local model has `$0 API cost` by rule (§19.4): whatever cost a harness
        // invents for a model it does not know (§19.6 point 3) is not recorded.
        const turn = isEndpointSource(source) ? withoutCost(r) : r;
        this.put(this.patchAttempt(cur, attempt.id, (x) => ({ ...x, usage: addTurnUsage(x.usage, turn) })));
      });
      return;
    }
  }

  // ---- Plumbing ----

  private notify(m: Mission, what: string, body: string, click?: 'open-diff' | 'show-session'): void {
    const onClick =
      click === 'open-diff' && this.deps.openFile
        ? () => void this.diff(m.id).then((f) => this.deps.openFile?.(f)).catch((e) => this.log(`task ${m.id}: ${String(e)}`))
        : undefined;
    this.deps.notify?.({ title: `Task ${what}: ${m.title}`, body, onClick });
  }

  private queue<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(missionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(missionId, next.catch(() => undefined));
    return next;
  }

  private need(missionId: string): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new TaskError('No such task.');
    return m;
  }

  /** Save and publish. Throws if the store cannot write: the mission in memory then stays as it was. */
  private put(m: Mission): void {
    const next = { ...m, updatedAt: this.now() };
    this.deps.store.save(next);
    this.missions.set(next.id, next);
    this.emitter.fire();
  }

  private patchTask(m: Mission, taskId: string, f: (t: Task) => Task): Mission {
    return { ...m, tasks: m.tasks.map((t) => (t.id === taskId ? f(t) : t)) };
  }

  private patchAttempt(m: Mission, id: string, f: (a: ExecutionAttempt) => ExecutionAttempt): Mission {
    return { ...m, attempts: m.attempts.map((a) => (a.id === id ? f(a) : a)) };
  }

  private id(): string {
    return ulid(this.now(), this.random);
  }

  dispose(): void {
    this.disposed = true;
    this.clearEscalations();
    for (const t of this.previewTimers.values()) clearTimeout(t);
    this.previewTimers.clear();
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }
}

// ---- Helpers ----

function handleView(h: SessionHandle): HandleView {
  const permission = h.blocks.some((b) => b.kind === 'permission' && (b as { state?: string }).state === 'pending');
  return { lifecycle: h.lifecycle, pendingAsk: !!h.pendingQuestion || !!h.pendingPlan || permission, backgroundTasks: h.backgroundTasks };
}

/** A turn's tokens without any cost: for a model on a local endpoint. */
function withoutCost(r: TurnRecord): TurnRecord {
  const modelsUsed: TurnRecord['modelsUsed'] = {};
  for (const [model, { costUsd: _c, ...rest }] of Object.entries(r.modelsUsed ?? {})) modelsUsed[model] = rest;
  const { costUsd: _cost, ...rest } = r;
  return { ...rest, modelsUsed, costBasis: 'none' };
}

function closeWait(a: ExecutionAttempt, now: number): ExecutionAttempt {
  const since = a.timing?.waitingSince;
  if (since === undefined) return a;
  return { ...a, timing: { ...a.timing, waitingSince: undefined, waitedOnHumanMs: (a.timing?.waitedOnHumanMs ?? 0) + Math.max(0, now - since) } };
}

function originOf(m: Mission, a: ExecutionAttempt): OrchestrationOrigin {
  return { kind: 'orchestration', missionId: m.id, taskId: a.taskId, attemptId: a.id };
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The task's newest failed attempt before `beforeId`. */
function previousFailure(m: Mission, task: Task, beforeId: string): ExecutionAttempt | undefined {
  const ids = task.attemptIds.slice(0, Math.max(0, task.attemptIds.indexOf(beforeId)));
  for (const id of [...ids].reverse()) {
    const a = m.attempts.find((x) => x.id === id);
    if (a?.outcome?.status === 'failed') return a;
  }
  return undefined;
}

/** Resolves when `p` does, or after `ms`, whichever is first. Never rejects. */
async function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.catch(() => undefined), new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

/** What a task waiting on an escalation step says it is waiting for. */
function pendingText(d: EscalationDecision, now: number): string {
  const due = d.notBefore !== undefined && d.notBefore > now ? ` at ${new Date(d.notBefore).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';
  const what: Record<string, string> = {
    'retry-same': 'retrying the same route',
    'continue-with-feedback': 'sending the failure back to the agent',
    'raise-effort': `raising effort to ${d.delta?.effort ?? 'the next level'}`,
    'raise-tier': `raising tier to ${d.delta?.tier ?? 'the next one'}`,
    'switch-harness': `switching to ${d.delta?.harness ?? 'another harness'}`,
    'switch-model': `switching to ${d.target?.model ?? 'another model'}`,
    wait: 'waiting for capacity, then retrying',
  };
  return `${capitalise(what[d.action] ?? d.action)}${due} (escalation step ${d.step ?? '?'}): ${d.reason}`;
}

/**
 * What an escalation step tells the agent: the failure, as evidence it can
 * act on — the checks' summary, the failing tests, where the full output is —
 * and what to do about it. The next message of a carried-on session, or the
 * "earlier attempt" section of a fresh one's prompt. Stays in the prompt; it
 * never reaches telemetry.
 */
function escalationMessage(task: Task, prev: ExecutionAttempt, d: EscalationDecision): string {
  const lines: string[] = [];
  const carry = d.mode === 'continue';
  switch (d.evidence.category) {
    case 'quality-new':
    case 'quality-repeat': {
      const summary = summariseVerification(task.verification, prev.verification);
      const failed = prev.verification.find((v) => v.outcome === 'failed' && task.verification.stages.some((s) => s.strategy === v.strategy && s.required));
      lines.push(`Agent Wrangler ran this task's checks on ${carry ? 'your' : 'an earlier attempt’s'} work, and they failed: ${summary.summary}.`);
      const failing = failed?.evidence?.failing ?? [];
      if (failing.length > 0) lines.push('Failing:', ...failing.slice(0, 20).map((f) => `- ${f}`));
      if (failed?.evidence?.logPath) lines.push(`The full output is in ${failed.evidence.logPath}.`);
      const review = prev.verification.find((v) => v.review)?.review;
      const unmet = review?.criteria.filter((c) => c.verdict !== 'met') ?? [];
      if (unmet.length > 0) lines.push('The reviewer said these acceptance criteria are not met:', ...unmet.map((c) => `- ${task.acceptanceCriteria[Number(c.id.slice(1)) - 1] ?? c.id}: ${c.why}`));
      if (d.evidence.category === 'quality-repeat') lines.push('This is the same failure as before: take a different approach rather than repeating the last one.');
      lines.push(carry ? 'Find and fix the cause, then say so and stop.' : 'This attempt starts again from the task’s starting point; the earlier work is kept on its own branch.');
      break;
    }
    case 'empty':
      lines.push(
        carry
          ? 'You finished without changing any files, but this task expects changes in the worktree. Make the change it asks for, then say so and stop. If no change is needed, say exactly why and stop.'
          : 'An earlier attempt finished without changing anything. This task expects changes in the worktree.',
      );
      break;
    case 'infra':
      lines.push(carry ? `Your last turn ended with an error (${d.evidence.signature ?? 'error'}). Carry on with the task where you left off; say so and stop when it is done.` : 'An earlier attempt stopped on an error that was not its own doing.');
      break;
    case 'capacity':
      lines.push(carry ? 'The rate limit has passed. Carry on with the task where you left off; say so and stop when it is done.' : 'An earlier attempt was stopped by a rate limit.');
      break;
    case 'stuck':
      lines.push('An earlier attempt ran for too long without finishing and was stopped. Work in small steps, and say so and stop as soon as the task is done.');
      break;
    case 'context':
      lines.push('An earlier attempt ran out of context. Read only what the task needs.');
      break;
    default:
      lines.push(carry ? 'Carry on with the task where you left off; say so and stop when it is done.' : 'An earlier attempt did not finish the task.');
  }
  if (d.action === 'raise-effort' && carry && d.delta?.effort) lines.unshift(`Your effort has been raised to ${d.delta.effort}.`);
  return lines.join('\n');
}

/** `<title-slug>-<6 of the id>`: readable, and two tasks with one title never share a branch. */
function missionSlug(m: Mission): string {
  const suffix = m.id.slice(-6).toLowerCase();
  const head = slugify(m.title, 'task').slice(0, 40).replace(/-+$/, '');
  return `${head}-${suffix}`;
}

function routePins(route: TaskRoute): { harness: HarnessId; source?: ModelSourceId; model?: string; effort?: EffortLevel } {
  return {
    harness: route.harness,
    ...(route.source ? { source: route.source } : {}),
    ...(route.model?.trim() ? { model: route.model.trim() } : {}),
    ...(route.effort?.trim() ? { effort: awEffort(route.effort) } : {}),
  };
}

/** The route the last attempt ran on, or the task's pins. */
function routeOf(m: Mission, a: ExecutionAttempt | undefined): TaskRoute {
  const d = a ? m.decisions.find((x) => x.id === a.routingDecisionId) : undefined;
  if (d && a) return routeFromDecision(d, a);
  const pins = (a && m.tasks.find((t) => t.id === a.taskId))?.overrides?.pins ?? m.tasks[0].overrides?.pins;
  return { harness: pins?.harness ?? 'claude-code', model: pins?.model, ...(pins?.source ? { source: pins.source } : {}) };
}

function routeFromDecision(d: RoutingDecision | undefined, a: ExecutionAttempt): TaskRoute {
  if (!d) return { harness: a.assignment.harness };
  const t = d.resolution.target;
  return {
    harness: t.harness,
    ...(isEndpointSource(t.source) ? { source: t.source } : {}),
    model: t.model,
    effort: t.effortNative === 'none' ? undefined : t.effortNative,
    permissionMode: decisionMode(d),
  };
}

/** The permission mode a decision launched with: on its `manual` or `assisted.*` reason. */
function decisionMode(d: RoutingDecision): PermissionModeName | undefined {
  const mode = d.reasons.find((r) => typeof r.inputs?.permissionMode === 'string')?.inputs?.permissionMode;
  return typeof mode === 'string' ? (mode as PermissionModeName) : undefined;
}

/** How a decision relates to the router: the recommendation, whether the user was shown it, whether they took it. */
interface DecisionRouting {
  recommendation?: RouteRecommendation;
  offered: boolean;
  accepted: boolean;
  /** The router picked it itself, failing over after an `infra` loss (#51): no person was asked. */
  failover?: boolean;
  /** The escalation step that started the attempt (#41). */
  escalation?: EscalationDecision;
  /** Who decided the route of the attempt the step came after: a step that keeps the route keeps its owner. */
  prevDecidedBy?: RoutingDecision['decidedBy'];
}

/** How `launch` starts an attempt. */
type LaunchOptions =
  /** A new session: the first attempt, a fresh retry, or an escalation step that starts over. */
  | { mode: 'fresh'; route: TaskRoute; taskId?: string; routing?: DecisionRouting; escalation?: EscalationDecision; feedback?: string }
  /** #4's Resume of an interrupted attempt's session. */
  | { mode: 'continue'; resumeOf: ExecutionAttempt; auto?: boolean }
  /** Escalation's "continue" (#41): the failed attempt's session gets `message` next, live or resumed. */
  | { mode: 'continue'; continues: ExecutionAttempt; route: TaskRoute; escalation: EscalationDecision; message: string };

/**
 * The escalation step a task is waiting on (#41): the newest decision, taken
 * (not blocked), one that starts an attempt, made after the task's newest
 * attempt, with the task `queued` (a retry) or `blocked` (a capacity wait).
 */
export function pendingEscalation(task: Task): EscalationDecision | undefined {
  const d = task.escalations.at(-1);
  if (!d || d.blockedBy || !LAUNCHING_ACTIONS.includes(d.action)) return undefined;
  if (task.attemptIds.at(-1) !== d.afterAttemptId) return undefined;
  return task.state === 'queued' || task.state === 'blocked' ? d : undefined;
}

/** The newest assessment of the mission's task. */
function latestAssessment(m: Mission, taskId: string): TaskAssessment | undefined {
  const task = m.tasks.find((t) => t.id === taskId);
  const id = task?.assessmentIds.at(-1);
  return id ? m.assessments.find((a) => a.id === id) : undefined;
}

/** A planned mission (#43): reviewed as a plan, run in the mission tree. */
export function isPlanned(m: Pick<Mission, 'planned'>): boolean {
  return m.planned === true;
}

/** The slug the mission's branches are under: from its mission branch once it has one, which is what git knows it by. */
function missionSlugOf(m: Mission): string {
  if (m.integration !== 'none') {
    const parts = m.integration.branch.split('/');
    if (parts.length === 3) return parts[1];
  }
  return missionSlug(m);
}

/** The assignment as seen from where the attempt started, which its diff and its checks are measured against. */
function measured(wt: WorktreeAssignment, a: Pick<ExecutionAttempt, 'startCommit'> | undefined): WorktreeAssignment {
  return a?.startCommit && a.startCommit !== wt.baseCommit ? { ...wt, baseCommit: a.startCommit } : wt;
}

/** The one branch a mission's result is on: the mission branch, or a single task's result branch. */
export function resultBranch(m: Mission): string | undefined {
  if (m.planned) return m.integration !== 'none' ? m.integration.branch : undefined;
  return m.tasks[0]?.result?.branch;
}

/** For the prompt: where this task sits in its mission, so the agent knows earlier work is already there. */
function missionContext(m: Mission, task: Task): { title: string; position: number; of: number; before: string[] } | undefined {
  if (!m.planned || m.tasks.length < 2) return undefined;
  const order = executionOrder(m.tasks);
  const position = order.findIndex((t) => t.id === task.id) + 1;
  const before = order.slice(0, Math.max(0, position - 1)).filter((t) => t.state === 'done').map((t) => `${t.key}: ${t.title}`);
  return { title: m.title, position, of: m.tasks.length, before };
}

/** What a pull request says: the mission and what each task did. The user's own words, sent by their click. */
function pullRequestBody(m: Mission): string {
  const lines = [m.objective.trim(), '', '## Tasks'];
  for (const t of executionOrder(m.tasks)) lines.push(`- ${t.state === 'done' ? '✓' : t.state === 'skipped' ? '–' : '·'} ${t.key}: ${t.title}`);
  lines.push('', 'Made with Agent Wrangler.');
  return lines.join('\n');
}

/** The `task-final` record for a task that has ended (§16.2): sums of its attempts, metadata only. */
export function taskFinalRecord(m: Mission, taskId: string, now: number): TaskFinalRecord | undefined {
  const task = m.tasks.find((t) => t.id === taskId);
  if (!task) return undefined;
  const outcome = task.state === 'done' || task.state === 'failed' || task.state === 'cancelled' || task.state === 'skipped' ? task.state : undefined;
  if (!outcome) return undefined;
  const attempts = task.attemptIds.map((id) => m.attempts.find((a) => a.id === id)).filter((a): a is ExecutionAttempt => !!a);
  if (attempts.length === 0 && outcome !== 'done') return undefined;
  let usd: number | undefined;
  let basis: TaskFinalRecord['cost']['basis'] = 'none';
  let tokens: number | undefined;
  let activeMs: number | undefined;
  for (const a of attempts) {
    const u = a.usage;
    if (u?.costUsd !== undefined && u.costBasis !== 'none') {
      usd = (usd ?? 0) + u.costUsd;
      basis = basis === 'none' || basis === u.costBasis ? u.costBasis : 'price-table';
    }
    const parts = [u?.inputTokens, u?.outputTokens, u?.cacheReadTokens, u?.cacheWriteTokens].filter((x): x is number => x !== undefined);
    if (parts.length > 0) tokens = (tokens ?? 0) + parts.reduce((s, x) => s + x, 0);
    if (a.launchedAt !== undefined && a.endedAt !== undefined) {
      activeMs = (activeMs ?? 0) + Math.max(0, a.endedAt - a.launchedAt - (a.timing?.waitedOnHumanMs ?? 0));
    }
  }
  const first = attempts[0];
  const start = first?.launchedAt ?? first?.createdAt;
  const end = attempts.at(-1)?.endedAt;
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'task-final',
    id: `task-final:${task.id}`,
    at: now,
    missionId: m.id,
    taskId: task.id,
    missionTasks: m.tasks.length,
    outcome,
    ...(task.result ? { acceptedBy: task.result.acceptedBy } : {}),
    attempts: attempts.length,
    firstAttemptPass: outcome === 'done' && attempts.length === 1 && task.result?.acceptedBy === 'verification',
    cost: { ...(usd !== undefined ? { usd: Math.round(usd * 1e6) / 1e6 } : {}), basis },
    ...(tokens !== undefined ? { tokens } : {}),
    ...(start !== undefined && end !== undefined ? { elapsedMs: Math.max(0, end - start) } : {}),
    ...(activeMs !== undefined ? { activeMs } : {}),
  };
}

/** A native effort level on AW's scale, for the routing record: `xhigh` and above are `max`. */
function awEffort(native: string | undefined): EffortLevel {
  const e = native?.trim().toLowerCase();
  if (!e || e === 'none' || e === 'minimal') return 'low';
  if ((EFFORT_LEVELS as readonly string[]).includes(e)) return e as EffortLevel;
  return 'max';
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Task';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
