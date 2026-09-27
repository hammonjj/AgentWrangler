/**
 * The Missions view: the table pane's third view (§18.2, §18.4; #43).
 *
 * What the host sends and the pure formatters the pane draws it with. As with
 * the task strip, **a webview never sees a `Mission`**: the host resolves
 * every "which attempt is current", "is this editable", "what is the plan's
 * problem" question into these flat records, and the pane only lays them out.
 *
 * It has to read at 300 px as well as at full width (§18, principle 6): the
 * header is a list of short chips that wrap, a task row's details fold onto
 * its second line, and nothing is dropped to make room.
 *
 * No Node, no DOM.
 */
import { formatDuration } from '../model';
import { formatTokens, formatUsd } from '../sessionUsage';
import type { PlanEdit, PlanIssueLevel } from './plan';
import type { TaskRouteView, TaskVerificationView, TaskViewAction } from './taskView';
import { routeChipText, taskStateLabel } from './taskView';
import type { CostBasis, DependencyKind, EffortLevel, HarnessId, MissionFinish, MissionState, TaskKind, TaskState } from './types';

/** Mission-level aggregates, summed from its attempts (§16.2 "Mission-level aggregates"). */
export interface MissionMetricsView {
  total: number;
  done: number;
  running: number;
  /** Waiting on the user (`needs-human`). */
  waiting: number;
  blocked: number;
  failed: number;
  skipped: number;
  pending: number;
  /** Sessions working for the mission now. */
  activeAgents: number;
  attempts: number;
  /** First launch to the last end, or to now while something runs. */
  startedAt?: number;
  endedAt?: number;
  /** Absent: no attempt reported a cost. */
  costUsd?: number;
  costBasis: CostBasis;
  tokens?: number;
  escalations: number;
  /** One dot for how verification is going: every check passed, some did not, the last result failed, or nothing checked yet. */
  health: 'good' | 'mixed' | 'bad' | 'none';
  /** Attempts per model, most used first: `Sonnet 4 · Opus 1`. */
  models: { label: string; count: number; local?: boolean }[];
}

/** A plan task's preview: what the assessor says the work is like and what the router would want (§11.2). */
export interface TaskPreviewView {
  /** "feature · involved · risk high". */
  summary: string;
  confidence: string;
  /** "standard (up to expert) · high effort". */
  requirement?: string;
  /** "→ Sonnet 5", or why there is none. */
  target?: string;
  /** `route`, `needs-human`, `blocked`. */
  verdict?: string;
  note?: string;
}

/** One task row (§18.2), and in plan review the task's editor. */
export interface MissionTaskView {
  taskId: string;
  key: string;
  title: string;
  state: TaskState;
  stateReason?: string;
  /** What the current attempt ran on. */
  route?: TaskRouteView;
  attempt?: { n: number; of: number };
  verification?: TaskVerificationView;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  costUsd?: number;
  branch?: string;
  /** Its dependencies, by key, in order. */
  deps: { taskId: string; key: string; kind: DependencyKind }[];
  /** The session its current attempt runs in (`${provider}:${sessionId}`): a click opens it in the right pane. */
  sessionKey?: string;
  actions: TaskViewAction[];
  // ---- plan review ----
  objective: string;
  acceptanceCriteria: string[];
  scopePaths: string[];
  kind?: TaskKind;
  /** The kind is the runner's default, not something anyone said. */
  kindDefaulted?: boolean;
  pins?: { harness?: HarnessId; model?: string; effort?: EffortLevel };
  caps?: { maxTier?: string; maxEffort?: EffortLevel };
  preview?: TaskPreviewView;
  /** Plan review may change it: the plan is under review and nothing of this task has run. */
  editable: boolean;
}

export interface MissionIssueView {
  level: PlanIssueLevel;
  text: string;
  taskId?: string;
}

