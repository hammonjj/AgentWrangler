/**
 * The orchestration domain: missions, tasks, attempts and the decisions around
 * them (`docs/plans/intelligent-orchestration.md` §7).
 *
 * Pure types. `src/shared/**` is bundled into the main process and the
 * webviews, so nothing here imports Node or the DOM. The state machines and
 * invariants over these types are `src/orchestration/domain/`.
 *
 * Two rules shape what is here and what is not:
 * - **Tasks never name a model** (§4). A model name appears only in an
 *   `ExecutionTarget` (a historical fact inside a `RoutingDecision`) and in a
 *   user's pin (`RoutePins.model`, the user's instruction).
 * - **Records are immutable once written** where the plan says so
 *   (assessments, routing decisions, escalation decisions): a change is a new
 *   record, so old decisions stay explainable.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The agent loop that does the work (§6.1). */
export type HarnessId = 'claude-code' | 'codex' | (string & {});
/** Where inference runs and how it is limited or billed (§6.1). */
export type ModelSourceId = 'anthropic' | 'openai' | `local:${string}` | (string & {});
/** AW's own effort scale, mapped per model onto its native levels (§6.4). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];
/** A capability tier. Ordered by the catalog, not by this type (§6.3). */
export type TierName = string;
export type Confidence = 'low' | 'medium' | 'high';
/** Who supplied an assessment value. */
export type Provenance = 'rule' | 'model' | 'planner' | 'user';
/** Epoch milliseconds. */
export type Millis = number;

// ---------------------------------------------------------------------------
// States (§7.4, §7.5)
// ---------------------------------------------------------------------------

export type MissionState =
  | 'draft'
  | 'planning'
  | 'planning-failed'
  | 'plan-review'
  | 'running'
  | 'paused'
  | 'finishing'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskState =
  | 'pending'
  | 'ready'
  | 'blocked'
  | 'assessing'
  | 'routed'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'integrating'
  | 'done'
  | 'needs-human'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type AttemptState =
  | 'created'
  | 'launching'
  | 'running'
  | 'waiting-human'
  | 'finishing'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type WorktreeState = 'creating' | 'ready' | 'in-use' | 'retained' | 'removed' | 'missing';

// ---------------------------------------------------------------------------
// Policy (§10)
// ---------------------------------------------------------------------------

export type RoutingMode = 'manual' | 'assisted' | 'auto';

/** Fix a dimension of the route. The only place a user names a model. */
export interface RoutePins {
  harness?: HarnessId;
  source?: ModelSourceId;
  model?: string;
  effort?: EffortLevel;
}

/** Hard limits. Caps only ever tighten from a wider scope to a narrower one. */
export interface RouteCaps {
  maxTier?: TierName;
  maxEffort?: EffortLevel;
  maxAttempts?: number;
  maxConcurrentAgents?: number;
  maxEstimatedCostUsd?: number;
  /** Stop starting work when a usage window reaches this percentage. */
  maxUsageWindowPercent?: number;
  location?: 'local-only' | 'hosted-only';
}

export interface RoutePreferences {
  harness?: HarnessId;
  source?: ModelSourceId;
  preferLocal?: boolean;
  strategy?: 'balanced' | 'max-quality' | 'lowest-cost' | 'fastest' | 'prefer-local';
}

export interface RouteExclusions {
  harnesses?: HarnessId[];
  sources?: ModelSourceId[];
  disableLocal?: boolean;
}

/** Everything a user controls about how work runs, at one scope. */
export interface ExecutionPolicy {
  mode?: RoutingMode;
  pins?: RoutePins;
  caps?: RouteCaps;
  preferences?: RoutePreferences;
  exclusions?: RouteExclusions;
  /** Allow the escalation-only `frontier` tier for this mission (§6.3). Off by default. */
  frontierAllowed?: boolean;
  /** One automatic resume per interrupted attempt, never after a host crash (§23.3). */
  autoRecover?: boolean;
  /** Let tasks with overlapping scopes run together (§13.4). */
  allowOverlap?: boolean;
  maxTasks?: number;
}

