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
  ExecutionTarget,
  HarnessId,
  ModelSourceId,
  OutcomeCategory,
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
  costBasis: CostBasis;
  /**
   * The first turn seen after the core was away: its usage is the difference
   * since the last recorded turn, so it covers turns that were never
   * delivered one by one (§16.3).
   */
  coversGap?: boolean;
  attemptId?: string;
}

/** Written when an attempt ends, and partially when it is interrupted (§16.2). */
export interface AttemptRecord extends RecordBase {
  type: 'attempt';
  missionId: string;
  taskId: string;
  attemptId: string;
  n: number;
  mode: RoutingMode;
  /** The repository policy the attempt ran under (`LoadedRepoPolicy.version`, #32); `default` when it had none. */
  repoPolicyVersion?: string;
  routingConfidence?: string;
  assessment?: { dimensions: Record<string, { value: string; confidence: string }>; assessorVersion: string };
  requirement?: { tier: TierName; effort: EffortLevel };
  target: ExecutionTarget & { effortRequested?: EffortLevel; effortApplied?: string };
  shadow?: { tier: TierName; effort: EffortLevel; target?: ExecutionTarget };
  agreement?: 'accepted' | 'changed-tier' | 'changed-effort' | 'changed-model';
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
  escalationStep?: number;
  git?: { filesChanged: number; insertions: number; deletions: number; commits: number };
  /** Fraction of changed files inside the predicted scope. */
  scopeAccuracy?: number;
  verification: { strategy: string; outcome: VerificationOutcomeKind; flaky?: boolean; preExisting?: boolean; durationMs?: number }[];
  flags: AttemptFlags;
  /** The record was written for an interrupted attempt and may be incomplete. */
  partial?: boolean;
}

export type TelemetryRecord = TurnRecord | AttemptRecord;
