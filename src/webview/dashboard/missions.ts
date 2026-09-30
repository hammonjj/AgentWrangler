/**
 * The Missions view: the table pane's third view (§18.2, §18.4; #43).
 *
 * Draws `MissionsSnapshot` and turns clicks and edits into `MissionOp`s for
 * the host. Decides nothing about missions: whether a task can be edited,
 * whether the plan can be approved, which buttons a task has — all of that
 * arrives in the view records, worked out host-side.
 *
 * It lives in a pane that may be 300 px wide inside a 2000 px window, so it
 * is laid out from `#app.narrow` (the pane's own width), never a media query:
 * header chips wrap, a task's figures fold onto its second line, and the plan
 * editor stacks its fields. No inline styles (the CSP forbids them): classes only.
 */
import {
  FINISH_LABEL,
  ISSUE_LABEL,
  dependencyText,
  missionChips,
  reviewStatText,
  taskRowFigures,
  taskRowState,
  type MissionOp,
  type MissionPlannerView,
  type MissionTaskView,
  type MissionView,
  type MissionsSnapshot,
} from '../../shared/orchestration/missionView';
import { certaintyMark, certaintyText, LINKED_PHASE_LABEL, linkedTone, outcomeFacts, TASK_PHASE_LABEL } from '../../shared/orchestration/delegatedLabels';
import type { PlanEdit, PlanOverrides } from '../../shared/orchestration/plan';
import { TASK_ACTION_LABEL, TASK_STRIP_ACTIONS, routeChipTitle, type TaskViewAction } from '../../shared/orchestration/taskView';
import { EFFORT_LEVELS, TASK_KINDS, type DependencyKind, type TaskKind } from '../../shared/orchestration/types';

/** What the view remembers between snapshots. Only the pane's own, never the host's. */
export interface MissionsUiState {
  /** Missions folded shut, by id. Finished ones start folded. */
  collapsed: Set<string>;
  /** Missions the user opened by hand (so a finished one stays open). */
  expanded: Set<string>;
  /** The one task whose editor is open in plan review. */
  editing?: string;
  /** The last refusal or failure per mission, until the next action on it. */
  errors: Map<string, string>;
  /** Scroll this mission into view on the next paint. */
  reveal?: string;
}

