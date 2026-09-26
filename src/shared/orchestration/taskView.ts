/**
 * What the two panes show about an orchestrated session: the chips on its row,
 * and the task strip above its conversation (§18.1, §18.3; #34).
 *
 * Imported by the main process and by both webview bundles, so no Node and no
 * DOM here. The host turns a `Mission` into the views below once, and the panes
 * only draw them — a webview never sees a `Mission`, never reaches into
 * `attempts` to work out which one is current, and never asks which harness it
 * is looking at. Every conditional that depends on orchestration state is
 * resolved on this side of the wire.
 *
 * The rules the formatters keep:
 * - **A task never names a model except as history** (§4). `TaskRouteView` is
 *   the `ExecutionTarget` that actually ran, which is a fact, not an instruction.
 * - **Expensive work is visible without opening anything** (§18.1): the
 *   `expert` tier and `max` effort come back with `emphasis` set, and the pane
 *   styles them rather than deciding when to.
 * - **Nothing is hidden without a way to reach it** (`product-context.md` §5,
 *   principle 6). Chips fold onto the row's second line at 300 px; they are
 *   never dropped, so every chip here has to be short enough to survive that.
 */
import { formatDuration } from '../model';
import { modelLabel } from '../modelName';
import { formatTokens, formatUsd } from '../sessionUsage';
import type {
  AttemptState,
  Confidence,
  EffortLevel,
  HarnessId,
  Provenance,
  OutcomeCategory,
  RoutingMode,
  TaskState,
  TierName,
  WorktreeState,
} from './types';

/** Tiers drawn as expensive. A catalog name, matched case-insensitively (§6.3). */
const LOUD_TIERS = new Set(['expert', 'frontier']);
/** The effort level drawn as expensive. */
const LOUD_EFFORT: EffortLevel = 'max';

/** How a harness is named where there is room for a word and not a vendor. */
const HARNESS_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** What ran an attempt, as the row and the strip say it. A fact, never an instruction. */
export interface TaskRouteView {
  harness: HarnessId;
  /** The model as the catalog names it, already shortened for display. Absent: the harness's default. */
  model?: string;
  /** AW's effort level, when the target had one. */
  effort?: EffortLevel | string;
  tier?: TierName;
  /** `manual` or `assisted` (#38); `auto` from #42. Shown as a marker beside the route. */
  mode: RoutingMode;
  location?: 'hosted' | 'local';
  /** Why this route, from the stored decision (§9.5): the tooltip's second paragraph. */
  why?: string;
}

/**
 * "Why this route" (§9.5, #38), assembled from the stored decision and never
 * regenerated: which rules fired on which inputs, what the requirement was,
 * and every candidate the resolver passed over and why.
 */
export interface RouteExplanationView {
  /** "Sonnet 5 · medium (standard)". What ran. */
  headline: string;
  /** "Recommended and accepted", "Picked by you", "Changed from the recommendation (effort)". */
  decided: string;
  /** The §9.5 paragraph: the chip's tooltip and the panel's first line. */
  summary: string;
  /** "standard (up to expert) · medium effort · needs edit, shell · 150k context". */
  requirement?: string;
  /** Each rule that fired, in the order it fired. */
  rules: { ruleId: string; text: string }[];
  gates: string[];
  /** In `manual`, or when the user changed it: what the router would have picked, and how that compares. */
  comparison?: string;
  fallbacks: string[];
  rejected: string[];
  /** Why the router could not route it, or why it upgraded. */
  note?: string;
  /** The router and catalog versions it was decided with. */
  versions?: string;
}

/** One line of the strip's attempts list. Each opens its own session. */
export interface TaskAttemptView {
  id: string;
  n: number;
  state: AttemptState;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  category?: OutcomeCategory;
  route?: TaskRouteView;
  /** The session this attempt ran in, as the table keys it (`${provider}:${sessionId}`). Absent once unknown. */
  sessionKey?: string;
  startedAt?: number;
  endedAt?: number;
  /** Summed from this attempt's turns (#27). */
  tokens?: number;
  costUsd?: number;
  /** True for the attempt the task is on now. */
  current?: boolean;
}

