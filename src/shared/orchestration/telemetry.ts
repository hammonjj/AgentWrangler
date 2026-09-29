/**
 * Telemetry records (`docs/plans/intelligent-orchestration.md` §16.2), shared
 * by #27 (turns) and #33 (attempts).
 *
 * Rules the types encode: **metadata, not content** (ids, enums, counts,
 * durations, token numbers, never prompt text or file contents), and **say
 * what is not known** (a field the source did not report is absent, never 0).
 * Every record has `v`, `type`, `at` and an `id` it is idempotent by.
 */
import type {
  AttemptFlags,
  CostBasis,
  EffortLevel,
  EscalationAction,
  EscalationBlock,
  ExecutionTarget,
  HarnessId,
  ModelSourceId,
  OutcomeCategory,
  RouteAgreement,
  RouteDimension,
  RouteRecommendation,
  RoutingMode,
  TierName,
  VerificationOutcomeKind,
} from './types';

export const TELEMETRY_SCHEMA_VERSION = 1;

interface RecordBase {
  v: number;
  at: number;
  /** Idempotency key: writing the same id twice records once. */
  id: string;
}

/** Tokens and cost for one model within a turn. */
export interface ModelTurnUsage {
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: number;
  costUsd?: number;
}

/**
 * One completed turn of an AW-hosted session (§16.2).
 *
 * `id` is the provider's own id for the turn's end (Claude `result.uuid`,
 * Codex `turn.id`), so the result a reattach delivers again records once
 * (§16.3, the #25 gate).
 */
export interface TurnRecord extends RecordBase {
  type: 'turn';
  sessionId: string;
  harness: HarnessId;
  source: ModelSourceId;
  /** Empty, with `usageUnknown` set, when the turn's usage could not be worked out. */
  modelsUsed: Record<string, ModelTurnUsage>;
  /** Why this turn has no usage (zeroed totals, totals that went down, nothing reported). */
  usageUnknown?: string;
  /** The turn's estimated cost, when there is one (`costBasis` says from what). */
  costUsd?: number;
  effort: { requested?: string; applied?: string };
  permissionMode?: string;
  durationMs?: number;
  apiMs?: number;
  ttftMs?: number;
  /** Model round trips in the turn. */
  numTurns?: number;
  toolCalls?: Record<string, number>;
  permissionAsks?: number;
  waitedOnHumanMs?: number;
  terminalReason?: string;
  isError: boolean;
  apiErrorStatus?: number;
  contextTokensPeak?: number;
  /**
   * Input-side tokens (input + cache read + cache write) of the turn's first
   * and last main-thread model request (#54): the first is what a cold
   * session starts from, the last what a session carried on starts from.
   * Absent when the harness did not report per-request usage.
   */
  requestContext?: { first?: number; last?: number };
  costBasis: CostBasis;
  /**
   * The first turn seen after the core was away: its usage is the difference
   * since the last recorded turn, so it covers turns that were never
   * delivered one by one (§16.3).
   */
  coversGap?: boolean;
  attemptId?: string;
}

/** An attempt's assignment as telemetry reports it: `fresh` is `cold`. */
export type AttemptAssignmentMode = 'cold' | 'continue' | 'reuse' | 'fork';