export function newMissionsUiState(): MissionsUiState {
  return { collapsed: new Set(), expanded: new Set(), errors: new Map() };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
/** Kinds a person writes; `plan` and `conflict-resolution` are the orchestrator's own. */
const WRITABLE_KINDS = TASK_KINDS.filter((k) => k !== 'plan' && k !== 'conflict-resolution');

function isOpen(v: MissionView, ui: MissionsUiState): boolean {
  if (ui.collapsed.has(v.id)) return false;
  return !TERMINAL.has(v.state) || ui.expanded.has(v.id);
}

/** The whole view. Missions that need the user first, then running, then the rest by recency. */
export function missionsHtml(snap: MissionsSnapshot, ui: MissionsUiState, nowMs: number): string {
  // Needs-you first, from the shared phase (#101), so the order agrees with the tab's count.
  const needsYou = (v: MissionView) =>
    v.phase ? v.phase.needsYou : v.state === 'plan-review' || v.state === 'review' || v.state === 'planning-failed' || v.metrics.waiting > 0;
  const rank = (v: MissionView) => (needsYou(v) ? 0 : TERMINAL.has(v.state) ? 2 : 1);
  const missions = [...snap.missions].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const head = `<div class="mbar"><button class="mnew" data-mission-new title="A mission is a plan of tasks, written by you or proposed by the read-only planner. Nothing runs until you approve it.">+ New mission</button><span class="mhint">A plan of tasks that run one after another on one branch, after you approve it.</span></div>`;
  if (missions.length === 0) {
    return `<div class="missions">${head}<div class="mempty">No missions yet. <span class="hint">“+ New mission” writes one for the launcher’s folder; the Tasks button runs a single task.</span></div></div>`;
  }
  return `<div class="missions">${head}${missions.map((v) => missionHtml(v, snap, ui, nowMs)).join('')}</div>`;
}

/**
 * The mission's phase, from the shared derivation (#101), in place of the raw
 * record state: an open proposal reads "Awaiting approval", never "running",
 * and a finished mission reads as three separate facts (merged, verified,
 * closeout) rather than one "completed" (status contract C1–C3).
 */
function phaseChipsHtml(v: MissionView): string {
  const p = v.phase;
  if (!p) return '';
  const mark = certaintyMark(p.certainty);
  const markHtml = mark ? `<span class="umark" aria-label="${mark === '?' ? 'unknown' : 'estimated'}">${mark}</span>` : '';
  const facts = p.outcome && p.phase === 'integrated' ? outcomeFacts(p.outcome) : [];
  const phase = facts.length > 0
    ? ''
    : `<span class="mchip phase lt-${linkedTone(p)}${p.needsYou ? ' needs' : ''}" title="${esc(`${p.title}\n${certaintyText(p.certainty, 'mission')}`)}">${markHtml}${esc(LINKED_PHASE_LABEL[p.phase])}</span>`;
  return phase + facts.map((f) => `<span class="mchip fact fact-${f.kind} ft-${f.tone}" title="${esc(f.title)}">${esc(f.text)}</span>`).join('');
}

function missionHtml(v: MissionView, snap: MissionsSnapshot, ui: MissionsUiState, nowMs: number): string {
  const open = isOpen(v, ui);
  const chips =
    phaseChipsHtml(v) +
    missionChips(v, nowMs)
      // The phase chips say what the state chip did, without its ambiguity.
      .filter((c) => !(v.phase && c.kind === 'state'))
      .map((c) => `<span class="mchip ${c.kind}${c.tone ? ` tone-${esc(c.tone)}` : ''}" title="${esc(c.title)}">${esc(c.text)}</span>`)
      .join('');
  const where = [v.repo, v.branch ? `${v.baseRef} → ${v.branch}` : `from ${v.baseRef}`].join(' · ');
  const error = ui.errors.get(v.id);
  let body = '';
  if (open) {
    body += `<div class="mmeta" title="${esc(v.objective)}">${esc(where)}</div>`;
    if (v.stateReason) body += `<div class="mreason">${esc(v.stateReason)}</div>`;
    if (error) body += `<div class="merror" role="alert">${esc(error)}<button class="mdismiss" data-mission-dismiss title="Dismiss">×</button></div>`;
    if (v.planner) body += plannerHtml(v.planner);
    const reviewing = v.state === 'plan-review';
    if (reviewing) body += planIssuesHtml(v);
    // Before a fresh plan arrives the mission holds only its objective as a stand-in task: not worth a row.
    const awaitingPlan = (v.state === 'planning' || v.state === 'planning-failed') && v.planner?.kind === 'plan';
    if (awaitingPlan) {
      if (v.state === 'planning') body += `<div class="mplanning">The planner is reading the repository. Its plan comes here for review, and nothing runs until you approve it.</div>`;
    } else {
      body += `<ol class="mtasks">${v.tasks.map((t, i) => (reviewing ? planTaskHtml(v, t, i, snap, ui) : taskRowHtml(t, nowMs))).join('')}</ol>`;
    }
    body += footerHtml(v);
  }
  return `<section class="mission m-${esc(v.state)}${open ? '' : ' shut'}" data-mission="${esc(v.id)}">
<div class="mhdr" data-mission-toggle><span class="twist">${open ? '▾' : '▸'}</span><span class="mtitle" title="${esc(v.objective)}">${esc(v.title)}</span><span class="mchips">${chips}</span></div>${body}</section>`;
}

/** What the planner did (#44): a line, what a replan changed, and its risks and warnings. */
function plannerHtml(p: MissionPlannerView): string {
  const list = (cls: string, label: string, items: string[]) =>
    items.length > 0 ? `<ul class="${cls}">${items.map((x) => `<li><span class="ilevel">${esc(label)}</span> ${esc(x)}</li>`).join('')}</ul>` : '';
  return `<div class="mplanner ps-${esc(p.state)}"><div class="pl-line" title="${esc(p.title)}">${esc(p.text)}${p.diff ? `<span class="pl-diff">${esc(p.diff)}</span>` : ''}</div>${list(
    'pl-warn',
    'Worth a look',
    p.warnings,
  )}${list('pl-risk', 'Risk', p.risks)}</div>`;
}

function planIssuesHtml(v: MissionView): string {
  if (v.issues.length === 0) return `<div class="missues ok">The plan is valid: ${v.tasks.length} of at most ${v.cap} tasks, no cycles. Nothing runs until you approve it.</div>`;
  const items = v.issues
    .map((i) => `<li class="issue ${i.level}"><span class="ilevel">${esc(ISSUE_LABEL[i.level])}</span> ${esc(i.text)}</li>`)
    .join('');
  return `<ul class="missues">${items}</ul>`;
}

/** One row of a running or finished mission (§18.2). The title opens the task's conversation. */
function taskRowHtml(t: MissionTaskView, nowMs: number): string {
  // The row's state comes from the shared task phase (#101): a finished task
  // reads "completed", and whether it was checked is its own labelled fact
  // beside it, so it never reads as one ambiguous "done · ? unverified" (C2).
  const raw = taskRowState(t);
  const state = t.phase ? { text: TASK_PHASE_LABEL[t.phase], title: t.stateReason ? `${TASK_PHASE_LABEL[t.phase]}: ${t.stateReason}` : raw.title } : raw;
  const verdictTone = t.verification ? (t.verification.verdict === 'passed' ? 'ok' : t.verification.verdict === 'failed' ? 'bad' : 'warn') : '';
  const verify = t.verification
    ? `<span class="tverify ft-${verdictTone}" title="${esc(t.verification.title)}"><span class="tvlabel">checks</span> ${esc(`${t.verification.glyph} ${t.verification.text}`)}</span>`
    : '';
  const figures = taskRowFigures(t, nowMs);
  const deps = dependencyText(t.deps);
  const line2 = [
    figures ? `<span class="tfig"${t.route ? ` title="${esc(routeChipTitle(t.route))}"` : ''}>${esc(figures)}</span>` : '',
    t.branch ? `<span class="tbranch" title="${esc(t.branch)}">${esc(t.branch)}</span>` : '',
    deps ? `<span class="tdeps">${esc(deps)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  const acts = t.actions.filter((a) => a !== 'show-session' && TASK_STRIP_ACTIONS.includes(a));
  const buttons = acts.length > 0 ? `<div class="tacts">${acts.map((a) => actionButton(a)).join('')}</div>` : '';
  const openable = t.sessionKey !== undefined;
  return `<li class="mtask ts-${esc(t.state)}${t.phase ? ` tp-${esc(t.phase)}` : ''}${t.needsYou ? ' needs' : ''}" data-task="${esc(t.taskId)}">
<div class="trow${openable ? ' openable' : ''}"${openable ? ' data-task-open title="Show this task’s conversation"' : ''}><span class="tdot" aria-hidden="true"></span><span class="tkey">${esc(t.key)}</span><span class="ttitle">${esc(t.title)}</span><span class="tstate" title="${esc(state.title)}">${esc(state.text)}</span>${verify}</div>
${line2 ? `<div class="tline2">${line2}</div>` : ''}${buttons}</li>`;
}

function actionButton(a: TaskViewAction): string {
  const cls = a === 'accept' ? ' primary' : a === 'cancel' ? ' danger' : '';
  return `<button class="tact${cls}" data-task-action="${esc(a)}">${esc(TASK_ACTION_LABEL[a])}</button>`;
}

/** A task in plan review: a compact line, and the editor when it is the one being edited. */
function planTaskHtml(v: MissionView, t: MissionTaskView, index: number, snap: MissionsSnapshot, ui: MissionsUiState): string {
  const editing = ui.editing === t.taskId;
  const deps = dependencyText(t.deps);
  const route = routeSummary(t);
  const preview = t.preview
    ? `<div class="tpreview" title="${esc([t.preview.summary, t.preview.requirement, t.preview.target, t.preview.note].filter(Boolean).join('\n'))}"><span class="pv-sum">${esc(t.preview.summary)}</span>${t.preview.requirement ? `<span class="pv-req">needs ${esc(t.preview.requirement)}</span>` : ''}${t.preview.target ? `<span class="pv-target">${esc(t.preview.target)}</span>` : ''}${t.preview.note ? `<span class="pv-note">${esc(t.preview.note)}</span>` : ''}</div>`
    : `<div class="tpreview pending">assessing…</div>`;
  const issues = v.issues.filter((i) => i.taskId === t.taskId && i.level !== 'warning').length;
  const tools = t.editable
    ? `<span class="ptools"><button class="pbtn2" data-plan-op="up" title="Move up"${index === 0 ? ' disabled' : ''}>↑</button><button class="pbtn2" data-plan-op="down" title="Move down"${index === v.tasks.length - 1 ? ' disabled' : ''}>↓</button><button class="pbtn2" data-plan-op="edit" aria-expanded="${editing}" title="${editing ? 'Close the editor' : 'Edit this task'}">${editing ? 'Done' : 'Edit'}</button></span>`
    : '';
  const head = `<div class="prow"><span class="tkey">${esc(t.key)}</span><span class="ttitle">${esc(t.title)}</span>${issues > 0 ? `<span class="pflag" title="This task has something to fix before the plan can start">!</span>` : ''}${tools}</div>
<div class="pline2">${deps ? `<span class="tdeps">${esc(deps)}</span>` : ''}${route ? `<span class="troute">${esc(route)}</span>` : ''}<span class="pcrit">${t.acceptanceCriteria.length} criteri${t.acceptanceCriteria.length === 1 ? 'on' : 'a'}</span></div>${preview}`;
  return `<li class="mtask ptask${editing ? ' editing' : ''}" data-task="${esc(t.taskId)}">${head}${editing ? editorHtml(v, t, snap) : ''}</li>`;
}

/** "Codex · gpt-5 · high · ≤ standard": what the task's own pins and caps say. Empty: it follows the launcher. */
function routeSummary(t: MissionTaskView): string {
  const parts: string[] = [];
  if (t.pins?.harness) parts.push(t.pins.harness === 'codex' ? 'Codex' : 'Claude Code');
  if (t.pins?.model) parts.push(t.pins.model);
  if (t.pins?.effort) parts.push(t.pins.effort);
  if (t.caps?.maxTier) parts.push(`≤ ${t.caps.maxTier}`);
  if (t.caps?.maxEffort) parts.push(`effort ≤ ${t.caps.maxEffort}`);
  return parts.length > 0 ? `pinned: ${parts.join(' · ')}` : '';
}

function options(values: readonly { value: string; label: string }[], current: string | undefined): string {
  return values.map((o) => `<option value="${esc(o.value)}"${(current ?? '') === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

function editorHtml(v: MissionView, t: MissionTaskView, snap: MissionsSnapshot): string {
  const others = v.tasks.filter((x) => x.taskId !== t.taskId);
  const depOf = (id: string) => t.deps.find((d) => d.taskId === id)?.kind ?? 'none';
  const deps = others.length
    ? others
        .map(
          (o) =>
            `<label class="pdep"><span>${esc(o.key)} ${esc(o.title)}</span><select data-dep="${esc(o.taskId)}">${options(
              [
                { value: 'none', label: 'independent' },
                { value: 'code', label: 'needs its result' },
                { value: 'order', label: 'runs after it' },
              ],
              depOf(o.taskId),
            )}</select></label>`,
        )
        .join('')
    : '<span class="phint">No other tasks yet.</span>';
  const kinds = [{ value: '', label: 'Kind: let the assessor decide' }, ...WRITABLE_KINDS.map((k) => ({ value: k, label: `Kind: ${k}` }))];
  const efforts = [{ value: '', label: 'launcher’s' }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))];
  const capEfforts = [{ value: '', label: 'no cap' }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))];
  const harnesses = [{ value: '', label: 'launcher’s' }, ...snap.harnesses.map((h) => ({ value: h.id, label: h.label }))];
  const tiers = [{ value: '', label: 'no cap' }, ...snap.tiers.map((x) => ({ value: x, label: x }))];
  const merge = others.length
    ? `<select data-plan-merge title="Fold this task into another: objectives, criteria and scope are joined"><option value="" selected>Merge into…</option>${others.map((o) => `<option value="${esc(o.taskId)}">${esc(`${o.key} ${o.title}`)}</option>`).join('')}</select>`
    : '';
  return `<div class="peditor">
<label class="pfield"><span>Title</span><input type="text" data-field="title" value="${esc(t.title)}"></label>
<label class="pfield"><span>Objective</span><textarea rows="3" data-field="objective">${esc(t.objective)}</textarea></label>
<label class="pfield"><span>Acceptance criteria, one per line</span><textarea rows="3" data-field="criteria">${esc(t.acceptanceCriteria.join('\n'))}</textarea></label>
<label class="pfield"><span>Scope: paths or globs, comma-separated (optional)</span><input type="text" data-field="scope" value="${esc(t.scopePaths.join(', '))}"></label>
<label class="pfield"><select data-field="kind">${options(kinds, t.kindDefaulted ? '' : t.kind)}</select></label>
<fieldset class="pgroup"><legend>Depends on</legend>${deps}</fieldset>
<fieldset class="pgroup pins"><legend>Pins and caps (this task only)</legend>
<label class="pmini"><span>Harness</span><select data-pin="harness">${options(harnesses, t.pins?.harness)}</select></label>
<label class="pmini"><span>Model</span><input type="text" data-pin="model" placeholder="launcher’s" value="${esc(t.pins?.model ?? '')}"></label>
<label class="pmini"><span>Effort</span><select data-pin="effort">${options(efforts, t.pins?.effort)}</select></label>
<label class="pmini"><span>Max tier</span><select data-cap="maxTier">${options(tiers, t.caps?.maxTier)}</select></label>
<label class="pmini"><span>Max effort</span><select data-cap="maxEffort">${options(capEfforts, t.caps?.maxEffort)}</select></label>
</fieldset>
<div class="pactions"><button class="pbtn2" data-plan-op="split" title="Split in two: the second part takes the later criteria and needs the first">Split</button>${merge}<button class="pbtn2 danger" data-plan-op="delete">Delete</button></div>
</div>`;
}

