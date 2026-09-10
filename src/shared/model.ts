/**
 * Shared data model. This file is imported by BOTH the extension host and the
 * webview bundles — it must stay free of `vscode`, Node, and DOM imports.
 */

export type SessionStatus = 'blocked' | 'waiting' | 'busy' | 'stuck' | 'ended';

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
  /** Session cwd is inside this window's workspace → click opens it in the Claude panel (host decorates). */
  inWorkspace?: boolean;
  /**
   * True when `status` was inferred from the transcript rather than pushed by a
   * hook — i.e. a session started before hooks were installed. Rendered dimmed
   * with a `~` so a guess is never mistaken for ground truth.
   */
  statusIsEstimated?: boolean;
  /** For `blocked`: what Claude is asking for (tool name, or an elicitation label). */
  blockedReason?: string;
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
  busy: 3,
  ended: 4,
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  blocked: 'Blocked on you',
  waiting: 'Waiting on you',
  stuck: 'Possibly stuck',
  busy: 'Busy',
  ended: 'Ended',
};

/** Blocked first (an agent frozen mid-task), then waiting, stuck, busy, ended;
 * within a rank, most recent activity first. */
export function compareSessions(a: AgentSession, b: AgentSession): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return b.lastActivityAt - a.lastActivityAt;
}

/** Dashboard sections: the five statuses, plus Archived pinned last. */
export type SectionId = SessionStatus | 'archived';

export const SECTION_ORDER: SectionId[] = ['blocked', 'waiting', 'stuck', 'busy', 'ended', 'archived'];

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

/**
 * Label for the pace chip, or '' to show nothing.
 *
 * Silent below the median, which is the important part: a turn three seconds
 * old is unremarkable, and putting "~28m" on it would read as a prediction of
 * 28 minutes when most turns are done inside three. Once a turn has outlived
 * half its peers, "most of the rest finish by p90" becomes a real statement
 * about the distribution and is worth showing. Past p90 the distribution has
 * nothing left to say, so it stops predicting rather than counting down to a
 * deadline it cannot know.
 */
export function paceText(elapsedMs: number, p50Ms: number, p75Ms: number, p90Ms: number): string {
  if (elapsedMs >= p90Ms) return 'very long';
  if (elapsedMs < p50Ms) return '';
  const left = `~${formatDuration(p90Ms - elapsedMs)}`;
  return elapsedMs >= p75Ms ? `long · ${left}` : left;
}
