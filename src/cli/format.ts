/**
 * What `aw` prints. Pure: every function takes the data and the time, and
 * returns text, so the tests pin the output exactly.
 */
import type {
  ControlChildDoneResult,
  ControlChildListResult,
  ControlChildReadResult,
  ControlChildSpawnResult,
  ControlChildView,
  ControlDelegateResult,
  ControlMissionActResult,
  ControlMissionCaller,
  ControlMissionResult,
  ControlMissionsResult,
  ControlProject,
  ControlSession,
  ControlSessionResult,
  ControlStatusResult,
  ControlTaskProposeResult,
  ControlTaskView,
  ControlWebDevice,
  ControlWebPairResult,
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
    ...(st.remote ? [`Remote control: ${st.remote.lines.map(safe).join(' ')}`] : []),
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

/**
 * `aw task`'s answer. Written for the agent that ran it as much as for a
 * person: the last line says what to tell the user, since nothing runs until
 * they act on it in the app.
 */
export function formatProposal(r: ControlTaskProposeResult, fromConversation = false): string {
  const lines = [`Task proposed: ${safe(r.task.title)}`];
  if (r.route) lines.push(`Route: ${safe(r.route)}${r.verdict === 'route' ? '' : ' (needs a decision)'}`);
  else lines.push('Route: none recommended');
  if (r.summary) lines.push(`Why: ${safe(r.summary)}`);
  if (r.note) lines.push(`Note: ${safe(r.note)}`);
  lines.push(`Id: ${r.task.missionId}`);
  lines.push(
    '',
    fromConversation
      ? 'Nothing is running yet. The user approves it on the "Task proposal" card at the end of this conversation in Agent Wrangler.'
      : 'Nothing is running yet. Approve it in Agent Wrangler: click the "Task proposal" notification, or Tasks → this task.',
  );
  return lines.join('\n');
}

/**
 * `aw delegate`'s answer (#82): what the planner decided, and, on the last
 * line, what to tell the user. Nothing runs until they approve it in the app.
 */
export function formatDelegation(r: ControlDelegateResult, fromConversation = false): string {
  const where = fromConversation ? 'on the "Delegated" card at the end of this conversation in Agent Wrangler' : 'in Agent Wrangler (click its notification, or see Missions)';
  const lines = [`Delegated: ${safe(r.task.title)}`];
  switch (r.decision) {
    case 'single':
      lines.push('Decision: one task');
      if (r.route) lines.push(`Route: ${safe(r.route)}${r.verdict === 'route' ? '' : ' (needs a decision)'}`);
      else lines.push('Route: none recommended');
      if (r.summary) lines.push(`Why: ${safe(r.summary)}`);
      if (r.note) lines.push(`Note: ${safe(r.note)}`);
      break;
    case 'multiple':
      lines.push(`Decision: a plan of ${r.tasks?.length ?? 0} tasks, run one at a time`);
      for (const t of r.tasks ?? []) lines.push(`  ${safe(t.key)}  ${safe(t.title)}`);
      break;
    case 'planning':
      lines.push('Decision: not yet; the planner is still reading the repository');
      break;
    case 'failed':
      lines.push(`Decision: none; it could not be planned${r.note ? `: ${safe(r.note)}` : ''}`);
      break;
    default:
      lines.push(`Decision: ${safe(r.decision)}${r.note ? ` (${safe(r.note)})` : ''}`);
  }
  lines.push(`Id: ${r.task.missionId}`, '');
  if (r.decision === 'cancelled') lines.push('It was cancelled; nothing ran.');
  else if (r.decision === 'failed') lines.push(`Nothing is running. The user can plan it again or run it as one task ${where}.`);
  else if (r.decision === 'planning') lines.push(`Nothing is running yet. The planner's decision appears ${where}; the user approves it there.`);
  else if (r.decision === 'multiple') lines.push(`Nothing is running yet. The user reviews and approves the plan ${where}.`);
  else if (r.decision === 'single') lines.push(`Nothing is running yet. The user approves it ${where}.`);
  return lines.join('\n');
}

export function formatTasks(tasks: readonly ControlTaskView[], now: number, width = 100): string {
  if (tasks.length === 0) return 'No tasks.';
  const rows = tasks.map((t) => [t.title, t.state, ago(t.createdAt, now), t.branch ?? '', t.missionId]);
  return table(['TASK', 'STATE', 'CREATED', 'BRANCH', 'ID'], rows, width);
}

// ---- agent mission control ----

const VERIFY_LABEL: Record<string, string> = { verified: '✓ verified', unverified: '? unverified', failed: '✗ failed', passed: '✓ verified', inconclusive: '~ inconclusive', error: '! check errored' };

function verifyText(verdict: string, noChecks = false): string {
  const label = VERIFY_LABEL[verdict] ?? verdict;
  return verdict === 'unverified' && noChecks ? `${label} (no checks configured)` : label;
}

function diffText(d: { commits: number; filesChanged: number; insertions: number; deletions: number } | undefined): string {
  return d ? `${d.filesChanged} file${d.filesChanged === 1 ? '' : 's'} +${d.insertions} −${d.deletions} (${d.commits} commit${d.commits === 1 ? '' : 's'})` : '—';
}

function callerLine(caller: ControlMissionCaller | undefined): string | undefined {
  if (!caller) return undefined;
  return caller.granted
    ? `You are ${caller.agent}; mission control is on: you may accept, finish or cancel your own verified missions (a local merge asks the user).`
    : `You are ${caller.agent}; mission control is off for you, so you can only read. The user turns it on in Preferences.`;
}

export function formatMissions(r: ControlMissionsResult, now: number, width = 100): string {
  const head = callerLine(r.caller);
  if (r.missions.length === 0) return [head, 'No missions.'].filter(Boolean).join('\n');
  const rows = r.missions.map((m) => [
    m.missionId,
    m.origin === 'yours' ? 'yours' : m.origin === 'other' ? 'other' : '—',
    verifyText(m.verification.verdict),
    ago(m.updatedAt, now),
    `${m.title} — ${m.waitingOn.text}`,
  ]);
  return [head, table(['ID', 'ORIGIN', 'CHECKS', 'UPDATED', 'MISSION — WAITING ON'], rows, width)].filter(Boolean).join('\n');
}

export function formatMission(r: ControlMissionResult, now: number): string {
  const m = r.mission;
  const lines = [
    `${safe(m.title)}  (${m.missionId})`,
    `  state:      ${m.state} — ${safe(m.phase)}`,
    `  waiting on: ${safe(m.waitingOn.text)} [${m.waitingOn.kind}]`,
    `  repo:       ${safe(m.repo)}  ${safe(m.baseRef)}${m.branch ? ` → ${safe(m.branch)}` : ''}`,
    `  diff:       ${diffText(m.diff)} vs ${safe(m.baseRef)}`,
    `  checks:     ${verifyText(m.verification.verdict, m.verification.noChecks)}`,
    `  origin:     ${m.origin === 'yours' ? 'yours (this agent delegated it)' : m.origin === 'other' ? 'another conversation' : 'not a durable agent’s'}`,
    `  updated:    ${ago(m.updatedAt, now)}`,
  ];
  if (m.finish) lines.push(`  finish:     ${m.finish}${m.finishResult?.pullRequestUrl ? ` ${m.finishResult.pullRequestUrl}` : m.finishResult?.mergeCommit ? ` at ${m.finishResult.mergeCommit.slice(0, 8)}` : ''}`);
  lines.push('  tasks:');
  for (const t of m.tasks) {
    lines.push(`    ${t.key}  ${t.state}${t.attempt ? ` (attempt ${t.attempt.n} ${t.attempt.state})` : ''}  ${verifyText(t.verification.verdict)}  ${diffText(t.diff)}  ${safe(t.title)}`);
    if (t.branch) lines.push(`        branch: ${safe(t.branch)}`);
    if (t.verification.stages.length === 0) lines.push('        checks: none configured for this repository');
    for (const s of t.verification.stages) {
      lines.push(`        ${s.required ? 'required' : 'advisory'} ${safe(s.strategy)}: ${s.outcome ?? 'not run'}${s.summary ? ` — ${clip(s.summary, 80)}` : ''}`);
    }
  }
  const head = callerLine(r.caller);
  return [head, ...lines].filter(Boolean).join('\n');
}

export function formatMissionAct(r: ControlMissionActResult): string {
  const lead = r.outcome === 'done' ? 'Done.' : r.outcome === 'requested' ? 'Requested.' : r.outcome === 'refused' ? `Refused (${r.code ?? 'refused'}).` : r.outcome === 'failed' ? 'Failed.' : `${r.outcome}.`;
  const tail = r.mission ? `\nNow: ${r.mission.state} — ${safe(r.mission.waitingOn.text)}` : '';
  return `${lead} ${safe(r.message)}${tail}`;
}

// ---- child conversations (#198) ----

function childStatus(c: ControlChildView): string {
  if (c.needsYou) return 'waiting on the user';
  return c.status ? statusLabel(c.status) : 'not started';
}

export function formatChildSpawn(r: ControlChildSpawnResult): string {
  const c = r.child;
  return [
    `Started a ${c.provider === 'codex' ? 'Codex' : 'Claude'} child conversation.`,
    `  id:       ${safe(c.childId)}`,
    `  session:  ${safe(c.key)}`,
    `  worktree: ${safe(c.worktree)}`,
    `  branch:   ${safe(c.branch)} (from the HEAD of ${safe(r.repo)})`,
    '',
    `Follow it with aw child read ${safe(c.childId)}. When it is finished, merge ${safe(c.branch)} to main yourself, then run aw child done ${safe(c.childId)}.`,
  ].join('\n');
}

export function formatChildList(r: ControlChildListResult, now: number, width = 100): string {
  if (r.children.length === 0) return `${safe(r.agent)} has no child conversations. Start one with aw child spawn "<prompt>".`;
  const rows = r.children.map((c) => [c.childId, childStatus(c), c.provider, c.lastActivityAt ? ago(c.lastActivityAt, now) : '—', c.branch, c.title ?? '']);
  return table(['ID', 'STATUS', 'HARNESS', 'ACTIVE', 'BRANCH', 'TITLE'], rows, width);
}

/** The head of `aw child read`; the blocks below it are rendered as `aw attach` renders them. */
export function formatChildReadHead(r: ControlChildReadResult): string {
  const c = r.child;
  const lines = [`${safe(c.childId)}  ${childStatus(c)}${r.lifecycle ? ` (runner: ${r.lifecycle})` : ''}  ${safe(c.branch)}`];
  if (r.pending) lines.push(`Waiting on the user: ${r.pending.kind}: ${clip(r.pending.summary, 200)}`);
  if (!r.lifecycle) lines.push('Agent Wrangler is not running this child right now, so there are no recent messages to show. aw child send resumes it.');
  return lines.join('\n');
}

export function formatChildDone(r: ControlChildDoneResult): string {
  return `${r.outcome === 'done' ? 'Done.' : r.outcome === 'refused' ? 'Refused.' : `${safe(r.outcome)}.`} ${safe(r.message)}`;
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

const DEVICE_SCOPE_LABEL: Record<string, string> = { loopback: 'this Mac', lan: 'home network' };

/** `aw web devices` (#137). */
export function formatWebDevices(devices: readonly ControlWebDevice[], now: number, width = 100): string {
  if (devices.length === 0) return 'No browser devices. Sign one in with aw web open, or pair one with aw web pair.';
  const rows = [...devices]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((d) => [d.id.slice(0, 8), DEVICE_SCOPE_LABEL[d.scope] ?? safe(d.scope), ago(d.createdAt, now), ago(d.lastSeen, now), d.name]);
  return `${table(['ID', 'WHERE', 'ADDED', 'LAST SEEN', 'NAME'], rows, width)}\n\nRevoke one with aw web devices revoke <id>.`;
}

/** `aw web pair`'s words around the QR code (#137). */
export function formatWebPair(r: ControlWebPairResult, now: number): string {
  const minutes = Math.max(1, Math.round((r.expiresAt - now) / 60_000));
  const code = r.code.length === 8 ? `${r.code.slice(0, 4)}-${r.code.slice(4)}` : r.code;
  return [
    'Scan the QR code with the camera of the phone or tablet. It sets up the',
    'certificate, then pairs the device.',
    ...(r.setupUrl ? ['', 'No camera? Open this in its browser:', `    ${r.setupUrl}`] : [`or open ${r.url.replace(/\?.*$/, '')} on it and type the code:`]),
    '',
    `    ${code}`,
    '',
    `Good once, for ${minutes} minute${minutes === 1 ? '' : 's'}. Whoever uses it first gets in as you.`,
  ].join('\n');
}