function footerHtml(v: MissionView): string {
  const parts: string[] = [];
  if (v.state === 'plan-review') {
    parts.push(`<button class="mbtn" data-plan-op="add"${v.tasks.length >= v.cap ? ` disabled title="At most ${v.cap} tasks"` : ''}>+ Add task</button>`);
    parts.push(
      `<button class="mbtn primary" data-mission-op="approve"${v.canApprove ? '' : ' disabled'} title="${v.canApprove ? 'Start the first task on the launcher’s model; the rest follow in order' : 'Fix what the plan review lists first'}">Approve and start</button>`,
    );
  }
  if (v.canRunProposal) {
    parts.push(`<button class="mbtn primary" data-mission-op="approve" title="Start the task on the route the router recommended">Run task</button>`);
  }
  if (v.review) {
    const stat = `<span class="mstat">${esc(reviewStatText(v.review))}</span>`;
    const buttons = v.review.finishes
      .map((f) => `<button class="mbtn${f === (v.review!.recommended ?? 'merge-local') ? ' primary' : ''}${f === 'discard' ? ' danger' : ''}" data-finish="${esc(f)}">${esc(FINISH_LABEL[f])}</button>`)
      .join('');
    parts.push(stat + buttons);
  }
  if (v.finishResult) {
    const r = v.finishResult;
    const text = r.pullRequestUrl ? `Pull request: ${r.pullRequestUrl}` : r.mergeCommit ? `Merged at ${r.mergeCommit.slice(0, 8)}${r.note ? ` (${r.note})` : ''}` : r.note ?? '';
    if (text) parts.push(`<span class="mstat">${esc(text)}</span>`);
  }
  if (v.canPlanAgain) {
    parts.push(
      `<button class="mbtn${v.state === 'planning-failed' ? ' primary' : ''}" data-mission-op="plan-again" title="Ask the read-only planner again${v.state === 'plan-review' ? '; the tasks here are replaced by its new plan' : ''}">Plan again…</button>`,
    );
  }
  if (v.canWritePlan) parts.push(`<button class="mbtn" data-mission-op="write-plan" title="Start plan review from what the mission has now, and write the tasks yourself">Write it myself</button>`);
  if (v.canReplan) {
    parts.push(
      `<button class="mbtn" data-mission-op="replan" title="Ask the planner for the rest of the plan. Done tasks stay; unfinished work is set aside on a branch of its own; the new plan is reviewed before anything runs.">Replan…</button>`,
    );
  }
  if (v.canPause) {
    parts.push(`<button class="mbtn" data-mission-op="pause" title="Start nothing new; what is running carries on">Pause</button>`);
    parts.push(`<button class="mbtn" data-mission-op="pause-now" title="Start nothing new, and pause the running agents too">Pause now</button>`);
  }
  if (v.canResume) parts.push(`<button class="mbtn primary" data-mission-op="resume" title="Resume paused agents and start what is ready">Resume</button>`);
  if (v.canCancel) parts.push(`<button class="mbtn danger" data-mission-op="cancel">Cancel mission</button>`);
  return parts.length > 0 ? `<div class="mfoot">${parts.join('')}</div>` : '';
}

