import { describe, expect, it } from 'vitest';
import {
  acceptKey,
  encodeText,
  isLoopbackHost,
  isSameOrigin,
  readCookie,
  tokenMatches,
  WsDecoder,
} from '../src/core/web/wsFrames';

/** A frame as a browser sends it: masked. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

describe('acceptKey', () => {
  it('matches the RFC 6455 example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('encodeText', () => {
  it('uses the 7-bit, 16-bit and 64-bit lengths at their boundaries', () => {
    expect(encodeText('a'.repeat(125)).subarray(0, 2)).toEqual(Buffer.from([0x81, 125]));
    expect(encodeText('a'.repeat(126)).subarray(0, 4)).toEqual(Buffer.from([0x81, 126, 0, 126]));
    const big = encodeText('a'.repeat(0x10000));
    expect(big[1]).toBe(127);
    expect(big.readBigUInt64BE(2)).toBe(0x10000n);
  });
});

describe('WsDecoder', () => {
  it('unmasks a text frame split across chunks', () => {
    const d = new WsDecoder();
    const f = clientFrame(0x1, Buffer.from('{"pane":"dashboard"}'));
    expect(d.push(f.subarray(0, 3))).toEqual([]);
    expect(d.push(f.subarray(3))).toEqual([{ kind: 'text', text: '{"pane":"dashboard"}' }]);
  });

  it('reads two frames from one chunk, including a 16-bit length', () => {
    const d = new WsDecoder();
    const long = 'x'.repeat(300);
    const events = d.push(Buffer.concat([clientFrame(0x1, Buffer.from('a')), clientFrame(0x1, Buffer.from(long))]));
    expect(events).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: long }]);
  });

  it('joins fragments', () => {
    const d = new WsDecoder();
    const events = d.push(Buffer.concat([clientFrame(0x1, Buffer.from('he'), false), clientFrame(0x0, Buffer.from('llo'))]));
    expect(events).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('reports ping and close', () => {
    const d = new WsDecoder();
    expect(d.push(clientFrame(0x9, Buffer.from('p')))).toEqual([{ kind: 'ping', payload: Buffer.from('p') }]);
    expect(d.push(clientFrame(0x8, Buffer.alloc(0)))).toEqual([{ kind: 'close' }]);
  });

  it('refuses an unmasked frame', () => {
    expect(new WsDecoder().push(Buffer.from([0x81, 1, 0x61]))).toEqual([{ kind: 'error', code: 1002 }]);
  });

  it('refuses a message over the limit before buffering it', () => {
    const d = new WsDecoder(10);
    const header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(d.push(header)).toEqual([{ kind: 'error', code: 1009 }]);
    expect(new WsDecoder(4).push(Buffer.concat([clientFrame(0x1, Buffer.from('abc'), false), clientFrame(0x0, Buffer.from('de'))]))).toEqual([
      { kind: 'error', code: 1009 },
    ]);
  });

  it('refuses a continuation with nothing to continue, and binary frames', () => {
    expect(new WsDecoder().push(clientFrame(0x0, Buffer.from('a')))).toEqual([{ kind: 'error', code: 1002 }]);
    expect(new WsDecoder().push(clientFrame(0x2, Buffer.from('a')))).toEqual([{ kind: 'error', code: 1003 }]);
  });
});

describe('request guards', () => {
  it('accepts loopback hosts on our port only', () => {
    expect(isLoopbackHost('127.0.0.1:7391', 7391)).toBe(true);
    expect(isLoopbackHost('localhost:7391', 7391)).toBe(true);
    expect(isLoopbackHost('[::1]:7391', 7391)).toBe(true);
    expect(isLoopbackHost('evil.example:7391', 7391)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:80', 7391)).toBe(false);
    expect(isLoopbackHost(undefined, 7391)).toBe(false);
  });

  it('requires the Origin to be this server', () => {
    expect(isSameOrigin('http://127.0.0.1:7391', '127.0.0.1:7391')).toBe(true);
    expect(isSameOrigin('http://evil.example', '127.0.0.1:7391')).toBe(false);
    expect(isSameOrigin('https://127.0.0.1:7391', '127.0.0.1:7391')).toBe(false);
    expect(isSameOrigin(undefined, '127.0.0.1:7391')).toBe(false);
  });

  it('reads a cookie and compares tokens', () => {
    expect(readCookie('a=1; aw_web=tok; b=2', 'aw_web')).toBe('tok');
    expect(readCookie('aw_webx=tok', 'aw_web')).toBeUndefined();
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'ab')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });
});
