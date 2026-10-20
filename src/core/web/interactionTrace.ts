/**
 * The daemon's half of interaction tracing (#190; `src/shared/trace.ts`).
 *
 * A browser stamps a row click with a correlation id. This remembers when the daemon received it,
 * when the app answered with a `navigate` (what `smartOpen` costs) and when the conversation's
 * `init` was queued for sending (what `source.init` costs), and takes the relay's per-batch
 * numbers for the batch that carried that `init` (queue wait, seal, send/ack, parts, bytes). The
 * browser's report closes it. The result is one redacted line in the log, a bounded ring of recent
 * interactions, and p50/p95 per transport, so a slow remote click can be explained, not guessed.
 *
 * Ids, stage names and numbers only: nothing a user typed or an agent said passes through here.
 * Durations are measured on one clock each (this daemon's, the browser's); the one number that
 * mixes them is labelled as a residual.
 */
import { percentile, type TraceReport } from '../../shared/trace';

export type TraceTransport = 'lan' | 'relay';

/** What the relay measured for one batch of items (`relayLink.ts`). */
export interface RelayBatchStats {
  /** Items in the batch, and in the queue ahead of the traced item when it was queued. */
  items: number;
  queueDepth: number;
  /** A batch was still in flight when it was queued, so it waited for that one first. */
  behindBatch: boolean;
  /** From the traced item being queued to its batch being taken. */
  queuedMs: number;
  /** Deflate and encrypt. */
  sealMs: number;
  /** Handing every part to Supabase, acknowledgements included. */
  sendMs: number;
  parts: number;
  /** Sealed bytes on the wire for the batch. */
  bytes: number;
}

export interface TraceEntry {
  cid: string;
  transport: TraceTransport;
  /** Daemon: the click arriving to the app's `navigate` (smartOpen). */
  smartOpenMs?: number;
  /** Daemon: `navigate` to the `init` being queued (the conversation read, caps and the rest). */
  initMs?: number;
  relay?: RelayBatchStats;
  /** Browser, from the click. */
  recvMs: number;
  firstMs: number;
  interactiveMs: number;
  reconnects: number;
  /**
   * `recvMs` less the daemon and relay stages above: the browser's own send, Supabase's transit
   * both ways, and receive-side decode. Mixes two clocks, so it is a residual, not a measurement.
   */
  residualMs?: number;
  /** `firstMs - recvMs`: the page rendering what arrived. */
  renderMs: number;
}

interface Pending {
  cid: string;
  connectionId: string;
  transport: TraceTransport;
  rxAt: number;
  navigateAt?: number;
  initAt?: number;
  relay?: RelayBatchStats;
}

export interface TransportSummary {
  count: number;
  recv: { p50: number; p95: number };
  first: { p50: number; p95: number };
  interactive: { p50: number; p95: number };
}

export interface InteractionTracerOptions {
  log(line: string): void;
  now?: () => number;
  /** Completed interactions kept. Default 200. */
  capacity?: number;
  /** A summary line every this many completed. Default 20; 0 for never. */
  summaryEvery?: number;
}

const MAX_PENDING = 64;
const PENDING_TTL_MS = 60_000;

export class InteractionTracer {
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly pending = new Map<string, Pending>();
  private readonly byConnection = new Map<string, string>();
  private readonly done: TraceEntry[] = [];
  private completed = 0;

  constructor(private readonly opts: InteractionTracerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.capacity = opts.capacity ?? 200;
  }

  /** The browser's click arrived. A newer click on the same connection replaces the older. */
  begin(connectionId: string, cid: string, transport: TraceTransport): void {
    const at = this.now();
    for (const [id, p] of this.pending) if (at - p.rxAt > PENDING_TTL_MS) this.drop(id);
    const older = this.byConnection.get(connectionId);
    if (older) this.pending.delete(older);
    while (this.pending.size >= MAX_PENDING) this.drop(this.pending.keys().next().value as string);
    this.pending.set(cid, { cid, connectionId, transport, rxAt: at });
    this.byConnection.set(connectionId, cid);
  }

  /** The cid an outgoing `init` on this connection answers, if a click is waiting for one. */
  awaiting(connectionId: string): string | undefined {
    const cid = this.byConnection.get(connectionId);
    return cid && this.pending.get(cid)?.initAt === undefined ? cid : undefined;
  }

  /** The app answered the click with a `navigate`. */
  navigated(connectionId: string): void {
    const p = this.current(connectionId);
    if (p && p.navigateAt === undefined) p.navigateAt = this.now();
  }

  /** The conversation's `init` is queued for sending. */
  initQueued(connectionId: string): void {
    const p = this.current(connectionId);
    if (p && p.initAt === undefined) p.initAt = this.now();
  }

  /** The relay's numbers for the batch carrying `cid`'s `init`. May arrive after the report. */
  relayBatch(cid: string, stats: RelayBatchStats): void {
    const p = this.pending.get(cid);
    if (p) {
      p.relay = stats;
      return;
    }
    const entry = this.done.find((e) => e.cid === cid);
    if (entry && !entry.relay) {
      entry.relay = stats;
      entry.residualMs = residual(entry);
    }
  }

