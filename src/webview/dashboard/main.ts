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
import {
  askLine,
  capitalize,
  etaText,
  formatAge,
  formatDuration,
  hookBanner,
  SECTION_LABEL,
  SECTION_ORDER,
  sectionOf,
  workingElapsedMs,
  type HookHealth,
  type SectionId,
  type SessionDTO,
} from '../../shared/model';
import {
  resetsInText,
  spendText,
  usageErrorText,
  usageSeverity,
  type UsageSnapshot,
  type UsageState,
  type UsageWindow,
} from '../../shared/usage';

interface WebviewState {
  collapsed?: string[];
  /** Hook-health kind whose banner the user hid. A different kind brings the banner back. */
  bannerDismissed?: string;
}

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
};
const vscodeApi = acquireVsCodeApi();
const post = (msg: DashboardToHost) => vscodeApi.postMessage(msg);

const app = document.getElementById('app')!;
let sessions: SessionDTO[] = [];
let hooks: HookHealth | undefined;
let usage: UsageState | undefined;

// ---- columns ----
// The layout is the host's (globalState, shared by every dashboard), but a drag
// has to feel immediate, so the webview keeps its own copy and posts changes.
// The snapshot that comes back matches what we already drew.
let columns: ColumnPrefs = {};
let narrow = document.documentElement.clientWidth < NARROW_PX;
/** Open column picker, or undefined. The number is where to pin it vertically. */
let menuTop: number | undefined;
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

