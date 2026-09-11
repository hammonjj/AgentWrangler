/**
 * Typed message protocol between the extension host and the webviews.
 * Imported by both bundles — keep free of `vscode`/Node/DOM imports.
 */
import type { ColumnPrefs } from './columns';
import type {
  ComposerState,
  ConversationCapabilities,
  ConvBlock,
  PermissionModeName,
} from './conversation';
import type { HookHealth, SessionDTO } from './model';
import type { UsageState } from './usage';

// ---- Dashboard ----

/**
 * `hooks` is absent until the host has checked settings.json once. `usage` is
 * absent when the usage cards are turned off; present-but-empty until the
 * first read lands.
 */
export type HostToDashboard = {
  type: 'snapshot';
  sessions: SessionDTO[];
  nowMs: number;
  hooks?: HookHealth;
  usage?: UsageState;
  /** Saved column layout. Absent only before the host has read storage once. */
  columns?: ColumnPrefs;
};

/**
 * `allow` / `deny` / `always` answer the permission prompt a blocked row is
 * sitting on; `always` also adds the rule Claude Code's "don't ask again" would.
 * `pin` opens a conversation panel of this session's own, which the reusable
 * pane never swaps away from.
 */
export type DashboardAction = 'pin' | 'resume' | 'archive' | 'allow' | 'deny' | 'always';

export type DashboardToHost =
  | { type: 'ready' }
  | { type: 'rowClick'; key: string }
  | { type: 'action'; key: string; action: DashboardAction }
  | { type: 'openExternal'; url: string }
  | { type: 'refresh' }
  /** Banner button: runs the same confirm-then-install flow as the palette command. */
  | { type: 'installHooks' }
  /** A column was dragged, hidden or shown — persist this layout for every dashboard. */
  | { type: 'setColumns'; prefs: ColumnPrefs };

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
  | { type: 'error'; text: string };

export type ConversationToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
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
  | { type: 'openExternal'; url: string }
  | { type: 'openFile'; path: string };
