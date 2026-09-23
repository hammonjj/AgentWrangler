import type { ModelChoice } from '../../shared/conversation';
import { subagentText } from '../../shared/subagents';
import './dashboard.css';
import {
  clampResizeWidth,
  COLUMNS,
  columnWidth,
  isHidden,
  MIN_AGENT_WIDTH,
  NARROW_PX,
  visibleColumns,
  withDefaultWidths,
  withHidden,
  withWidths,
  type ColumnDef,
  type ColumnId,
  type ColumnPrefs,
} from '../../shared/columns';
import type { DashboardAction, DashboardToHost, HostToDashboard } from '../../shared/messages';
import { modelLabel } from '../../shared/modelName';
import { paneApi } from '../common/paneApi';
import { canPauseSession, clampMenuPosition, rowMenuItems, rowMenuSize } from '../../shared/rowMenu';
import {
  askLine,
  capitalize,
  displayLabel,
  etaText,
  formatAge,
  formatDuration,
  GLOBAL_PROJECT_DIR,
  hookBanner,
  SECTION_LABEL,
  SECTION_ORDER,
  sectionOf,
  UNCATEGORIZED_SECTION,
  workingElapsedMs,
  type HookHealth,
  type ProjectDTO,
  type SectionId,
  type SessionDTO,
} from '../../shared/model';
import {
  resetsInText,
  spendText,
  usageErrorText,
  usageSeverity,
  type UsageError,
  type UsageSnapshot,
  type UsageState,
  type UsageWindow,
} from '../../shared/usage';

interface WebviewState {
  collapsed?: string[];
  tableView?: 'status' | 'sections';
  /** Hook-health kind whose banner the user hid. A different kind brings the banner back. */
  bannerDismissed?: string;
  /**
   * Folder the launcher is pointed at. Per-webview on purpose: two windows are
   * usually two different jobs, and a shared setting would have each one
   * changing where the other starts its next conversation.
   */
  project?: string;
  provider?: 'all' | 'claude' | 'codex';
}

// Shared with the conversation pane when both live in one webview: the VSCode
// API may only be acquired once, and messages and saved state are namespaced so
// the two cannot overwrite each other. See `common/paneApi.ts`.
const vscodeApi = paneApi<WebviewState>('dashboard');
const post = (msg: DashboardToHost) => vscodeApi.post(msg);

const app = document.getElementById('app')!;
let sessions: SessionDTO[] = [];
let hooks: HookHealth | undefined;
let usage: UsageState | undefined;
let codexUsage: UsageState | undefined;
let conversationSections = [UNCATEGORIZED_SECTION];
/** The bar's Discord button, absent until the first snapshot says whether it exists. */
let discord: { configured: boolean; on: boolean } | undefined;
type QuestionDraft = { step: number; selected: Record<number, string[]>; other: Record<number, string> };
const questionDrafts = new Map<string, QuestionDraft>();

// ---- columns ----
// The layout is the host's (globalState, shared by every dashboard), but a drag
// has to feel immediate, so the webview keeps its own copy and posts changes.
// The snapshot that comes back matches what we already drew.
let columns: ColumnPrefs = {};
let showCodexSubagents = false;
/**
 * Whether the table is narrow enough to fold its optional columns away.
 *
 * Measured on the table's own container, not on the window. Sharing a webview
 * with the conversation pane means the table is only ever part of the width,
 * and the divider between them moves — so the window can be 2000px wide while
 * the table has 400px, and the window never resizes when the divider does.
 */
let narrow = app.clientWidth > 0 && app.clientWidth < NARROW_PX;
/** Open column picker, or undefined. The number is where to pin it vertically. */
let menuPosition: { top: number; left: number } | undefined;
/** Open row context menu: which row it belongs to, and where it was asked for. */
let rowMenu: { key: string; x: number; y: number; showSections?: boolean } | undefined;
/** A drag owns the table until it ends: snapshots arriving mid-drag are deferred. */
let dragging = false;
let renderDeferred = false;

/**
 * Permission cards the user opened or closed by hand, by session key. Not
 * persisted: a prompt lives for minutes, and the default (open while it can
 * still be answered) is the right one every time a new one arrives.
 */
const permOverride = new Map<string, boolean>();

function permExpanded(key: string, pending: boolean): boolean {
  return permOverride.get(key) ?? pending;
}

function cols(): ColumnDef[] {
  return visibleColumns(columns, narrow);
}

/** Send the layout up so it outlives this webview, and draw it now. */
function saveColumns(next: ColumnPrefs): void {
  columns = next;
  post({ type: 'setColumns', prefs: next });
}
// Collapse state survives reloads via webview state; Archived starts collapsed.
const saved = vscodeApi.getState();
const collapsed = new Set<string>(saved?.collapsed ?? ['archived']);
let bannerDismissed = saved?.bannerDismissed;
let project = saved?.project;
let providerFilter: 'all' | 'claude' | 'codex' = saved?.provider ?? 'all';
let tableView: 'status' | 'sections' = saved?.tableView ?? 'status';

function saveState(): void {
  vscodeApi.setState({ collapsed: [...collapsed], bannerDismissed, project, provider: providerFilter, tableView });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A length this file computed: `12px`, `37.5%`. Anything else is not painted. */
const LENGTH = /^\d+(\.\d+)?(px|%)$/;

/**
 * Draw the table, then paint the lengths that are data rather than design.
 *
 * `style="width:150px"` in the HTML above would be an INLINE STYLE, and the
 * webview CSP has no `'unsafe-inline'` in `style-src`, so the browser drops the
 * attribute on the floor — silently, since a blocked style is a console
 * violation and not an error. That is why dragged column widths used to vanish
 * the moment the table re-rendered: with every `<th>` back to `auto`, fixed
 * table layout simply split the width equally, and a drag appeared to resize
 * every column at once.
 *
 * The same property set through the CSSOM is not an inline style and is not
 * blocked. So widths ride in `data-w` (and the menus' offsets in `data-top` /
 * `data-left`) and land here, after the HTML is in the document.
 */
function applyStyles(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-w]')) {
    if (LENGTH.test(el.dataset.w!)) el.style.width = el.dataset.w!;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-top]')) {
    if (LENGTH.test(el.dataset.top!)) el.style.top = el.dataset.top!;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-left]')) {
    if (LENGTH.test(el.dataset.left!)) el.style.left = el.dataset.left!;
  }
}

function paint(html: string): void {
  // The only text field inside #app is the stepper's "Other…" box, and a
  // snapshot arrives every couple of seconds — without this, typing an answer
  // loses the caret (and the focus ring) mid-word.
  const typing = document.activeElement;
  const focused =
    typing instanceof HTMLInputElement && typing.classList.contains('qother')
      ? { draft: typing.closest<HTMLElement>('.qstep')?.dataset.draft, at: typing.selectionStart }
      : undefined;
  app.innerHTML = html;
  applyStyles(app);
  if (focused?.draft) {
    const restored = app.querySelector<HTMLInputElement>(`.qstep[data-draft="${CSS.escape(focused.draft)}"] .qother`);
    if (restored) {
      restored.focus();
      const at = focused.at ?? restored.value.length;
      restored.setSelectionRange(at, at);
    }
  }
}

const ICON_COLUMNS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><path d="M6.4 2.8v10.4M10.4 2.8v10.4"/></svg>';

function clickHint(s: SessionDTO): string {
  if (s.runnerOwned) return 'Click to open the conversation — this window runs it, so you can type into it';
  return s.wasRunningHere ? 'Click to resume a session this workspace ran recently' : 'Click to open the conversation here';
}

/**
 * The row's right-click menu. Rendered as part of the table's own HTML rather
 * than as a detached popup, for the same reason the column picker is: a
 * snapshot arrives every couple of seconds on a busy machine, and a menu living
 * outside `#app` would be torn out from under the pointer by the next one.
 *
 * A row whose session vanished between the right-click and this render draws
 * nothing — the snapshot handler clears `rowMenu` in that case, so the stale
 * state cannot eat the next click either.
 */
function rowMenuHtml(): string {
  if (!rowMenu) return '';
  const s = sessions.find((x) => x.key === rowMenu!.key);
  if (!s) return '';

  const items = rowMenuItems(s);
  const expanded = rowMenu.showSections === true;
  const menuSize = expanded
    ? { width: 240, height: 38 + conversationSections.length * 30 + 42 + items.length * 30 }
    : rowMenuSize([...items, { action: 'rename', label: 'Add to…' }]);
  const { left, top } = clampMenuPosition(rowMenu, menuSize, {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });
  const sectionRows = expanded
    ? `<div class="rmsub" role="group" aria-label="Conversation sections">${conversationSections.map((section) =>
        `<button class="rmrow rmsection${section === (s.conversationSection ?? UNCATEGORIZED_SECTION) ? ' current' : ''}" role="menuitemradio" aria-checked="${section === (s.conversationSection ?? UNCATEGORIZED_SECTION)}" data-section="${esc(section)}"><span>${section === (s.conversationSection ?? UNCATEGORIZED_SECTION) ? '✓' : ''}</span>${esc(section)}</button>`,
      ).join('')}<button class="rmrow rmcreate" role="menuitem" data-create-section><span>＋</span>Create new section…</button></div>`
    : '';
  const rows = items
    .map(
      (i) =>
        `<button class="rmrow${i.danger ? ' danger' : ''}" role="menuitem" data-row-action="${i.action}"${
          i.title ? ` title="${esc(i.title)}"` : ''
        }>${esc(i.label)}</button>`,
    )
    .join('');
  return `<div class="rowmenu${expanded ? ' sections-open' : ''}" data-left="${left}px" data-top="${top}px" role="menu" aria-label="Actions for ${esc(displayLabel(s))}"><button class="rmrow rmadd" role="menuitem" data-add-to>Add to…<span>›</span></button>${sectionRows}${rows}</div>`;
}

