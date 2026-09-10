import './dashboard.css';
import type { DashboardAction, DashboardToHost, HostToDashboard } from '../../shared/messages';
import { formatAge, SECTION_LABEL, SECTION_ORDER, sectionOf, type SectionId, type SessionDTO } from '../../shared/model';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): { collapsed?: string[] } | undefined;
  setState(state: { collapsed?: string[] }): void;
};
const vscodeApi = acquireVsCodeApi();
const post = (msg: DashboardToHost) => vscodeApi.postMessage(msg);

const app = document.getElementById('app')!;
let sessions: SessionDTO[] = [];
// Collapse state survives reloads via webview state; Archived starts collapsed.
const collapsed = new Set<string>(vscodeApi.getState()?.collapsed ?? ['archived']);

function saveState(): void {
  vscodeApi.setState({ collapsed: [...collapsed] });
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

  return `<tr class="row st-${s.status}${s.archived ? ' archived' : ''}" data-key="${esc(s.key)}" title="${esc(clickHint(s))}">
  <td class="c-dot"><span class="dot" aria-hidden="true"></span></td>
  <td class="c-agent">
    <div class="title">${titleLine}${kindChip}</div>
    ${s.subtitle ? `<div class="sub">${esc(s.subtitle)}</div>` : ''}
  </td>
  <td class="c-proj"${s.cwd ? ` title="${esc(s.cwd)}"` : ''}>${esc(s.projectName ?? '')}</td>
  <td class="c-branch"${branch ? ` title="${branch}"` : ''}>${branch}</td>
  <td class="c-pr">${pr}</td>
  <td class="c-age" data-age-ts="${s.lastActivityAt}">${formatAge(Date.now(), s.lastActivityAt)}</td>
  <td class="c-act">${actionButtons(s)}</td>
</tr>`;
}

function render(): void {
  if (sessions.length === 0) {
    app.innerHTML = `<div class="empty">No agent sessions found.
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

  let html = `<table>
<colgroup>
  <col class="c-dot"><col class="c-agent"><col class="c-proj"><col class="c-branch"><col class="c-pr"><col class="c-age"><col class="c-act">
</colgroup>
<thead><tr>
  <th></th><th>Agent</th><th>Project</th><th>Branch</th><th>PR</th><th class="h-age">Age</th><th></th>
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
    render();
  }
});

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest('button.act') as HTMLElement | null;
  const pr = target.closest('.pr') as HTMLElement | null;
  const row = target.closest('tr.row') as HTMLElement | null;
  const secRow = target.closest('tr.sec') as HTMLElement | null;

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

// Ages tick locally; data itself is pushed by the host.
setInterval(() => {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-age-ts]'))) {
    el.textContent = formatAge(Date.now(), Number(el.dataset.ageTs));
  }
}, 10_000);

post({ type: 'ready' });
