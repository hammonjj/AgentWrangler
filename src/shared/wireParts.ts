/**
 * Splitting a browser's long pane envelopes into parts, and putting them back
 * together on the daemon.
 *
 * The workbench socket refuses any one message over `MAX_SOCKET_MESSAGE_BYTES`
 * (the `ws` server's `maxPayload`) by closing with 1009. A `send` with a few
 * pasted images is past that, and the shim keeps an envelope until it is
 * acknowledged and sends it again on every new socket, so a message that big
 * used to close every socket it was sent on: a tab reconnecting twice a second
 * forever. So a long envelope goes as `shell.part` messages, each well under
 * the limit, which the connection joins and handles as if it had arrived whole.
 * A whole envelope still has a ceiling (`MAX_ASSEMBLED_CHARS`), which the shim
 * checks before it sends anything, so nothing is sent that would be refused.
 *
 * No Node or DOM imports: the shim and the daemon both use it.
 */

import { SHELL_PANE } from './shellProtocol';

/** What the daemon's socket takes in one message (`ws` `maxPayload`); past it, 1009. */
export const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Characters of the original line per part. Even a line that is all control
 * characters (6 bytes each once escaped into the part's JSON) stays under the
 * socket limit.
 */
export const WIRE_PART_CHARS = 1024 * 1024;

/** The longest envelope a tab may send, in characters, however it is split. A bound on what a tab can make the daemon hold. */
export const MAX_ASSEMBLED_CHARS = 64 * 1024 * 1024;

/** One part, as the `body` of a `shell` envelope. */
export interface WirePart {
  type: 'part';
  /** The same for every part of one envelope; a new id starts a new one. */
  id: string;
  index: number;
  count: number;
  /** The whole line's length, in characters. */
  chars: number;
  /** What the whole envelope is (`conversation.send`), for the log. Never content. */
  label: string;
  data: string;
}

/** `pane.type` of an envelope, for a log line: names, never content. */
export function envelopeLabel(envelope: unknown): string {
  const e = envelope as { pane?: unknown; body?: { type?: unknown } } | null;
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40) : '?');
  return `${clean(e?.pane)}.${clean(e?.body?.type)}`;
}

/**
 * The messages to send for one envelope line: the line itself when it is short
 * enough, otherwise its parts in order. Splitting may cut a surrogate pair; JSON
 * carries the halves and joining puts them back.
 */
export function splitLine(line: string, id: string, label: string, partChars = WIRE_PART_CHARS): string[] {
  if (line.length <= partChars) return [line];
  const count = Math.ceil(line.length / partChars);
  const out: string[] = [];
  for (let index = 0; index < count; index++) {
    const body: WirePart = {
      type: 'part',
      id,
      index,
      count,
      chars: line.length,
      label,
      data: line.slice(index * partChars, (index + 1) * partChars),
    };
    out.push(JSON.stringify({ pane: SHELL_PANE, body }));
  }
  return out;
}

/** A `shell.part` body as it arrives, checked; undefined for anything else. */
export function parseWirePart(body: unknown): WirePart | undefined {
  const p = body as Partial<WirePart> | null;
  if (!p || typeof p !== 'object' || p.type !== 'part') return undefined;
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 128) return undefined;
  if (!int(p.index) || !int(p.count) || !int(p.chars) || p.count < 1 || p.index >= p.count) return undefined;
  if (typeof p.data !== 'string' || typeof p.label !== 'string') return undefined;
  const label = p.label.replace(/[^A-Za-z0-9_.?-]/g, '?').slice(0, 82);
  return { type: 'part', id: p.id, index: p.index, count: p.count, chars: p.chars, label, data: p.data };
}

export type PartResult =
  /** The last part: the whole line, to be handled as if it had arrived in one message. */
  | { kind: 'done'; line: string; label: string; count: number }
  | { kind: 'pending' }
  /** Not used; whatever was being joined is dropped. `reason` is for the log. */
  | { kind: 'refused'; label: string; chars: number; reason: string };

/**
 * One connection's parts, joined. The shim sends an envelope's parts one after
 * another, so one is joined at a time: a part 0 starts over, and a part out of
 * order drops what was being joined (the tab sends it all again after a drop).
 */
export class PartAssembler {
  private current: { id: string; count: number; chars: number; label: string; next: number; have: number; data: string[] } | undefined;

  constructor(private readonly maxChars = MAX_ASSEMBLED_CHARS) {}

  add(part: WirePart): PartResult {
    if (part.index === 0) {
      this.current = undefined;
      if (part.chars > this.maxChars) {
        return { kind: 'refused', label: part.label, chars: part.chars, reason: `over the ${mb(this.maxChars)} limit` };
      }
      this.current = { id: part.id, count: part.count, chars: part.chars, label: part.label, next: 0, have: 0, data: [] };
    }
    const c = this.current;
    if (!c || c.id !== part.id || c.next !== part.index || c.count !== part.count || c.chars !== part.chars) {
      this.current = undefined;
      return { kind: 'refused', label: part.label, chars: part.chars, reason: 'a part out of order' };
    }
    c.have += part.data.length;
    if (c.have > c.chars) {
      this.current = undefined;
      return { kind: 'refused', label: c.label, chars: c.chars, reason: 'longer than it said' };
    }
    c.data.push(part.data);
    c.next++;
    if (c.next < c.count) return { kind: 'pending' };
    this.current = undefined;
    if (c.have !== c.chars) return { kind: 'refused', label: c.label, chars: c.chars, reason: 'shorter than it said' };
    return { kind: 'done', line: c.data.join(''), label: c.label, count: c.count };
  }

  /** Characters held for an envelope not yet complete. */
  get pendingChars(): number {
    return this.current?.have ?? 0;
  }
}

/**
 * Sockets in a row closed with 1009 after which the shim gives up on its long unacknowledged
 * envelopes. Parts make that close something that should not happen; this is what stops it
 * looping if it does.
 */
export const MAX_1009_CLOSES = 3;

/** The unacknowledged envelopes that went in parts: the only ones that could have been too big. */
export function oversizedResends(unacked: Iterable<[string, { line: string }]>, partChars = WIRE_PART_CHARS): string[] {
  const out: string[] = [];
  for (const [id, u] of unacked) if (u.line.length > partChars) out.push(id);
  return out;
}

/** A size for a log line or a toast: `20.1 MB`. */
export function mb(chars: number): string {
  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}