/**
 * What the agent is actually doing, when hooks told us. `blocked` names the tool
 * it wants; `busy` names the tool in flight and how long it has been running —
 * that elapsed time is what tells a 20-minute test suite apart from a stall.
 *
 * Busy rows then add, when the data exists, the agent's own checklist — the only
 * honest percentage in the whole pipeline. The time estimate lives in its own
 * column (`etaCell`), not here.
 */
/**
 * There was a `here` chip on every session this window runs. It went because it
 * marked the rule rather than the exception: nearly everything runs in one
 * window, so it appeared on nearly every row and told the reader nothing they
 * did not already assume. "Not here" is the fact worth a chip, and that one is
 * not worth inventing until a second window is actually in use — the row's
 * click hint and its tooltip already say where a session will open.
 */

/**
 * A frozen session. Worth a chip of its own as well as the section, because the
 * status underneath it (Busy, Blocked) is still on the row and would otherwise
 * read as something that is still happening.
 */
function pausedChip(s: SessionDTO): string {
  return s.paused
    ? '<span class="chip paused" title="Stopped, and spending nothing. Right-click → Resume agent to let it run again.">paused</span>'
    : '';
}

function statusChip(s: SessionDTO): string {
  if (s.status === 'blocked' && s.blockedReason) {
    return `<span class="chip blk">${esc(capitalize(`needs ${s.blockedReason}`))}</span>`;
  }
  if (s.status !== 'busy') return '';

  const chips: string[] = [];
  if (s.activeTool) {
    chips.push(
      `<span class="chip tool">${esc(s.activeTool.name)} · <span data-age-ts="${s.activeTool.sinceMs}">${formatAge(Date.now(), s.activeTool.sinceMs)}</span></span>`,
    );
  }

  const todo = s.progress?.todo;
  if (todo) {
    // Width of the fill is the real ratio; the label repeats it for anyone who
    // can't read the bar (and for the ~4% of sessions where this appears at all).
    const pct = todo.total > 0 ? Math.round((todo.completed / todo.total) * 100) : 0;
    const label = todo.active ? ` title="${esc(todo.active)}"` : '';
    chips.push(
      `<span class="chip todo"${label}><span class="fill" data-w="${pct}%"></span><span class="txt">${todo.completed}/${todo.total}</span></span>`,
    );
  }
  return chips.join('');
}

/**
 * The permission card: extra rows under a blocked session saying what it wants
 * to run, and the buttons that answer it.
 *
 * It is its own `<tr>` spanning the whole table rather than a third line inside
 * the Agent cell, because the command needs the full width and as many lines as
 * it takes — a one-line ellipsis is not something you can safely click Allow on.
 * Expanded by default while a decision can still land, collapsed once it cannot;
 * the header line stays either way, so the row never loses what it is waiting
 * for. Claude Code's own dialog stays open the whole time and works as before;
 * whichever is answered first wins.
 */
function permissionRow(s: SessionDTO, span: number): string {
  if (s.status !== 'blocked' || (!s.blockedAsk && !s.permissionRequestId && !s.pendingQuestion)) return '';

  const ask = s.blockedAsk;
  const question = s.pendingQuestion;
  const pending = question !== undefined || s.permissionRequestId !== undefined;
  const open = permExpanded(s.key, pending);

  // The header is the summary when Claude gave one, else the ask itself on one
  // line; the body below repeats it in full, unflattened.
  const headline = question?.questions[0]?.question ?? ask?.summary ?? askLine(ask);
  const header = headline
    ? `<span class="phead">${esc(headline)}</span>`
    : `<span class="phead dim">${esc(capitalize(s.blockedReason ?? 'permission'))} — open the session for details</span>`;

  const bodyLabel = ask?.isCommand ? 'Command' : 'Request';
  const detail = ask?.body
    ? `<div class="pdetail"><span class="plabel">${bodyLabel}</span><pre class="pcmd${ask.isCommand ? ' mono' : ''}">${esc(ask.body)}</pre></div>`
    : '';

  const always =
    pending && s.alwaysAllow
      ? `<button class="pbtn always" data-action="always" title="${esc(
          `Allow this and stop asking: adds ${s.alwaysAllow.rules.join(', ')} to ${s.alwaysAllow.destination}, exactly as Claude Code's own "don't ask again" would.`,
        )}">Always allow</button>`
      : '';
  const questionBody = question ? questionStepper(s.key, question.requestId, question.questions) : undefined;
  const buttons = questionBody ?? (pending
    ? `<div class="pbtns">
      <button class="pbtn allow" data-action="allow" title="Allow this once, as if you had clicked Allow in Claude Code">Allow</button>
      ${always}
      <button class="pbtn deny" data-action="deny" title="Deny, as if you had clicked Deny in Claude Code">Deny</button>
    </div>`
    : // No buttons: either this was answered in Claude Code already, or it is a
      // tool that only the session itself can answer (a question, a plan).
      '<div class="pnote">Answer this in the session.</div>');

  return `<tr class="permrow${open ? ' open' : ''}${pending ? ' pending' : ''}" data-key="${esc(s.key)}" data-request="${esc(question?.requestId ?? s.permissionRequestId ?? '')}">
  <td class="c-perm" colspan="${span}">
    <button class="ptoggle" data-perm="toggle" aria-expanded="${open}" title="${open ? 'Hide the details' : 'Show the command and the buttons'}"><span class="ptw" aria-hidden="true">${open ? '▾' : '▸'}</span>${header}</button>
    <div class="pslide"><div class="pinner">${detail}${buttons}</div></div>
  </td>
</tr>`;
}

/**
 * Copy what is on screen for the current question back into its draft. Called
 * on every keystroke and tick, not just on Next: `paint()` replaces `#app`
 * wholesale and a snapshot lands every couple of seconds, so a choice that
 * lives only in the DOM is gone before the user reaches the last question.
 */
function saveQuestionDraft(stepper: HTMLElement): QuestionDraft | undefined {
  const draft = questionDrafts.get(stepper.dataset.draft ?? '');
  if (!draft) return undefined;
  const step = Number(stepper.dataset.step);
  draft.selected[step] = Array.from(stepper.querySelectorAll<HTMLInputElement>('input[data-qchoice]:checked')).map(
    (input) => input.value,
  );
  draft.other[step] = stepper.querySelector<HTMLInputElement>('.qother')?.value.trim() ?? '';
  return draft;
}

function questionStepper(key: string, requestId: string, questions: import('../../shared/conversation').QuestionView[]): string {
  if (questions.length === 0) return '<div class="pnote">Open the session to answer this question.</div>';
  const draftKey = `${key}\n${requestId}`;
  const draft = questionDrafts.get(draftKey) ?? { step: 0, selected: {}, other: {} };
  draft.step = Math.min(draft.step, questions.length - 1);
  questionDrafts.set(draftKey, draft);
  const q = questions[draft.step];
  const selected = draft.selected[draft.step] ?? [];
  const type = q.multiSelect ? 'checkbox' : 'radio';
  const inputName = `dashq:${requestId}:${draft.step}`;
  const options = q.options.map((option) => `<label class="qchoice" title="${esc(option.description)}">
    <input type="${type}" name="${esc(inputName)}" data-qchoice value="${esc(option.label)}"${selected.includes(option.label) ? ' checked' : ''}>
    <span><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span>
  </label>`).join('');
  return `<div class="qstep" data-draft="${esc(draftKey)}" data-step="${draft.step}" data-multi="${q.multiSelect === true}">
    <div class="qprogress">Question ${draft.step + 1} of ${questions.length}${q.header ? ` · ${esc(q.header)}` : ''}</div>
    <div class="qprompt">${esc(q.question)}</div>
    <div class="qchoices">${options}<input class="qother" value="${esc(draft.other[draft.step] ?? '')}" placeholder="Other…" aria-label="Other answer"></div>
    <div class="qnav">${draft.step > 0 ? '<button class="pbtn" data-qnav="back">Back</button>' : ''}<span></span><button class="pbtn allow" data-qnav="${draft.step + 1 === questions.length ? 'answer' : 'next'}">${draft.step + 1 === questions.length ? 'Answer' : 'Next'}</button></div>
  </div>`;
}