export interface MissionView {
  id: string;
  title: string;
  objective: string;
  state: MissionState;
  stateReason?: string;
  /** The repository's directory name: enough to tell missions apart, and no full path on screen. */
  repo: string;
  baseRef: string;
  /** The branch the result is on (the mission branch, or a single task's). */
  branch?: string;
  /** Written as a plan and reviewed (#43), rather than a single task started directly. */
  planned: boolean;
  metrics: MissionMetricsView;
  /** In run order. */
  tasks: MissionTaskView[];
  /** Plan review's findings (§11.2). Empty once the plan runs. */
  issues: MissionIssueView[];
  /** At most this many tasks (default 8, never above 12). */
  cap: number;
  canApprove: boolean;
  /** Mission review (§18.4): what the result adds up to, and the buttons. */
  review?: { commits: number; insertions: number; deletions: number; finishes: MissionFinish[]; recommended?: MissionFinish };
  finish?: MissionFinish;
  finishResult?: { mergeCommit?: string; pullRequestUrl?: string; note?: string };
  canCancel: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Everything the Missions view needs. `tiers` and `harnesses` fill plan review's pin and cap menus. */
export interface MissionsSnapshot {
  missions: MissionView[];
  tiers: string[];
  harnesses: { id: HarnessId; label: string }[];
}

/** What a Missions view click asks the host to do. */
export type MissionOp =
  | { kind: 'edit'; edit: PlanEdit }
  | { kind: 'approve' }
  | { kind: 'cancel' }
  | { kind: 'finish'; how: MissionFinish }
  | { kind: 'task'; taskId: string; action: TaskViewAction }
  | { kind: 'open'; taskId: string };

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const MISSION_STATE_LABEL: Partial<Record<MissionState, string>> = {
  'plan-review': 'plan review',
  'planning-failed': 'planning failed',
  review: 'ready for review',
};

export function missionStateLabel(s: MissionState): string {
  return MISSION_STATE_LABEL[s] ?? s;
}

/** A header chip: short enough to survive a 300 px pane, with everything else in its tooltip. */
export interface MissionChip {
  kind: 'state' | 'counts' | 'agents' | 'elapsed' | 'cost' | 'escalations' | 'health' | 'models';
  text: string;
  title: string;
  /** For the state and health chips: which colour. */
  tone?: string;
}

const HEALTH_TITLE: Record<MissionMetricsView['health'], string> = {
  good: 'Verification: every check that ran passed',
  mixed: 'Verification: some attempts failed their checks, the latest passed or is unverified',
  bad: 'Verification: the latest result failed its checks',
  none: 'Verification: nothing has been checked yet',
};

const COST_BASIS: Record<CostBasis, string> = {
  'harness-estimate': 'the harness’s estimate',
  'price-table': 'the price table',
  none: 'no cost reported',
};

/** §18.2's header metrics, in the order they are drawn. Chips with nothing to say are left out. */
export function missionChips(v: MissionView, nowMs: number): MissionChip[] {
  const m = v.metrics;
  const chips: MissionChip[] = [{ kind: 'state', text: missionStateLabel(v.state), title: v.stateReason ?? missionStateLabel(v.state), tone: v.state }];
  const parts = [`${m.done}/${m.total} done`];
  if (m.running > 0) parts.push(`${m.running} running`);
  if (m.waiting > 0) parts.push(`${m.waiting} waiting`);
  if (m.blocked > 0) parts.push(`${m.blocked} blocked`);
  if (m.failed > 0) parts.push(`${m.failed} failed`);
  chips.push({
    kind: 'counts',
    text: parts.join(' · '),
    title: `${m.done} done, ${m.running} running, ${m.waiting} waiting for you, ${m.blocked} blocked, ${m.failed} failed, ${m.skipped} skipped, ${m.pending} not started`,
  });
  if (m.activeAgents > 0) chips.push({ kind: 'agents', text: `${m.activeAgents} agent${m.activeAgents === 1 ? '' : 's'}`, title: 'Sessions working for this mission now' });
  if (m.startedAt !== undefined) {
    const end = m.endedAt ?? nowMs;
    chips.push({ kind: 'elapsed', text: formatDuration(Math.max(0, end - m.startedAt)), title: 'From the first attempt’s launch to the last one’s end' });
  }
  if (m.costUsd !== undefined) chips.push({ kind: 'cost', text: formatUsd(m.costUsd), title: `Estimated cost, from ${COST_BASIS[m.costBasis]}${m.tokens !== undefined ? ` · ${formatTokens(m.tokens)} tokens` : ''}` });
  else if (m.tokens !== undefined) chips.push({ kind: 'cost', text: formatTokens(m.tokens), title: 'Tokens; no attempt reported a cost' });
  if (m.escalations > 0) chips.push({ kind: 'escalations', text: `${m.escalations} esc`, title: `${m.escalations} escalation${m.escalations === 1 ? '' : 's'}` });
  if (m.attempts > 0) chips.push({ kind: 'health', text: '●', title: HEALTH_TITLE[m.health], tone: m.health });
  if (m.models.length > 0) {
    chips.push({ kind: 'models', text: modelDistributionText(m.models), title: `Attempts by model: ${m.models.map((x) => `${x.label} ${x.count}`).join(', ')}` });
  }
  return chips;
}

/** `Sonnet 4 · Opus 1 · local:qwen 2`, most used first. */
export function modelDistributionText(models: MissionMetricsView['models']): string {
  return models.map((x) => `${x.local ? `local:${x.label}` : x.label} ${x.count}`).join(' · ');
}

/** "after t1, t2 (order)". Empty for a task that needs nothing. */
export function dependencyText(deps: MissionTaskView['deps']): string {
  if (deps.length === 0) return '';
  return `after ${deps.map((d) => (d.kind === 'order' ? `${d.key} (order)` : d.key)).join(', ')}`;
}

/** The row's figures: "2/3 · Sonnet · high · 4m · 12.3k · $0.42". */
export function taskRowFigures(t: MissionTaskView, nowMs: number): string {
  const parts: string[] = [];
  if (t.attempt && t.attempt.of > 0) parts.push(`${t.attempt.n}/${t.attempt.of}`);
  if (t.route) parts.push(routeChipText(t.route));
  if (t.startedAt !== undefined) parts.push(formatDuration(Math.max(0, (t.endedAt ?? nowMs) - t.startedAt)));
  if (t.tokens !== undefined) parts.push(formatTokens(t.tokens));
  if (t.costUsd !== undefined) parts.push(formatUsd(t.costUsd));
  return parts.join(' · ');
}

/** A task's state as its row says it, with the reason when there is one. */
export function taskRowState(t: Pick<MissionTaskView, 'state' | 'stateReason'>): { text: string; title: string } {
  const text = taskStateLabel(t.state);
  return { text, title: t.stateReason ? `${text}: ${t.stateReason}` : text };
}

/** What each finish button says (§18.4). */
export const FINISH_LABEL: Record<MissionFinish, string> = {
  'merge-local': 'Merge locally',
  'pull-request': 'Open a PR',
  keep: 'Keep',
  discard: 'Discard',
};

/** What a plan-review issue level reads as. */
export const ISSUE_LABEL: Record<PlanIssueLevel, string> = {
  error: 'Refused',
  blocker: 'Before it can start',
  warning: 'Worth a look',
};

/** "3 commits, +81 −12" for the review line. */
export function reviewStatText(r: NonNullable<MissionView['review']>): string {
  return `${r.commits} commit${r.commits === 1 ? '' : 's'}, +${r.insertions} −${r.deletions}`;
}
