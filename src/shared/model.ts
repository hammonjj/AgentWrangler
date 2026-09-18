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
 * What a row click does.
 *
 * `conversation` — the Agent Wrangler conversation pane in this window. The
 * default for every session, because jumping the user between VSCode windows
 * to reach a conversation costs more attention than it is worth.
 *
 * The rest are the old "go to wherever it runs" behaviour, still reachable via
 * `agentWrangler.rowClickOpens` and always available as the pane's own
 * secondary action. `panel`: the Claude Code panel in this window. `terminal`:
 * show the integrated terminal running it. `window`: hand off to the VSCode
 * window that owns it. `resume`: a new terminal running `claude --resume`.
 */
export type OpenTarget = 'conversation' | 'panel' | 'terminal' | 'window' | 'resume';

export interface AgentSession {
  /** Provider id, e.g. 'claude'. */
  provider: string;
  /** Client that originated the session, e.g. vscode, cli, or desktop. */
  client?: string;
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
  /**
   * Name of the linked git worktree this session is working in, when it is in
   * one — the directory `git worktree add` created. Absent in a main checkout,
   * which is the point: the column is only ever filled in for the trees that
   * are easy to lose track of.
   */
  worktree?: string;
  /** Absolute path of that worktree's root, for the cell's tooltip. */
  worktreePath?: string;
  /** Wire id of the model behind the latest reply, e.g. `claude-opus-5`; the Model column shortens it. */
  model?: string;
  status: SessionStatus;
  /** ms epoch of last observed activity (transcript mtime, else registry startedAt). */
  lastActivityAt: number;
  /**
   * ms epoch the *process* started, from the pid registry. Not the age of the
   * conversation: a `--resume` starts a new process on an old conversation, so
   * this is when the session was last picked up, and it is absent entirely for
   * ended sessions. `conversationStartedAt` is the one to show a human.
   */
  startedAt?: number;
  /**
   * ms epoch the conversation itself began — its first prompt, however many
   * processes and resumes ago that was. Taken from the transcript file's
   * creation time, which is exact for the purpose: Claude Code writes no
   * transcript until the first prompt lands, and a resume appends to the same
   * file rather than starting a new one.
   */
  conversationStartedAt?: number;
  kind?: SessionKind;
  entrypoint?: string;
  transcriptPath?: string;
  pid?: number;
  prLink?: PrLink;
  /** User shoved this session out of the way (host decorates from ArchiveService). */
  archived?: boolean;
  /**
   * User wants this one kept in front of them, in the section at the top (host
   * decorates from PinService). Mutually exclusive with `archived`.
   */
  pinned?: boolean;
  /** ms epoch the pin was made — the Pinned section sorts by it, so pins hold still. */
  pinnedAt?: number;
  /**
   * A name the user gave this conversation, shown instead of `title` (host
   * decorates from NicknameService). The original title is never overwritten,
   * so clearing the nickname brings it back — see `displayTitle`.
   */
  nickname?: string;
  /**
   * Its process is stopped (SIGSTOP) and spending nothing until resumed (host
   * decorates from PauseService). A paused session keeps whatever `status` it
   * had when it was frozen — that status is simply no longer moving, which is
   * the point — so the row is grouped by `sectionOf` instead.
   */
  paused?: boolean;
  /** What clicking the row does, decided by the host from where the process lives (host decorates). */
  openTarget?: OpenTarget;
  /**
   * This window is running the session itself, so the conversation pane can be
   * typed into rather than only read (host decorates).
   */
  runnerOwned?: boolean;
  /**
   * True when `status` was inferred from the transcript rather than pushed by a
   * hook — i.e. a session started before hooks were installed. Rendered dimmed
   * with a `~` so a guess is never mistaken for ground truth.
   */
  statusIsEstimated?: boolean;
  /** For `blocked`: what Claude is asking for (tool name, or an elicitation label). */
  blockedReason?: string;
  /**
   * For `blocked`: what the permission is actually for — the command, the file
   * an Edit touches, the question being asked. Read off the hook payload's
   * `tool_input`, so absent without hooks.
   */
  blockedAsk?: PermissionAsk;
  /**
   * For `blocked`: set while our PermissionRequest hook is still waiting for a
   * decision file, i.e. while Allow/Deny from the dashboard can still land.
   * Absent once the user has answered in Claude Code itself.
   */
  permissionRequestId?: string;
  /**
   * For `blocked`: the rule an *Always allow* would add, as Claude Code itself
   * would phrase it (`Bash(npm test:*)`), and where it would be saved. Present
   * only when the payload offered a suggestion — the same one Claude Code's own
   * "don't ask again" would apply.
   */
  alwaysAllow?: { rules: string[]; destination: string };
  /** For `busy`: the tool currently in flight, so a long build reads as work, not a stall. */
  activeTool?: { name: string; sinceMs: number };
  /** For `busy`: how far into the current turn we are. Requires hooks. */
  progress?: TurnProgress;
}

