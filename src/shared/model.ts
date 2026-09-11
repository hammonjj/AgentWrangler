/**
 * Shared data model. This file is imported by BOTH the extension host and the
 * webview bundles — it must stay free of `vscode`, Node, and DOM imports.
 */

/**
 * `waiting` and `done` both mean the agent has finished its turn and is idle at
 * its prompt. The difference is what its last message did: `waiting` asked you
 * something (a question, a choice, "let me know"), `done` reported and stopped.
 * Both are read off the reply text, so the split is a heuristic — see
 * `needsReply` in core.
 */
export type SessionStatus = 'blocked' | 'waiting' | 'done' | 'busy' | 'stuck' | 'ended';

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker';

export interface PrLink {
  prNumber: number;
  prUrl: string;
  prRepository?: string;
}

/**
 * The agent's own checklist, when it keeps one (the `TodoWrite` tool). This is
 * the only true denominator available anywhere in the pipeline: everything else
 * we observe says what has happened, never how much is left.
 */
export interface TodoProgress {
  completed: number;
  total: number;
  /** `activeForm` of the in-progress item, e.g. "Running the backend tests". */
  active?: string;
}

/**
 * Where a turn's elapsed time sits against how long this user's turns actually
 * take. Deliberately a band and not a percentage: measured over 507 real turns,
 * p90 is ~10x p50, so `elapsed / median` would read 100% while ten more minutes
 * of genuine work remained.
 */
export type PaceBand = 'typical' | 'long' | 'very-long';

export interface TurnPace {
  band: PaceBand;
  /** Baseline percentiles (ms) this was judged against — the row tooltip quotes them. */
  p50Ms: number;
  p75Ms: number;
  p90Ms: number;
  /** Completed turns behind the baseline; below `MIN_TURN_SAMPLES` it is the seeded fallback. */
  samples: number;
  /** True while the fallback baseline is in use, so the UI can hedge the wording. */
  provisional: boolean;
}

/** Live progress of the turn a `busy` session is working on. Hook-fed; absent otherwise. */
export interface TurnProgress {
  /** ms epoch of the `UserPromptSubmit` that began this turn. */
  startedAtMs: number;
  /**
   * Time this turn has spent blocked on a human (permission prompts, elicitation).
   * Subtracted from elapsed so a prompt left sitting overnight doesn't read as work.
   */
  blockedMs: number;
  /** Tool calls since the turn began — a rising count is live proof of work. */
  toolCalls: number;
  todo?: TodoProgress;
  pace?: TurnPace;
}

/**
 * What a row click does. `panel`: the Claude Code panel in this window (reveal,
 * or resume an ended session into one). `terminal`: show the integrated terminal
 * running the session. `window`: hand off to the VSCode window that owns it.
 * `resume`: a new terminal running `claude --resume`. `viewer`: the read-only
 * transcript, for a live session nothing in this app can reveal.
 */
export type OpenTarget = 'panel' | 'terminal' | 'window' | 'resume' | 'viewer';

export interface AgentSession {
  /** Provider id, e.g. 'claude'. */
  provider: string;
  sessionId: string;
  /** Globally unique key: `${provider}:${sessionId}`. */
  key: string;
  /** Friendly handle from the live registry (e.g. "my-app-backend-cf"). Live sessions only. */
  name?: string;
  /** Best-effort human title (ai-title → registry name → slug → first prompt → id prefix). */
  title: string;
  /** Last prompt preview (~200 chars). */
  subtitle?: string;
  cwd?: string;
  projectName?: string;
  gitBranch?: string;
  status: SessionStatus;
  /** ms epoch of last observed activity (transcript mtime, else registry startedAt). */
  lastActivityAt: number;
  startedAt?: number;
  kind?: SessionKind;
  entrypoint?: string;
  transcriptPath?: string;
  pid?: number;
  prLink?: PrLink;
  /** User shoved this session out of the way (host decorates from ArchiveService). */
  archived?: boolean;
  /** What clicking the row does, decided by the host from where the process lives (host decorates). */
  openTarget?: OpenTarget;
  /**
   * True when `status` was inferred from the transcript rather than pushed by a
   * hook — i.e. a session started before hooks were installed. Rendered dimmed
   * with a `~` so a guess is never mistaken for ground truth.
   */
  statusIsEstimated?: boolean;
  /** For `blocked`: what Claude is asking for (tool name, or an elicitation label). */
  blockedReason?: string;
  /**
   * For `blocked`: what the permission is actually for, one line — the Bash
   * command's description, the file an Edit touches, the question being asked.
   * Read off the hook payload's `tool_input`, so absent without hooks.
   */
  blockedDetail?: string;
  /**
   * For `blocked`: set while our PermissionRequest hook is still waiting for a
   * decision file, i.e. while Allow/Deny from the dashboard can still land.
   * Absent once the user has answered in Claude Code itself.
   */
  permissionRequestId?: string;
  /** For `busy`: the tool currently in flight, so a long build reads as work, not a stall. */
  activeTool?: { name: string; sinceMs: number };
  /** For `busy`: how far into the current turn we are. Requires hooks. */
  progress?: TurnProgress;
}