/**
 * The ETA column. Busy rows with a watched turn get a countdown against this
 * user's own turn history (see `etaText`), coloured by how far past typical the
 * turn has run. Busy rows without one show a dash that says why in its tooltip,
 * so an empty cell never reads as "nothing to estimate". Other statuses have no
 * turn in flight and stay blank.
 */
function etaCell(s: SessionDTO): string {
  if (s.status !== 'busy') return '<td class="c-eta"></td>';

  const p = s.progress;
  if (!p?.pace) {
    const why = s.statusIsEstimated
      ? 'No estimate: this session started before the status hooks were installed. Restart it for one.'
      : 'No estimate: this turn began before the dashboard was watching, so its age is unknown.';
    return `<td class="c-eta none" title="${esc(why)}">—</td>`;
  }

  const { p50Ms, p90Ms, band, provisional } = p.pace;
  const text = etaText(workingElapsedMs(p, Date.now()), p50Ms, p90Ms);
  return `<td class="c-eta ${band}${provisional ? ' prov' : ''}" data-eta="${p.startedAtMs},${p.blockedMs},${p50Ms},${p90Ms}">${text}</td>`;
}

/**
 * The turn block of the row tooltip: elapsed working time, evidence that work is
 * happening, and the closest thing to a remaining estimate the data supports —
 * when most turns are done by, phrased as the comparison it actually is.
 */
function progressTooltip(s: SessionDTO): string {
  const p = s.progress;
  if (!p) return '';

  const elapsed = workingElapsedMs(p, Date.now());
  const lines = [`Turn: ${formatDuration(elapsed)} of work, ${p.toolCalls} tool call${p.toolCalls === 1 ? '' : 's'}`];
  if (p.blockedMs > 0) lines.push(`(plus ${formatDuration(p.blockedMs)} waiting on you, not counted)`);
  if (p.todo) {
    lines.push(`Checklist: ${p.todo.completed} of ${p.todo.total} done${p.todo.active ? ` — ${p.todo.active}` : ''}`);
  }

  const pace = p.pace;
  if (pace) {
    const basis = pace.provisional
      ? 'typical timings (still learning yours)'
      : `your last ${pace.samples} turns`;
    if (elapsed >= pace.p90Ms) {
      lines.push(
        `Pace: past the 90th percentile of ${basis} (${formatDuration(pace.p90Ms)}). No estimate left to give — it may be a long one, or it may be wedged.`,
      );
    } else if (elapsed < pace.p50Ms) {
      lines.push(
        `Pace: typical so far, against ${basis}. Half finish within ${formatDuration(pace.p50Ms)} — ${formatDuration(pace.p50Ms - elapsed)} from now; 9 in 10 within ${formatDuration(pace.p90Ms)}.`,
      );
    } else {
      const outran = elapsed >= pace.p75Ms ? 'longer than 3 in 4' : 'longer than half';
      lines.push(
        `Pace: ${outran} of ${basis}. 9 in 10 finish within ${formatDuration(pace.p90Ms)} — ${formatDuration(pace.p90Ms - elapsed)} from now.`,
      );
    }
  }
  return `\n\n${lines.join('\n')}`;
}

function rowTitle(s: SessionDTO): string {
  const hint = clickHint(s);
  // Pin and archive used to be buttons on the row and are now in the menu, so
  // the tooltip is what carries the discovery — nothing else on the row hints
  // that a right-click does anything.
  const more = '\nRight-click to pin, rename, archive and more.';
  // The row shows the nickname instead of the title, so this is the only place
  // the name it came with is still readable.
  const renamed = s.nickname ? `\n\nRenamed by you. Its own title is "${s.title}".` : '';
  const est =
    s.statusIsEstimated && s.status !== 'ended'
      ? '\n\nStatus is estimated from the transcript — this session started before hooks were installed. Restart it for exact status.'
      : '';
  // A paused session is silent for a reason we know, so it says the reason
  // rather than the two paragraphs below — both of which describe a session
  // that stopped on its own, which is exactly what this one did not do.
  //
  // It does not name the status it was paused at. Status is derived from
  // transcript activity, and a paused process makes none, so a session frozen
  // while Busy is relabelled Possibly stuck a few minutes later — the tooltip
  // would then confidently report a status the session never had.
  const paused = s.paused
    ? '\n\nPaused: its process is stopped, so it is spending nothing and its status has stopped moving. Resume it from the row menu or the bar button and it carries on from exactly where it was.'
    : '';
  // "Stuck" is a silence, and generation is silent too; say so where the label
  // is read, so a red row prompts a look rather than a restart.
  const stuck =
    s.status === 'stuck' && !s.paused
      ? `\n\nNo transcript or hook activity for ${formatAge(Date.now(), s.lastActivityAt)}. A long think or a large file write is silent like this too — check the session before assuming it is wedged.`
      : '';
  // Done vs Waiting is read off the reply text; say so, since it is a judgment.
  const done =
    s.status === 'done'
      ? '\n\nFinished its turn without asking you anything — the last message reads as a report. Waiting would mean it ended on a question or a choice.'
      : '';
  return `${hint}${more}${renamed}${est}${paused}${stuck}${done}${progressTooltip(s)}`;
}

/** Branch, minus the detached-HEAD placeholder, which names nothing. */
function branchText(s: SessionDTO): string {
  return s.gitBranch && s.gitBranch !== 'HEAD' ? esc(s.gitBranch) : '';
}

/** Unescaped — the caller escapes it as a tooltip. */
function worktreeTitle(s: SessionDTO): string {
  return `Linked git worktree${s.worktreePath ? `\n${s.worktreePath}` : ''}`;
}

function prHtml(s: SessionDTO): string {
  return s.prLink
    ? `<span class="pr" role="link" data-url="${esc(s.prLink.prUrl)}" title="${esc(s.prLink.prUrl)}">#${s.prLink.prNumber}</span>`
    : '';
}

/**
 * One renderer per configurable column, each returning a whole `<td>` so a
 * column that is switched off costs nothing at all — no zero-width cell, no
 * hidden text. The dot, Agent and action columns are not in here: they are the
 * table itself rather than columns the user chooses.
 */
const CELL: Record<ColumnId, (s: SessionDTO) => string> = {
  proj: (s) => `<td class="c-proj"${s.cwd ? ` title="${esc(s.cwd)}"` : ''}>${esc(s.projectName ?? '')}</td>`,
  worktree: (s) =>
    s.worktree === undefined
      ? '<td class="c-worktree"></td>'
      : `<td class="c-worktree" title="${esc(worktreeTitle(s))}">${esc(s.worktree)}</td>`,
  branch: (s) => {
    const b = branchText(s);
    return `<td class="c-branch"${b ? ` title="${b}"` : ''}>${b}</td>`;
  },
  // The wire id is the tooltip: the cell shortens "claude-opus-5" to "Opus 5",
  // and the shortening is a guess worth being able to check.
  model: (s) => {
    const label = modelLabel(s.model);
    return label === undefined
      ? '<td class="c-model"></td>'
      : `<td class="c-model" title="${esc(s.model ?? label)}">${esc(label)}</td>`;
  },
  subagents: (s) => {
    const text = subagentText(s.subagents);
    const title = text ? `${text}. Estimated from recent worker transcripts, including nested workers; excludes guardian reviews.` : '';
    return `<td class="c-subagents" title="${esc(title)}">${esc(text)}</td>`;
  },
  pr: (s) => `<td class="c-pr">${prHtml(s)}</td>`,
  eta: etaCell,
  age: ageCell,
};

/**
 * How old the *conversation* is — time since its first prompt, across however
 * many processes and resumes it has taken since.
 *
 * It used to count from the last activity, which answered a question the table
 * already answers twice over: a busy row has its tool's elapsed time and an ETA,
 * and an idle row's silence is the whole point of it being idle. "How long has
 * this been going" is the thing nothing else says, and it is what decides
 * whether an agent has been at one task all morning.
 *
 * The fallbacks are ordered by how close they get to that meaning: the
 * transcript's birth time is exact; the registry's `startedAt` is this
 * *process*, which for a resumed session is too late but never too early; and
 * last activity is what is left when there is no transcript at all. The tooltip
 * says which one it is rather than presenting a guess as a fact.
 */
function ageCell(s: SessionDTO): string {
  const now = Date.now();
  const since = s.conversationStartedAt ?? s.startedAt ?? s.lastActivityAt;
  const lastSeen = `last activity ${formatAge(now, s.lastActivityAt)} ago`;
  const title =
    s.conversationStartedAt !== undefined
      ? `Conversation started ${formatAge(now, since)} ago · ${lastSeen}`
      : s.startedAt !== undefined
        ? `This process started ${formatAge(now, since)} ago — the conversation itself may be older · ${lastSeen}`
        : `No start time known, so this is ${lastSeen}`;
  return `<td class="c-age" title="${esc(title)}" data-age-ts="${since}">${formatAge(now, since)}</td>`;
}

