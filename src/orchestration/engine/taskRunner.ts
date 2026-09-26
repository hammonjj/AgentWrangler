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
import type { TelemetryRecord, TurnRecord } from '../../shared/orchestration/telemetry';
import {
  EFFORT_LEVELS,
  isOrchestrationOrigin,
  type AttemptState,
  type EffortLevel,
  type ExecutionAttempt,
  type ExecutionPolicy,
  type ExecutionTarget,
  type HarnessId,
  type Mission,
  type ModelSourceId,
  type OrchestrationOrigin,
  type OutcomeCategory,
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
import { transitionAttempt, transitionMission, transitionTask } from '../domain/lifecycles';
import type { AgentHarness } from '../harness/types';
import type { Assessor } from '../policy/assessor';
import type { LoadedRepoPolicy, RepoPolicyStore } from '../policy/repoPolicyStore';
import type { MissionStore } from '../store/missionStore';
import { slugify } from '../worktrees/naming';
import { nodeExec, type Exec } from '../worktrees/exec';
import type { WorktreeManager } from '../worktrees/worktreeManager';
import { Verifier } from '../verify/verifier';
import { buildVerificationPlan, summariseVerification } from '../../shared/orchestration/verification';
import { tierRank } from '../../shared/orchestration/catalog';
import type { ResolverSnapshot } from '../policy/resolver';
import { compareRoutes, recommendRoute } from '../policy/recommend';
import { attemptRecord, addTurnUsage, routingRecord } from './attemptRecord';
import { attemptLaunchPolicy, attemptPermissionMode, attemptPrompt } from './attemptPolicy';
import { sessionVerdict, turnFailure, turnMessageIds, type HandleView, type SessionVerdict } from './sessionVerdict';

/** What the user picked: harness, model, effort and (Claude) permission mode (#33 "manual route"). */
export interface TaskRoute {
  harness: HarnessId;
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
  /**
   * The mission's policy, frozen when it is recorded (§10.2): caps, preferences
   * and exclusions the router and resolver honour. `mode` is set by the entry
   * point — `start` is `manual`, `propose` is `assisted` — not by this field.
   */
  policy?: ExecutionPolicy;
}

/** A task the router is to propose a route for (`assisted`, #38): everything but the route. */
export type NewTaskDraft = Omit<NewTask, 'route'>;

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
export type TaskAction = 'show-session' | 'open-diff' | 'accept' | 'resume' | 'retry' | 'recreate-worktree' | 'cancel';

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
   * The catalog and source health the resolver decides against (#38), read
   * fresh for every recommendation. Absent: no recommendations — `manual`
   * attempts record no shadow and `propose` refuses.
   */
  routing?: { snapshot(): ResolverSnapshot };
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
  /** Asked to open a diff file once one is written for a notification click. */
  openFile?: (file: string) => void;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  /** How long an idle, finished-looking session must stay so before the attempt finishes. */
  settleMs?: number;
  log?: (msg: string) => void;
}

const SOURCE: Record<string, ModelSourceId> = { 'claude-code': 'anthropic', codex: 'openai' };
const PROVIDER: Record<string, 'claude' | 'codex'> = { 'claude-code': 'claude', codex: 'codex' };
const TASK_KEY = 't1';
/** What a resumed attempt is told. */
const CONTINUE_PROMPT =
  'Agent Wrangler lost track of this session and has resumed it. Carry on with the task where you left off; say so and stop when it is done.';
const DEFAULT_SETTLE_MS = 2000;
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
  }

  // ---- Reading ----

  /** Every mission this runner knows, newest first. */
  list(): Mission[] {
    return [...this.missions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(missionId: string): Mission | undefined {
    return this.missions.get(missionId);
  }

  /** The task's current attempt. */
  currentAttempt(m: Mission): ExecutionAttempt | undefined {
    const task = m.tasks[0];
    const id = task?.attemptIds.at(-1);
    return id ? m.attempts.find((a) => a.id === id) : undefined;
  }

  /** The session the task's current attempt runs in, if one is live here. */
  handleOf(missionId: string): SessionHandle | undefined {
    const m = this.missions.get(missionId);
    const a = m && this.currentAttempt(m);
    const id = a?.assignment.sessionIds.at(-1);
    return id ? this.deps.sessions.get(id) : undefined;
  }

  /** What the user can do with the task now. */
  actions(missionId: string): TaskAction[] {
    const m = this.missions.get(missionId);
    if (!m) return [];
    const task = m.tasks[0];
    const a = this.currentAttempt(m);
    const out: TaskAction[] = [];
    if (this.handleOf(missionId)) out.push('show-session');
    const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (a?.git && a.git.filesChanged > 0 && wt && wt.state !== 'removed') out.push('open-diff');
    // A proposal nobody has started (#38) is started from the launcher's task menu, not retried.
    if (task.state === 'needs-human' && task.attemptIds.length > 0) {
      if (a?.state === 'succeeded') out.push('accept');
      if (a?.state === 'interrupted' && a.resumable && wt?.state !== 'missing') out.push('resume');
      if (wt?.state === 'missing') out.push('recreate-worktree');
      out.push('retry');
    }
    if (!['completed', 'cancelled', 'failed', 'review'].includes(m.state)) out.push('cancel');
    return out;
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
        const now = this.now();
        for (const to of ['ready', 'assessing'] as TaskState[]) {
          m = this.patchTask(m, (t) => transitionTask(m, t, to, { now, reason: to === 'assessing' ? 'assessing before it is routed' : undefined }));
        }
        this.put(m);
        await this.assess(id);
        m = this.need(id);
        const assessment = latestAssessment(m);
        const rec = assessment && this.recommendationFor(m, assessment);
        if (!rec) throw new TaskError('The task could not be routed: no assessment or no catalog.');
        const at = this.now();
        m = this.patchTask(m, (t) => transitionTask(m, { ...t, recommendation: rec }, 'routed', { now: at, reason: 'route proposed; waiting for you to accept or change it' }));
        if (rec.verdict !== 'route') m = this.patchTask(m, (t) => transitionTask(m, t, 'needs-human', { now: at, reason: rec.note ?? 'a person has to decide the route' }));
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
        route = { harness: t.harness, model: t.model, ...(t.effortNative !== 'none' ? { effort: t.effortNative } : {}) };
      }
      this.checkRoute(route);
      const target = accepted ? rec.resolution.target! : this.targetFor(route);
      const tiers = this.deps.routing?.snapshot().catalog.tiers;
      const cap = m.policy.caps?.maxTier;
      if (!accepted && cap && tiers && tierRank(tiers, target.tier) > tierRank(tiers, cap) && tierRank(tiers, cap) >= 0) {
        throw new TaskError(`${target.model || 'That model'} is ${target.tier}; this task is capped at ${cap}.`);
      }
      this.put(this.patchTask(m, (t) => ({ ...t, overrides: { ...t.overrides, pins: routePins(route!) } })));
      await this.launch(missionId, { mode: 'fresh', route, routing: { recommendation: rec, offered: true, accepted } });
      return this.need(missionId);
    });
  }

  /** Record a new single-task mission, not yet started. */
  private async record(req: NewTaskDraft, policy: ExecutionPolicy, overrides?: Task['overrides']): Promise<string> {
    const objective = req.objective.trim();
    if (!objective) throw new TaskError('A task needs an objective.');
    const loaded = this.deps.repoPolicies.forFolder(req.folder);
    if (!loaded) throw new TaskError(`${req.folder} is not in a git repository. A task runs in a worktree of one.`);
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
      verification: buildVerificationPlan({ kind: req.kind ?? 'feature', policy: loaded.policy }),
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
      policy,
      policyChanges: [],
      state: 'draft',
      source: { kind: 'user', trusted: true },
      tasks: [task],
      assessments: [],
      decisions: [],
      attempts: [],
      worktrees: [],
      createdAt: now,
      updatedAt: now,
    };
    this.put(mission);
    this.log(`task ${id}: recorded in ${mission.repoRoot} (${policy.mode ?? 'manual'} routing)`);
    return id;
  }

  /** Resume an interrupted attempt: the same session id, through #4's Resume (orphan sweep first). */
  resume(missionId: string, opts: { auto?: boolean } = {}): Promise<void> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      const prev = this.currentAttempt(m);
      if (!prev || prev.state !== 'interrupted' || !prev.resumable) throw new TaskError('There is no interrupted attempt to resume.');
      // An automatic resume queued behind a Cancel (or anything else) must not revive the task.
      if (m.tasks[0].state !== 'needs-human' || !['running', 'paused'].includes(m.state)) throw new TaskError('The task is no longer waiting to be resumed.');
      await this.launch(missionId, { mode: 'continue', resumeOf: prev, auto: opts.auto });
    });
  }

  /** Start again from the base in a new worktree and branch, keeping the last attempt's for comparison. */
  retry(missionId: string): Promise<void> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      const prev = this.currentAttempt(m);
      if (m.tasks[0].state !== 'needs-human') throw new TaskError('The task is not waiting for a decision.');
      if (prev && LIVE.includes(prev.state)) {
        // Held by something this build cannot follow: give it up, without touching it.
        m = this.endAttempt(m, prev.id, 'cancelled', { status: 'cancelled' }, 'given up for a fresh retry');
        this.put(m);
      }
      await this.endSession(m, prev);
      m = await this.retainTree(this.missions.get(missionId)!, prev);
      await this.launch(missionId, { mode: 'fresh', route: routeOf(m, prev) });
    });
  }

  /**
   * Accept the result: the task is done and the mission goes to review, where
   * #34 offers merge, pull request, keep or discard. Commits anything the
   * session did after the attempt finished first, so the branch is the result.
   */
  accept(missionId: string): Promise<void> {
    return this.queue(missionId, async () => {
      let m = this.need(missionId);
      const a = this.currentAttempt(m);
      const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
      if (!a || a.state !== 'succeeded' || !wt || m.tasks[0].state !== 'needs-human') throw new TaskError('There is no finished attempt to accept.');
      const manager = await this.managerFor(m);
      // A missing tree has nothing more to commit; any other failure is the user's to see, not to lose.
      const extra = wt.state === 'missing' ? undefined : await manager.commitAll(wt, `aw: ${m.tasks[0].key}: changes after attempt ${a.n}`).catch((e: Error) => {
        throw new TaskError(`Could not commit the changes made after the attempt, so nothing was accepted: ${e.message}`);
      });
      const stats = await manager.diffStats(wt);
      if (extra || stats.headCommit !== a.git?.headCommit) {
        m = this.patchAttempt(m, a.id, (x) => ({ ...x, flags: { ...x.flags, userEditedBranch: true } }));
      }
      const now = this.now();
      m = this.patchTask(m, (t) => transitionTask(m, { ...t, result: { branch: wt.branch, commit: stats.headCommit, acceptedBy: 'user' } }, 'done', { now, reason: 'accepted by the user' }));
      m = transitionMission(m, 'finishing', { now });
      m = transitionMission(m, 'review', { now, reason: 'accepted; merge, open a pull request, keep or discard the branch' });
      this.put(m);
      await this.endSession(m, a);
    });
  }

  /** Stop the task: its session is ended, its worktree and branch are kept. */
  cancel(missionId: string): Promise<void> {
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
      if (!['done', 'failed', 'cancelled', 'skipped'].includes(m.tasks[0].state)) {
        m = this.patchTask(m, (t) => transitionTask(m, t, 'cancelled', { now, reason: 'cancelled by the user' }));
      }
      if (!['completed', 'failed', 'cancelled'].includes(m.state)) m = transitionMission(m, 'cancelled', { now, reason: 'cancelled by the user' });
      this.put(m);
    });
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

  /** Write the current attempt's diff to a file and return its path. */
  diff(missionId: string): Promise<string> {
    return this.queue(missionId, async () => {
      const m = this.need(missionId);
      const a = this.currentAttempt(m);
      const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
      if (!a || !wt) throw new TaskError('The task has no branch yet.');
      const text = await (await this.managerFor(m)).diffText(wt);
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
    const wt = a?.worktreeId ? m.worktrees.find((w) => w.id === a.worktreeId) : undefined;
    if (wt?.state === 'missing' && m.tasks[0].state === 'needs-human') {
      const why = branchGone.has(wt.id) ? 'its worktree and branch have gone; retry it fresh' : 'its worktree has gone; recreate it from its branch, or retry';
      this.put(this.patchTask(m, (t) => ({ ...t, stateReason: why })));
    }
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
    const prompt = a.assignment.mode === 'continue' ? CONTINUE_PROMPT : attemptPrompt(m.tasks[0], { harness: a.assignment.harness, branch: wt.branch });
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
   * Launch the task's next attempt. Runs inside the mission's queue.
   * `fresh`: a new session in a new worktree (the first, or `-a<n>`).
   * `continue`: the interrupted attempt's session, resumed in its own tree.
   */
  private async launch(
    missionId: string,
    opts:
      | { mode: 'fresh'; route: TaskRoute; routing?: DecisionRouting }
      | { mode: 'continue'; resumeOf: ExecutionAttempt; auto?: boolean },
  ): Promise<void> {
    let m = this.need(missionId);
    const task = m.tasks[0];
    const n = task.attemptIds.length + 1;
    const prevDecision = opts.mode === 'continue' ? m.decisions.find((d) => d.id === opts.resumeOf.routingDecisionId) : undefined;
    const route: TaskRoute = opts.mode === 'fresh' ? opts.route : routeFromDecision(prevDecision, opts.resumeOf);
    let harness: AgentHarness;
    let loaded: LoadedRepoPolicy;
    try {
      harness = this.checkRoute(route);
      const policy = this.deps.repoPolicies.forFolder(m.repoRoot);
      if (!policy) throw new TaskError(`${m.repoRoot} is no longer a git repository.`);
      loaded = policy;
    } catch (e) {
      // Nothing was started; a first attempt that never got going leaves the task waiting on the user.
      if (task.attemptIds.length === 0) this.put(this.failBeforeLaunch(m, errorText(e)));
      throw e;
    }
    const now = this.now();
    // Check the task can take an attempt now, before any worktree is made or taken:
    // a throw after that would leave the tree held by nothing.
    this.advanceTaskToRunning(m, now);

    // The worktree: recorded `creating` before any git work (§23.2).
    const manager = await this.manager(loaded);
    let wt: WorktreeAssignment;
    if (opts.mode === 'continue') {
      const prev = m.worktrees.find((w) => w.id === opts.resumeOf.worktreeId);
      if (!prev || prev.state === 'missing' || prev.state === 'removed') throw new TaskError('The attempt’s worktree has gone; recreate it or retry fresh.');
      wt = prev;
    } else {
      const planned = manager.plan({ id: this.id(), missionSlug: missionSlug(m), purpose: 'task', taskKey: task.key, taskId: task.id, attempt: n, baseCommit: m.base.commit });
      try {
        wt = await manager.create(planned);
      } catch (e) {
        m = this.need(missionId);
        if (task.attemptIds.length === 0) this.put(this.failBeforeLaunch(m, `could not create its worktree: ${errorText(e)}`));
        throw new TaskError(`Could not create the task’s worktree: ${errorText(e)}`);
      }
    }
    // Already `in-use` only when letting go of it failed after the last attempt; it is ours either way.
    if (wt.state !== 'in-use') wt = await manager.markInUse(wt);
    m = this.need(missionId);

    // The routing decision, immutable (§7.2). Beside a route the user picked,
    // what the router would have picked, whenever there is an assessment to route from.
    const routing: DecisionRouting =
      (opts.mode === 'fresh' ? opts.routing : undefined) ?? { recommendation: this.recommendationFor(m), offered: false, accepted: false };
    const decision = this.decision(m, task, n, route, harness, routing);
    const provider = PROVIDER[route.harness] ?? 'claude';
    const preassigned = harness.capabilities().preassignedSessionId;
    const sessionIds = opts.mode === 'continue' ? [...opts.resumeOf.assignment.sessionIds] : preassigned ? [randomUUID()] : [];
    const promptId = randomUUID();
    const attempt: ExecutionAttempt = {
      id: this.id(),
      taskId: task.id,
      n,
      routingDecisionId: decision.id,
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
      ...(opts.mode === 'continue' ? { resumeOf: opts.resumeOf.id, ...(opts.auto ? { autoResumed: true } : {}) } : {}),
    };
    m = { ...m, decisions: [...m.decisions, decision], attempts: [...m.attempts, attempt] };
    m = this.patchTask(m, (t) => ({ ...t, attemptIds: [...t.attemptIds, attempt.id] }));
    m = this.advanceTaskToRunning(m, now);
    if (m.state === 'draft') m = transitionMission(m, 'running', { now, reason: 'a single task started directly' });
    m = this.patchAttempt(m, attempt.id, (x) => transitionAttempt(m, x, 'launching', { now }));
    // Write-ahead: the attempt, its session id and origin are on disk before anything starts.
    this.put(m);
    this.writeRouting(m, decision);

    const policy: LaunchPolicy = attemptLaunchPolicy({ harness: route.harness, primaryRoot: m.repoRoot, repoPolicy: loaded.policy });
    const prompt = opts.mode === 'continue' ? CONTINUE_PROMPT : attemptPrompt(task, { harness: route.harness, branch: wt.branch });
    let handle: SessionHandle;
    try {
      handle = await harness.launch({
        cwd: wt.path,
        prompt,
        promptId,
        target: { harness: route.harness, model: route.model ?? '', effortNative: route.effort?.trim() || 'none' },
        origin: originOf(m, attempt),
        permissionMode: provider === 'claude' ? decisionMode(decision) : undefined,
        ...(opts.mode === 'continue' ? { resume: sessionIds.at(-1) } : sessionIds[0] ? { sessionId: sessionIds[0] } : {}),
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
  private advanceTaskToRunning(m: Mission, now: number): Mission {
    const steps: Partial<Record<TaskState, TaskState[]>> = {
      pending: ['ready', 'assessing', 'routed', 'queued', 'running'],
      // An `assisted` task, proposed and now accepted or changed (#38).
      routed: ['queued', 'running'],
      'needs-human': ['queued', 'running'],
      queued: ['running'],
    };
    const path = steps[m.tasks[0].state];
    if (!path) throw new TaskError(`The task is ${m.tasks[0].state}; it cannot start an attempt.`);
    for (const to of path) {
      m = this.patchTask(m, (t) =>
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
  private failBeforeLaunch(m: Mission, why: string): Mission {
    const now = this.now();
    if (m.state === 'draft') m = transitionMission(m, 'running', { now });
    for (const to of ['ready', 'assessing', 'routed', 'queued', 'running', 'needs-human'] as TaskState[]) {
      if (m.tasks[0].state === 'needs-human') break;
      m = this.patchTask(m, (t) => transitionTask(m, t, to, { now }));
    }
    return this.patchTask(m, (t) => ({ ...t, stateReason: why }));
  }

  /**
   * What a route the user named resolves to: the catalog entry that has the
   * model as an alias (the harness's own default, for an empty model), or the
   * bare route when the catalog has never seen it.
   */
  private targetFor(route: TaskRoute): ExecutionTarget {
    const source = SOURCE[route.harness] ?? route.harness;
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
    if (accepted) reasons = [...rec!.reasons, { ruleId: 'assisted.accepted', text: 'Recommendation accepted.', ...inputs }];
    else if (routing.offered && cmp) reasons = [{ ruleId: 'assisted.changed', text: `Changed from the recommendation: ${cmp.changed.join(', ') || 'nothing'}.`, ...inputs }];
    else reasons = [{ ruleId: 'manual', text: 'Route picked by the user.', ...inputs }];
    return {
      id: this.id(),
      taskId: task.id,
      attemptN: n,
      mode,
      ...(rec ? { assessmentId: rec.assessmentId } : {}),
      policyVersion: accepted ? rec!.policyVersion : 'manual',
      requirement: accepted
        ? rec!.requirement
        : { minTier: target.tier, maxTier: target.tier, effort: awEffort(route.effort), needs: [], gates: [] },
      reasons,
      overrides: cmp?.changed ?? [],
      resolution: accepted
        ? { target, candidates: rec!.resolution.candidates, catalogVersion: rec!.resolution.catalogVersion, ...(rec!.resolution.note ? { note: rec!.resolution.note } : {}) }
        : { target, candidates: [{ target, verdict: 'chosen', reason: 'picked by the user' }], catalogVersion: 'manual' },
      ...(rec ? { shadow: rec, agreement: cmp!.agreement } : {}),
      decidedBy: accepted ? 'router' : 'user',
      decidedAt: this.now(),
    };
  }

  // ---- Recommendation (#38) ----

  /**
   * What the router and resolver would pick for this task now, from its newest
   * assessment and a fresh snapshot. Undefined when there is no assessment or
   * no catalog. Never throws: a routing bug must not stop a launch.
   */
  private recommendationFor(m: Mission, assessment: TaskAssessment | undefined = latestAssessment(m)): RouteRecommendation | undefined {
    if (!assessment || !this.deps.routing) return undefined;
    try {
      return recommendRoute(assessment, m.policy, this.deps.routing.snapshot(), this.now());
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
    if (!d || d.shadow || d.mode !== 'manual') return;
    const rec = this.recommendationFor(m);
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

  private async assess(missionId: string): Promise<void> {
    const assessor = this.deps.assessor;
    const before = this.missions.get(missionId);
    if (!assessor || !before || this.disposed) return;
    const task = before.tasks[0];
    // Immutable records: one assessment per task revision, and it is not made twice.
    if (before.assessments.some((a) => a.taskId === task.id && a.taskRevision === task.revision)) return;
    const loaded = this.deps.repoPolicies.forFolder(before.repoRoot);
    const assessment = await assessor.assess({
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
      repoRoot: before.repoRoot,
      policy: loaded?.policy ?? DEFAULT_REPO_POLICY,
      repoPolicyVersion: loaded?.version ?? 'default',
      upstream: [],
    });
    // The mission moved on while the model was thinking; take it as it is now.
    const m = this.missions.get(missionId);
    if (!m || m.assessments.some((a) => a.id === assessment.id)) return;
    const next = this.patchTask({ ...m, assessments: [...m.assessments, assessment] }, (t) =>
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

  // ---- Watching ----

  private watch(missionId: string, attemptId: string, handle: SessionHandle, opts: { recovered: boolean; turnSeen?: boolean }): void {
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
    // is never missed; from now for a reattached one (its old turns ended long ago).
    try {
      w.sub = handle.subscribe(opts.recovered ? handle.snapshot().seq : 0, listener);
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
    await this.apply(w.missionId, w.attemptId, verdict);
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
        if (m.tasks[0].state === 'needs-human') return;
        m = this.patchTask(m, (t) => transitionTask(m, t, 'needs-human', { now, reason: v.reason }));
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
        m = await this.releaseTree(missionId, a.id);
        const auto = v.autoResumable && v.resumable && m.policy.autoRecover === true && !a.autoResumed;
        if (auto) {
          this.log(`task ${missionId}: attempt ${a.n} interrupted (${v.reason}); resuming once, as autoRecover allows`);
          // After this step, in the same queue: never inside it.
          void this.resume(missionId, { auto: true }).catch((e) => this.log(`task ${missionId}: automatic resume failed: ${String(e)}`));
        } else {
          this.notify(m, 'was interrupted', `${capitalise(v.reason)}. Resume the attempt or retry it fresh.`);
        }
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
      case 'failed':
        this.unwatch(a.id);
        m = this.endAttempt(m, a.id, 'failed', { status: 'failed', category: v.category, signature: v.reason }, v.reason);
        this.put(m);
        await this.releaseTree(missionId, a.id);
        this.notify(this.need(missionId), 'failed', `${capitalise(v.reason)}. Retry it fresh, or cancel it.`);
        return;
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
    // Only the turn this core saw end: after a restart there may be none, and then nothing says it failed.
    const failure = turnFailure(lastTurn);
    const wt = m.worktrees.find((w) => w.id === a.worktreeId);
    if (!wt) {
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: 'infra', signature: 'no-worktree' }, 'its worktree record has gone'));
      return;
    }
    let stats: Awaited<ReturnType<WorktreeManager['diffStats']>>;
    try {
      const manager = await this.managerFor(m);
      if (wt.state !== 'missing') await manager.commitAll(wt, `aw: ${m.tasks[0].key}: attempt ${a.n}`);
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
    if (failure) {
      m = await this.releaseTree(missionId, a.id);
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', ...failure }, `its last turn ended in an error (${failure.signature})`));
      this.notify(this.need(missionId), 'failed', `Its last turn ended in an error (${failure.signature}). Retry it fresh, or cancel it.`);
      return;
    }
    if (stats.filesChanged === 0) {
      m = await this.releaseTree(missionId, a.id);
      this.put(this.endAttempt(m, a.id, 'failed', { status: 'failed', category: 'empty', signature: 'no-diff' }, 'the attempt changed nothing'));
      this.notify(this.need(missionId), 'changed nothing', 'The attempt finished without changing anything. Retry it, or cancel it.');
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

    const plan = m.tasks[0].verification;
    const verdict = summariseVerification(plan, results);
    this.log(`task ${missionId}: attempt ${a.n} ${verdict.verdict}: ${verdict.summary}`);
    if (verdict.verdict === 'failed') {
      this.put(
        this.endAttempt(
          m,
          a.id,
          'failed',
          // `quality-new` until #41 can tell a repeat from a first sighting;
          // the signature is what will let it.
          { status: 'failed', category: 'quality-new', signature: verdict.signature },
          `verification failed: ${verdict.summary}`,
        ),
      );
      this.notify(this.need(missionId), 'failed verification', `${verdict.summary}. Retry it, or open the diff and decide.`, 'open-diff');
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
    const task = m.tasks[0];
    const a = m.attempts.find((x) => x.id === attemptId)!;
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
        now: this.now,
        log: this.log,
      });
      return await verifier.run(task.verification, {
        attemptId: a.id,
        task,
        policy: loaded.policy,
        worktree: wt,
        headCommit,
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
   * `needs-human`. Returns the mission; the caller saves it.
   */
  private endAttempt(
    m: Mission,
    attemptId: string,
    to: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
    outcome: { status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; category?: OutcomeCategory; signature?: string },
    reason: string,
    extra: Partial<ExecutionAttempt> = {},
  ): Mission {
    const now = this.now();
    m = this.patchAttempt(m, attemptId, (x) => ({ ...transitionAttempt(m, closeWait(x, now), to, { now, reason }), outcome, ...extra }));
    const task = m.tasks[0];
    if (task.state === 'running' || task.state === 'verifying') {
      if (to === 'succeeded' && task.state === 'running') m = this.patchTask(m, (t) => transitionTask(m, t, 'verifying', { now }));
      if (to !== 'cancelled' || reason !== 'cancelled by the user') {
        m = this.patchTask(m, (t) => transitionTask(m, t, 'needs-human', { now, reason }));
      }
    } else if (task.state === 'needs-human') {
      m = this.patchTask(m, (t) => ({ ...t, stateReason: reason }));
    }
    const a = m.attempts.find((x) => x.id === attemptId)!;
    const record = attemptRecord(m, a, now);
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
    for (const m of this.missions.values()) {
      if (!m.tasks.some((t) => t.id === a.taskId)) continue;
      const has = m.worktrees.some((w) => w.id === a.id);
      this.put({ ...m, worktrees: has ? m.worktrees.map((w) => (w.id === a.id ? a : w)) : [...m.worktrees, a] });
      return;
    }
  }

  // ---- Usage (§16.2) ----

  private onTurnRecord(r: TurnRecord): void {
    if (!r.attemptId) return;
    for (const m of this.missions.values()) {
      const a = m.attempts.find((x) => x.id === r.attemptId);
      if (!a) continue;
      // An ended attempt is never reopened: turns after it (the user carrying on) are not its.
      if (!LIVE.includes(a.state)) return;
      void this.queue(m.id, async () => {
        const cur = this.need(m.id);
        // Checked again here: the attempt may have ended (and its record been written) while this waited.
        if (!LIVE.includes(cur.attempts.find((x) => x.id === a.id)?.state ?? 'failed')) return;
        this.put(this.patchAttempt(cur, a.id, (x) => ({ ...x, usage: addTurnUsage(x.usage, r) })));
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

  private patchTask(m: Mission, f: (t: Task) => Task): Mission {
    return { ...m, tasks: m.tasks.map((t, i) => (i === 0 ? f(t) : t)) };
  }

  private patchAttempt(m: Mission, id: string, f: (a: ExecutionAttempt) => ExecutionAttempt): Mission {
    return { ...m, attempts: m.attempts.map((a) => (a.id === id ? f(a) : a)) };
  }

  private id(): string {
    return ulid(this.now(), this.random);
  }

  dispose(): void {
    this.disposed = true;
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

/** `<title-slug>-<6 of the id>`: readable, and two tasks with one title never share a branch. */
function missionSlug(m: Mission): string {
  const suffix = m.id.slice(-6).toLowerCase();
  const head = slugify(m.title, 'task').slice(0, 40).replace(/-+$/, '');
  return `${head}-${suffix}`;
}

function routePins(route: TaskRoute): { harness: HarnessId; model?: string; effort?: EffortLevel } {
  return { harness: route.harness, ...(route.model?.trim() ? { model: route.model.trim() } : {}), ...(route.effort?.trim() ? { effort: awEffort(route.effort) } : {}) };
}

/** The route the last attempt ran on, or the task's pins. */
function routeOf(m: Mission, a: ExecutionAttempt | undefined): TaskRoute {
  const d = a ? m.decisions.find((x) => x.id === a.routingDecisionId) : undefined;
  if (d && a) return routeFromDecision(d, a);
  const pins = m.tasks[0].overrides?.pins;
  return { harness: pins?.harness ?? 'claude-code', model: pins?.model };
}

function routeFromDecision(d: RoutingDecision | undefined, a: ExecutionAttempt): TaskRoute {
  if (!d) return { harness: a.assignment.harness };
  const t = d.resolution.target;
  return { harness: t.harness, model: t.model, effort: t.effortNative === 'none' ? undefined : t.effortNative, permissionMode: decisionMode(d) };
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
}

/** The newest assessment of the mission's task. */
function latestAssessment(m: Mission): TaskAssessment | undefined {
  const task = m.tasks[0];
  const id = task?.assessmentIds.at(-1);
  return id ? m.assessments.find((a) => a.id === id) : undefined;
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