function saveState(): void {
  vscodeApi.setState({ collapsed: [...collapsed], bannerDismissed });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const ICON_EYE =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3c-3.5 0-6.2 2.4-7.5 5 1.3 2.6 4 5 7.5 5s6.2-2.4 7.5-5c-1.3-2.6-4-5-7.5-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
const ICON_ARCHIVE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.7" y="2.5" width="12.6" height="3.2" rx="0.6"/><path d="M3.1 5.9v6.4a1.2 1.2 0 0 0 1.2 1.2h7.4a1.2 1.2 0 0 0 1.2-1.2V5.9"/><path d="M6.2 8.7h3.6"/></svg>';
const ICON_UNARCHIVE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.7" y="2.5" width="12.6" height="3.2" rx="0.6"/><path d="M3.1 5.9v6.4a1.2 1.2 0 0 0 1.2 1.2h7.4a1.2 1.2 0 0 0 1.2-1.2V5.9"/><path d="M8 12.2V8.2M6.2 9.8 8 8l1.8 1.8"/></svg>';

const ICON_COLUMNS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><path d="M6.4 2.8v10.4M10.4 2.8v10.4"/></svg>';

function clickHint(s: SessionDTO): string {
  switch (s.openTarget) {
    case 'panel':
      return 'Click to open in the Claude Code panel';
    case 'terminal':
      return 'Click to show the terminal running this session';
    case 'window':
      return 'Click to jump to this session in its VSCode window';
    case 'resume':
      return 'Click to resume in a terminal';
    default:
      return 'Click to open the live transcript viewer';
  }
}

function actionButtons(s: SessionDTO): string {
  const btns: string[] = [];
  if (s.transcriptPath) {
    btns.push(`<button class="act" data-action="viewer" title="View transcript (read-only)">${ICON_EYE}</button>`);
  }
  btns.push(
    s.archived
      ? `<button class="act" data-action="archive" title="Unarchive">${ICON_UNARCHIVE}</button>`
      : `<button class="act" data-action="archive" title="Archive">${ICON_ARCHIVE}</button>`,
  );
  return btns.join('');
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
      `<span class="chip todo"${label}><span class="fill" style="width:${pct}%"></span><span class="txt">${todo.completed}/${todo.total}</span></span>`,
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
  if (s.status !== 'blocked' || (!s.blockedAsk && !s.permissionRequestId)) return '';

  const ask = s.blockedAsk;
  const pending = s.permissionRequestId !== undefined;
  const open = permExpanded(s.key, pending);

  // The header is the summary when Claude gave one, else the ask itself on one
  // line; the body below repeats it in full, unflattened.
  const headline = ask?.summary ?? askLine(ask);
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
  const buttons = pending
    ? `<div class="pbtns">
      <button class="pbtn allow" data-action="allow" title="Allow this once, as if you had clicked Allow in Claude Code">Allow</button>
      ${always}
      <button class="pbtn deny" data-action="deny" title="Deny, as if you had clicked Deny in Claude Code">Deny</button>
    </div>`
    : // No buttons: either this was answered in Claude Code already, or it is a
      // tool that only the session itself can answer (a question, a plan).
      '<div class="pnote">Answer this in the session.</div>';

  return `<tr class="permrow${open ? ' open' : ''}${pending ? ' pending' : ''}" data-key="${esc(s.key)}">
  <td class="c-perm" colspan="${span}">
    <button class="ptoggle" data-perm="toggle" aria-expanded="${open}" title="${open ? 'Hide the details' : 'Show the command and the buttons'}"><span class="ptw" aria-hidden="true">${open ? '▾' : '▸'}</span>${header}</button>
    <div class="pslide"><div class="pinner">${detail}${buttons}</div></div>
  </td>
</tr>`;
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
  const est =
    s.statusIsEstimated && s.status !== 'ended'
      ? '\n\nStatus is estimated from the transcript — this session started before hooks were installed. Restart it for exact status.'
      : '';
  // "Stuck" is a silence, and generation is silent too; say so where the label
  // is read, so a red row prompts a look rather than a restart.
  const stuck =
    s.status === 'stuck'
      ? `\n\nNo transcript or hook activity for ${formatAge(Date.now(), s.lastActivityAt)}. A long think or a large file write is silent like this too — check the session before assuming it is wedged.`
      : '';
  // Done vs Waiting is read off the reply text; say so, since it is a judgment.
  const done =
    s.status === 'done'
      ? '\n\nFinished its turn without asking you anything — the last message reads as a report. Waiting would mean it ended on a question or a choice.'
      : '';
  return `${hint}${est}${stuck}${done}${progressTooltip(s)}`;
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
  pr: (s) => `<td class="c-pr">${prHtml(s)}</td>`,
  eta: etaCell,
  age: (s) => `<td class="c-age" data-age-ts="${s.lastActivityAt}">${formatAge(Date.now(), s.lastActivityAt)}</td>`,
};

function rowHtml(s: SessionDTO, span: number): string {
  const titleLine =
    s.name && s.title !== s.name
      ? `<span class="nm">${esc(s.name)}</span><span class="sep">·</span>${esc(s.title)}`
      : esc(s.title);
  const kindChip =
    s.kind && s.kind !== 'interactive' ? `<span class="chip kind">${esc(capitalize(s.kind))}</span>` : '';

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
  ]
    .filter(Boolean)
    .join('<span class="sep">·</span>');
  const secondLine = meta ? `<div class="sub"><span class="meta">${meta}</span></div>` : '';

  const est = s.statusIsEstimated && s.status !== 'ended' ? ' est' : '';
  return `<tr class="row st-${s.status}${s.archived ? ' archived' : ''}${est}" data-key="${esc(s.key)}" title="${esc(rowTitle(s))}">
  <td class="c-dot"><span class="dot" aria-hidden="true"></span></td>
  <td class="c-agent"><div class="agent">
    <div class="title"><span class="ttl">${titleLine}</span><span class="chips">${kindChip}${statusChip(s)}</span></div>
    ${secondLine}
  </div></td>
  ${cols()
    .map((c) => CELL[c.id](s))
    .join('')}
  <td class="c-act">${actionButtons(s)}</td>
</tr>${permissionRow(s, span)}`;
}

/**
 * Hook status, when it needs saying: hooks absent/stale/disabled (all status is
 * a guess), or installed while some live sessions still predate the install.
 */