function rowHtml(s: SessionDTO, span: number): string {
  // A nickname replaces the whole line, registry handle included: the point of
  // naming something is that the name is what you see. The title it came with
  // is not lost — it moves to the row's tooltip.
  const titleLine = s.nickname
    ? esc(s.nickname)
    : s.name && s.title !== s.name
      ? `<span class="nm">${esc(s.name)}</span><span class="sep">·</span>${esc(s.title)}`
      : esc(s.title);
  const kindChip =
    s.kind && s.kind !== 'interactive' ? `<span class="chip kind">${esc(capitalize(s.kind))}</span>` : '';
  const providerChip = `<span class="chip provider ${esc(s.provider)}" title="${esc(s.client ? `${capitalize(s.provider)} · ${s.client}` : capitalize(s.provider))}">${s.provider === 'codex' ? 'Codex' : 'Claude'}</span>`;

  // Anything without a column of its own right now — switched off, or folded
  // away by a narrow dock — rides on the row's second line instead, so hiding a
  // column costs the space it took and not the fact it carried.
  const shown = new Set(cols().map((c) => c.id));
  const meta = [
    shown.has('proj') ? '' : s.projectName ? esc(s.projectName) : '',
    // Folded, the two are bare words with nothing to tell them apart, and a
    // session sitting at the root of its worktree would print the same name
    // twice. In the columns they keep their headers, so both stay.
    shown.has('worktree') || s.worktree === s.projectName ? '' : esc(s.worktree ?? ''),
    shown.has('branch') ? '' : branchText(s),
    shown.has('model') ? '' : esc(modelLabel(s.model) ?? ''),
    shown.has('pr') ? '' : prHtml(s),
    shown.has('subagents') ? '' : esc(subagentText(s.subagents)),
  ]
    .filter(Boolean)
    .join('<span class="sep">·</span>');
  const secondLine = meta ? `<div class="sub"><span class="meta">${meta}</span></div>` : '';

  const est = s.statusIsEstimated && s.status !== 'ended' ? ' est' : '';
  return `<tr class="row st-${s.status}${s.archived ? ' archived' : ''}${s.paused ? ' paused' : ''}${est}" data-key="${esc(s.key)}" title="${esc(rowTitle(s))}">
  <td class="c-dot"><span class="dot" aria-hidden="true"></span></td>
  <td class="c-agent"><div class="agent">
    <div class="title"><span class="ttl">${titleLine}</span><span class="chips">${providerChip}${pausedChip(s)}${kindChip}${statusChip(s)}</span></div>
    ${secondLine}
  </div></td>
  ${cols()
    .map((c) => CELL[c.id](s))
    .join('')}
  <td class="c-act"></td>
</tr>${permissionRow(s, span)}`;
}

/**
 * Hook status, when it needs saying: hooks absent/stale/disabled (all status is
 * a guess), or installed while some live sessions still predate the install.
 */
function bannerHtml(): string {
  if (providerFilter === 'codex') return '';
  const estimatedLive = sessions.filter((s) => s.provider === 'claude' && s.status !== 'ended' && s.statusIsEstimated && !s.archived).length;
  const b = hookBanner(hooks, estimatedLive);
  if (!b) return '';
  if (b.dismissible && bannerDismissed === hooks?.kind) return '';
  const action = b.action
    ? `<button class="bact" data-banner="install">${b.action === 'update' ? 'Update hooks' : 'Install hooks'}</button>`
    : '';
  const close = b.dismissible ? `<button class="bx" data-banner="dismiss" title="Hide">×</button>` : '';
  return `<div class="banner ${b.tone}" role="status"><span class="txt">${esc(b.text)}</span>${action}${close}</div>`;
}

// ---- plan usage cards ----

/** "Thu 8:20 AM" — the absolute reset time, for the tooltip; the card itself shows the countdown. */
function resetsAtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** "8:20 AM" — the compact local clock time shown beside the five-hour countdown. */
function resetsAtLocalTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function usageResetText(w: UsageWindow, nowMs: number): string {
  const countdown = resetsInText(nowMs, w.resetsAtMs);
  if (!countdown || w.resetsAtMs === undefined) return countdown;
  const isFiveHourSession = w.id === 'session' || /(?:^|\s)5\s*hr(?:$|\s)/i.test(w.label);
  return isFiveHourSession ? `${countdown} (${resetsAtLocalTime(w.resetsAtMs)})` : countdown;
}

function usageCardTitle(w: UsageWindow, snap: UsageSnapshot, provider: 'Claude' | 'Codex'): string {
  const lines = [`${w.label}: ${Math.round(w.percent)}% of the limit used.`];
  if (w.resetsAtMs !== undefined) {
    lines.push(`Resets ${resetsAtClock(w.resetsAtMs)} (${resetsInText(Date.now(), w.resetsAtMs).toLowerCase()}).`);
  }
  if (w.active) lines.push('This is the window currently constraining requests.');
  lines.push(`Read ${formatAge(Date.now(), snap.fetchedAtMs)} ago from ${provider}.`);
  return lines.join('\n');
}

function usageCardHtml(w: UsageWindow, snap: UsageSnapshot, provider: 'Claude' | 'Codex', prefix: boolean): string {
  const pct = Math.round(w.percent);
  const sev = usageSeverity(w.percent);
  const resets =
    w.resetsAtMs !== undefined
      ? `<span class="ureset" data-resets-at="${w.resetsAtMs}"${w.id === 'session' || /(?:^|\s)5\s*hr(?:$|\s)/i.test(w.label) ? ' data-five-hour="true"' : ''}>${esc(usageResetText(w, Date.now()))}</span>`
      : '<span class="ureset"></span>';
  const label = prefix ? `${provider} · ${w.label}` : w.label;
  return `<div class="ucard ${sev}${w.active ? ' active' : ''}" title="${esc(usageCardTitle(w, snap, provider))}">
  <div class="uhead"><span class="ulabel">${esc(label)}</span><span class="upct">${pct}%</span></div>
  <div class="ubar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(w.label)}"><span class="ufill" data-w="${pct}%"></span></div>
  ${resets}
</div>`;
}

/** The extra-usage card: only once credits have actually been spent, so an idle $0 does not take a slot. */
function spendCardHtml(snap: UsageSnapshot): string {
  const s = snap.spend;
  if (!s || s.usedMinor <= 0) return '';
  const pct = Math.round(s.percent);
  const sev = usageSeverity(s.percent);
  const title = `Extra usage: ${spendText(s)} of credits spent this month (${pct}%). These cover you past the plan limits.`;
  return `<div class="ucard ${sev}" title="${esc(title)}">
  <div class="uhead"><span class="ulabel">Extra usage</span><span class="upct">${pct}%</span></div>
  <div class="ubar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Extra usage"><span class="ufill" data-w="${pct}%"></span></div>
  <span class="ureset">${esc(spendText(s))}</span>
</div>`;
}

/**
 * The strip above the table: one card per rate-limit window, so "where am I
 * this week" is answered at the same glance as "who is waiting on me". The
 * host omits `usage` entirely when the cards are turned off. The last good
 * read stays up, unmarked, through a failed refresh: the service repolls on
 * its own, and an old number beats a blank or a warning when the question is
 * whether the weekly limit is close. There is no refresh button: the palette
 * command "Refresh" forces a read for anyone who wants one now.
 */
function providerUsageErrorText(error: UsageError, provider: 'Claude' | 'Codex'): string {
  if (provider === 'Claude') return usageErrorText(error);
  if (error.kind === 'no-credentials') return 'No Codex login found on this machine, so plan usage is unavailable.';
  if (error.kind === 'rate-limited') return 'Codex is rate-limiting usage reads right now. Showing the last numbers.';
  return `Could not read Codex plan usage${error.detail ? ` (${error.detail})` : ''}.`;
}

function providerUsageHtml(state: UsageState | undefined, provider: 'Claude' | 'Codex', prefix: boolean): string {
  if (!state) return '';
  const { last, error } = state;

  if (!last) {
    const text = error ? providerUsageErrorText(error, provider) : `Reading ${provider} plan usage…`;
    return `<div class="usage${error ? ' err' : ''}" role="status"><span class="unote">${esc(text)}</span></div>`;
  }

  const cards = last.windows.map((w) => usageCardHtml(w, last, provider, prefix)).join('')
    + (provider === 'Claude' ? spendCardHtml(last) : '');
  return `<div class="usage" role="region" aria-label="${provider} plan usage">${cards}</div>`;
}

function usageHtml(): string {
  if (providerFilter === 'claude') return providerUsageHtml(usage, 'Claude', false);
  if (providerFilter === 'codex') return providerUsageHtml(codexUsage, 'Codex', false);
  return providerUsageHtml(usage, 'Claude', true) + providerUsageHtml(codexUsage, 'Codex', true);
}

/**
 * The cards live OUTSIDE `#app`, like the launcher bar and for the same two
 * reasons. `render()` replaces `#app` wholesale, and — the point of moving them
 * here — `#app` is the element that scrolls: anything inside it slides away
 * once the list is longer than the dock is tall. "How much week do I have left"
 * is asked while looking at the busy rows at the bottom of the list, so the
 * answer has to stay on screen with them.
 */
