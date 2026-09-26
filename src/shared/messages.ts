/**
 * Typed message protocol between the extension host and the webviews.
 * Imported by both bundles — keep free of `vscode`/Node/DOM imports.
 */
import type { ColumnPrefs } from './columns';
import type {
  ComposerState,
  ConversationCapabilities,
  ConvBlock,
  ImageAttachment,
  ModelChoice,
  PermissionModeName,
} from './conversation';
import type { HookHealth, ProjectDTO, SessionDTO } from './model';
import type { UsageState } from './usage';

// ---- Dashboard ----

/**
 * `hooks` is absent until the host has checked settings.json once. `usage` is
 * absent when the usage cards are turned off; present-but-empty until the
 * first read lands.
 */
export type HostToDashboard =
  | {
      type: 'snapshot';
      sessions: SessionDTO[];
      nowMs: number;
      hooks?: HookHealth;
      usage?: UsageState;
      codexUsage?: UsageState;
      /** Saved column layout. Absent only before the host has read storage once. */
      columns?: ColumnPrefs;
      showCodexSubagents?: boolean;
      /**
       * The toolbar's Discord button. `configured` is what makes it exist at
       * all — with the integration off there is nothing to mute — and `on` is
       * whether announcements are being posted. Absent only before the host has
       * read settings once.
       */
      discord?: { configured: boolean; on: boolean };
      /**
       * What the launcher's model and effort dropdowns show: the models the
       * last conversation reported, and the defaults a new one will start on.
       * `model`/`effort` are empty when the setting is unset, which means
       * "whatever Claude Code picks".
       */
      launcher?: {
        /** Orchestration is on: show the Tasks button (#33). */
        tasks?: boolean;
        models: ModelChoice[];
        provider: 'anthropic' | 'openai';
        anthropic: { model: string; effort: string };
        openai: { model: string; effort: string };
      };
      /**
       * Folders the launcher's dropdown offers, newest-used first. Absent until
       * the first scan resolves; an empty array means the scan genuinely found
       * nothing, which is a different thing and leaves only "Browse…".
       */
      projects?: ProjectDTO[];
    }
  /**
   * The folder dialog closed on a choice. Sent before the snapshot that will
   * contain it, because the webview has to know which entry to select and the
   * list alone cannot say — a browsed folder is not necessarily the newest.
   */
  | { type: 'projectPicked'; dir: string };

/**
 * `allow` / `deny` / `always` answer the permission prompt a blocked row is
 * sitting on; `always` also adds the rule Claude Code's "don't ask again" would.
 * `copyId` and `close` come from the row's right-click menu (see
 * `shared/rowMenu.ts`). `close` ends the process running the session and is the
 * only one of these the user can lose work to, so the host confirms it first.
 */
/**
 * Which half of the workbench a message belongs to. The dashboard and the
 * conversation share one webview, and their message unions overlap (`ready`,
 * `openExternal`), so every message is addressed rather than sniffed.
 */
export type PaneName = 'dashboard' | 'conversation';

export type DashboardAction =
  /** Open the conversation in a tab of its own that row clicks never swap away. */
  | 'openInTab'
  /** Ask for the user's own name for this conversation. */
  | 'rename'
  /** Resume an *ended* session in a terminal. Not the opposite of `pause` — see `unpause`. */
  | 'resume'
  /** Resume an interrupted session here, in this app, the way it was started. */
  | 'resumeHere'
  | 'archive'
  | 'copyId'
  | 'close'
  /**
   * The row's × button: `close`, but the modal is only raised when a turn is in
   * flight. Nothing else about it differs — the process ends and the transcript
   * is kept either way.
   */
  | 'dismiss'
  /** Stop this session's process (SIGSTOP) so it spends nothing. */
  | 'pause'
  /** Let a paused session run again (SIGCONT). */
  | 'unpause'
  | 'allow'
  | 'deny'
  | 'always';

export type DashboardToHost =
  | { type: 'ready' }
  | { type: 'rowClick'; key: string }
  /**
   * `requestId` is carried by the three permission actions only: it is the
   * `permissionRequestId` the card was drawn from, so the host can refuse an
   * answer meant for a prompt the session has since moved on from. Absent on
   * every other action, and on a card drawn before this field existed.
   */
  | { type: 'action'; key: string; action: DashboardAction; requestId?: string }
  | { type: 'answerQuestion'; key: string; requestId: string; answers: Record<string, string> }
  | { type: 'openExternal'; url: string }
  | { type: 'refresh' }
  /** Banner button: runs the same confirm-then-install flow as the palette command. */
  | { type: 'installHooks' }
  /** A column was dragged, hidden or shown — persist this layout for every dashboard. */
  | { type: 'setColumns'; prefs: ColumnPrefs }
  | { type: 'setShowCodexSubagents'; value: boolean }
  /** The bar's Discord button: post announcements to the channel, or go quiet. */
  | { type: 'setDiscordNotifications'; value: boolean }
  /** Start a Claude Code conversation in `cwd`, this window running it, and show the pane. */
  | { type: 'newConversation'; cwd: string; provider?: 'claude' | 'codex' }
  /** The Tasks button: run a task in `cwd` on the launcher's route, or act on a running one (#33). */
  | { type: 'taskMenu'; cwd: string; provider?: 'claude' | 'codex' }
  /** The launcher's dropdowns: the default a *new* conversation starts on. */
  | { type: 'setRunnerModel'; provider: 'anthropic' | 'openai'; model: string }
  | { type: 'setRunnerEffort'; provider: 'anthropic' | 'openai'; effort: string }
  /** "Browse…" was chosen: open the folder dialog. A choice comes back as `projectPicked`. */
  | { type: 'browseProject' }
  /** The X on a dropdown row: stop offering this folder. Browsing back to it undoes this. */
  | { type: 'removeProject'; dir: string }
  /** The star on a dropdown row: pin this folder to the top of the list, or unpin it. */
  | { type: 'setProjectFavourite'; dir: string; favourite: boolean }
  /** The dropdown was opened — re-scan, since a folder may have been used elsewhere since the last snapshot. */
  | { type: 'refreshProjects' }
  /**
   * The bar's pause button: freeze every running agent on the machine, or thaw
   * everything currently frozen. Machine-wide on purpose — the budget being
   * protected is the account's, not this window's.
   */
  | { type: 'pauseAll'; pause: boolean };

