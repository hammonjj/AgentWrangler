import { Emitter, type Disposable } from '../../core/events';
import type { AgentProvider } from '../../core/provider';
import { readRolloutBlocks } from '../../codex/rollout';
import type { BlockPatch, ConvBlock } from '../../shared/conversation';
import type { AgentSession } from '../../shared/model';
import type { ConversationInit, ConversationSource } from './source';

export class CodexTranscriptSource implements ConversationSource {
  readonly kind = 'transcript' as const;
  private appendEmitter = new Emitter<ConvBlock[]>();
  private patchEmitter = new Emitter<BlockPatch>();
  private subscription?: Disposable;
  private blocks: ConvBlock[] = [];
  private pumping = false;

  constructor(private session: AgentSession, provider: AgentProvider) {
    this.subscription = provider.onTranscriptAppended?.((event) => {
      if (event.sessionId === this.session.sessionId.toLowerCase()) void this.pump();
    });
  }

  onAppend = (listener: (blocks: ConvBlock[]) => void): Disposable => this.appendEmitter.event(listener);
  onPatch = (listener: (patch: BlockPatch) => void): Disposable => this.patchEmitter.event(listener);

  async init(): Promise<ConversationInit> {
    const read = await this.read();
    this.blocks = read.blocks;
    return read;
  }

  setSession(session: AgentSession): void {
    this.session = session;
    void this.pump();
  }

  private async read(): Promise<ConversationInit> {
    if (!this.session.transcriptPath) return { blocks: [], truncated: false };
    return readRolloutBlocks(this.session.transcriptPath).catch(() => ({ blocks: [], truncated: false }));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const read = await this.read();
      const previous = new Map(this.blocks.map((block) => [block.id, block]));
      for (const after of read.blocks) {
        const before = previous.get(after.id);
        if (before && JSON.stringify(before) !== JSON.stringify(after)) {
          this.patchEmitter.fire({ id: after.id, block: after });
        }
      }
      const added = read.blocks.filter((block) => !previous.has(block.id));
      this.blocks = read.blocks;
      if (added.length > 0) this.appendEmitter.fire(added);
    } finally {
      this.pumping = false;
    }
  }

  dispose(): void {
    this.subscription?.dispose();
    this.appendEmitter.dispose();
    this.patchEmitter.dispose();
  }
}