/** Written when an attempt ends, and partially when it is interrupted (§16.2). */
export interface AttemptRecord extends RecordBase {
  type: 'attempt';
  missionId: string;
  taskId: string;
  attemptId: string;
  n: number;
  mode: RoutingMode;
  /**
   * Which session ran it (#54): `cold` a new one (the assignment's `fresh`),
   * `continue` the same task's earlier session, `reuse` an earlier task's
   * session on the same worktree, `fork` a fork of an upstream task's.
   * Absent on records written before #54.
   */
  assignmentMode?: AttemptAssignmentMode;
  /** `reuse` / `fork`: the attempt whose session it carried on or forked. */
  assignedFrom?: string;
  /**
   * Input-side tokens the session held at the start: a carried session's last
   * known context, or a cold session's first request. Absent when not
   * reported, never 0 for unknown.
   */
  contextTokensAtStart?: number;
  /** The repository policy the attempt ran under (`LoadedRepoPolicy.version`, #32); `default` when it had none. */
  repoPolicyVersion?: string;
  routingConfidence?: string;
  assessment?: { dimensions: Record<string, { value: string; confidence: string }>; assessorVersion: string };
  requirement?: { tier: TierName; effort: EffortLevel };
  target: ExecutionTarget & { effortRequested?: EffortLevel; effortApplied?: string };
  /** What the router recommended for this attempt (#38): in `manual` the shadow, in `assisted` the proposal. */
  shadow?: { tier: TierName; effort: EffortLevel; target?: ExecutionTarget; verdict: RouteRecommendation['verdict'] };
  agreement?: RouteAgreement;
  /** The dimensions that differ from the recommendation. */
  changed?: RouteDimension[];
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  activeMs?: number;
  queueMs?: number;
  waitedOnHumanMs?: number;
  usage: Record<string, ModelTurnUsage>;
  cost: { usd?: number; basis: CostBasis };
  turns: number;
  toolCalls?: Record<string, number>;
  permissionAsks?: number;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  category?: OutcomeCategory;
  signature?: string;
  /** The escalation step that started this attempt (#41): 1 for the first. Absent: a person started it. */
  escalationStep?: number;
  /** What that step was. */
  escalationAction?: EscalationAction;
  git?: { filesChanged: number; insertions: number; deletions: number; commits: number };
  /** Fraction of changed files inside the predicted scope. */
  scopeAccuracy?: number;
  verification: {
    strategy: string;
    outcome: VerificationOutcomeKind;
    flaky?: boolean;
    preExisting?: boolean;
    skipped?: boolean;
    durationMs?: number;
    /**
     * A `review` stage's verdict, as counts and cost (#36): enough to ask later
     * whether the reviewer catches what the commands miss, with none of what it
     * wrote (its reasons quote the code).
     */
    review?: {
      met: number;
      unmet: number;
      unclear: number;
      concerns: number;
      repaired?: number;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    };
  }[];
  flags: AttemptFlags;
  /** The record was written for an interrupted attempt and may be incomplete. */
  partial?: boolean;
  /** Present when the attempt ran on a registered endpoint's model (§19.4, #51). */
  local?: LocalRunMetrics;
}

/**
 * What a run on a local endpoint measured (§19.4). Only what was actually
 * reported or measured: through a harness, TTFT is not visible, so it is
 * absent rather than guessed. Cost is `$0 API cost` by rule, never a field.
 */
export interface LocalRunMetrics {
  /** `local:<endpoint id>`. */
  source: ModelSourceId;
  runtime?: string;
  /** Display only, as the user declared it. */
  device?: string;
  /** The context window the model was run with, as the catalog knew it. */
  contextWindow?: number;
  ttftMs?: number;
  outTokPerSec?: number;
  /** `server`: the runtime's own timings. `client`: measured from the stream. `attempt`: output tokens over active time. */
  tokPerSecFrom?: 'server' | 'client' | 'attempt';
  /** Time waiting for a server slot. */
  queueMs?: number;
  /** The endpoint is not on this machine. */
  external?: boolean;
  /**
   * **An estimate, labelled as one:** what the hosted route the router would
   * otherwise have picked would have cost for the same tokens, at its price
   * table. Absent when that route has no price.
   */
  apiEquivalentUsd?: number;
  apiEquivalentModel?: string;
}