// ---------------------------------------------------------------------------
// Input → operations
// ---------------------------------------------------------------------------

export type MissionIntent =
  | { kind: 'op'; missionId: string; op: MissionOp }
  | { kind: 'new' }
  | { kind: 'toggle'; missionId: string }
  | { kind: 'edit-toggle'; missionId: string; taskId: string }
  | { kind: 'dismiss'; missionId: string };

function ids(target: HTMLElement): { missionId?: string; taskId?: string } {
  return {
    missionId: target.closest<HTMLElement>('[data-mission]')?.dataset.mission,
    taskId: target.closest<HTMLElement>('[data-task]')?.dataset.task,
  };
}

/** What a click inside the Missions view means, or undefined if it was not on one of its controls. */
export function clickIntent(target: HTMLElement, snap: MissionsSnapshot | undefined): MissionIntent | undefined {
  if (target.closest('[data-mission-new]')) return { kind: 'new' };
  const { missionId, taskId } = ids(target);
  if (!missionId) return undefined;
  if (target.closest('[data-mission-dismiss]')) return { kind: 'dismiss', missionId };
  const btn = target.closest<HTMLButtonElement>('button');
  if (btn?.disabled) return undefined;
  const missionOp = target.closest<HTMLElement>('[data-mission-op]')?.dataset.missionOp;
  if (missionOp === 'approve') return { kind: 'op', missionId, op: { kind: 'approve' } };
  if (missionOp === 'cancel') return { kind: 'op', missionId, op: { kind: 'cancel' } };
  if (missionOp === 'pause' || missionOp === 'pause-now') return { kind: 'op', missionId, op: { kind: 'pause', ...(missionOp === 'pause-now' ? { now: true } : {}) } };
  if (missionOp === 'resume') return { kind: 'op', missionId, op: { kind: 'resume' } };
  if (missionOp === 'plan-again' || missionOp === 'write-plan' || missionOp === 'replan') return { kind: 'op', missionId, op: { kind: missionOp } };
  const finish = target.closest<HTMLElement>('[data-finish]')?.dataset.finish;
  if (finish) return { kind: 'op', missionId, op: { kind: 'finish', how: finish as 'merge-local' } };
  const action = target.closest<HTMLElement>('[data-task-action]')?.dataset.taskAction;
  if (action && taskId) return { kind: 'op', missionId, op: { kind: 'task', taskId, action: action as TaskViewAction } };
  const planOp = target.closest<HTMLElement>('[data-plan-op]')?.dataset.planOp;
  if (planOp) {
    const mission = snap?.missions.find((m) => m.id === missionId);
    const index = mission && taskId ? mission.tasks.findIndex((t) => t.taskId === taskId) : -1;
    const edit = (e: PlanEdit): MissionIntent => ({ kind: 'op', missionId, op: { kind: 'edit', edit: e } });
    switch (planOp) {
      case 'add':
        return edit({ kind: 'add' });
      case 'edit':
        return taskId ? { kind: 'edit-toggle', missionId, taskId } : undefined;
      case 'up':
        return taskId && index > 0 ? edit({ kind: 'move', taskId, to: index - 1 }) : undefined;
      case 'down':
        return taskId && index >= 0 ? edit({ kind: 'move', taskId, to: index + 1 }) : undefined;
      case 'split':
        return taskId ? edit({ kind: 'split', taskId }) : undefined;
      case 'delete':
        return taskId ? edit({ kind: 'delete', taskId }) : undefined;
    }
    return undefined;
  }
  if (target.closest('[data-task-open]') && taskId) return { kind: 'op', missionId, op: { kind: 'open', taskId } };
  if (target.closest('[data-mission-toggle]')) return { kind: 'toggle', missionId };
  return undefined;
}