/**
 * A permission prompt, broken into the two things a decision actually needs:
 * what Claude says it is doing, and the literal thing that will happen. Kept
 * apart rather than pre-joined into one line because the dashboard shows the
 * command on its own, monospaced and over as many lines as it takes.
 */
export interface PermissionAsk {
  /** Claude's own one-line description, when it gave one ("Run the unit tests"). */
  summary?: string;
  /** The subject itself: the command, the file, the URL, the question. May be multi-line. */
  body?: string;
  /** `body` is a shell command — rendered monospace and labelled as one. */
  isCommand?: boolean;
}

/** The ask flattened to one line, for tooltips and the narrow layout. */
export function askLine(ask: PermissionAsk | undefined): string | undefined {
  if (!ask) return undefined;
  const body = ask.body?.replace(/\s+/g, ' ').trim();
  if (ask.summary && body) return `${ask.summary} — ${body}`;
  return ask.summary ?? (body || undefined);
}

/** Working time spent on this turn — wall clock minus time parked on a human. */
export function workingElapsedMs(p: TurnProgress, nowMs: number): number {
  return Math.max(0, nowMs - p.startedAtMs - p.blockedMs);
}

/** DTO sent over the webview wire — AgentSession is already JSON-safe. */
export type SessionDTO = AgentSession;

/**
 * A folder a conversation can be started in: somewhere Claude Code has already
 * been used, a workspace folder, or one the user browsed to. `dir` is the real
 * absolute path and the identity; `name` is only what the dropdown has room to
 * show at 300px, and is not unique (two checkouts of one repo share a basename,
 * which is why the full path rides along as the option's tooltip).
 */
export interface ProjectDTO {
  dir: string;
  name: string;
  /** Newest transcript activity in this folder, when anything is known. Absent = never used. */
  lastUsedAt?: number;
}

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
  waiting: 'Waiting',
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

/** Dashboard sections: Pinned first, then the six statuses, Paused, and Archived last. */
export type SectionId = SessionStatus | 'pinned' | 'paused' | 'archived';

/**
 * The two sections the user puts things in bracket the ones the agents put
 * themselves in: Pinned at the top, Archived at the bottom, status in between.
 *
 * Paused sits above Ended, not below it: a paused agent is still a live process
 * with a conversation you are coming back to, and the two things you might do
 * about it — resume it, or decide you are done with it — are both worth seeing
 * before a list of sessions that are already over.
 */
export const SECTION_ORDER: SectionId[] = [
  'pinned',
  'blocked',
  'waiting',
  'stuck',
  'done',
  'busy',
  'paused',
  'ended',
  'archived',
];

export const SECTION_LABEL: Record<SectionId, string> = {
  ...STATUS_LABEL,
  pinned: 'Pinned',
  paused: 'Paused',
  archived: 'Archived',
};

/**
 * Which section a row belongs to, most explicit instruction first.
 *
 * Pinned wins over everything, including Blocked: "keep this in front of me" is
 * a standing instruction from the user, where every status is something the
 * agent did. Nothing is lost by it — a pinned blocked row keeps its status dot,
 * its permission card and its place in the status-bar bell, so the only thing
 * pinning changes is where it sits. (Pinned and archived are mutually exclusive
 * at the point of action; the order here only settles a stale pair.)
 *
 * Paused beats the underlying status because a frozen session's status stopped
 * moving with it — a paused `busy` row left in Busy would sit there looking
 * like work in progress, and would drift into *Possibly stuck* ten minutes
 * later, which is exactly the wrong thing to say about a process somebody
 * stopped on purpose.
 */
export function sectionOf(s: AgentSession): SectionId {
  if (s.pinned) return 'pinned';
  if (s.archived) return 'archived';
  return s.paused ? 'paused' : s.status;
}

/**
 * What to call this session on screen: the user's nickname when they gave one,
 * otherwise the title it came with. Every surface that shows a session to a
 * human goes through here, so a rename is one edit rather than a list of places
 * that have to be kept in step.
 */
export function displayTitle(s: Pick<AgentSession, 'nickname' | 'title'>): string {
  return s.nickname ?? s.title;
}

/**
 * The same, for the surfaces that have room for one short string and have
 * always preferred the registry's handle to the derived title — the status bar,
 * the toasts, the confirms, the terminal tab. A nickname outranks both: the
 * point of giving something a name is that the name is what you see.
 */
export function displayLabel(s: Pick<AgentSession, 'nickname' | 'name' | 'title'>): string {
  return s.nickname ?? s.name ?? s.title;
}

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
