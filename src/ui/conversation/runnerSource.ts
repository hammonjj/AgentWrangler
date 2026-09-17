/**
 * A conversation driven by a Claude Code process this extension owns.
 *
 * Thin by design: `RunnerSession` already holds the blocks and the pending
 * asks, because it must outlive the pane. Closing the pane disposes this
 * adapter and leaves the session running — which is why `dispose` here only
 * unsubscribes, and never ends anything.
 *
 * The one thing it adds is the past: a resumed session's blocks start at the
 * moment this process took over, so `init` puts the transcript's history in
 * front of them.
 */
import type { RunnerSession } from '../../claude/runner/runnerSession';
import type { Disposable } from '../../core/events';
import type { BlockPatch, ComposerState, ConvBlock, ImageAttachment, PermissionModeName } from '../../shared/conversation';
import type { ConversationInit, ConversationSource } from './source';

export class RunnerSource implements ConversationSource {
  readonly kind = 'runner' as const;
  private subs: Disposable[] = [];

  constructor(readonly runner: RunnerSession) {}

  /**
   * The conversation so far: what the session said before this process resumed
   * it, read from its transcript, followed by what has happened since. The two
   * cannot overlap — the history is snapshotted before the process starts — and
   * their block ids cannot collide, `t:` against `r:`.
   */
  async init(): Promise<ConversationInit> {
    const history = await this.runner.history();
    return {
      blocks: [...history.blocks, ...this.runner.blocks],
      truncated: history.truncated || this.runner.everythingTruncated,
    };
  }

  onAppend(listener: (blocks: ConvBlock[]) => void): Disposable {
    const sub = this.runner.onAppend(listener);
    this.subs.push(sub);
    return sub;
  }

  onPatch(listener: (patch: BlockPatch) => void): Disposable {
    const sub = this.runner.onPatch(listener);
    this.subs.push(sub);
    return sub;
  }

  onComposer(listener: (composer: ComposerState) => void): Disposable {
    const sub = this.runner.onComposer(listener);
    this.subs.push(sub);
    return sub;
  }

  get composer(): ComposerState {
    return this.runner.composer;
  }

  /** The store's view is decoration here; the runner is the source of truth. */
  setSession(): void {
    // nothing to do
  }

  async decide(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): Promise<boolean> {
    return this.runner.decide(requestId, decision, message);
  }

  async answer(requestId: string, answers: Record<string, string>): Promise<boolean> {
    return this.runner.answer(requestId, answers);
  }

  async decidePlan(requestId: string, approve: boolean, feedback?: string): Promise<boolean> {
    return this.runner.decidePlan(requestId, approve, feedback);
  }

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.runner.send(text, images);
  }

  async interrupt(): Promise<void> {
    await this.runner.interrupt();
  }

  async setPermissionMode(mode: PermissionModeName): Promise<void> {
    await this.runner.setPermissionMode(mode);
  }

  async setModel(model?: string): Promise<void> {
    await this.runner.setModel(model);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }
}
