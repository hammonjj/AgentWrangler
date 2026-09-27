/**
 * Plan review's vocabulary (`docs/plans/intelligent-orchestration.md` §11.2,
 * §12.1, §18.4; #43): the edits a person can make to a mission's plan before
 * it runs, as the Missions view sends them.
 *
 * Types only, plus the caps. Imported by the table pane, which builds edits
 * from clicks, and by the main process, which applies them
 * (`orchestration/domain/plan.ts`) and refuses any that would break the graph.
 * No Node, no DOM.
 */
import type { DependencyKind, EffortLevel, HarnessId, TaskKind, TierName } from './types';

/** Tasks per mission when the mission sets no limit (§11.2). */
export const DEFAULT_MAX_TASKS = 8;
/** No mission may have more, whatever its policy says (§7.2). */
export const HARD_MAX_TASKS = 12;

/**
 * How serious a plan problem is (§11.2). `error`: the graph or the cap is
 * broken, and an edit that introduces one is refused. `blocker`: the plan may
 * be kept while it is written, but it cannot be approved. `warning`: worth a
 * look, never a stop.
 */
export type PlanIssueLevel = 'error' | 'blocker' | 'warning';

/** The fields of a task a person writes. Absent: unchanged (or empty, for a new task). */
export interface PlanTaskFields {
  title?: string;
  objective?: string;
  acceptanceCriteria?: string[];
  /** `null` clears a kind the user set, so the assessor decides it again. */
  kind?: TaskKind | null;
  /** Globs relative to the repository root: where the work is expected to land. */
  scopePaths?: string[];
}

/**
 * A task's pins and caps as plan review sets them. Deliberately the existing
 * `RoutePins` / `RouteCaps` fields and nothing more: #40 owns how scopes
 * combine, and this editor only writes the task's own overrides.
 * An empty string clears a field.
 */
export interface PlanOverrides {
  pins?: { harness?: HarnessId | ''; model?: string; effort?: EffortLevel | '' };
  caps?: { maxTier?: TierName | ''; maxEffort?: EffortLevel | '' };
}

/** One edit to a plan. Every one is validated as a whole plan before it is kept (§12.1). */
export type PlanEdit =
  /** A new task, after `after` (a task id) or at the end. */
  | { kind: 'add'; after?: string; fields?: PlanTaskFields }
  | { kind: 'update'; taskId: string; fields: PlanTaskFields }
  | { kind: 'delete'; taskId: string }
  /** Fold `taskId` into `into`: objectives, criteria, scope and edges are joined, and `taskId` goes. */
  | { kind: 'merge'; taskId: string; into: string }
  /**
   * Split a task in two. The second part takes the acceptance criteria from
   * `at` on (default: the second half), depends on the first by `code`, and
   * inherits the first part's downstream edges.
   */
  | { kind: 'split'; taskId: string; at?: number }
  /** Move a task to a position in the list. Refused if it would run before something it needs. */
  | { kind: 'move'; taskId: string; to: number }
  /** Make `taskId` depend on `on` (`code` or `order`), or remove the edge (`none`). */
  | { kind: 'depend'; taskId: string; on: string; dep: DependencyKind | 'none' }
  | { kind: 'overrides'; taskId: string; overrides: PlanOverrides };

/** A task as a hand-written plan (or, from #44, the planner) supplies it. Dependencies by key. */
export interface PlanTaskDraft extends PlanTaskFields {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  /** Keys of earlier tasks in the same draft (`t1`, …), with the kind of each edge. */
  dependsOn?: { key: string; kind: DependencyKind }[];
}