/** A recorded change to a running mission's policy (§10.2). */
export interface PolicyChange {
  at: Millis;
  by: 'user';
  /** The fields that changed, as they became. */
  changed: ExecutionPolicy;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Mission and task (§7.2)
// ---------------------------------------------------------------------------

/** How a mission ended up being finished (§13.3). */
export type MissionFinish = 'merge-local' | 'pull-request' | 'keep' | 'discard';

export interface Mission {
  id: string;
  /** Schema version of this record (`MISSION_SCHEMA_VERSION`). */
  v: number;
  title: string;
  /** The user's own words. Stays on this machine, never in telemetry. */
  objective: string;
  repoRoot: string;
  base: { ref: string; commit: string };
  /** The mission branch and its integration worktree, or none for a single-task mission. */
  integration: { branch: string; worktreeId: string } | 'none';
  /** The effective policy, frozen when the mission starts. */
  policy: ExecutionPolicy;
  policyChanges: PolicyChange[];
  state: MissionState;
  stateReason?: string;
  /** Set when the user approves the plan. `running` requires it, except for a single task started directly. */
  planApprovedAt?: Millis;
  /** Set when the user picks how to finish. `completed` requires it. */
  finish?: MissionFinish;
  plannerAttemptId?: string;
  source: { kind: 'user' | 'issue' | 'schedule'; ref?: string; trusted: boolean };
  tasks: Task[];
  assessments: TaskAssessment[];
  decisions: RoutingDecision[];
  attempts: ExecutionAttempt[];
  worktrees: WorktreeAssignment[];
  createdAt: Millis;
  updatedAt: Millis;
}

export type DependencyKind = 'code' | 'order';

/** "This task needs that one": `code` carries its result, `order` only its completion (§12.1). */
export interface TaskDependency {
  taskId: string;
  kind: DependencyKind;
}

export interface TaskScope {
  /** Globs, relative to the repository root. */
  paths: string[];
  subsystems: string[];
  confidence: Confidence;
}

export type TaskKind =
  | 'docs'
  | 'test'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'migration'
  | 'architecture'
  | 'investigation'
  | 'review'
  | 'chore'
  | 'conflict-resolution'
  | 'plan';

/** Every task kind, in the order the assessor's schema lists them. */
export const TASK_KINDS: readonly TaskKind[] = [
  'docs',
  'test',
  'bugfix',
  'feature',
  'refactor',
  'migration',
  'architecture',
  'investigation',
  'review',
  'chore',
  'conflict-resolution',
  'plan',
];

/** The user's per-task overrides. The pin is the only model name a task may carry. */
export interface TaskOverrides {
  pins?: RoutePins;
  caps?: RouteCaps;
  preferences?: RoutePreferences;
}

export interface TaskResult {
  branch: string;
  commit: string;
  acceptedBy: 'verification' | 'user';
}

export interface Task {
  id: string;
  /** Short key within the mission: `t1`, `t2`, … */
  key: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  scope: TaskScope;
  kindHint?: TaskKind;
  /**
   * `kindHint` is the runner's default (`feature`, so an empty diff still
   * fails verification), not something a person or the planner said. The
   * assessor is not told it, so the kind the router reads is the assessed one (#38).
   */
  kindDefaulted?: boolean;
  dependsOn: TaskDependency[];
  overrides?: TaskOverrides;
  verification: VerificationPlan;
  /** Bumped by every edit in plan review. */
  revision: number;
  state: TaskState;
  stateReason?: string;
  assessmentIds: string[];
  attemptIds: string[];
  escalations: EscalationDecision[];
  result?: TaskResult;
  /** An integrated upstream was later rejected or reverted; a rerun needs the user (§12.3). */
  invalidated?: boolean;
  /**
   * The router's proposal while an `assisted` task waits for the user to
   * accept or change it (#38). Copied into the attempt's decision as its
   * `shadow` when it launches.
   */
  recommendation?: RouteRecommendation;
  createdBy: 'user' | 'planner';
}

// ---------------------------------------------------------------------------
// Assessment and routing (§8, §9)
// ---------------------------------------------------------------------------

/** An assessment value with how sure it is and where it came from (§8.2). */
export interface Assessed<T> {
  value: T;
  confidence: Confidence;
  from: Provenance;
  evidence?: string;
}

export type Complexity = 'trivial' | 'routine' | 'involved' | 'hard';
export type Breadth = 'single-file' | 'few-files' | 'subsystem' | 'cross-cutting';
export type Risk = 'low' | 'moderate' | 'high' | 'critical';
export type Ambiguity = 'clear' | 'minor-gaps' | 'underspecified' | 'open-ended';
export type Verifiability = 'none' | 'weak' | 'partial' | 'strong';
export type ContextLoad = 'small' | 'medium' | 'large' | 'very-large';

export interface AssessmentDimensions {
  complexity: Assessed<Complexity>;
  breadth: Assessed<Breadth>;
  risk: Assessed<Risk>;
  ambiguity: Assessed<Ambiguity>;
  verifiability: Assessed<Verifiability>;
  contextLoad: Assessed<ContextLoad>;
}

/** What the work is like. Immutable: new inputs make a new one (§7.2). */
export interface TaskAssessment {
  id: string;
  taskId: string;
  taskRevision: number;
  inputsHash: string;
  assessorVersion: string;
  dimensions: AssessmentDimensions;
  kind: Assessed<TaskKind>;
  domains: string[];
  /** Hard needs, e.g. `edit`, `shell`, `vision`, `exclusive:unity-editor:<project>`. */
  requires: string[];
  confidence: Confidence;
  evidence: string[];
  llm?: { completionId: string; model: string };
  createdAt: Millis;
}

export type RouteGate = 'plan-first' | 'human-review';

/** What the work needs. Never a model name (§9.1). */
export interface RouteRequirement {
  minTier: TierName;
  maxTier: TierName;
  effort: EffortLevel;
  needs: string[];
  prefer?: RoutePreferences;
  gates: RouteGate[];
}

/** The concrete thing that runs it: harness × source × model × native effort (§6.1). */
export interface ExecutionTarget {
  harness: HarnessId;
  source: ModelSourceId;
  model: string;
  resolvedModel?: string;
  tier: TierName;
  /** The model's own effort level that was sent, or `none` for a model without effort control. */
  effortNative: string;
  location: 'hosted' | 'local';
}

export interface RoutingReason {
  ruleId: string;
  text: string;
  inputs?: Record<string, unknown>;
}

export interface ResolverCandidate {
  target: ExecutionTarget;
  verdict: 'chosen' | 'fallback' | 'rejected';
  reason: string;
}

/**
 * What the router and resolver recommend for a task, from one assessment
 * against one catalog snapshot (§9; #38). The proposal `assisted` mode shows,
 * and the shadow `manual` mode records beside what the user picked.
 */
export interface RouteRecommendation {
  assessmentId: string;
  /** The router's rule version (`ROUTER_VERSION`). */
  policyVersion: string;
  requirement: RouteRequirement;
  reasons: RoutingReason[];
  /**
   * `route`: `resolution.target` is the recommendation. `needs-human`: the work
   * needs more than the caps allow, a gate asks for a person first, or nothing
   * the policy allows can run it. `blocked`: something would, once capacity
   * frees up. `note` says which.
   */
  verdict: 'route' | 'needs-human' | 'blocked';
  note?: string;
  resolution: { target?: ExecutionTarget; candidates: ResolverCandidate[]; catalogVersion: string; note?: string };
  at: Millis;
}

/** A route dimension a person can change from the recommendation. */
export type RouteDimension = 'harness' | 'model' | 'tier' | 'effort';

/**
 * How the route that ran compares with the recommendation (§27.3).
 * `accepted`: the user took the proposal as offered (`assisted`).
 * `matched`: what ran is what the router would have picked, though nobody was
 * asked (`manual`, or a retry on the same route). `changed-*`: the most
 * significant dimension that differs (tier, then harness, then model, then
 * effort); `RoutingDecision.overrides` lists all of them.
 */
export type RouteAgreement =
  | 'accepted'
  | 'matched'
  | 'changed-tier'
  | 'changed-harness'
  | 'changed-model'
  | 'changed-effort'
  | 'no-recommendation';

/**
 * One routing decision per attempt. Immutable; `target.tier ≤ requirement.maxTier` always (§7.2).
 *
 * One exception, and only one: a `manual` decision made before its task was
 * assessed gets its `shadow` (and `agreement`) filled in once, when the
 * assessment lands (#38). Nothing already on the record changes, and a
 * decision that has a shadow is never touched again.
 */
export interface RoutingDecision {
  id: string;
  taskId: string;
  attemptN: number;
  mode: RoutingMode;
  assessmentId?: string;
  policyVersion: string;
  requirement: RouteRequirement;
  reasons: RoutingReason[];
  /** The dimensions the user changed from the recommendation. */
  overrides: RouteDimension[];
  resolution: { target: ExecutionTarget; candidates: ResolverCandidate[]; catalogVersion: string; note?: string };
  /** What the router recommended, beside what ran (§27.3). In `assisted` it is the proposal the user saw. */
  shadow?: RouteRecommendation;
  agreement?: RouteAgreement;
  decidedBy: 'router' | 'user';
  decidedAt: Millis;
}

// ---------------------------------------------------------------------------
// Execution (§7.2, §13)
// ---------------------------------------------------------------------------

/**
 * Which session runs an attempt. `sessionIds` holds every id that session has
 * had, current last: an id can change mid-life (`/clear`, and per #4's code
 * compaction and resume), and #4's registry follows it with the same `origin`
 * (amended at the #25 gate).
 */
export interface AgentAssignment {
  mode: 'fresh' | 'continue';
  sessionIds: string[];
  harness: HarnessId;
}

export interface AttemptOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  category?: OutcomeCategory;
  signature?: string;
}

