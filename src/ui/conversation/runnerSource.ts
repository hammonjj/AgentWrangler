/**
 * A conversation driven by a session Agent Wrangler runs itself, Claude or
 * Codex, through its `SessionHandle`.
 *
 * Thin by design: the handle holds the blocks and the pending asks, because it
 * must outlive the pane. Closing the pane disposes this adapter and leaves the
 * session running, which is why `dispose` here only unsubscribes and never
 * ends anything.
 *
 * The one thing it adds is the past: a resumed Claude session's blocks start
 * at the moment this process took over, so `init` puts the transcript's
 * history in front of them.
 */
import type { Disposable } from '../../core/events';
import type { CommandOutcome, SessionHandle } from '../../core/session/sessionHandle';
import type { BlockPatch, ComposerState, ConvBlock, ImageAttachment, PermissionModeName } from '../../shared/conversation';
import type { ConversationInit, ConversationSource } from './source';

export class LiveSessionSource implements ConversationSource {
  readonly kind = 'runner' as const;
  private subs: Disposable[] = [];

  constructor(readonly handle: SessionHandle) {}

  /**
   * The conversation so far: what the session said before this process
   * resumed it, followed by what has happened since. The two cannot overlap
   * (the history is snapshotted before the process starts) and their block ids
   * cannot collide, `t:` against `r:`.
   */
  async init(): Promise<ConversationInit> {
    const history = await this.handle.history();
    const now = this.handle.snapshot();
    return {
      blocks: [...history.blocks, ...now.blocks],
      truncated: history.truncated || now.truncated,
    };
  }

  onAppend(listener: (blocks: ConvBlock[]) => void): Disposable {
    return this.track(this.handle.onAppend(listener));
  }

  onPatch(listener: (patch: BlockPatch) => void): Disposable {
    return this.track(this.handle.onPatch(listener));
  }

  onComposer(listener: (composer: ComposerState) => void): Disposable {
    return this.track(this.handle.onComposer(listener));
  }

  get composer(): ComposerState {
    return this.handle.composer;
  }

  /** The store's view is decoration here; the handle is the source of truth. */
  setSession(): void {
    // nothing to do
  }

  async decide(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): Promise<boolean> {
    return applied(await this.handle.decide(requestId, decision, message));
  }

  async answer(requestId: string, answers: Record<string, string>): Promise<boolean> {
    return applied(await this.handle.answer(requestId, answers));
  }

  async decidePlan(requestId: string, approve: boolean, feedback?: string): Promise<boolean> {
    return applied(await this.handle.decidePlan(requestId, approve, feedback));
  }

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.handle.canSend) throw new Error('The runner stopped; your draft is preserved.');
    const outcome = await this.handle.send(text, images);
    if (outcome !== 'applied') throw new Error('The runner stopped; your draft is preserved.');
  }

  async interrupt(): Promise<void> {
    await this.handle.interrupt();
  }

  async setPermissionMode(mode: PermissionModeName): Promise<void> {
    await this.handle.setPermissionMode(mode);
  }

  async setEffort(effort: string): Promise<void> {
    await this.handle.setEffort(effort);
  }

  async setModel(model?: string): Promise<void> {
    await this.handle.setModel(model);
  }

  fullBlockText(blockId: string): string | undefined {
    return this.handle.fullBlockText(blockId);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  private track(sub: Disposable): Disposable {
    this.subs.push(sub);
    return sub;
  }
}

function applied(outcome: CommandOutcome): boolean {
  return outcome === 'applied';
}