/**
 * One dimension of an assessment as the strip draws it (§8.2, #37).
 *
 * `from` is on the row for a reason: a value a path rule produced and a value
 * a cheap model guessed are worth different amounts of the reader's trust, and
 * the plan's rule is never to claim more certainty than the source gives
 * (§2.2). The pane shows both, and neither is styled away.
 */
export interface AssessmentRowView {
  /** `Complexity`, `Risk`, … */
  label: string;
  value: string;
  confidence: Confidence;
  from: Provenance;
  /** `rule`, `model`, `planner`, `you`. */
  fromLabel: string;
  evidence?: string;
  /** The value is one a reader should not miss: `critical` risk, `none` verifiability. */
  emphasis?: boolean;
}

/** What the work is like, as the conversation's task strip shows it. */
export interface TaskAssessmentView {
  /** "feature · involved · risk high" — the chip. */
  summary: string;
  /** The assessment as a whole, which is its least sure dimension. */
  confidence: Confidence;
  rows: AssessmentRowView[];
  domains: string[];
  requires: string[];
  /** Why this assessment is thinner than usual, e.g. the model call failed. */
  note?: string;
  assessorVersion: string;
}

export interface TaskDiffView {
  filesChanged: number;
  insertions: number;
  deletions: number;
  commits: number;
}

/** What can be done with the task from the strip. Mirrors `TaskAction` in the runner. */
export type TaskViewAction =
  | 'show-session'
  | 'open-diff'
  | 'accept'
  | 'resume'
  | 'retry'
  | 'recreate-worktree'
  | 'cancel';

/** How an attempt's verification came out, as the strip and the row show it (#35). */
export interface TaskVerificationView {
  /** `✓`, `✗`, `~`, `?`, `!`. */
  glyph: string;
  text: string;
  title: string;
  verdict: string;
  /** A required check failed on the base commit too: the repository was already red. */
  baseIsRed?: boolean;
  /** One line per stage, in the order they ran. */
  stages: string[];
  /** The log of the first stage worth opening, when one was written. */
  logPath?: string;
  /** The reviewer's verdict per acceptance criterion, when a review ran (#36). */
  review?: TaskReviewView;
}

/** A `review` stage's verdict as the strip shows it (#36). */
export interface TaskReviewView {
  /** Required by the repository's policy; otherwise advisory. */
  required: boolean;
  /** The stage outcome: `passed`, `failed`, `inconclusive`. */
  outcome: string;
  criteria: { id: string; text: string; verdict: 'met' | 'unmet' | 'unclear'; why: string }[];
  concerns: string[];
  model: string;
  costUsd?: number;
}

/** The task strip above the conversation (§18.3). Built by the host, drawn by the pane. */
export interface TaskView {
  missionId: string;
  /** `t1`, `t2`, … within the mission. */
  taskKey: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  state: TaskState;
  stateReason?: string;
  /** The route the current attempt ran on. Absent before the first attempt launches. */
  route?: TaskRouteView;
  /** What the work is like (#37). Absent until the assessor has answered. */
  assessment?: TaskAssessmentView;
  /** Why the current attempt runs where it does (#38). Absent before the first attempt. */
  routing?: RouteExplanationView;
  /** `n` of `of`: the attempt on screen, and how many there have been. */
  attempt?: { n: number; of: number };
  branch?: string;
  worktreePath?: string;
  worktreeState?: WorktreeState;
  diff?: TaskDiffView;
  /** What the checks said about the current attempt (#35). Absent: none have run. */
  verification?: TaskVerificationView;
  /** Newest last, so the list reads in the order the attempts happened. */
  attempts: TaskAttemptView[];
  actions: TaskViewAction[];
}

/** The chips on an orchestrated session's row (§18.1). A cut-down `TaskView`. */
export interface TaskBadge {
  missionId: string;
  taskKey: string;
  title: string;
  state: TaskState;
  attempt?: { n: number; of: number };
  route?: TaskRouteView;
  /** The mission holds more than one task, so the task chip says which one. */
  multiTask?: boolean;
  /** The verification badge, once the checks have run (#35). */
  verification?: TaskVerificationView;
}