/** Outcome categories the classifier assigns (§15.1). */
export type OutcomeCategory =
  | 'infra'
  | 'lost'
  | 'capacity'
  | 'context'
  | 'quality-new'
  | 'quality-repeat'
  | 'empty'
  | 'ambiguity'
  | 'policy'
  | 'stuck'
  | 'budget';

export interface AttemptGitStats {
  baseCommit: string;
  headCommit?: string;
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** An attempt's usage, summed from its turns (§16). Absent fields were not reported. */
export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costBasis: CostBasis;
  turns: number;
  /** The same, per model (the `attempt` record's `usage`, §16.2). */
  byModel?: Record<string, { in?: number; out?: number; cacheRead?: number; cacheWrite?: number; thinking?: number; costUsd?: number }>;
  /** Turn records summed so far, by id, so a record seen twice counts once. */
  turnIds?: string[];
}

/** An attempt's clock (§16.3): active time is launch to end minus the time spent waiting on a person. */
export interface AttemptTiming {
  /** When its task was queued for it. */
  queuedAt?: Millis;
  /** When the current wait on a person began, while there is one. */
  waitingSince?: Millis;
  /** Time spent waiting on a person, summed over finished waits. */
  waitedOnHumanMs?: number;
}

export type CostBasis = 'harness-estimate' | 'price-table' | 'none';