function list(text: string, split: RegExp): string[] {
  return text.split(split).map((s) => s.trim()).filter(Boolean);
}

/** What a changed field in the plan editor means. Sent on `change` (blur, or a pick), never per keystroke. */
export function changeIntent(target: HTMLElement): MissionIntent | undefined {
  const { missionId, taskId } = ids(target);
  if (!missionId || !taskId) return undefined;
  const el = target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const edit = (e: PlanEdit): MissionIntent => ({ kind: 'op', missionId, op: { kind: 'edit', edit: e } });
  const field = el.dataset.field;
  if (field === 'title') return edit({ kind: 'update', taskId, fields: { title: el.value } });
  if (field === 'objective') return edit({ kind: 'update', taskId, fields: { objective: el.value } });
  if (field === 'criteria') return edit({ kind: 'update', taskId, fields: { acceptanceCriteria: list(el.value, /\n/) } });
  if (field === 'scope') return edit({ kind: 'update', taskId, fields: { scopePaths: list(el.value, /[,\n]/) } });
  if (field === 'kind') return edit({ kind: 'update', taskId, fields: { kind: el.value ? (el.value as TaskKind) : null } });
  const dep = el.dataset.dep;
  if (dep) return edit({ kind: 'depend', taskId, on: dep, dep: el.value as DependencyKind | 'none' });
  if (el.dataset.planMerge !== undefined && el.value) return edit({ kind: 'merge', taskId, into: el.value });
  const pin = el.dataset.pin as keyof NonNullable<PlanOverrides['pins']> | undefined;
  if (pin) return edit({ kind: 'overrides', taskId, overrides: { pins: { [pin]: el.value } } });
  const cap = el.dataset.cap as keyof NonNullable<PlanOverrides['caps']> | undefined;
  if (cap) return edit({ kind: 'overrides', taskId, overrides: { caps: { [cap]: el.value } } });
  return undefined;
}
