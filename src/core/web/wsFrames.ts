/**
 * Spike #120: just enough RFC 6455 for the browser prototype, and the request
 * guards that keep a loopback server from being driven by any page the user
 * happens to have open.
 *
 * Hand-rolled because Node has a WebSocket client but no server, and a spike
 * should not add a dependency it may not keep. The plan (`docs/plans/
 * browser-workbench.md` §5) recommends `ws` for the real thing; this covers
 * what a browser sends — masked text frames, fragments, ping and close — and
 * refuses the rest.
 */
import * as crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The `Sec-WebSocket-Accept` value for a client's key. */
export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** A server frame: never masked, always final. */
export function encodeText(text: string): Buffer {
  return frame(0x1, Buffer.from(text, 'utf8'));
}
export function encodePong(payload: Buffer): Buffer {
  return frame(0xa, payload);
}
export function encodeClose(code: number): Buffer {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  return frame(0x8, body);
}

export type WsEvent =
  | { kind: 'text'; text: string }
  | { kind: 'ping'; payload: Buffer }
  | { kind: 'close' }
  /** Protocol error or oversize message: close with this code and drop the socket. */
  | { kind: 'error'; code: number };

/**
 * Feeds bytes in, gets whole messages out. Fragments are joined; a message over
 * `maxMessageBytes` is an error (1009) rather than an allocation.
 */
export class WsDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;

  constructor(private readonly maxMessageBytes = 16 * 1024 * 1024) {}

  push(chunk: Buffer): WsEvent[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: WsEvent[] = [];
    for (;;) {
      if (this.buf.length < 2) return out;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      // A client must mask every frame (RFC 6455 §5.1); RSV bits mean an
      // extension we never negotiated.
      if ((b1 & 0x80) === 0 || (b0 & 0x70) !== 0) return [...out, { kind: 'error', code: 1002 }];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return out;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return out;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return [...out, { kind: 'error', code: 1009 }];
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxMessageBytes) return [...out, { kind: 'error', code: 1009 }];
      if (this.buf.length < offset + 4 + len) return out;
      const mask = this.buf.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(offset + 4 + len);

      if (opcode === 0x8) return [...out, { kind: 'close' }];
      if (opcode === 0x9) {
        out.push({ kind: 'ping', payload });
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0 && opcode !== 0x1) return [...out, { kind: 'error', code: 1003 }];
      // A continuation with nothing to continue, or a new text frame while one
      // is still open, is a protocol error either way.
      if ((opcode === 0x0) !== (this.fragments.length > 0)) return [...out, { kind: 'error', code: 1002 }];
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) return [...out, { kind: 'error', code: 1009 }];
      this.fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.fragmentBytes = 0;
      out.push({ kind: 'text', text });
    }
  }
}

/**
 * Loopback only, by name. A `Host` that is anything else is a DNS-rebinding
 * page that resolved its own name to 127.0.0.1; the browser would otherwise
 * treat it as same-origin with us.
 */
export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

/**
 * A WebSocket upgrade is not covered by CORS or by `SameSite` for every
 * browser, so the `Origin` is checked by hand: it must be this server.
 */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || !hostHeader) return false;
  return origin.toLowerCase() === `http://${hostHeader.toLowerCase()}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Constant-time, and false for anything of the wrong length or type. */
export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