const usageEl = document.createElement('div');
usageEl.id = 'usage';
app.insertAdjacentElement('beforebegin', usageEl);

/** The strip currently drawn, so a snapshot that changes nothing leaves the bars' transition alone. */
let usagePainted = '';

function renderUsage(): void {
  const html = usageHtml();
  if (html === usagePainted) return;
  usagePainted = html;
  usageEl.innerHTML = html;
  applyStyles(usageEl); // the bars' widths ride in `data-w`; see paint()
}

// ---- column header, resize handles, picker ----

/**
 * The header row. Widths ride on the cells as data (`paint` puts them into the
 * CSSOM) rather than as style, because they are data: a width the user dragged
 * has to survive every re-render and reach the other dashboard unchanged. Each
 * header carries a grab handle on its LEFT edge — the divider it shares with
 * the column before it, which is both the thing the eye aims at and the edge
 * that moves when that column is resized.
 */
function headHtml(): string {
  const ths = cols()
    .map((c) => {
      const w = columnWidth(columns, c);
      const title = c.title ? ` title="${esc(c.title)}"` : '';
      return `<th class="h-${c.id}" data-col="${c.id}" data-w="${w}px"${title}><span class="rz" data-rz="${c.id}"></span>${esc(c.label)}</th>`;
    })
    .join('');
  return `<thead><tr>
  <th class="h-dot"></th><th class="h-agent" title="Takes whatever width the other columns leave. Drag a divider to resize the column to its right.">Agent</th>${ths}<th class="h-act"><button class="colcfg" data-cols="menu" title="Choose columns">${ICON_COLUMNS}</button></th>
</tr></thead>`;
}

/**
 * The column picker. Rendered as part of the table's own HTML rather than as a
 * detached popup, so a snapshot arriving while it is open cannot yank it out
 * from under the pointer. Pinned to the click's y so it opens where it was
 * asked for, whatever the dashboard is scrolled to.
 */
function menuHtml(): string {
  if (!menuPosition) return '';
  const rows = COLUMNS.map((c) => {
    const hidden = isHidden(columns, c.id);
    const folded = !hidden && narrow && c.foldsWhenNarrow;
    const note = folded ? '<span class="cmnote">too narrow</span>' : '';
    return `<label class="cmrow"><input type="checkbox" data-col="${c.id}"${hidden ? '' : ' checked'}>${esc(c.label)}${note}</label>`;
  }).join('');
  return `<div class="colmenu" data-top="${menuPosition.top}px" data-left="${menuPosition.left}px" role="menu">
  <div class="cmhead">Columns</div>
  ${rows}
  <button class="cmreset" data-cols="reset">Reset widths</button>
  <div class="cmhead">Codex sessions</div>
  <label class="cmrow"><input type="checkbox" data-codex-subagents${showCodexSubagents ? ' checked' : ''}>Show internal/subagent sessions</label>
</div>`;
}

// ---- launcher ----

/**
 * The project dropdown and its New button live OUTSIDE `#app`, which `render()`
 * replaces wholesale on every snapshot. Inside it, an open dropdown would be
 * torn out from under the pointer every time any session changed status — which
 * on a busy machine is every couple of seconds.
 */
const bar = document.createElement('div');
bar.id = 'bar';
// A <select> cannot carry a per-row button: an <option> renders as text and
// nothing else. So the dropdown is a popup of real rows — the folder on the
// left, the X that stops offering it on the right.
// The bar has two halves with opposite jobs. On the left, starting work: the
// folder and the button that spawns an agent in it, wrapped together because
// they are one control in two pieces — pick where, then go. On the right, the
// controls that act on everything already running, a group that begins with the
// pause button and is where anything fleet-wide belongs later.
//
// The two halves are held apart by the left one's `margin-right: auto` rather
// than by the folder button growing to fill the bar, which is what it used to
// do: in a full-width window that stretched one dropdown across two thousand
// pixels and crammed everything else against the right edge.
//
// `#projmenu` stays a direct child: it is positioned against `#bar`, which is
// the only positioned ancestor, and moving it inside the group would anchor it
// to a box that shrinks.
bar.innerHTML = `<div class="launch"><button id="proj" class="projbtn" aria-haspopup="listbox" aria-expanded="false"><span id="projname"></span><span class="chev" aria-hidden="true">▾</span></button>
<select id="launchmodel" class="launchsel" title="Model for the next conversation"></select>
<select id="launcheffort" class="launchsel" title="How hard Claude thinks, for the next conversation"></select>
<button id="new" class="newbtn" title="Start a Claude Code conversation in this folder, running in this window">+ New</button></div>
<div id="ctl" class="ctlgroup"><select id="provider" class="providerfilter" title="Filter sessions by provider"><option value="all">All</option><option value="claude">Claude</option><option value="codex">Codex</option></select><button id="discord" class="ctlbtn discordbtn" hidden aria-pressed="false"></button><button id="pauseall" class="ctlbtn"></button></div>
<div id="projmenu" class="projmenu" role="listbox" hidden></div>`;
// First in the body, above the usage strip, which is itself above the scrolling
// `#app` — the three are a flex column, so only the last one moves.
document.body.insertAdjacentElement('afterbegin', bar);

const projBtn = bar.querySelector<HTMLButtonElement>('#proj')!;
const projName = bar.querySelector<HTMLElement>('#projname')!;
const projMenu = bar.querySelector<HTMLElement>('#projmenu')!;
const newBtn = bar.querySelector<HTMLButtonElement>('#new')!;
const launchModel = bar.querySelector<HTMLSelectElement>('#launchmodel')!;
const launchEffort = bar.querySelector<HTMLSelectElement>('#launcheffort')!;

/**
 * The two dropdowns beside "+ New": what the *next* conversation starts on.
 *
 * They are settings, not session state — there is no session yet — so a change
 * writes `runner.model` / `runner.effort` and comes back on the next snapshot.
 * The model list is whatever the last conversation reported (the launcher has
 * no running CLI to ask), which is why "Default" is always offered: it means
 * "whatever Claude Code picks", and it is the right answer when the list is
 * empty or out of date.
 *
 * Effort levels follow the chosen model, the same rule the composer uses — a
 * model that has none hides the dropdown rather than offering a level it would
 * ignore. With no model chosen there is nothing to ask, so the setting's own
 * range is offered instead.
 */
const EFFORT_FALLBACK: Record<LaunchProvider, string[]> = {
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh'],
};

/**
 * What Claude Code falls back to when no effort is set.
 *
 * Named in the label rather than left as a bare "Default" so the row reads like
 * the model's — "Default (Sonnet 4.5)" answers *which* model the default is,
 * and this answers the same question. It is the level the Agent SDK documents
 * as its default and the one the CLI's own 4.6 migration note quotes; it is not
 * reported per-session by anything we can ask, so unlike the model's label this
 * one is a constant and would need changing if that ever did.
 */
const EFFORT_DEFAULT: Record<LaunchProvider, string> = { anthropic: 'high', openai: 'medium' };

function fillSelect(el: HTMLSelectElement, rows: { value: string; label: string }[], current: string): void {
  const key = rows.map((r) => `${r.value}\u0000${r.label}`).join('\u0001');
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.textContent = '';
    for (const row of rows) {
      const opt = document.createElement('option');
      opt.value = row.value;
      opt.textContent = row.label;
      el.appendChild(opt);
    }
  }
  // A stored value the list no longer contains would silently select row zero
  // and misreport what the next conversation will do.
  el.value = rows.some((r) => r.value === current) ? current : '';
}

type LaunchProvider = 'anthropic' | 'openai';
type LauncherState = {
  models: ModelChoice[];
  provider: LaunchProvider;
  anthropic: { model: string; effort: string };
  openai: { model: string; effort: string };
};
let launchProvider: LaunchProvider = 'anthropic';

function modelValue(provider: LaunchProvider, model: string): string {
  return `${provider}:${model}`;
}

