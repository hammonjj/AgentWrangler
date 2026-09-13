/**
 * What the conversation pane talks to.
 *
 * Two implementations exist: one tails a transcript file (any session, on this
 * machine, anywhere — read-only, with permissions answered through the hook
 * that Claude Code races against its own dialog), and one drives a Claude Code
 * process this extension owns (phase 2 — full duplex). The pane holds this
 * interface and nothing else, so it cannot accidentally depend on which it has.
 *
 * Everything past `init`/`onAppend`/`onPatch` is optional: a source advertises
 * what it can do by implementing it, and the host turns that into the
 * capabilities the webview renders buttons from.
 */
import type { Disposable } from '../../core/events';
import type { BlockPatch, ComposerState, ConvBlock, ImageAttachment, PermissionModeName } from '../../shared/conversation';
import type { AgentSession } from '../../shared/model';

export interface ConversationInit {
  blocks: ConvBlock[];
  /** Conversation exists above the first block; the pane says so rather than implying a start. */
  truncated: boolean;
}

export interface ConversationSource extends Disposable {
  readonly kind: 'transcript' | 'runner';

  /** Everything to show right now. Called once, when the webview says it is ready. */
  init(): Promise<ConversationInit>;

  onAppend(listener: (blocks: ConvBlock[]) => void): Disposable;
  onPatch(listener: (patch: BlockPatch) => void): Disposable;

  /** The store's view of this session changed (title, status, a new permission prompt). */
  setSession(session: AgentSession): void;

  /** Live state of a driven session. Absent here means the pane is read-only. */
  onComposer?(listener: (composer: ComposerState) => void): Disposable;
  readonly composer?: ComposerState;

  /** Answer a permission ask. Resolves false when there was nothing left to answer. */
  decide?(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): Promise<boolean>;
  answer?(requestId: string, answers: Record<string, string>): Promise<boolean>;
  decidePlan?(requestId: string, approve: boolean, feedback?: string): Promise<boolean>;

  send?(text: string, images?: ImageAttachment[]): Promise<void>;
  interrupt?(): Promise<void>;
  setPermissionMode?(mode: PermissionModeName): Promise<void>;
  setModel?(model?: string): Promise<void>;

  /** The untruncated text of a tool result the pane only got a prefix of. */
  fullToolResult?(blockId: string): string | undefined;
}