/** A chip as the panes draw it: text, its tooltip, and whether it is loud. */
export interface TaskChip {
  kind: 'task' | 'route' | 'verify';
  text: string;
  title: string;
  emphasis?: boolean;
}

/** Whether a route is expensive enough to be drawn loudly (§18.1). */
export function routeIsLoud(r: TaskRouteView | undefined): boolean {
  if (!r) return false;
  return (r.tier !== undefined && LOUD_TIERS.has(r.tier.toLowerCase())) || r.effort === LOUD_EFFORT;
}

export function harnessLabel(h: HarnessId): string {
  return HARNESS_LABEL[h] ?? h;
}

/**
 * "Sonnet · high", "Codex · gpt-5 · low", "local:qwen · low".
 *
 * The model is what the user recognises, so it leads; the harness joins it only
 * when the model does not already say which one it was (no model reported, or a
 * local endpoint whose name is the harness's business).
 */
export function routeChipText(r: TaskRouteView): string {
  const parts: string[] = [];
  if (r.model) parts.push(r.location === 'local' ? `local:${r.model}` : r.model);
  else parts.push(harnessLabel(r.harness));
  if (r.effort) parts.push(String(r.effort));
  return parts.join(' · ');
}

/** The route chip's tooltip: everything the chip had to leave out. */
export function routeChipTitle(r: TaskRouteView): string {
  const parts = [`Ran on ${harnessLabel(r.harness)}`];
  if (r.model) parts.push(r.model);
  if (r.tier) parts.push(`${r.tier} tier`);
  if (r.effort) parts.push(`${r.effort} effort`);
  parts.push(`${r.mode} routing`);
  if (r.location === 'local') parts.push('local model');
  const line = parts.join(' · ');
  return r.why ? `${line}\n\n${r.why}` : line;
}

/** `manual` needs no marker; the other two do. */
export function routeModeMarker(mode: RoutingMode): string | undefined {
  return mode === 'manual' ? undefined : mode === 'auto' ? 'A' : 'a';
}

/** The task chip: `t2` inside a multi-task mission, plain `Task` otherwise. */
export function taskChipText(b: Pick<TaskBadge, 'taskKey' | 'multiTask' | 'attempt'>): string {
  const head = b.multiTask ? b.taskKey : 'Task';
  return b.attempt && b.attempt.of > 1 ? `${head} · ${b.attempt.n}/${b.attempt.of}` : head;
}

export function taskChipTitle(b: TaskBadge): string {
  const parts = [b.title, taskStateLabel(b.state)];
  if (b.attempt) parts.push(`attempt ${b.attempt.n} of ${b.attempt.of}`);
  return parts.join(' — ');
}

/** Both chips for a row, in the order they are drawn. Never empty. */
export function taskChips(b: TaskBadge): TaskChip[] {
  const chips: TaskChip[] = [
    { kind: 'task', text: taskChipText(b), title: taskChipTitle(b) },
  ];
  if (b.route) {
    const marker = routeModeMarker(b.route.mode);
    chips.push({
      kind: 'route',
      text: marker ? `${routeChipText(b.route)} · ${marker}` : routeChipText(b.route),
      title: routeChipTitle(b.route),
      emphasis: routeIsLoud(b.route) || undefined,
    });
  }
  // The verdict last, so it reads as the conclusion of the row rather than as
  // another property of the agent. Absent until the checks have run: a task
  // that is still working has nothing to say here, and a `?` while it runs
  // would be mistaken for "unverified".
  if (b.verification) {
    chips.push({
      kind: 'verify',
      text: `${b.verification.glyph} ${b.verification.text}`,
      title: b.verification.title,
    });
  }
  return chips;
}

/** How a task's state reads to a person. */
export function taskStateLabel(state: TaskState): string {
  switch (state) {
    case 'pending':
      return 'not started';
    case 'needs-human':
      return 'needs you';
    case 'done':
      return 'done';
    default:
      return state;
  }
}

/** How an attempt's state reads to a person. */
export function attemptStateLabel(a: Pick<TaskAttemptView, 'state' | 'outcome' | 'category'>): string {
  if (a.state === 'succeeded') return 'succeeded';
  if (a.state === 'failed') return a.category ? `failed (${a.category})` : 'failed';
  if (a.state === 'interrupted') return 'interrupted';
  if (a.state === 'waiting-human') return 'waiting for you';
  return a.state;
}