function bannerHtml(): string {
  const estimatedLive = sessions.filter((s) => s.status !== 'ended' && s.statusIsEstimated && !s.archived).length;
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

function usageCardTitle(w: UsageWindow, snap: UsageSnapshot): string {
  const lines = [`${w.label}: ${Math.round(w.percent)}% of the limit used.`];
  if (w.resetsAtMs !== undefined) {
    lines.push(`Resets ${resetsAtClock(w.resetsAtMs)} (${resetsInText(Date.now(), w.resetsAtMs).toLowerCase()}).`);
  }
  if (w.active) lines.push('This is the window currently constraining requests.');
  lines.push(`Read ${formatAge(Date.now(), snap.fetchedAtMs)} ago from Claude, the same source as /usage.`);
  return lines.join('\n');
}

function usageCardHtml(w: UsageWindow, snap: UsageSnapshot): string {
  const pct = Math.round(w.percent);
  const sev = usageSeverity(w.percent);
  const resets =
    w.resetsAtMs !== undefined
      ? `<span class="ureset" data-resets-at="${w.resetsAtMs}">${esc(resetsInText(Date.now(), w.resetsAtMs))}</span>`
      : '<span class="ureset"></span>';
  return `<div class="ucard ${sev}${w.active ? ' active' : ''}" title="${esc(usageCardTitle(w, snap))}">
  <div class="uhead"><span class="ulabel">${esc(w.label)}</span><span class="upct">${pct}%</span></div>
  <div class="ubar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(w.label)}"><span class="ufill" style="width:${pct}%"></span></div>
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
  <div class="ubar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Extra usage"><span class="ufill" style="width:${pct}%"></span></div>
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
function usageHtml(): string {
  if (!usage) return '';
  const { last, error } = usage;

  if (!last) {
    const text = error ? usageErrorText(error) : 'Reading plan usage…';
    return `<div class="usage${error ? ' err' : ''}" role="status"><span class="unote">${esc(text)}</span></div>`;
  }

  const cards = last.windows.map((w) => usageCardHtml(w, last)).join('') + spendCardHtml(last);
  return `<div class="usage" role="region" aria-label="Plan usage">${cards}</div>`;
}

// ---- column header, resize handles, picker ----

/**
 * The header row. Widths are inline because they are data, not style: a width
 * the user dragged has to survive every re-render and reach the other dashboard
 * unchanged. Each header carries a grab handle on its LEFT edge — the divider
 * it shares with the column before it, which is both the thing the eye aims at
 * and the edge that moves when that column is resized.
 */
function headHtml(): string {
  const ths = cols()
    .map((c) => {
      const w = columnWidth(columns, c);
      const title = c.title ? ` title="${esc(c.title)}"` : '';
      return `<th class="h-${c.id}" data-col="${c.id}" style="width:${w}px"${title}><span class="rz" data-rz="${c.id}"></span>${esc(c.label)}</th>`;
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
  if (menuTop === undefined) return '';
  const rows = COLUMNS.map((c) => {
    const hidden = isHidden(columns, c.id);
    const folded = !hidden && narrow && c.foldsWhenNarrow;
    const note = folded ? '<span class="cmnote">too narrow</span>' : '';
    return `<label class="cmrow"><input type="checkbox" data-col="${c.id}"${hidden ? '' : ' checked'}>${esc(c.label)}${note}</label>`;
  }).join('');
  return `<div class="colmenu" style="top:${menuTop}px" role="menu">
  <div class="cmhead">Columns</div>
  ${rows}
  <button class="cmreset" data-cols="reset">Reset widths</button>
</div>`;
}

function render(): void {
  // A drag owns the widths until the pointer is released; re-rendering under it
  // would replace the <th> being dragged.
  if (dragging) {
    renderDeferred = true;
    return;
  }

  if (sessions.length === 0) {
    menuTop = undefined; // no table, so no button to close the picker with
    app.innerHTML = `${usageHtml()}${bannerHtml()}<div class="empty">No agent sessions found.
<div class="hint">Sessions are discovered from <code>~/.claude</code>. Start a Claude Code session anywhere and it will appear here.</div></div>`;
    return;
  }

  const groups = new Map<SectionId, SessionDTO[]>();
  for (const s of sessions) {
    const sec = sectionOf(s);
    const list = groups.get(sec);
    if (list) list.push(s);
    else groups.set(sec, [s]);
  }

  // No <colgroup>: `table-layout: fixed` takes its columns from the first row,
  // so widths live on the header cells and a column that is switched off simply
  // is not rendered.
  const span = cols().length + 3; // dot + agent + data columns + actions
  let html = `${usageHtml()}${bannerHtml()}${menuHtml()}<table>${headHtml()}`;

  for (const sec of SECTION_ORDER) {
    const rows = groups.get(sec);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const isCollapsed = collapsed.has(sec);
    html += `<tbody class="grp${isCollapsed ? ' collapsed' : ''}" data-sec="${sec}">
<tr class="sec st-${sec}"><td colspan="${span}"><span class="twist">${isCollapsed ? '▸' : '▾'}</span>${esc(SECTION_LABEL[sec])}<span class="count">${rows.length}</span></td></tr>`;
    for (const s of rows) html += rowHtml(s, span);
    html += '</tbody>';
  }
  html += '</table>';
  app.innerHTML = html;
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as HostToDashboard;
  if (m.type === 'snapshot') {
    sessions = m.sessions;
    // A card the user opened or closed is about one prompt. Once that session
    // is no longer blocked the override has outlived its subject, and the next
    // prompt should open by itself.
    for (const key of Array.from(permOverride.keys())) {
      if (!sessions.some((s) => s.key === key && s.status === 'blocked')) permOverride.delete(key);
    }
    hooks = m.hooks;
    usage = m.usage;
    // Our own drag already drew this; anything else is another dashboard's.
    if (m.columns) columns = m.columns;
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

function openMenu(atY: number): void {
  menuTop = Math.max(4, Math.round(atY));
  render();
}

function closeMenu(): void {
  if (menuTop === undefined) return;
  menuTop = undefined;
  render();
}

/** A checkbox in the picker: show or hide that column, everywhere, for good. */
app.addEventListener('change', (e) => {
  const box = (e.target as HTMLElement).closest('input[data-col]') as HTMLInputElement | null;
  if (!box) return;
  saveColumns(withHidden(columns, box.dataset.col as ColumnId, !box.checked));
  render(); // menu stays open: hiding two columns should take two clicks, not four
});

// Right-click the header for the same menu, where a table's column menu lives.
app.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('thead')) return;
  e.preventDefault();
  openMenu((e as MouseEvent).clientY);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// Only the fold threshold matters here: widths are absolute and do not care how
// wide the dock is.
let lastNarrow = narrow;
window.addEventListener('resize', () => {
  narrow = document.documentElement.clientWidth < NARROW_PX;
  if (narrow !== lastNarrow) {
    lastNarrow = narrow;
    render();
  }
});

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  const colBtn = target.closest('[data-cols]') as HTMLElement | null;
  if (colBtn?.dataset.cols === 'menu') {
    if (menuTop === undefined) openMenu(colBtn.getBoundingClientRect().bottom + 4);
    else closeMenu();
    return;
  }
  if (colBtn?.dataset.cols === 'reset') {
    saveColumns(withDefaultWidths(columns));
    render();
    return;
  }
  // Any click outside the open menu dismisses it, and does nothing else.
  if (menuTop !== undefined && !target.closest('.colmenu')) {
    closeMenu();
    return;
  }

  const bannerBtn = target.closest('button[data-banner]') as HTMLElement | null;
  const ptoggle = target.closest('button.ptoggle') as HTMLElement | null;
  const pbtn = target.closest('button.pbtn') as HTMLButtonElement | null;
  const permRow = target.closest('tr.permrow') as HTMLElement | null;
  const btn = target.closest('button.act') as HTMLElement | null;
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
  if (pbtn && permRow) {
    // One click, one decision: disable every button until the next snapshot
    // re-renders the card from what actually happened.
    for (const b of Array.from(permRow.querySelectorAll<HTMLButtonElement>('button.pbtn'))) b.disabled = true;
    pbtn.textContent = pbtn.dataset.action === 'deny' ? 'Denying…' : 'Allowing…';
    post({ type: 'action', key: permRow.dataset.key!, action: pbtn.dataset.action as DashboardAction });
    e.stopPropagation();
    return;
  }
  // Anywhere else on the card: leave the row alone rather than opening the
  // session out from under a decision.
  if (permRow) {
    e.stopPropagation();
    return;
  }
  if (btn && row) {
    post({ type: 'action', key: row.dataset.key!, action: btn.dataset.action as DashboardAction });
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
    el.textContent = resetsInText(now, Number(el.dataset.resetsAt));
  }
}, 10_000);

post({ type: 'ready' });
