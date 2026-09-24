/**
 * A minimal RFC 6455 WebSocket client, enough to talk to `codex app-server
 * --listen unix://PATH`.
 *
 * That listener speaks WebSocket over the Unix socket, one JSON-RPC message
 * per text frame, and refuses raw NDJSON (spike S4,
 * `docs/plans/spikes/s4-codex-restart.md`). A plain `GET /` upgrade with
 * `Host: localhost` is accepted with no token. This is the whole client: masked
 * frames out; text, continuation, ping and close in. No extensions, no
 * subprotocols, no new dependency.
 */
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';

export interface WsConnection {
  send(text: string): void;
  close(): void;
  onMessage(listener: (text: string) => void): void;
  /** Fires once, however the connection ends (close frame, EOF, error, `close()`). */
  onClose(listener: (reason: string) => void): void;
}

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** One masked frame, as a client must send it. Exported for tests. */
export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer = crypto.randomBytes(4)): Buffer {
  const len = payload.length;
  const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (len < 126) header[1] = 0x80 | len;
  else if (len < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Frames parsed off the front of `buffer`, and what is left over. Exported for tests. */
export function decodeFrames(buffer: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { fin: boolean; opcode: number; payload: Buffer }[] = [];
  let at = 0;
  for (;;) {
    if (buffer.length - at < 2) break;
    const fin = (buffer[at] & 0x80) !== 0;
    const opcode = buffer[at] & 0x0f;
    const masked = (buffer[at + 1] & 0x80) !== 0;
    let len = buffer[at + 1] & 0x7f;
    let offset = at + 2;
    if (len === 126) {
      if (buffer.length - at < 4) break;
      len = buffer.readUInt16BE(at + 2);
      offset = at + 4;
    } else if (len === 127) {
      if (buffer.length - at < 10) break;
      len = Number(buffer.readBigUInt64BE(at + 2));
      offset = at + 10;
    }
    const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
    if (masked) offset += 4;
    if (buffer.length < offset + len) break;
    let payload = Buffer.from(buffer.subarray(offset, offset + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    frames.push({ fin, opcode, payload });
    at = offset + len;
  }
  return { frames, rest: buffer.subarray(at) };
}

/** Upgrade an already-connected byte stream to WebSocket. */
export function websocketOver(stream: Duplex, timeoutMs = 10_000): Promise<WsConnection> {
  const key = crypto.randomBytes(16).toString('base64');
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const messageListeners: ((text: string) => void)[] = [];
  const unheard: string[] = [];
  const closeListeners: ((reason: string) => void)[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let upgraded = false;
  let closed: string | undefined;
  let fragments: Buffer[] = [];

  const finish = (reason: string) => {
    if (closed !== undefined) return;
    closed = reason;
    stream.destroy();
    for (const listener of closeListeners) listener(reason);
  };
  const connection: WsConnection = {
    send(text) {
      if (closed !== undefined) throw new Error(`Codex App Server connection is closed (${closed})`);
      stream.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
    },
    close() {
      if (closed !== undefined) return;
      try { stream.write(encodeFrame(OP_CLOSE, Buffer.alloc(0))); } catch { /* already gone */ }
      finish('closed by client');
    },
    onMessage(listener) {
      messageListeners.push(listener);
      // Anything that arrived with the upgrade response, before anyone listened.
      const early = unheard.splice(0);
      for (const text of early) listener(text);
    },
    onClose(listener) {
      if (closed !== undefined) {
        const reason = closed;
        queueMicrotask(() => listener(reason));
      } else closeListeners.push(listener);
    },
  };

  return new Promise<WsConnection>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (upgraded) return;
      reject(new Error('Codex App Server did not accept the WebSocket upgrade in time'));
      finish('upgrade timed out');
    }, timeoutMs);
    const handleFrames = () => {
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === OP_PING) {
          try { stream.write(encodeFrame(OP_PONG, frame.payload)); } catch { /* closing */ }
        } else if (frame.opcode === OP_CLOSE) {
          finish('closed by server');
          return;
        } else if (frame.opcode === OP_TEXT || frame.opcode === OP_BINARY || frame.opcode === OP_CONT) {
          fragments.push(frame.payload);
          if (frame.fin) {
            const text = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            if (messageListeners.length === 0) unheard.push(text);
            for (const listener of messageListeners) listener(text);
          }
        }
      }
    };
    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const acceptHeader = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
        if (!/^HTTP\/1\.1 101/.test(head) || (acceptHeader !== undefined && acceptHeader !== accept)) {
          clearTimeout(timer);
          reject(new Error(`Codex App Server refused the WebSocket upgrade: ${head.split('\r\n')[0]}`));
          finish('upgrade refused');
          return;
        }
        upgraded = true;
        clearTimeout(timer);
        resolve(connection);
      }
      handleFrames();
    });
    stream.on('error', (error) => {
      if (!upgraded) {
        clearTimeout(timer);
        reject(error);
      }
      finish(error.message);
    });
    stream.on('end', () => finish('socket ended'));
    stream.on('close', () => {
      if (!upgraded) {
        clearTimeout(timer);
        reject(new Error('Codex App Server closed the socket before the WebSocket upgrade'));
      }
      finish('socket closed');
    });
    stream.write([
      'GET / HTTP/1.1',
      'Host: localhost',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  });
}

/** Connect to a Unix socket and upgrade it. */
export function connectUnixWebSocket(socketPath: string): Promise<WsConnection> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  }).then((socket) => websocketOver(socket));
}
