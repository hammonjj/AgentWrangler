/**
 * A durable agent with nothing to continue (#179), shown as an empty
 * conversation the user can type into straight away. Nothing runs until the
 * first message: sending it starts the agent's session, which the host then
 * shows in this one's place.
 */
import type { Disposable } from '../../core/events';
import type { BlockPatch, ConvBlock, ImageAttachment } from '../../shared/conversation';
import type { AgentSession } from '../../shared/model';
import type { ConversationInit, ConversationSource } from './source';

const NONE: Disposable = { dispose: () => undefined };

export class AgentDraftSource implements ConversationSource {
  readonly kind = 'draft' as const;

  constructor(
    private session: AgentSession,
    private notice: string | undefined,
    private start: (text: string, images?: ImageAttachment[]) => Promise<void>,
  ) {}

  async init(): Promise<ConversationInit> {
    const blocks: ConvBlock[] = [];
    if (this.notice) blocks.push({ kind: 'note', id: 'agent-notice', tone: 'warn', text: this.notice });
    blocks.push({ kind: 'note', id: 'agent-draft', tone: 'info', text: this.session.subtitle ?? 'Your first message starts this agent’s conversation.' });
    return { blocks, truncated: false };
  }

  onAppend(): Disposable {
    return NONE;
  }

  onPatch(_listener: (patch: BlockPatch) => void): Disposable {
    return NONE;
  }

  setSession(session: AgentSession): void {
    this.session = session;
  }

  send(text: string, images?: ImageAttachment[]): Promise<void> {
    return this.start(text, images);
  }

  dispose(): void {
    // Nothing is running.
  }
}