  /** The browser's report: the interaction is complete. */
  complete(connectionId: string, report: TraceReport): TraceEntry | undefined {
    const p = this.pending.get(report.cid);
    if (!p || p.connectionId !== connectionId) return undefined;
    this.drop(report.cid);
    const entry: TraceEntry = {
      cid: p.cid,
      transport: p.transport,
      ...(p.navigateAt !== undefined ? { smartOpenMs: p.navigateAt - p.rxAt } : {}),
      ...(p.initAt !== undefined ? { initMs: p.initAt - (p.navigateAt ?? p.rxAt) } : {}),
      ...(p.relay ? { relay: p.relay } : {}),
      recvMs: report.recvMs,
      firstMs: report.firstMs,
      interactiveMs: report.interactiveMs,
      reconnects: report.reconnects,
      renderMs: Math.max(0, report.firstMs - report.recvMs),
    };
    entry.residualMs = residual(entry);
    this.done.push(entry);
    if (this.done.length > this.capacity) this.done.shift();
    this.completed++;
    this.opts.log(`trace: ${formatEntry(entry)}`);
    const every = this.opts.summaryEvery ?? 20;
    if (every > 0 && this.completed % every === 0) this.opts.log(`trace: ${formatSummary(this.summary())}`);
    return entry;
  }

  /** A connection closed: its waiting click is forgotten. */
  end(connectionId: string): void {
    const cid = this.byConnection.get(connectionId);
    if (cid) this.drop(cid);
  }

  recent(): readonly TraceEntry[] {
    return this.done;
  }

  summary(): Partial<Record<TraceTransport, TransportSummary>> {
    const out: Partial<Record<TraceTransport, TransportSummary>> = {};
    for (const transport of ['lan', 'relay'] as const) {
      const rows = this.done.filter((e) => e.transport === transport);
      if (rows.length === 0) continue;
      const pair = (pick: (e: TraceEntry) => number) => {
        const values = rows.map(pick);
        return { p50: percentile(values, 0.5) ?? 0, p95: percentile(values, 0.95) ?? 0 };
      };
      out[transport] = { count: rows.length, recv: pair((e) => e.recvMs), first: pair((e) => e.firstMs), interactive: pair((e) => e.interactiveMs) };
    }
    return out;
  }

  private current(connectionId: string): Pending | undefined {
    const cid = this.byConnection.get(connectionId);
    return cid ? this.pending.get(cid) : undefined;
  }

  private drop(cid: string): void {
    const p = this.pending.get(cid);
    this.pending.delete(cid);
    if (p && this.byConnection.get(p.connectionId) === cid) this.byConnection.delete(p.connectionId);
  }
}

function residual(e: TraceEntry): number | undefined {
  if (e.smartOpenMs === undefined || e.initMs === undefined) return undefined;
  const relay = e.relay ? e.relay.queuedMs + e.relay.sealMs + e.relay.sendMs : 0;
  return Math.max(0, e.recvMs - e.smartOpenMs - e.initMs - relay);
}

export function formatEntry(e: TraceEntry): string {
  const parts = [`${e.cid} ${e.transport} click→recv ${e.recvMs} ms, →first ${e.firstMs} ms, →interactive ${e.interactiveMs} ms`];
  const stages: string[] = [];
  if (e.smartOpenMs !== undefined) stages.push(`smartOpen ${e.smartOpenMs}`);
  if (e.initMs !== undefined) stages.push(`init ${e.initMs}`);
  if (e.relay) stages.push(`queue ${e.relay.queuedMs}`, `seal ${e.relay.sealMs}`, `send+ack ${e.relay.sendMs}`);
  if (e.residualMs !== undefined) stages.push(`other ${e.residualMs}`);
  stages.push(`render ${e.renderMs}`);
  parts.push(`(${stages.join(', ')})`);
  if (e.relay) {
    parts.push(`batch ${e.relay.items} items, ${e.relay.parts} parts, ${Math.round(e.relay.bytes / 1024)} KB, depth ${e.relay.queueDepth}`);
  }
  if (e.reconnects > 0) parts.push(`reconnects ${e.reconnects}`);
  return parts.join(' ');
}

export function formatSummary(s: Partial<Record<TraceTransport, TransportSummary>>): string {
  const rows = (['lan', 'relay'] as const).flatMap((t) => {
    const x = s[t];
    return x
      ? [
          `${t} n=${x.count} recv p50/p95 ${x.recv.p50}/${x.recv.p95} ms, first ${x.first.p50}/${x.first.p95} ms, interactive ${x.interactive.p50}/${x.interactive.p95} ms`,
        ]
      : [];
  });
  return rows.length > 0 ? `summary ${rows.join('; ')}` : 'summary: nothing yet';
}