/** One direct call to a local endpoint (§19.1 path 2): a structured completion or a qualification probe. */
export interface LocalCallRecord extends RecordBase {
  type: 'local-call';
  source: ModelSourceId;
  model: string;
  /** `planner`: a local planner round (§11.5). */
  purpose: 'completion' | 'planner' | 'qualification';
  /** For `qualification`: stage 1 (the probe) or 2 (one scratch-repo task run, §19.6). Absent on records from before stage 2: stage 1. */
  qualificationStage?: 1 | 2;
  /** Stage 2: the fixture id and run number. Fixture ids are AW's own, never a project's. */
  fixture?: string;
  run?: number;
  ok: boolean;
  /** `invalid-output`, `error`, `timeout`, `aborted`; `infra` marks a server that went away. */
  failure?: string;
  infra?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  attempts: number;
  local: LocalRunMetrics;
  /** The call failed locally and was answered by the hosted completion instead. */
  fellBackToHosted?: boolean;
}

/**
 * One routing decision, once it carries a recommendation (§16.2, #38): what
 * the router asked for, what the resolver picked, what ran, and whether they
 * agree. Rule ids and levels only — never the objective, and never the reason
 * texts, which can quote a risk path's description.
 */
export interface RoutingRecord extends RecordBase {
  type: 'routing';
  missionId: string;
  taskId: string;
  decisionId: string;
  attemptN: number;
  mode: RoutingMode;
  decidedBy: 'router' | 'user';
  routerVersion: string;
  catalogVersion: string;
  assessmentId?: string;
  requirement: { minTier: TierName; maxTier: TierName; effort: EffortLevel; gates: string[] };
  ruleIds: string[];
  verdict: RouteRecommendation['verdict'];
  recommended?: ExecutionTarget;
  ran: ExecutionTarget;
  /** AW's effort level for the route that ran (#42), so the comparison report does not wait for the attempt to end. */
  ranEffort?: EffortLevel;
  /** The escalation step that launched this attempt (#42). Absent: the task's own decision, not the ladder's. */
  escalationStep?: number;
  agreement: RouteAgreement;
  changed: RouteDimension[];
  candidates: { chosen: number; fallback: number; rejected: number };
}

/**
 * A task's end (§16.2, #43): how it finished, who accepted it, and what it
 * took. Written once per task, by task id; the totals are sums of its
 * attempts, with the cost's basis (absent cost: nothing reported one).
 */
export interface TaskFinalRecord extends RecordBase {
  type: 'task-final';
  missionId: string;
  taskId: string;
  /** Tasks in the mission, so a single task and a planned one can be told apart. */
  missionTasks: number;
  outcome: 'done' | 'failed' | 'cancelled' | 'skipped';
  acceptedBy?: 'verification' | 'user';
  attempts: number;
  /** The first attempt passed its checks and was the result. */
  firstAttemptPass: boolean;
  cost: { usd?: number; basis: CostBasis };
  tokens?: number;
  /** Launch of the first attempt to the end of the last. */
  elapsedMs?: number;
  activeMs?: number;
}

/** A policy value as telemetry carries it: an enum, a number, a flag, or harness/source/model ids. Never text a person wrote. */
export type PolicyFieldValue = string | number | boolean | string[];

/**
 * A person changed a control at mission or task scope (§16.2 `override`, #40):
 * who changed what, from what, at which scope. `via: 'proposal'` is a change
 * to an `assisted` proposal's route, which pins the task.
 */
export interface OverrideRecord extends RecordBase {
  type: 'override';
  missionId: string;
  taskId?: string;
  scope: 'mission' | 'task';
  by: 'user';
  via: 'editor' | 'proposal';
  changes: { field: string; from?: PolicyFieldValue; to?: PolicyFieldValue }[];
  /** The mission's state when it was made: `draft` is before anything started. */
  missionState: string;
}

/**
 * A started mission's policy changed (§16.2 `policy-change`, §10.2, #40). It
 * applies from `appliesFromAttempt`; attempts running at the time keep the
 * policy they started with.
 */
