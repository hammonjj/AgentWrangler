/**
 * What `aw` prints. Pure: every function takes the data and the time, and
 * returns text, so the tests pin the output exactly.
 */
import type {
  ControlProject,
  ControlSession,
  ControlSessionResult,
  ControlStatusResult,
  RunBy,
} from '../core/control/protocol';
import { STATUS_LABEL } from '../shared/model';
import type { ControlStatus } from '../core/control/protocol';

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Remove control characters but newline and tab. Titles, transcript text and
 * tool previews are written by agents, and an escape sequence in them would
 * otherwise reach the terminal (OSC 52 writes the clipboard, others retitle
 * the window or plant links).
 */
export function safe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Cut to `width` characters, with an ellipsis when anything was cut. */
export function clip(text: string, width: number): string {
  const flat = safe(text).replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Aligned columns; the last column takes what is left of `width` and is clipped. */
export function table(header: string[], dirty: string[][], width: number): string {
  // Cells are one line each and free of control characters.
  const rows = dirty.map((r) => r.map((c) => safe(c).replace(/\s+/g, ' ')));
  const widths = header.map((h, i) => (i === header.length - 1 ? 0 : Math.max(h.length, ...rows.map((r) => r[i].length))));
  const used = widths.reduce((a, b) => a + b + 2, 0);
  const last = Math.max(12, width - used);
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? clip(c, last) : pad(c, widths[i])))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

const RUN_BY_LABEL: Record<RunBy, string> = { hosted: 'AW (host)', app: 'AW', external: '—' };

/** Enumerations may grow within v1: an unknown value is shown as itself. */
export function runByLabel(runBy: string): string {
  return (RUN_BY_LABEL as Record<string, string>)[runBy] ?? safe(runBy);
}

export function statusLabel(status: string, blockedOn?: string): string {
  if (status === 'blocked') return blockedOn ? `Waiting: ${safe(blockedOn)}` : 'Waiting';
  return (STATUS_LABEL as Record<string, string>)[status] ?? safe(status);
}

export function formatSessions(sessions: readonly ControlSession[], now: number, width = 100): string {
  if (sessions.length === 0) return 'No sessions.';
  const rows = sessions.map((s) => [
    s.sessionId.slice(0, 8),
    clip(statusLabel(s.status, s.blockedOn), 22),
    runByLabel(s.runBy),
    ago(s.lastActivityAt, now),
    clip(s.projectName ?? '', 20),
    `${s.archived ? '[archived] ' : ''}${s.title}`,
  ]);
  return table(['ID', 'STATUS', 'RUN BY', 'ACTIVE', 'PROJECT', 'TITLE'], rows, width);
}

export function formatStatus(st: ControlStatusResult, now: number): string {
  const order: ControlStatus[] =['blocked', 'waiting', 'busy', 'stuck', 'done', 'ended'];
  const parts = order.filter((k) => st.byStatus[k]).map((k) => `${st.byStatus[k]} ${k === 'blocked' ? 'waiting on a prompt' : STATUS_LABEL[k].toLowerCase()}`);
  const total = order.reduce((n, k) => n + (st.byStatus[k] ?? 0), 0);
  return [
    `Agent Wrangler is running (pid ${st.appPid}, build ${st.build}, up ${ago(st.startedAt, now).replace(' ago', '')}).`,
    total === 0 ? 'No sessions in the table.' : `${total} session${total === 1 ? '' : 's'}: ${parts.join(', ')}.`,
    `Run by Agent Wrangler: ${st.running.hosted} that survive a quit, ${st.running.app} that end with it.`,
  ].join('\n');
}

