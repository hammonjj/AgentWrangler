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
      /** Saved column layout. Absent only before the host has read storage once. */
      columns?: ColumnPrefs;
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
 * `pin` opens a conversation panel of this session's own, which the reusable
 * pane never swaps away from.
 *
 * `copyId`, `goTo` and `close` come from the row's right-click menu (see
 * `shared/rowMenu.ts`). `close` ends the process running the session and is the
 * only one of these the user can lose work to, so the host confirms it first.
 */
export type DashboardAction =
  | 'pin'
  | 'resume'
  | 'archive'
  | 'copyId'
  | 'goTo'
  | 'close'
  | 'allow'
  | 'deny'
  | 'always';

export type DashboardToHost =
  | { type: 'ready' }
  | { type: 'rowClick'; key: string }
  | { type: 'action'; key: string; action: DashboardAction }
  | { type: 'openExternal'; url: string }
  | { type: 'refresh' }
  /** Banner button: runs the same confirm-then-install flow as the palette command. */
  | { type: 'installHooks' }
  /** A column was dragged, hidden or shown — persist this layout for every dashboard. */
  | { type: 'setColumns'; prefs: ColumnPrefs }
  /** Start a Claude Code conversation in `cwd`, this window running it, and show the pane. */
  | { type: 'newConversation'; cwd: string }
  /** "Browse…" was chosen: open the folder dialog. A choice comes back as `projectPicked`. */
  | { type: 'browseProject' }
  /** The X on a dropdown row: stop offering this folder. Browsing back to it undoes this. */
  | { type: 'removeProject'; dir: string }
  /** The dropdown was opened — re-scan, since a folder may have been used elsewhere since the last snapshot. */
  | { type: 'refreshProjects' };

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
  | { type: 'toolResult'; id: string; text: string }
  /**
   * Where dictation has got to. `text` arrives once, with `state: 'idle'`, and
   * is what the composer inserts; an empty string means nothing was said.
   * `message` is a problem worth showing on the button rather than as an error
   * block — a missing tool, usually, which the host has already offered to fix.
   */
  | { type: 'dictation'; state: 'idle' | 'recording' | 'transcribing'; text?: string; message?: string }
  /**
   * Answer to `fileSuggest`. `query` comes back so a slow answer to an earlier
   * keystroke cannot replace the list for what is on screen now.
   */
  | { type: 'fileSuggestions'; query: string; files: string[] }
  | { type: 'error'; text: string };

export type ConversationToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: ImageAttachment[] }
  | { type: 'interrupt' }
  | { type: 'decide'; requestId: string; decision: 'allow' | 'always' | 'deny'; message?: string }
  | { type: 'answer'; requestId: string; answers: Record<string, string> }
  | { type: 'plan'; requestId: string; decision: 'approve' | 'deny'; feedback?: string }
  | { type: 'setPermissionMode'; mode: PermissionModeName }
  | { type: 'setModel'; model?: string }
  | { type: 'adopt' }
  | { type: 'release' }
  /** The demoted old behaviour: go to the panel, terminal or window that runs this session. */
  | { type: 'goTo' }
  | { type: 'pin' }
  | { type: 'resumeHere' }
  | { type: 'requestToolResult'; id: string }
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
   * with a `dictation` message; `cancel` throws it away without transcribing.
   */
  | { type: 'dictate'; action: 'start' | 'stop' | 'cancel' }
  /** An `@` is being typed: what files in the session's folder match so far. */
  | { type: 'fileSuggest'; query: string };