export interface PolicyChangeRecord extends RecordBase {
  type: 'policy-change';
  missionId: string;
  taskId?: string;
  scope: 'mission' | 'task';
  fields: string[];
  /** Index of this change in the mission's `policyChanges`, from 1: the revision it starts. */
  revision: number;
  appliesFromAttempt: number;
  /** Attempts that were running when it changed, and are not restarted. */
  runningAttempts: number;
}

/**
 * One step of the escalation ladder after a failed attempt (§15, §16.2
 * `escalation`, #41), blocked steps included. No reason text: it can quote a
 * verification summary, and that quotes the code. The category, signature
 * and what blocked it say which rule applied.
 */
export interface EscalationRecord extends RecordBase {
  type: 'escalation';
  missionId: string;
  taskId: string;
  decisionId: string;
  afterAttemptId: string;
  afterAttemptN: number;
  mode: RoutingMode;
  category: OutcomeCategory;
  signature?: string;
  repeats: number;
  action: EscalationAction;
  blockedBy?: EscalationBlock;
  delta?: { tier?: TierName; effort?: EffortLevel; harness?: HarnessId };
  /** A launching step: continue the session or start fresh. */
  continueSession?: boolean;
  /** How long the step waits before it runs. */
  delayMs?: number;
  step?: number;
}

/**
 * A planner run ended (§16.2, #44): what it cost, how big a plan it proposed,
 * and how many rounds that took. Counts only: never the objective, a task's
 * text or a problem the validator named. Written once per run, by run id.
 */
export interface PlanRecord extends RecordBase {
  type: 'plan';
  missionId: string;
  kind: 'plan' | 'replan';
  outcome: 'proposed' | 'failed' | 'cancelled';
  model: string;
  rounds: number;
  /** Tasks proposed, when it proposed a plan. */
  tasks?: number;
  decomposition?: 'single' | 'multiple';
  /** Problems the validator found, over every round. */
  problems: number;
  /** Advice (§11.3) the proposal still broke after its repair round. */
  warnings?: number;
  cost: { usd?: number; basis: CostBasis };
  tokens?: number;
  durationMs: number;
}

/**
 * A plan the planner proposed was approved (§16.2, #44): how far the user's
 * review moved it from the proposal, the signal of plan quality.
 */
export interface PlanReviewRecord extends RecordBase {
  type: 'plan-review';
  missionId: string;
  planRunId: string;
  proposedTasks: number;
  approvedTasks: number;
  /** Plan edits the user made between the proposal and Approve. */
  edits: number;
  /** Time from the proposal to Approve. */
  reviewMs: number;
}

/** Local calibration of the conversation offer. Never contains request content. */
export interface DelegationSuggestionRecord extends RecordBase {
  type: 'delegation-suggestion';
  provider: 'claude' | 'codex';
  outcome: 'accepted' | 'declined' | 'ignored';
  reason: 'bounded-work';
  assessorVersion: number;
  repoPolicyVersion: string;
  durationMs: number;
}

/**
 * A task branch merged into the mission branch (§16.2, #46):
 * merged, conflict, reverted, or mission-verification outcome.
 */
export interface IntegrationRecord extends RecordBase {
  type: 'integration';
  missionId: string;
  taskId: string;
  taskBranch: string;
  missionBranch: string;
  outcome: 'merged' | 'conflict' | 'reverted' | 'error';
  /** The merge commit, or the revert commit, or undefined on error. */
  commit?: string;
  /** Conflicting files when outcome is 'conflict'. */
  conflictingFiles?: string[];
  /** When reverted, the verification failure that caused it. */
  verificationFailure?: { stage: string; summary: string };
  errorSummary?: string;
  durationMs?: number;
}

export type TelemetryRecord =
  | DelegationSuggestionRecord
  | TurnRecord
  | AttemptRecord
  | RoutingRecord
  | LocalCallRecord
  | OverrideRecord
  | PolicyChangeRecord
  | TaskFinalRecord
  | EscalationRecord
  | PlanRecord
  | PlanReviewRecord
  | IntegrationRecord;
