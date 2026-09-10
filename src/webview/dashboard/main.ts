import './dashboard.css';
import type { DashboardAction, DashboardToHost, HostToDashboard } from '../../shared/messages';
import {
  formatAge,
  formatDuration,
  hookBanner,
  paceText,
  SECTION_LABEL,
  SECTION_ORDER,
  sectionOf,
  workingElapsedMs,
  type HookHealth,
  type SectionId,
  type SessionDTO,
} from '../../shared/model';

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

function clickHint(s: SessionDTO): string {
  if (s.inWorkspace) return 'Click to open in the Claude Code panel';
  if (s.status !== 'ended' && s.entrypoint === 'claude-vscode') {
    return 'Click to jump to this session in its VSCode window';
  }
  if (s.status === 'ended') return 'Click to resume in a terminal';
  return 'Click to open the live transcript viewer';
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
 * Busy rows then add, when the data exists: the agent's own checklist (the only
 * honest percentage in the whole pipeline) and a pace chip, which stays hidden
 * until the turn has outrun the median and so has something real to say.
 */
function statusChip(s: SessionDTO): string {
  if (s.status === 'blocked' && s.blockedReason) {
    return `<span class="chip blk">needs ${esc(s.blockedReason)}</span>`;
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

  const p = s.progress;
  if (p?.pace) {
    // Rendered even when currently empty: the chip ticks itself, so it needs to
    // already be in the DOM when the turn crosses the median.
    const { p50Ms, p75Ms, p90Ms, band, provisional } = p.pace;
    const text = paceText(workingElapsedMs(p, Date.now()), p50Ms, p75Ms, p90Ms);
    chips.push(
      `<span class="chip pace ${band}${provisional ? ' prov' : ''}${text ? '' : ' quiet'}" data-pace="${p.startedAtMs},${p.blockedMs},${p50Ms},${p75Ms},${p90Ms}">${text}</span>`,
    );
  }
  return chips.join('');
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
    } else {
      const outran = elapsed >= pace.p75Ms ? 'longer than 3 in 4' : elapsed >= pace.p50Ms ? 'longer than half' : 'typical so far';
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
  return `${hint}${est}${stuck}${progressTooltip(s)}`;
}

function rowHtml(s: SessionDTO): string {
  const titleLine =
    s.name && s.title !== s.name
      ? `<span class="nm">${esc(s.name)}</span><span class="sep">·</span>${esc(s.title)}`
      : esc(s.title);
  const kindChip = s.kind && s.kind !== 'interactive' ? `<span class="chip kind">${esc(s.kind)}</span>` : '';
  const branch = s.gitBranch && s.gitBranch !== 'HEAD' ? esc(s.gitBranch) : '';
  const pr = s.prLink
    ? `<span class="pr" role="link" data-url="${esc(s.prLink.prUrl)}" title="${esc(s.prLink.prUrl)}">#${s.prLink.prNumber}</span>`
    : '';

  // Narrow layouts hide the Project/Branch/PR columns and show this instead
  // (CSS decides which), so the row still says where the agent is working.
  const meta = [s.projectName ? esc(s.projectName) : '', branch, pr]
    .filter(Boolean)
    .join('<span class="sep">·</span>');
  const sub = s.subtitle ? esc(s.subtitle) : '';
  const secondLine =
    meta || sub
      ? `<div class="sub">${meta ? `<span class="meta">${meta}</span>` : ''}${meta && sub ? '<span class="msep"> — </span>' : ''}${sub}</div>`
      : '';

  const est = s.statusIsEstimated && s.status !== 'ended' ? ' est' : '';
  return `<tr class="row st-${s.status}${s.archived ? ' archived' : ''}${est}" data-key="${esc(s.key)}" title="${esc(rowTitle(s))}">
  <td class="c-dot"><span class="dot" aria-hidden="true"></span></td>
  <td class="c-agent"><div class="agent">
    <div class="title"><span class="ttl">${titleLine}</span><span class="chips">${kindChip}${statusChip(s)}</span></div>
    ${secondLine}
  </div></td>
  <td class="c-proj"${s.cwd ? ` title="${esc(s.cwd)}"` : ''}>${esc(s.projectName ?? '')}</td>
  <td class="c-branch"${branch ? ` title="${branch}"` : ''}>${branch}</td>
  <td class="c-pr">${pr}</td>
  <td class="c-age" data-age-ts="${s.lastActivityAt}">${formatAge(Date.now(), s.lastActivityAt)}</td>
  <td class="c-act">${actionButtons(s)}</td>
</tr>`;
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

function render(): void {
  if (sessions.length === 0) {
    app.innerHTML = `${bannerHtml()}<div class="empty">No agent sessions found.
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

  // No <colgroup>: widths sit on the header cells so a column hidden by the
  // narrow-layout media query disappears entirely instead of leaving a gap.
  let html = `${bannerHtml()}<table>
<thead><tr>
  <th class="h-dot"></th><th class="h-agent">Agent</th><th class="h-proj">Project</th><th class="h-branch">Branch</th><th class="h-pr">PR</th><th class="h-age">Age</th><th class="h-act"></th>
</tr></thead>`;

  for (const sec of SECTION_ORDER) {
    const rows = groups.get(sec);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const isCollapsed = collapsed.has(sec);
    html += `<tbody class="grp${isCollapsed ? ' collapsed' : ''}" data-sec="${sec}">
<tr class="sec st-${sec}"><td colspan="7"><span class="twist">${isCollapsed ? '▸' : '▾'}</span>${esc(SECTION_LABEL[sec])}<span class="count">${rows.length}</span></td></tr>`;
    for (const s of rows) html += rowHtml(s);
    html += '</tbody>';
  }
  html += '</table>';
  app.innerHTML = html;
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as HostToDashboard;
  if (m.type === 'snapshot') {
    sessions = m.sessions;
    hooks = m.hooks;
    render();
  }
});

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const bannerBtn = target.closest('button[data-banner]') as HTMLElement | null;
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

// Ages and the pace countdown tick locally; data itself is pushed by the host.
// Crossing a percentile also changes the chip's class, which arrives with the
// next host snapshot — the text leads it by a few seconds at most.
setInterval(() => {
  const now = Date.now();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-age-ts]'))) {
    el.textContent = formatAge(now, Number(el.dataset.ageTs));
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-pace]'))) {
    const [startedAtMs, blockedMs, p50Ms, p75Ms, p90Ms] = el.dataset.pace!.split(',').map(Number);
    const text = paceText(workingElapsedMs({ startedAtMs, blockedMs, toolCalls: 0 }, now), p50Ms, p75Ms, p90Ms);
    el.textContent = text;
    el.classList.toggle('quiet', text === '');
  }
}, 10_000);

post({ type: 'ready' });
