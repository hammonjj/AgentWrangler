// Spike S4 (#8): `app-server --listen unix://PATH` does not speak NDJSON on the socket. It
// expects an HTTP/1.1 WebSocket upgrade over the Unix socket, then one JSON-RPC message per
// text frame (found by connecting raw: the server logs "failed to upgrade control socket
// websocket connection"). `app-server proxy` is a dumb byte pipe to that socket, so a client
// behind the proxy has to speak WebSocket over the proxy's stdio as well.
//
// This is a minimal RFC 6455 client, enough for the spike: masked text frames out,
// text/ping/close in. It exposes a line stream so rpc.ts can treat it like NDJSON stdio.

import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { PassThrough, type Readable, type Writable } from 'node:stream';

export interface WsLink { lines: PassThrough; send(text: string): void }

export async function connectUnixSocket(path: string): Promise<net.Socket> {
  const socket = net.connect(path);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}

export async function websocketOver(input: Readable, output: Writable): Promise<WsLink> {
  const key = crypto.randomBytes(16).toString('base64');
  output.write([
    'GET / HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
  ].join('\r\n'));

  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let fragments: Buffer[] = [];
  const lines = new PassThrough();

  const sendFrame = (opcode: number, payload: Buffer) => {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = 0x80 | len;
    else if (len < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    output.write(Buffer.concat([header, mask, masked]));
  };

  const ready = new Promise<void>((resolve, reject) => {
    input.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) { reject(new Error(`upgrade refused: ${head.split('\r\n')[0]}`)); return; }
        upgraded = true;
        resolve();
      }
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer[1] & 0x80) offset += 4; // servers do not mask, but be safe
        if (buffer.length < offset + len) return;
        const payload = buffer.subarray(offset, offset + len);
        buffer = buffer.subarray(offset + len);
        if (opcode === 0x9) { sendFrame(0xa, payload); continue; }
        if (opcode === 0x8) { output.end(); continue; }
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          fragments.push(Buffer.from(payload));
          if (fin) { lines.write(`${Buffer.concat(fragments).toString('utf8')}\n`); fragments = []; }
        }
      }
    });
    input.once('error', reject);
    input.once('end', () => reject(new Error('closed before upgrade')));
  });
  input.on('close', () => lines.end());
  input.on('end', () => lines.end());
  await ready;
  return { lines, send: (text) => sendFrame(0x1, Buffer.from(text, 'utf8')) };
}
