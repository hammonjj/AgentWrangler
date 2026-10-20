/**
 * Interaction timing across the wire (#190): one row click, followed from the browser's click to
 * the first rendered content and back to the daemon as a report.
 *
 * A correlation id (`cid`) is minted by the browser, rides on the click's envelope, and is echoed
 * on the daemon's reply (the conversation's `init`), so both ends can name the same interaction.
 * Nothing but ids, stage names and numbers is ever recorded: no transcript text, paths, titles,
 * tokens or keys. The browser and the daemon do not share a clock, so each side reports
 * durations on its own clock and nobody subtracts across them except as a labelled residual.
 *
 * No Node and no DOM: bundled into the daemon and the browser.
 */

/** Short, URL-safe and random enough to tell interactions apart; not a secret. */
const CID = /^[A-Za-z0-9_-]{6,24}$/;

export function newTraceId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

/** A `cid` from a peer is foreign input: only the shape above is accepted. */
export function parseTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && CID.test(value) ? value : undefined;
}

/** What the browser reports once the conversation has rendered, on its own clock. */
export interface TraceReport {
  cid: string;
  /** Click to the conversation's `init` arriving in the page. */
  recvMs: number;
  /** Click to the first frame painted after it. */
  firstMs: number;
  /** Click to the page being idle again: the composer can be typed in. */
  interactiveMs: number;
  /** Reconnects this tab has made so far, for the reconnect rate. */
  reconnects: number;
}

const MAX_REPORT_MS = 10 * 60 * 1000;

export function parseTraceReport(body: unknown): TraceReport | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const m = body as Record<string, unknown>;
  const cid = parseTraceId(m.cid);
  if (!cid) return undefined;
  const ms = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_REPORT_MS ? Math.round(v) : undefined;
  const recvMs = ms(m.recvMs);
  const firstMs = ms(m.firstMs);
  const interactiveMs = ms(m.interactiveMs);
  const reconnects = ms(m.reconnects) ?? 0;
  if (recvMs === undefined || firstMs === undefined || interactiveMs === undefined) return undefined;
  return { cid, recvMs, firstMs, interactiveMs, reconnects };
}

/** `p` in 0..1 of `values` by nearest rank; undefined for none. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}
