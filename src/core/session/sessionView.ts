/**
 * The event plumbing every `SessionHandle` shares: one numbered log of view
 * events, the per-kind listener conveniences over it, and the snapshot.
 *
 * Subclasses keep their own state and announce changes through the `emit*`
 * helpers; this class numbers them, keeps a bounded replay window, and fans
 * them out. It holds no provider knowledge.
 */
import type { Disposable } from '../events';
import type { BlockPatch, ComposerState, ConvBlock } from '../../shared/conversation';
import { SeqLog } from './seqLog';
import type { SessionLifecycle, SessionProvider, SessionViewEvent, SessionViewSnapshot } from './sessionHandle';

/**
 * View events kept for late subscribers. Every session has one, so it is kept
 * small: a subscriber further behind than this takes a snapshot instead.
 */
const VIEW_LOG_BYTES = 1024 * 1024;

export abstract class SessionViewBase {
  abstract readonly provider: SessionProvider;
  abstract readonly sessionId: string | undefined;
  abstract readonly lifecycle: SessionLifecycle;
  abstract readonly composer: ComposerState;
  abstract readonly blocks: readonly ConvBlock[];
  protected abstract get truncatedView(): boolean;

  private viewLog = new SeqLog<SessionViewEvent>({ maxBytes: VIEW_LOG_BYTES });

  snapshot(): SessionViewSnapshot {
    return {
      seq: this.viewLog.seq,
      provider: this.provider,
      sessionId: this.sessionId,
      lifecycle: this.lifecycle,
      composer: { ...this.composer },
      blocks: [...this.blocks],
      truncated: this.truncatedView,
    };
  }

  subscribe(fromSeq: number, listener: (event: SessionViewEvent) => void): Disposable {
    return this.viewLog.subscribe(fromSeq, listener);
  }

  onAppend(listener: (blocks: ConvBlock[]) => void): Disposable {
    return this.live((e) => e.type === 'append' && listener(e.blocks));
  }

  onPatch(listener: (patch: BlockPatch) => void): Disposable {
    return this.live((e) => e.type === 'patch' && listener(e.patch));
  }

  onComposer(listener: (composer: ComposerState) => void): Disposable {
    return this.live((e) => e.type === 'composer' && listener(e.composer));
  }

  onLifecycle(listener: (lifecycle: SessionLifecycle) => void): Disposable {
    return this.live((e) => e.type === 'lifecycle' && listener(e.lifecycle));
  }

  onReset(listener: () => void): Disposable {
    return this.live((e) => e.type === 'reset' && listener());
  }

  onTurnEnd(listener: (raw: unknown) => void): Disposable {
    return this.live((e) => e.type === 'turnEnd' && listener(e.raw));
  }

  protected emitAppend(blocks: ConvBlock[]): void {
    this.viewLog.push({ type: 'append', blocks });
  }

  protected emitPatch(patch: BlockPatch): void {
    this.viewLog.push({ type: 'patch', patch });
  }

  protected emitComposer(composer: ComposerState): void {
    this.viewLog.push({ type: 'composer', composer: { ...composer } });
  }

  protected emitLifecycle(lifecycle: SessionLifecycle): void {
    this.viewLog.push({ type: 'lifecycle', lifecycle });
  }

  protected emitReset(): void {
    this.viewLog.push({ type: 'reset' });
  }

  protected emitTurnEnd(raw: unknown): void {
    this.viewLog.push({ type: 'turnEnd', raw });
  }

  protected disposeView(): void {
    this.viewLog.dispose();
  }

  /** Live events only: the conveniences never replay history at a new listener. */
  private live(listener: (event: SessionViewEvent) => void): Disposable {
    return this.viewLog.subscribe(this.viewLog.seq, listener);
  }
}