/** Working time spent on this turn — wall clock minus time parked on a human. */
export function workingElapsedMs(p: TurnProgress, nowMs: number): number {
  return Math.max(0, nowMs - p.startedAtMs - p.blockedMs);
}

/** DTO sent over the webview wire — AgentSession is already JSON-safe. */
export type SessionDTO = AgentSession;

export const STATUS_RANK: Record<SessionStatus, number> = {
  blocked: 0,
  waiting: 1,
  stuck: 2,
  done: 3,
  busy: 4,
  ended: 5,
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  blocked: 'Blocked on you',
  waiting: 'Waiting on you',
  stuck: 'Possibly stuck',
  done: 'Done',
  busy: 'Busy',
  ended: 'Ended',
};

/** Statuses in which a human has to act before the agent can go on. `done` is
 * deliberately not one: a finished report needs reading, not answering. */
export function needsUser(status: SessionStatus): boolean {
  return status === 'waiting' || status === 'blocked';
}

/** First letter upper-cased, the rest untouched: "needs Edit" → "Needs Edit", "bg" → "Bg". */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Blocked first (an agent frozen mid-task), then waiting, stuck, done (finished,
 * worth a look), busy, ended; within a rank, most recent activity first. */
export function compareSessions(a: AgentSession, b: AgentSession): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return b.lastActivityAt - a.lastActivityAt;
}

/** Dashboard sections: the six statuses, plus Archived pinned last. */
export type SectionId = SessionStatus | 'archived';

export const SECTION_ORDER: SectionId[] = ['blocked', 'waiting', 'stuck', 'done', 'busy', 'ended', 'archived'];

export const SECTION_LABEL: Record<SectionId, string> = {
  ...STATUS_LABEL,
  archived: 'Archived',
};

export function sectionOf(s: AgentSession): SectionId {
  return s.archived ? 'archived' : s.status;
}

/** One rendered block of a transcript in the viewer. */
export type ViewerBlock =
  | { kind: 'user'; text: string; ts?: string }
  | { kind: 'assistant'; text: string; ts?: string; msgId?: string }
  | { kind: 'tool'; name: string; inputPreview: string; ts?: string };

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatAge(nowMs: number, thenMs: number): string {
  return formatDuration(nowMs - thenMs);
}

// ---- hook health (the dashboard banner) ----

/** Mirrors `InstallState.kind` in the extension host, minus the host-only payload. */
export type HookInstallKind = 'installed' | 'stale' | 'absent' | 'disabled' | 'unreadable';

export interface HookHealth {
  kind: HookInstallKind;
  /** True once any hook event has been read — proves the installed hooks are live. */
  reporting: boolean;
  /** Reason text for `disabled` / `unreadable`. */
  why?: string;
}

export interface HookBanner {
  tone: 'info' | 'warn';
  text: string;
  /** Present when a button should run the installer (`update` re-runs it over a stale block). */
  action?: 'install' | 'update';
  /** Hideable by the user. The self-resolving notes (old sessions) are not. */
  dismissible: boolean;
}

/**
 * What the dashboard should say about hook status, or undefined for nothing.
 *
 * The exact-status feature is opt-in and otherwise invisible: without hooks a
 * permission prompt reads as Busy and no progress exists to show, and the only
 * hint is a hollow dot. So `absent` gets a banner with the install button
 * rather than a silent log line. `estimatedLive` is the number of live sessions
 * still on transcript inference — after an install, that's the ones started
 * before it, which need a restart and nothing else.
 */