function renderLaunchDefaults(launcher: LauncherState): void {
  launchProvider = launcher.provider;
  const models = launcher.models;
  // The CLI's list has a default row of its own, already labelled with the
  // model it resolves to. Its label is borrowed for the unset row and the row
  // itself dropped, so there is one "Default (Sonnet 4.5)" rather than two
  // entries that mean the same thing.
  const key = JSON.stringify(models.map((m) => [m.provider, m.value, m.label]));
  if (launchModel.dataset.key !== key) {
    launchModel.dataset.key = key;
    launchModel.textContent = '';
    for (const provider of ['openai', 'anthropic'] as const) {
      const group = document.createElement('optgroup');
      group.label = provider === 'openai' ? 'OpenAI' : 'Anthropic';
      const providerModels = models.filter((m) => (m.provider ?? 'anthropic') === provider);
      const advertisedDefault = providerModels.find((m) => m.value === 'default');
      const choices = [
        { value: '', label: advertisedDefault?.label ?? 'Default model' },
        ...providerModels.filter((m) => m !== advertisedDefault).map((m) => ({ value: m.value, label: m.label })),
      ];
      for (const choice of choices) {
        const option = document.createElement('option');
        option.value = modelValue(provider, choice.value);
        option.textContent = choice.label;
        group.appendChild(option);
      }
      launchModel.appendChild(group);
    }
  }
  const selected = launcher[launchProvider];
  launchModel.value = modelValue(launchProvider, selected.model);
  // Shown even when the catalog is empty — which it is until the first
  // conversation reports one. A control that appears out of nowhere later is
  // worse than one that says Default and means it.
  launchModel.hidden = false;

  const chosen = models.find((m) => (m.provider ?? 'anthropic') === launchProvider && m.value === selected.model);
  const levels = selected.model === '' ? EFFORT_FALLBACK[launchProvider] : chosen?.effortLevels ?? [];
  fillSelect(
    launchEffort,
    [{ value: '', label: `Default (${capitalize(EFFORT_DEFAULT[launchProvider])})` }, ...levels.map((l) => ({ value: l, label: capitalize(l) }))],
    selected.effort,
  );
  launchEffort.hidden = levels.length === 0;
}

launchModel.addEventListener('change', () => {
  const split = launchModel.value.indexOf(':');
  launchProvider = launchModel.value.slice(0, split) as LaunchProvider;
  post({ type: 'setRunnerModel', provider: launchProvider, model: launchModel.value.slice(split + 1) });
});
launchEffort.addEventListener('change', () => post({ type: 'setRunnerEffort', provider: launchProvider, effort: launchEffort.value }));
const pauseBtn = bar.querySelector<HTMLButtonElement>('#pauseall')!;
const discordBtn = bar.querySelector<HTMLButtonElement>('#discord')!;
const providerSelect = bar.querySelector<HTMLSelectElement>('#provider')!;
providerSelect.value = providerFilter;
providerSelect.addEventListener('change', () => {
  providerFilter = providerSelect.value as typeof providerFilter;
  saveState();
  render();
});

let projects: ProjectDTO[] = [];
let menuOpen = false;

/**
 * The folder New will use: the saved one while it still exists, else Global.
 *
 * Global rather than "the most recent folder" because a launcher that defaults
 * to a project starts work *in* that project by accident — the first click of
 * the session has already picked a repo. Global belongs to nothing, so the
 * wrong default costs nothing; picking a folder is an explicit act.
 */
function currentProject(): string {
  if (project && (project === GLOBAL_PROJECT_DIR || projects.some((p) => p.dir === project))) return project;
  return GLOBAL_PROJECT_DIR;
}

const GLOBAL_TITLE = 'No project — runs in a scratch folder of its own';

function renderLauncher(): void {
  const cur = currentProject();
  const global = cur === GLOBAL_PROJECT_DIR;
  projName.textContent = global ? 'Global' : (projects.find((p) => p.dir === cur)?.name ?? cur);
  projBtn.title = global ? GLOBAL_TITLE : cur;
  newBtn.disabled = false;
  const starts = launchProvider === 'openai' ? 'Codex' : 'Claude Code';
  newBtn.title = global
    ? `Start a ${starts} conversation with no project, running in this window`
    : `Start a ${starts} conversation in this folder, running in this window`;
  // An open menu is showing the list that just changed, so redraw it in place
  // rather than closing it out from under the pointer.
  if (menuOpen) renderMenu();
}

function renderMenu(): void {
  const cur = currentProject();
  const rows = projects
    .map(
      (p) => `<div class="pmrow${p.dir === cur ? ' on' : ''}">
<button class="pmname" data-dir="${esc(p.dir)}" role="option" aria-selected="${p.dir === cur}" title="${esc(p.dir)}">${esc(p.name)}</button>
<button class="pmx" data-rm="${esc(p.dir)}" title="Remove ${esc(p.name)} from this list. Browsing to it again brings it back." aria-label="Remove ${esc(p.name)} from this list">✕</button>
</div>`,
    )
    .join('');
  const empty = projects.length === 0 ? '<div class="pmempty">No folders yet</div>' : '';
  // First, and never removable: it is the default, and it is the one row that
  // is always a valid answer even on a machine with no projects at all.
  const globalRow = `<div class="pmrow${cur === GLOBAL_PROJECT_DIR ? ' on' : ''}">
<button class="pmname" data-dir="${esc(GLOBAL_PROJECT_DIR)}" role="option" aria-selected="${cur === GLOBAL_PROJECT_DIR}" title="${esc(GLOBAL_TITLE)}">Global</button>
<span class="pmx" aria-hidden="true"></span>
</div>`;
  // Browse is always present: with nothing in the list it is the only way in,
  // and it is also the only way a removed folder comes back.
  projMenu.innerHTML = `${globalRow}${empty}${rows}<button class="pmbrowse" data-browse="1">Browse…</button>`;
}

function openProjMenu(): void {
  menuOpen = true;
  projMenu.hidden = false;
  projBtn.setAttribute('aria-expanded', 'true');
  renderMenu();
  // A folder may have been used in another window since the last scan. The
  // answer arrives as a snapshot and redraws the menu under the pointer.
  post({ type: 'refreshProjects' });
}

function closeProjMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  projMenu.hidden = true;
  projBtn.setAttribute('aria-expanded', 'false');
}

projBtn.addEventListener('click', () => {
  if (menuOpen) closeProjMenu();
  else openProjMenu();
});

projMenu.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  const rm = target.closest<HTMLElement>('[data-rm]');
  if (rm) {
    // The menu stays open: clearing three stale folders should be three clicks,
    // not three round trips through opening it again.
    post({ type: 'removeProject', dir: rm.dataset.rm! });
    return;
  }
  if (target.closest('[data-browse]')) {
    closeProjMenu();
    post({ type: 'browseProject' });
    return;
  }
  const pick = target.closest<HTMLElement>('[data-dir]');
  if (pick) {
    project = pick.dataset.dir!;
    saveState();
    closeProjMenu();
    renderLauncher();
    projBtn.focus();
  }
});

// Anywhere outside dismisses, the way a dropdown does. Capture, because the
// table's own click handler stops propagation on most of what it handles.
document.addEventListener(
  'click',
  (e) => {
    if (menuOpen && !bar.contains(e.target as Node)) closeProjMenu();
  },
  true,
);

newBtn.addEventListener('click', () => {
  post({ type: 'newConversation', cwd: currentProject(), provider: launchProvider === 'openai' ? 'codex' : 'claude' });
});

// ---- fleet controls ----

/**
 * The pause button is one button with two jobs, for the same reason the
 * composer's Send/Stop is: the thing to press is always the button in the same
 * place. Anything paused at all makes it *Resume*, because a half-frozen fleet
 * is a state you want one click to leave — and it carries the count, since the
 * rows that would tell you are usually scrolled away.
 */
function renderControls(): void {
  const paused = sessions.filter((s) => s.paused).length;
  const pausable = sessions.filter((s) => !s.paused && canPauseSession(s)).length;
  const resuming = paused > 0;
  pauseBtn.classList.toggle('on', resuming);
  // U+FE0E pins both glyphs to their text presentation: left alone, macOS
  // renders ▶ as a colour emoji, which is a different size from ⏸ beside it
  // and makes the button change width when it changes job.
  pauseBtn.textContent = resuming ? `▶︎ ${paused}` : '⏸︎';
  pauseBtn.disabled = !resuming && pausable === 0;
  pauseBtn.title = resuming
    ? `Resume ${paused} paused agent${paused === 1 ? '' : 's'}, from exactly where ${paused === 1 ? 'it' : 'they'} stopped`
    : pausable === 0
      ? 'Nothing is running to pause'
      : `Pause all ${pausable} running agent${pausable === 1 ? '' : 's'} on this machine, so they stop spending. Reversible.`;
  pauseBtn.setAttribute('aria-label', pauseBtn.title);
}

pauseBtn.addEventListener('click', () => {
  post({ type: 'pauseAll', pause: !sessions.some((s) => s.paused) });
});

/**
 * The Discord button: are announcements going out, or is the channel quiet.
 *
 * It only exists when the integration is configured — a mute switch for
 * something that was never switched on is a button that cannot do anything,
 * and the bar is short enough that an inert control is noise. Lit means
 * posting; unlit means nothing outbound at all — permission prompts included.
 * Prompts used to be exempt, on the grounds that muting one strands an agent;
 * in practice a button that reads "off" while the channel keeps filling up is
 * read as broken, so off is off. The prompt is still waiting in Agent Wrangler,
 * and turning the button back on republishes anything still open.
 *
 * The glyph is inline SVG rather than a background image: the CSP forbids
 * inline styles, and `currentColor` lets lit/unlit be the one colour rule that
 * every other button in the bar already uses.
 */
const DISCORD_MARK = `<svg class="dicon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.644-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z"/></svg>`;