export interface AttemptFlags {
  userIntervened?: boolean;
  userEditedBranch?: boolean;
  tookOver?: boolean;
  /** The upstream changed after this attempt started; merge-check before integration (§12.1). */
  staleBase?: boolean;
  /** Its session's host stopped answering; the host still holds it, so it is not interrupted (§23.3). */
  hostUnreachable?: boolean;
}

/** One try at a task. Persisted as `launching` before the session is launched; never reopened (§7.2). */
export interface ExecutionAttempt {
  id: string;
  taskId: string;
  n: number;
  routingDecisionId?: string;
  /** The repository policy it ran under, frozen at launch (`LoadedRepoPolicy.version`, §13.6). */
  repoPolicyVersion?: string;
  assignment: AgentAssignment;
  worktreeId?: string;
  state: AttemptState;
  stateReason?: string;
  launchedAt?: Millis;
  endedAt?: Millis;
  outcome?: AttemptOutcome;
  git?: AttemptGitStats;
  verification: VerificationResult[];
  usage?: UsageSummary;
  flags: AttemptFlags;
  /**
   * The client message ids of every message the orchestrator sent into the
   * session. A turn caused by any other message was the user's (§16.3).
   */
  sentIds?: string[];
  /** Turns the orchestrator saw end, for harnesses that do not echo message ids (Codex). */
  turnsSeen?: number;
  /** The interrupted attempt this one resumes (same session, `assignment.mode: 'continue'`). */
  resumeOf?: string;
  /** Started by `autoRecover`, not by a person: at most one per interrupted attempt (§23.3). */
  autoResumed?: boolean;
  /** Interrupted with a conversation that can be resumed (the same session id). */
  resumable?: boolean;
  timing?: AttemptTiming;
  createdAt: Millis;
}

