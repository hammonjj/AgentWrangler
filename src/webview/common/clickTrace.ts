/**
 * What a row click costs in this tab (#190), measured on this tab's clock only.
 *
 * `stamp` puts a correlation id on the table's `rowClick` envelope and notes the time. The daemon
 * echoes the id on the conversation's `init`; `received` notes when that reached the page and
 * schedules the two points a person feels: the first frame painted after it, and the page idle
 * again. The report goes back to the daemon, which joins it to its own and the relay's numbers
 * (`src/core/web/interactionTrace.ts`). Only the id and durations leave the page.
 *
 * The clock, the paint and the idle callback are injected so this is tested without a browser.
 */
import { newTraceId, parseTraceId, type TraceReport } from '../../shared/trace';

export interface ClickTraceEnv {
  now(): number;
  /** Run after the next frame has been painted, and after anything already queued. */
  afterPaint(run: () => void): void;
  /** Run when the page has nothing else to do. */
  afterIdle(run: () => void): void;
  report(report: TraceReport): void;
  reconnects(): number;
  /** For ids a test can repeat. Default `Math.random`. */
  random?: () => number;
}

export class ClickTrace {
  private current: { cid: string; startedAt: number } | undefined;

  constructor(private readonly env: ClickTraceEnv) {}

  /** The envelope a pane is about to send, with an id on it when it is a row click. */
  stamp<T>(message: T): T {
    const m = message as { pane?: unknown; body?: { type?: unknown } } | null;
    if (m?.pane !== 'dashboard' || m.body?.type !== 'rowClick') return message;
    const cid = newTraceId(this.env.random);
    this.current = { cid, startedAt: this.env.now() };
    return { ...message, cid };
  }

  /** An envelope from the daemon, about to be handed to the panes. */
  received(envelope: unknown): void {
    const current = this.current;
    if (!current) return;
    const m = envelope as { pane?: unknown; cid?: unknown; body?: { type?: unknown } } | null;
    if (m?.pane !== 'conversation' || m.body?.type !== 'init' || parseTraceId(m.cid) !== current.cid) return;
    this.current = undefined;
    const recvMs = this.env.now() - current.startedAt;
    this.env.afterPaint(() => {
      const firstMs = this.env.now() - current.startedAt;
      this.env.afterIdle(() => {
        this.env.report({
          cid: current.cid,
          recvMs: Math.round(recvMs),
          firstMs: Math.round(firstMs),
          interactiveMs: Math.round(this.env.now() - current.startedAt),
          reconnects: this.env.reconnects(),
        });
      });
    });
  }

  /** A connection dropped: a reply that never came is not waited for. */
  reset(): void {
    this.current = undefined;
  }
}