function renderDiscord(): void {
  const configured = discord?.configured === true;
  discordBtn.hidden = !configured;
  if (!configured) return;
  const on = discord?.on === true;
  if (discordBtn.childElementCount === 0) discordBtn.innerHTML = DISCORD_MARK;
  discordBtn.classList.toggle('on', on);
  discordBtn.setAttribute('aria-pressed', String(on));
  discordBtn.title = on
    ? 'Posting to Discord: permission prompts, finished agents, auto-pause. Click to go quiet — open prompt cards are closed, and you answer them here instead.'
    : 'Discord is quiet — nothing is posted, including permission prompts. Click to start posting again.';
  discordBtn.setAttribute('aria-label', discordBtn.title);
}

discordBtn.addEventListener('click', () => {
  const next = !(discord?.on === true);
  // Answer the press now rather than waiting for the round trip: the host will
  // confirm with the next snapshot, and put this back if the write failed.
  discord = { configured: true, on: next };
  renderDiscord();
  post({ type: 'setDiscordNotifications', value: next });
});

// Before the first snapshot there is nothing to pause, and a blank button that
// still takes a click is worse than a disabled one that says so.
renderControls();

function render(): void {
  // A drag owns the widths until the pointer is released; re-rendering under it
  // would replace the <th> being dragged.
  if (dragging) {
    renderDeferred = true;
    return;
  }

  renderUsage();
  const visibleSessions = providerFilter === 'all' ? sessions : sessions.filter((s) => s.provider === providerFilter);
  if (visibleSessions.length === 0) {
    menuPosition = undefined; // no table, so no button to close the picker with
    rowMenu = undefined; // and no row for a menu to belong to
    paint(`${bannerHtml()}<div class="empty">No ${providerFilter === 'all' ? 'agent' : capitalize(providerFilter)} sessions found.
<div class="hint">Sessions are discovered from <code>~/.claude</code> and <code>~/.codex</code>. Start an agent session anywhere and it will appear here.</div></div>`);
    return;
  }

  // No <colgroup>: `table-layout: fixed` takes its columns from the first row,
  // so widths live on the header cells and a column that is switched off simply
  // is not rendered.
  const span = cols().length + 3; // dot + agent + data columns + actions
  let html = `${bannerHtml()}${menuHtml()}${rowMenuHtml()}<div class="tabletabs" role="tablist" aria-label="Conversation grouping"><button role="tab" aria-selected="${tableView === 'status'}" data-table-view="status">Status</button><button role="tab" aria-selected="${tableView === 'sections'}" data-table-view="sections">Sections</button></div><table>${headHtml()}`;

  const groups = new Map<string, SessionDTO[]>();
  for (const s of visibleSessions) {
    const group = tableView === 'status' ? sectionOf(s) : (s.conversationSection ?? UNCATEGORIZED_SECTION);
    const list = groups.get(group);
    if (list) list.push(s);
    else groups.set(group, [s]);
  }
  const groupOrder = tableView === 'status' ? SECTION_ORDER : conversationSections;
  for (const group of groupOrder) {
    const rows = groups.get(group) ?? [];
    if (tableView === 'status' && rows.length === 0) continue;
    // Newest first, except that a permission prompt outranks activity inside
    // the Waiting section: it is the one row in the table where the agent is
    // stopped until you press something, and burying it under a conversation
    // that merely asked a question would be the wrong way round.
    rows.sort((a, b) => {
      const blocked = Number(b.status === 'blocked') - Number(a.status === 'blocked');
      return blocked !== 0 ? blocked : b.lastActivityAt - a.lastActivityAt;
    });
    const collapseKey = tableView === 'status' ? group : `named:${group}`;
    const isCollapsed = collapsed.has(collapseKey);
    const label = tableView === 'status' ? SECTION_LABEL[group as SectionId] : group;
    const styleClass = tableView === 'status' ? ` st-${group}` : ' named';
    html += `<tbody class="grp${isCollapsed ? ' collapsed' : ''}" data-sec="${esc(collapseKey)}">
<tr class="sec${styleClass}"><td colspan="${span}"><span class="twist">${isCollapsed ? '▸' : '▾'}</span>${esc(label)}<span class="count">${rows.length}</span></td></tr>`;
    for (const s of rows) html += rowHtml(s, span);
    html += '</tbody>';
  }
  html += '</table>';
  paint(html);
}

vscodeApi.onMessage((body) => {
  const m = body as HostToDashboard;
  if (m.type === 'projectPicked') {
    project = m.dir;
    // The scan that will contain it is still running, and a selection with no
    // option to match would show as blank; carry it until the snapshot lands.
    if (!projects.some((p) => p.dir === m.dir)) {
      projects = [{ dir: m.dir, name: m.dir.split(/[\\/]/).filter(Boolean).pop() ?? m.dir }, ...projects];
    }
    saveState();
    renderLauncher();
    return;
  }
  if (m.type === 'snapshot') {
    sessions = m.sessions;
    conversationSections = m.conversationSections;
    if (m.projects) {
      projects = m.projects;
      renderLauncher();
    }
    // A card the user opened or closed is about one prompt. Once that session
    // is no longer blocked the override has outlived its subject, and the next
    // prompt should open by itself.
    for (const key of Array.from(permOverride.keys())) {
      if (!sessions.some((s) => s.key === key && s.status === 'blocked')) permOverride.delete(key);
    }
    // A menu whose row is gone draws nothing, so leaving it open would swallow
    // the next click as a dismissal of something invisible.
    if (rowMenu && !sessions.some((s) => s.key === rowMenu!.key)) rowMenu = undefined;
    hooks = m.hooks;
    usage = m.usage;
    codexUsage = m.codexUsage;
    // Our own drag already drew this; anything else is another dashboard's.
    if (m.columns) columns = m.columns;
    showCodexSubagents = m.showCodexSubagents === true;
    if (m.discord) discord = m.discord;
    if (m.launcher) {
      renderLaunchDefaults(m.launcher);
      renderLauncher();
    }
    // The bar lives outside #app, so `render()` never touches it.
    renderControls();
    renderDiscord();
    render();
  }
});

// ---- resizing ----

/**
 * Drag a divider. Exactly ONE column changes width: the one the handle belongs
 * to. The handle sits on that column's LEFT edge, so dragging left grows it and
 * dragging right shrinks it, and the elastic Agent column — which has no width
 * of its own and simply takes whatever the fixed columns leave — absorbs the
 * difference. Every other column keeps the width it had.
 *
 * Agent's floor is therefore the only ceiling on growing a column: `slack` is
 * how much it has left to give, measured when the drag starts. Without it a
 * drag would push the table wider than the dock and squeeze Agent to nothing.
 */
function beginResize(e: PointerEvent, handle: HTMLElement): void {
  const id = handle.dataset.rz as ColumnId;
  const th = handle.parentElement as HTMLTableCellElement | null;
  const def = cols().find((c) => c.id === id);
  if (!th || !def) return;

  const agentTh = app.querySelector('th.h-agent');
  const startX = e.clientX;
  const startW = th.getBoundingClientRect().width;
  const slack = agentTh ? agentTh.getBoundingClientRect().width - MIN_AGENT_WIDTH : 0;

  dragging = true;
  document.body.classList.add('resizing');
  handle.classList.add('dragging'); // only THIS divider lights up, not all of them
  handle.setPointerCapture(e.pointerId);
  e.preventDefault();

  let width = startW;

  const move = (ev: PointerEvent) => {
    width = clampResizeWidth(ev.clientX - startX, {
      startWidth: startW,
      minWidth: def.minWidth,
      slack,
    });
    th.style.width = `${width}px`;
  };

  let ended = false;
  const end = () => {
    if (ended) return; // pointerup and lostpointercapture both fire
    ended = true;
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    handle.removeEventListener('lostpointercapture', end);
    dragging = false;
    document.body.classList.remove('resizing');
    handle.classList.remove('dragging');

    saveColumns(withWidths(columns, { [id]: width }));

    if (renderDeferred) {
      renderDeferred = false;
      render();
    }
  };

  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // Belt and braces: a capture lost to a window switch must not leave the table
  // frozen mid-drag, refusing every snapshot from then on.
  handle.addEventListener('lostpointercapture', end);
}

app.addEventListener('pointerdown', (e) => {
  const handle = (e.target as HTMLElement).closest('.rz') as HTMLElement | null;
  if (handle) beginResize(e, handle);
});

// ---- column picker ----

function openMenu(button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const menuWidth = 230;
  menuPosition = {
    top: Math.max(4, Math.round(rect.bottom + 4)),
    left: Math.max(4, Math.round(Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 4))),
  };
  rowMenu = undefined; // one menu at a time, in both directions
  render();
}

function closeMenu(): void {
  if (!menuPosition) return;
  menuPosition = undefined;
  render();
}

// ---- row context menu ----

/** One menu at a time: opening this one closes the column picker and the launcher's. */
function openRowMenu(key: string, x: number, y: number): void {
  menuPosition = undefined;
  closeProjMenu();
  rowMenu = { key, x, y };
  render();
}

function closeRowMenu(): void {
  if (!rowMenu) return;
  rowMenu = undefined;
  render();
}