export function hookBanner(h: HookHealth | undefined, estimatedLive: number): HookBanner | undefined {
  if (!h) return undefined;
  switch (h.kind) {
    case 'absent':
      return {
        tone: 'warn',
        text:
          'Status is estimated from transcripts: a permission prompt shows as Busy, and there is no turn progress. ' +
          'Install the Claude Code status hooks for exact status.',
        action: 'install',
        dismissible: true,
      };
    case 'stale':
      return {
        tone: 'warn',
        text: 'The Agent Wrangler hooks in settings.json are out of date. Update them to keep exact status.',
        action: 'update',
        dismissible: false,
      };
    case 'disabled':
      return {
        tone: 'warn',
        text: `Status hooks cannot run (${h.why ?? 'hooks are disabled'}). All status is estimated.`,
        dismissible: false,
      };
    case 'unreadable':
      return {
        tone: 'warn',
        text: `Cannot check hook status: ${h.why ?? 'settings.json is unreadable'}.`,
        dismissible: true,
      };
    case 'installed':
      if (estimatedLive === 0) return undefined;
      return {
        tone: 'info',
        text:
          `${estimatedLive} live session${estimatedLive === 1 ? '' : 's'} started before the hooks were installed ` +
          `and still report${estimatedLive === 1 ? 's' : ''} estimated status. Restart ${estimatedLive === 1 ? 'it' : 'them'} for exact status.`,
        dismissible: false,
      };
    default:
      return undefined;
  }
}

// ---- plan usage (the cards above the table) ----

/**
 * One rate-limit window from Claude's usage endpoint: the 5-hour session, the
 * 7-day all-models window, and any model- or surface-scoped weekly window
 * (e.g. "Weekly Fable"). The same three rows Claude Code's own /usage shows.
 */
export interface UsageLimit {
  /** Stable id for the card: `session`, `weekly_all`, `weekly_scoped:<name>`. */
  id: string;
  /** Row label as Claude Code names it: "Session (5hr)", "Weekly (7 day)", "Weekly Fable". */
  label: string;
  /** Percent of the window used, 0–100 (the API can report over 100 briefly). */
  percent: number;
  /** Server-side severity word (`normal`, or a warning level). Kept for the tooltip. */
  severity: string;
  /** ms epoch when this window resets, if the server said. */
  resetsAtMs?: number;
  /** True for the window the server says is currently the binding one. */
  isActive: boolean;
}

export interface UsageSnapshot {
  /** ms epoch of the fetch these limits came from. */
  fetchedAtMs: number;
  limits: UsageLimit[];
  /**
   * Why the most recent fetch failed, when it did. `limits` are then the last
   * good read (possibly empty), and `fetchedAtMs` says how old they are.
   */
  error?: string;
}

/** Colour band for a usage card. Yellow from 70%, orange from 90%: those are the
 * points where the rest of the day, or the week, starts needing a plan. */
export type UsageBand = 'ok' | 'warn' | 'high';

export function usageBand(l: Pick<UsageLimit, 'percent' | 'severity'>): UsageBand {
  if (l.percent >= 90) return 'high';
  if (l.percent >= 70) return 'warn';
  // Trust a non-normal server severity even below our thresholds.
  return l.severity && l.severity !== 'normal' ? 'warn' : 'ok';
}

/**
 * "Resets in 4h 12m" — two units, because "4h" alone hides whether the session
 * window frees up before or after lunch. Past the reset time the card says so
 * rather than counting negative; the next fetch replaces it.
 */
export function usageResetText(resetsAtMs: number | undefined, nowMs: number): string {
  if (resetsAtMs === undefined) return '';
  const ms = resetsAtMs - nowMs;
  if (ms <= 0) return 'Resetting…';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `Resets in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `Resets in ${h}h ${m}m` : `Resets in ${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `Resets in ${d}d ${rh}h` : `Resets in ${d}d`;
}

/**
 * Text for the ETA column of a busy row.
 *
 * The estimate is a percentile of past turns, never a prediction of this one,
 * and the number shown tracks which percentile still has something to say:
 *
 * - below the median: time until half of your turns are done (`~2m`). A young
 *   turn most likely finishes soon, and p50 is the honest way to say so.
 * - median to p90: time until 9 in 10 are done (`~27m`). Once a turn has
 *   outlived half its peers the median is spent; p90 is the next real bound.
 * - past p90: `>30m` — the distribution has nothing left to say, so the cell
 *   stops counting down rather than inventing a deadline it cannot know.
 *
 * The jump at the median is deliberate: it is the moment the turn stopped being
 * typical, and a smooth countdown through it would hide exactly that.
 */
export function etaText(elapsedMs: number, p50Ms: number, p90Ms: number): string {
  if (elapsedMs >= p90Ms) return `>${formatDuration(p90Ms)}`;
  const bound = elapsedMs < p50Ms ? p50Ms : p90Ms;
  return `~${formatDuration(bound - elapsedMs)}`;
}