/** A worktree and branch AW created (§13.2). AW only ever removes its own, never a dirty or in-use one. */
export interface WorktreeAssignment {
  id: string;
  purpose: 'task' | 'integration';
  taskId?: string;
  path: string;
  branch: string;
  baseCommit: string;
  state: WorktreeState;
  /**
   * The branch head AW last saw while no attempt held the tree: the base when
   * it was created, then its head each time an attempt let it go. A branch
   * that has moved past this while nobody was working in it has commits made
   * outside any attempt (#31).
   */
  lastKnownHead?: string;
  createdAt: Millis;
  removedAt?: Millis;
}

// ---------------------------------------------------------------------------
// Verification (§14)
// ---------------------------------------------------------------------------

export interface VerificationStage {
  /** A strategy named in repo policy: `command:typecheck`, `diff-sanity`, `review`, … Never a command. */
  strategy: string;
  required: boolean;
  timeoutSec?: number;
  /**
   * Run the stage only when the task's assessment says the repository's own
   * checks say little about it: risk `moderate` or higher, or verifiability
   * `weak` or lower (#36, `review.when: auto`). Absent: always run.
   */
  onlyIf?: 'risky-or-weakly-verified';
}

export interface VerificationPlan {
  stages: VerificationStage[];
}

export type VerificationOutcomeKind = 'passed' | 'failed' | 'inconclusive' | 'unavailable' | 'error';

export interface VerificationResult {
  strategy: string;
  state: 'running' | 'finished';
  outcome?: VerificationOutcomeKind;
  summary?: string;
  evidence?: { exitCode?: number; logPath?: string; failing?: string[]; signature?: string };
  flaky?: boolean;
  preExisting?: boolean;
  startedAt: Millis;
  durationMs?: number;
  /** What the reviewer said, for a `review` stage that reached a verdict (#36). */
  review?: ReviewVerdict;
  /** The stage's `onlyIf` did not hold, so it was not run (outcome `unavailable`). */
  skipped?: boolean;
}

/** The reviewer's answer for one acceptance criterion (§14.1 `review`). */
export type CriterionVerdict = 'met' | 'unmet' | 'unclear';

export interface ReviewCriterion {
  /** `c1`, `c2`, … — the criterion's position in `Task.acceptanceCriteria`, from 1. */
  id: string;
  verdict: CriterionVerdict;
  why: string;
}

/**
 * A `review` stage's verdict (#36): one entry per acceptance criterion, in
 * the task's order, plus concerns the reviewer raised beyond them. Evidence,
 * never a pass on its own: `review` does not count as verification for a task
 * that nothing else verified (§14.3).
 */
export interface ReviewVerdict {
  criteria: ReviewCriterion[];
  concerns: string[];
  /** The reviewer's model, as the completion reported it. */
  model: string;
  /** Tokens and cost of the review, when reported. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** Criteria the reviewer left out or answered twice, which were read as `unclear`. */
  repaired?: number;
}

// ---------------------------------------------------------------------------
// Escalation (§15)
// ---------------------------------------------------------------------------

export type EscalationAction =
  | 'retry-same'
  | 'continue-with-feedback'
  | 'raise-effort'
  | 'raise-tier'
  | 'switch-harness'
  | 'wait'
  | 'split-task'
  | 'needs-human'
  | 'stop';

/** What happened after a failed attempt, blocked steps included. Immutable. */
export interface EscalationDecision {
  id: string;
  taskId: string;
  afterAttemptId: string;
  evidence: { category: OutcomeCategory; signature?: string; repeats: number };
  action: EscalationAction;
  delta?: { tier?: TierName; effort?: EffortLevel; harness?: HarnessId };
  blockedBy?: 'cap' | 'pin' | 'limit';
  reason: string;
  decidedAt: Millis;
}

// ---------------------------------------------------------------------------
// The session tag (#4's registry `origin`, ask A3)
// ---------------------------------------------------------------------------

/** What an orchestrated session carries as its registry `origin`. The registry never interprets it. */
export interface OrchestrationOrigin {
  kind: 'orchestration';
  missionId: string;
  taskId: string;
  attemptId: string;
}

export function isOrchestrationOrigin(origin: unknown): origin is OrchestrationOrigin {
  if (!origin || typeof origin !== 'object') return false;
  const o = origin as Partial<OrchestrationOrigin>;
  return (
    o.kind === 'orchestration' &&
    typeof o.missionId === 'string' &&
    typeof o.taskId === 'string' &&
    typeof o.attemptId === 'string'
  );
}