/** A checkbox in the picker: show or hide that column, everywhere, for good. */
app.addEventListener('change', (e) => {
  const box = (e.target as HTMLElement).closest('input[data-col]') as HTMLInputElement | null;
  if (!box) return;
  saveColumns(withHidden(columns, box.dataset.col as ColumnId, !box.checked));
  render(); // menu stays open: hiding two columns should take two clicks, not four
});

app.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement;

  // Right-click the header for the column menu, where a table's column menu lives.
  if (target.closest('thead')) {
    e.preventDefault();
    const button = app.querySelector<HTMLElement>('[data-cols="menu"]');
    if (button) openMenu(button);
    return;
  }
  // A permission card is a decision surface. Right-clicking it must not offer
  // to close the very session that is waiting on the answer.
  if (target.closest('tr.permrow')) return;

  const row = target.closest('tr.row') as HTMLElement | null;
  if (!row) return;
  e.preventDefault();
  openRowMenu(row.dataset.key!, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenu();
  closeRowMenu();
  if (menuOpen) {
    closeProjMenu();
    projBtn.focus(); // Escape should leave focus somewhere, not on a hidden row
  }
});

// Only the fold threshold matters here: widths are absolute and do not care how
// wide the dock is. A ResizeObserver rather than a window resize listener,
// because dragging the divider between the panes changes this width without the
// window changing size at all.
let lastNarrow = narrow;
const measure = () => {
  const width = app.clientWidth;
  if (width === 0) return; // hidden pane: keep the last real answer
  narrow = width < NARROW_PX;
  if (narrow !== lastNarrow) {
    lastNarrow = narrow;
    render();
  }
};
new ResizeObserver(measure).observe(app);
window.addEventListener('resize', measure);

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  // The row menu is checked first: while it is open it owns the next click,
  // whether that click picks an item or dismisses it. In particular a click on
  // a row must dismiss and stop there, rather than also opening that session.
  if (rowMenu) {
    if (target.closest('[data-add-to]')) {
      rowMenu.showSections = !rowMenu.showSections;
      render();
      e.stopPropagation();
      return;
    }
    const section = target.closest<HTMLElement>('[data-section]');
    if (section) {
      const key = rowMenu.key;
      const name = section.dataset.section!;
      closeRowMenu();
      post({ type: 'setConversationSection', key, section: name });
      e.stopPropagation();
      return;
    }
    if (target.closest('[data-create-section]')) {
      const key = rowMenu.key;
      closeRowMenu();
      post({ type: 'createConversationSection', key });
      e.stopPropagation();
      return;
    }
    const item = target.closest('[data-row-action]') as HTMLElement | null;
    const key = rowMenu.key;
    closeRowMenu();
    if (item) post({ type: 'action', key, action: item.dataset.rowAction as DashboardAction });
    e.stopPropagation();
    return;
  }

  const viewTab = target.closest<HTMLElement>('[data-table-view]');
  if (viewTab) {
    tableView = viewTab.dataset.tableView as 'status' | 'sections';
    saveState();
    render();
    return;
  }

  const colBtn = target.closest('[data-cols]') as HTMLElement | null;
  if (colBtn?.dataset.cols === 'menu') {
    if (!menuPosition) openMenu(colBtn);
    else closeMenu();
    return;
  }
  if (colBtn?.dataset.cols === 'reset') {
    saveColumns(withDefaultWidths(columns));
    render();
    return;
  }
  // Any click outside the open menu dismisses it, and does nothing else.
  if (menuPosition && !target.closest('.colmenu')) {
    closeMenu();
    return;
  }

  const bannerBtn = target.closest('button[data-banner]') as HTMLElement | null;
  const ptoggle = target.closest('button.ptoggle') as HTMLElement | null;
  const pbtn = target.closest('button.pbtn') as HTMLButtonElement | null;
  const qnav = target.closest<HTMLButtonElement>('button[data-qnav]');
  const permRow = target.closest('tr.permrow') as HTMLElement | null;
  const pr = target.closest('.pr') as HTMLElement | null;
  const row = target.closest('tr.row') as HTMLElement | null;
  const secRow = target.closest('tr.sec') as HTMLElement | null;

  if (bannerBtn) {
    if (bannerBtn.dataset.banner === 'install') {
      post({ type: 'installHooks' });
    } else {
      bannerDismissed = hooks?.kind;
      saveState();
      render();
    }
    return;
  }
  if (ptoggle && permRow) {
    // Toggled on the live element rather than by re-rendering: a fresh <div> is
    // born at its final height and the slide would never run.
    const open = !permRow.classList.contains('open');
    permOverride.set(permRow.dataset.key!, open);
    permRow.classList.toggle('open', open);
    ptoggle.setAttribute('aria-expanded', String(open));
    ptoggle.title = open ? 'Hide the details' : 'Show the command and the buttons';
    const twisty = ptoggle.querySelector('.ptw');
    if (twisty) twisty.textContent = open ? '▾' : '▸';
    e.stopPropagation();
    return;
  }
  if (qnav && permRow) {
    const stepper = qnav.closest<HTMLElement>('.qstep')!;
    const draft = saveQuestionDraft(stepper);
    if (!draft) return;
    const step = Number(stepper.dataset.step);
    const picked = draft.selected[step] ?? [];
    const other = draft.other[step] ?? '';
    if (qnav.dataset.qnav === 'back') draft.step--;
    else if (qnav.dataset.qnav === 'next') {
      if (picked.length === 0 && !other) return;
      draft.step++;
    } else {
      if (picked.length === 0 && !other) return;
      const session = sessions.find((item) => item.key === permRow.dataset.key);
      const questions = session?.pendingQuestion?.questions ?? [];
      const answers = Object.fromEntries(questions.map((question, index) => {
        const values = [...(draft.selected[index] ?? [])];
        if (draft.other[index]) values.push(draft.other[index]);
        return [question.question, values.join(', ')];
      }));
      qnav.disabled = true;
      qnav.textContent = 'Answering…';
      post({ type: 'answerQuestion', key: permRow.dataset.key!, requestId: permRow.dataset.request!, answers });
      questionDrafts.delete(stepper.dataset.draft!);
      e.stopPropagation();
      return;
    }
    render();
    e.stopPropagation();
    return;
  }
  if (pbtn && permRow) {
    // One click, one decision: disable every button until the next snapshot
    // re-renders the card from what actually happened.
    for (const b of Array.from(permRow.querySelectorAll<HTMLButtonElement>('button.pbtn'))) b.disabled = true;
    pbtn.textContent = pbtn.dataset.action === 'deny' ? 'Denying…' : 'Allowing…';
    post({
      type: 'action',
      key: permRow.dataset.key!,
      action: pbtn.dataset.action as DashboardAction,
      // Which prompt this card was drawn for. The card is re-rendered from each
      // snapshot, so this is always the one the buttons currently mean.
      requestId: permRow.dataset.request || undefined,
    });
    e.stopPropagation();
    return;
  }
  // Anywhere else on the card: leave the row alone rather than opening the
  // session out from under a decision.
  if (permRow) {
    e.stopPropagation();
    return;
  }
  if (pr) {
    post({ type: 'openExternal', url: pr.dataset.url! });
    e.stopPropagation();
    return;
  }
  if (row) {
    post({ type: 'rowClick', key: row.dataset.key! });
    return;
  }
  if (secRow) {
    const sec = (secRow.parentElement as HTMLElement).dataset.sec!;
    if (!collapsed.delete(sec)) collapsed.add(sec);
    saveState();
    render();
  }
});

// Ages and the ETA countdown tick locally; data itself is pushed by the host.
// Crossing a percentile also changes the cell's colour class, which arrives
// with the next host snapshot — the text leads it by a few seconds at most.
setInterval(() => {
  const now = Date.now();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-age-ts]'))) {
    el.textContent = formatAge(now, Number(el.dataset.ageTs));
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-eta]'))) {
    const [startedAtMs, blockedMs, p50Ms, p90Ms] = el.dataset.eta!.split(',').map(Number);
    el.textContent = etaText(workingElapsedMs({ startedAtMs, blockedMs, toolCalls: 0 }, now), p50Ms, p90Ms);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-resets-at]'))) {
    const resetsAtMs = Number(el.dataset.resetsAt);
    const countdown = resetsInText(now, resetsAtMs);
    el.textContent = el.dataset.fiveHour === 'true' ? `${countdown} (${resetsAtLocalTime(resetsAtMs)})` : countdown;
  }
}, 10_000);

post({ type: 'ready' });

// Every keystroke and every tick of a radio in the question stepper, so the
// next snapshot re-renders the card with the answer still in it.
app.addEventListener('input', (event) => {
  const stepper = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.qstep');
  if (stepper) saveQuestionDraft(stepper);
});

// Kept in the column menu so diagnostic visibility is beside the worker summary.
app.addEventListener('change', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.hasAttribute('data-codex-subagents')) {
    post({ type: 'setShowCodexSubagents', value: input.checked });
  }
});