export function formatSession(r: ControlSessionResult, now: number): string {
  const s = r.session;
  const lines: [string, string | undefined][] = [
    ['Title', s.title],
    ['Session', s.sessionId],
    ['Provider', s.provider],
    ['Status', statusLabel(s.status, s.blockedOn) + (r.lifecycle ? ` (runner: ${r.lifecycle})` : '')],
    ['Run by', s.runBy === 'external' ? 'not Agent Wrangler' : s.runBy === 'hosted' ? 'Agent Wrangler, survives a quit' : 'Agent Wrangler, ends with the app'],
    ['Waiting on', r.pending ? `${r.pending.kind}: ${clip(r.pending.summary, 200)}` : undefined],
    ['Project', s.projectName],
    ['Folder', s.cwd],
    ['Branch', s.gitBranch],
    ['Worktree', s.worktree],
    ['Model', s.model],
    ['Pid', s.pid === undefined ? undefined : String(s.pid)],
    ['Active', ago(s.lastActivityAt, now)],
    ['Archived', s.archived ? 'yes' : undefined],
    ['Registry', r.record ? `${r.record.state}${r.record.endedReason ? ` (${r.record.endedReason})` : ''}, first run ${ago(r.record.createdAt, now)}` : undefined],
    ['Launched', r.record ? launchText(r.record.launch) : undefined],
  ];
  return lines
    .filter((l): l is [string, string] => l[1] !== undefined && l[1] !== '')
    .map(([k, v]) => `${pad(`${k}:`, 12)}${safe(v).replace(/\s+/g, ' ')}`)
    .join('\n');
}

function launchText(l: { model?: string; effort?: string; permissionMode?: string }): string | undefined {
  const parts = [l.model && `model ${l.model}`, l.effort && `effort ${l.effort}`, l.permissionMode && `mode ${l.permissionMode}`].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function formatProjects(projects: readonly ControlProject[], now: number, width = 100): string {
  if (projects.length === 0) return 'No projects.';
  const rows = projects.map((p) => [
    `${p.favourite ? '★ ' : ''}${p.name}`,
    p.lastUsedAt === undefined ? 'never' : ago(p.lastUsedAt, now),
    p.occupiedBy?.length ? `${p.occupiedBy.length} live` : '',
    p.dir,
  ]);
  return table(['PROJECT', 'USED', 'SESSIONS', 'FOLDER'], rows, width);
}

// ---- the read-only view, when the app is not running ----

export interface OfflineHost {
  hostId: string;
  sessionId?: string;
  cwd: string;
  alive: boolean;
  startedAt: number;
  exitReason?: string;
}

export interface OfflineRecord {
  sessionId: string;
  provider: string;
  cwd: string;
  state: string;
  endedReason?: string;
  lastShownAt: number;
}

export interface OfflineView {
  hosts: OfflineHost[];
  records: OfflineRecord[];
}

/**
 * What is still running with the app quit: live session hosts, and what the
 * registry last knew. Read-only; nothing here can be acted on without the app.
 */
export function formatOffline(view: OfflineView, now: number, width = 100, full = false): string {
  const out = ['Agent Wrangler is not running. This is a read-only view from its files.', ''];
  const live = view.hosts.filter((h) => h.alive);
  if (live.length === 0) {
    out.push('No session hosts are running.');
  } else {
    out.push(`${live.length} session host${live.length === 1 ? ' is' : 's are'} still running (they reattach when the app starts):`);
    out.push(
      table(
        ['ID', 'HOST', 'STARTED', 'FOLDER'],
        live.map((h) => [(h.sessionId ?? '(starting)').slice(0, 8), h.hostId, ago(h.startedAt, now), h.cwd]),
        width,
      ),
    );
  }
  if (!full) return out.join('\n');
  const liveIds = new Set(live.map((h) => h.sessionId?.toLowerCase()).filter(Boolean));
  const records = view.records.filter((r) => !liveIds.has(r.sessionId.toLowerCase()));
  out.push('');
  if (records.length === 0) {
    out.push('The registry remembers no other sessions.');
  } else {
    out.push('Sessions Agent Wrangler ran, as it last recorded them:');
    out.push(
      table(
        ['ID', 'PROVIDER', 'STATE', 'SHOWN', 'FOLDER'],
        records.map((r) => [
          r.sessionId.slice(0, 8),
          r.provider,
          r.state === 'live' ? 'live when the app stopped' : `${r.state}${r.endedReason ? ` (${r.endedReason})` : ''}`,
          ago(r.lastShownAt, now),
          r.cwd,
        ]),
        width,
      ),
    );
  }
  return out.join('\n');
}