// ---- Conversation pane ----

/**
 * The pane is fed by either a transcript being tailed or (from phase 2) a
 * Claude Code process this extension drives. `composer` is present only in the
 * second case; its absence is what makes the pane read-only.
 */
export type HostToConversation =
  | {
      type: 'init';
      session: SessionDTO;
      blocks: ConvBlock[];
      /** Earlier conversation exists above the first block. */
      truncated: boolean;
      caps: ConversationCapabilities;
      composer?: ComposerState;
    }
  | { type: 'append'; blocks: ConvBlock[] }
  /** In-place update of one block: a tool's result, a streaming reply, an ask being settled. */
  | { type: 'patch'; id: string; block: Partial<ConvBlock> }
  | { type: 'session'; session: SessionDTO; caps: ConversationCapabilities }
  | { type: 'composer'; composer: ComposerState }
  /**
   * The whole of a block the pane only got the start of — the answer to
   * `requestBlockText`. Absent entirely when the host no longer holds it
   * (evicted, or a reload since), which the pane says on the button rather
   * than leaving it spinning.
   */
  | { type: 'blockText'; id: string; text?: string }
  | { type: 'archive'; requestId: string; blocks: ConvBlock[]; more: boolean; query: string; error?: string }
  | { type: 'subagent'; id: string; blocks: ConvBlock[]; more: boolean; error?: string }
  /**
   * Where dictation has got to. `text` arrives once, with `state: 'idle'`, and
   * is what the composer inserts; an empty string means nothing was said.
   * `message` is a problem shown beside the composer rather than as an error
   * block — a missing tool, a refused microphone, a failed transcription.
   * `notice` is information that is not a failure (the recording limit).
   */
  | {
      type: 'dictation';
      state: 'idle' | 'recording' | 'transcribing';
      text?: string;
      message?: string;
      notice?: string;
      /** With `recording`: whether previews will follow (`dictation.livePreview`). */
      livePreview?: boolean;
    }
  /**
   * Provisional text while recording, replacing the previous preview whole.
   * Never inserted into the composer: the final `dictation` text is a fresh
   * transcription of the entire recording. `recordedMs - coveredMs` is how far
   * behind the preview is.
   */
  | { type: 'dictationPreview'; text: string; recordedMs: number; coveredMs: number; previewError?: string }
  /**
   * Answer to `fileSuggest`. `query` comes back so a slow answer to an earlier
   * keystroke cannot replace the list for what is on screen now.
   */
  | { type: 'fileSuggestions'; query: string; files: string[] }
  /**
   * Answer to `dropPaths`: `mentions` go in the box as text, `images` join the
   * pasted ones as attachments, and `notes` are the ones that could not be
   * taken (unreadable, or an image past the size limit).
   */
  | { type: 'dropped'; mentions: string[]; images: ImageAttachment[]; notes: string[] }
  | { type: 'sendResult'; requestId: string; error?: string; adopted?: boolean }
  | { type: 'error'; text: string };

export type ConversationToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: ImageAttachment[]; requestId?: string; sessionKey?: string }
  | { type: 'cancelSend' }
  | { type: 'interrupt' }
  | { type: 'decide'; requestId: string; decision: 'allow' | 'always' | 'deny'; message?: string }
  | { type: 'answer'; requestId: string; answers: Record<string, string> }
  | { type: 'plan'; requestId: string; decision: 'approve' | 'deny'; feedback?: string }
  | { type: 'setPermissionMode'; mode: PermissionModeName }
  | { type: 'setModel'; model?: string }
  /** How hard to think. Empty string puts the CLI's own default back. */
  | { type: 'setEffort'; effort: string }
  | { type: 'adopt' }
  | { type: 'release' }
  /** The pane's own button for "give this conversation a tab of its own". */
  | { type: 'openInTab' }
  | { type: 'resumeHere' }
  /** Install Claude status hooks from the transcript warning. */
  | { type: 'installHooks' }
  /** "Show the rest" on a block whose text was capped for the wire. */
  | { type: 'requestBlockText'; id: string; toolUseId?: string }
  | { type: 'archive'; requestId: string; before?: string; beforeTime?: string; query?: string }
  | { type: 'subagent'; id: string; toolUseId: string; before?: string }
  /**
   * Open an edit's patch in VSCode's diff editor. The patch travels with the
   * message because the webview is what holds the rendered blocks — the host
   * hands them over at `init` and does not keep a copy.
   */
  | { type: 'openDiff'; file: string; patch: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openFile'; path: string }
  /**
   * The microphone button. `stop` transcribes what was recorded and answers
   * with a `dictation` message — it never sends anything to the agent;
   * `cancel` throws the audio away without transcribing.
   */
  | { type: 'dictate'; action: 'start' | 'stop' | 'cancel' }
  /** An `@` is being typed: what files in the session's folder match so far. */
  | { type: 'fileSuggest'; query: string }
  /**
   * Files were dropped on the pane. Only the host can tell an image from a
   * folder or read either, so the webview hands over the paths and is told what
   * to put in the composer.
   */
  | { type: 'dropPaths'; paths: string[] };