/** "1/3 · Sonnet · high · succeeded · 4m · 12.3k · $0.42" — one line per attempt (§18.3). */
export function attemptLine(a: TaskAttemptView, of: number, nowMs: number): string {
  const parts = [`${a.n}/${of}`];
  if (a.route) parts.push(routeChipText(a.route));
  parts.push(attemptStateLabel(a));
  const end = a.endedAt ?? (a.startedAt !== undefined ? nowMs : undefined);
  if (a.startedAt !== undefined && end !== undefined) parts.push(formatDuration(end - a.startedAt));
  if (a.tokens !== undefined) parts.push(formatTokens(a.tokens));
  if (a.costUsd !== undefined) parts.push(formatUsd(a.costUsd));
  return parts.join(' · ');
}

/** "3 files, +81 −12" — the strip's diff stat. Absent diff: nothing to say. */
export function diffStatText(d: TaskDiffView | undefined): string | undefined {
  if (!d) return undefined;
  if (d.filesChanged === 0 && d.insertions === 0 && d.deletions === 0) return 'no changes yet';
  const files = `${d.filesChanged} file${d.filesChanged === 1 ? '' : 's'}`;
  return `${files}, +${d.insertions} −${d.deletions}`;
}

/** What each action's button says. */
export const TASK_ACTION_LABEL: Record<TaskViewAction, string> = {
  'show-session': 'Show session',
  'open-diff': 'Open diff',
  accept: 'Accept',
  resume: 'Resume',
  retry: 'Retry',
  'recreate-worktree': 'Recreate worktree',
  cancel: 'Cancel',
};

/** Actions the strip draws as buttons, in this order; the rest go in its menu. */
export const TASK_STRIP_ACTIONS: readonly TaskViewAction[] = [
  'open-diff',
  'accept',
  'resume',
  'retry',
  'cancel',
  'recreate-worktree',
];

/** "involved · medium confidence · from the model" — a row's tooltip, evidence and all. */
export function assessmentRowTitle(r: AssessmentRowView): string {
  const parts = [`${r.label}: ${r.value}`, `${r.confidence} confidence`, `from the ${r.fromLabel}`];
  return r.evidence ? `${parts.join(' · ')}\n${r.evidence}` : parts.join(' · ');
}

/** The assessment chip's tooltip: the summary, how sure it is, and anything that went wrong. */
export function assessmentChipTitle(a: TaskAssessmentView): string {
  const parts = [`What this work is like: ${a.summary}`, `${a.confidence} confidence overall`];
  if (a.domains.length > 0) parts.push(`domains: ${a.domains.join(', ')}`);
  if (a.requires.length > 0) parts.push(`needs: ${a.requires.join(', ')}`);
  if (a.note) parts.push(a.note);
  return parts.join('\n');
}

/** A criterion verdict's glyph in the strip's review list (#36). */
export const CRITERION_GLYPH: Record<TaskReviewView['criteria'][number]['verdict'], string> = {
  met: '✓',
  unmet: '✗',
  unclear: '?',
};

/**
 * The review list's heading: "Review (advisory) · sonnet · $0.12".
 * Advisory or required first, because it decides whether the verdict below
 * can hold the task back.
 */
export function reviewHeadText(r: TaskReviewView): string {
  const parts = [`Review (${r.required ? 'required' : 'advisory'})`];
  if (r.model) parts.push(modelLabel(r.model) ?? r.model);
  if (r.costUsd !== undefined) parts.push(formatUsd(r.costUsd));
  return parts.join(' · ');
}

/** The strip's one-line summary, used as its collapsed state and its tooltip. */
export function taskSummaryLine(v: TaskView): string {
  const parts = [taskStateLabel(v.state)];
  if (v.attempt) parts.push(`attempt ${v.attempt.n}/${v.attempt.of}`);
  if (v.route) parts.push(routeChipText(v.route));
  if (v.branch) parts.push(v.branch);
  const diff = diffStatText(v.diff);
  if (diff) parts.push(diff);
  return parts.join(' · ');
}
