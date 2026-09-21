/**
 * A conversation read from a session's transcript file.
 *
 * This works for every Claude Code session on the machine, whatever window or
 * terminal owns it, because the transcript is just a file. It is read-only in
 * one respect only — typing — and not in another: a permission prompt can be
 * answered from here, because Claude Code races our `PermissionRequest` hook
 * against its own dialog and takes whichever answers first.
 */
import * as fs from 'node:fs/promises';
import { createTranscriptState, reduceTranscriptLines, type TranscriptState } from '../../claude/transcriptBlocks';
import { readTranscriptTail } from '../../claude/transcriptHistory';
import { MAX_CHUNK_BYTES, readRange, splitCompleteLines } from '../../claude/transcriptTail';
import { Emitter, type Disposable } from '../../core/events';
import type { BlockPatch, ConvBlock } from '../../shared/conversation';
import type { AgentSession } from '../../shared/model';
import type { ConversationInit, ConversationSource } from './source';

/**
 * Backstop poll while a turn is running. The provider's watcher is the real
 * signal; this covers the events a recursive fs.watch misses under load.
 */
const FOLLOW_POLL_MS = 2000;

/** The part of the provider this source needs: "that session's file grew". */
export interface TranscriptFeed {
  onTranscriptAppended?(listener: (e: { sessionId: string; path: string }) => void): Disposable;
}

/**
 * Answers one specific permission prompt, named by the `permissionRequestId`
 * the card was built from. Resolves false when it is too late — the prompt was
 * answered elsewhere, or the session has moved on to a different one.
 *
 * The request id rather than the session id, because a session is not a prompt:
 * a card can outlive the ask it was drawn for, and the answer must not then be
 * applied to whatever replaced it.
 */
export type DecidePermission = (
  requestId: string,
  behavior: 'allow' | 'deny' | 'always',
) => Promise<boolean>;

export class TranscriptSource implements ConversationSource {
  readonly kind = 'transcript' as const;

  private state: TranscriptState = createTranscriptState();
  private byteOffset = 0;
  private appendEmitter = new Emitter<ConvBlock[]>();
  private patchEmitter = new Emitter<BlockPatch>();
  private subs: Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private ready = false;
  private pumping = false;
  private disposed = false;
  /** The permission card on screen, if any, and whether it can still be answered. */
  private ask?: { id: string; requestId: string; pending: boolean };

  constructor(
    private session: AgentSession,
    feed: TranscriptFeed,
    private decidePermission: DecidePermission,
  ) {
    if (feed.onTranscriptAppended) {
      this.subs.push(
        feed.onTranscriptAppended((e) => {
          if (e.sessionId === this.session.sessionId.toLowerCase()) void this.pump();
        }),
      );
    }
  }

  onAppend = (listener: (blocks: ConvBlock[]) => void): Disposable => this.appendEmitter.event(listener);
  onPatch = (listener: (patch: BlockPatch) => void): Disposable => this.patchEmitter.event(listener);

  async init(): Promise<ConversationInit> {
    const read = await readTranscriptTail(this.session.transcriptPath);
    this.state = read.state;
    this.byteOffset = read.byteOffset;

    let blocks = read.blocks;
    const ask = this.buildAsk();
    if (ask) blocks = [...blocks, ask];

    this.ready = true;
    this.armTimer();
    return { blocks, truncated: read.truncated };
  }

  setSession(session: AgentSession): void {
    const prev = this.session;
    this.session = session;
    if (!this.ready) return;
    if (session.status !== prev.status) {
      this.armTimer();
      void this.pump(); // catch the tail that produced the transition
    }
    this.syncAsk();
  }

  /** Held back by the reducer when a block's text was too long for the wire. */
  fullBlockText(blockId: string): string | undefined {
    return this.state.overflow.get(blockId);
  }

  async decide(requestId: string, decision: 'allow' | 'always' | 'deny'): Promise<boolean> {
    if (!this.ask || this.ask.requestId !== requestId || !this.ask.pending) return false;
    const sent = await this.decidePermission(requestId, decision);
    if (!this.ask) return sent;
    this.ask.pending = false;
    this.patchEmitter.fire({
      id: this.ask.id,
      block: { state: sent ? (decision === 'deny' ? 'denied' : 'allowed') : 'expired' },
    });
    return sent;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.appendEmitter.dispose();
    this.patchEmitter.dispose();
  }

  // ---- internals ----

  /** The permission card for whatever the session is blocked on, or undefined. */
  private buildAsk(): ConvBlock | undefined {
    const s = this.session;
    if (s.status !== 'blocked' || !s.permissionRequestId) return undefined;
    const id = `p:${s.permissionRequestId}`;
    this.ask = { id, requestId: s.permissionRequestId, pending: true };
    return {
      kind: 'permission',
      id,
      requestId: s.permissionRequestId,
      toolName: s.blockedReason ?? 'a tool',
      summary: s.blockedAsk?.summary,
      body: s.blockedAsk?.body,
      isCommand: s.blockedAsk?.isCommand,
      // Always allow is Claude Code's own "don't ask again", carried by the
      // prompt's own suggestion; with no suggestion there is no rule to offer.
      alwaysAllowRule: s.alwaysAllow?.rules.join(', '),
      state: 'pending',
    };
  }

  /**
   * Keep the card in step with the store. A prompt answered in Claude Code
   * itself clears `permissionRequestId`, and the card must stop offering
   * buttons that can no longer land.
   */
  private syncAsk(): void {
    const s = this.session;
    const live = s.status === 'blocked' ? s.permissionRequestId : undefined;

    if (this.ask && this.ask.requestId !== live) {
      if (this.ask.pending) {
        this.ask.pending = false;
        this.patchEmitter.fire({ id: this.ask.id, block: { state: 'expired' } });
      }
      this.ask = undefined;
    }
    if (live && !this.ask) {
      const block = this.buildAsk();
      if (block) this.appendEmitter.fire([block]);
    }
  }

  /** Read appended bytes past our offset and stream the new blocks out. */
  private async pump(): Promise<void> {
    if (!this.ready || this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      const filePath = this.session.transcriptPath;
      if (!filePath) return;
      let size: number;
      try {
        size = (await fs.stat(filePath)).size;
      } catch {
        return;
      }
      if (size < this.byteOffset) return; // rewritten under us; a reopen re-inits

      while (size > this.byteOffset) {
        const end = Math.min(size, this.byteOffset + MAX_CHUNK_BYTES);
        const buf = await readRange(filePath, this.byteOffset, end);
        if (buf === undefined) return;
        const split = splitCompleteLines(buf, false);
        if (split.endOffset === 0) break; // only a partial line so far
        this.byteOffset += split.endOffset;
        const { appends, patches } = reduceTranscriptLines(this.state, split.lines);
        for (const p of patches) this.patchEmitter.fire(p);
        if (appends.length > 0) this.appendEmitter.fire(appends);
        if (end === size) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private armTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const s = this.session.status;
    if (s === 'busy' || s === 'stuck' || s === 'blocked') {
      this.timer = setInterval(() => void this.pump(), FOLLOW_POLL_MS);
    }
  }
}
