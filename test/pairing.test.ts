/**
 * Pairing, device lists and revocation (#137): the code and its limits, the
 * QR encoder, the `/pair` and `/pair/new` forms over real listeners, a revoked
 * device being disconnected and refused, and the `aw web` command line.
 *
 * Every listener binds 127.0.0.1 (the LAN one with LAN-style names); nothing
 * listens on a real network interface. Codes and credentials are made up per
 * run.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAccessGate, type AccessAuditRecord } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { createBrowserConnections, type BrowserConnections } from '../src/core/web/browserConnections';
import { DEVICE_TTL_MS, WebDeviceStore, cleanDeviceName, summarizeUserAgent } from '../src/core/web/devices';
import {
  PAIRING_ALPHABET,
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_FAILURES_GLOBAL,
  PAIRING_TTL_MS,
  PairingOffers,
  formatPairingCode,
  normalizePairingCode,
} from '../src/core/web/pairing';
import {
  alignmentPositions,
  dataCodewords,
  encodeQr,
  formatBits,
  maskApplies,
  qrToSvg,
  qrToTerminal,
  reedSolomonDivisor,
  reedSolomonRemainder,
  versionBits,
  type QrCode,
  type QrEcc,
} from '../src/core/web/qr';
import { LAN_DEVICE_COOKIE, LAN_PAIR_FORM_COOKIE, MAX_FORM_BYTES, PAIR_FORM_COOKIE, WebServer } from '../src/core/web/server';
import { LocalCertificates, type TlsMaterial } from '../src/core/web/tls';
import { parseArgs, webRefusal } from '../src/cli/args';
import { formatWebDevices, formatWebPair } from '../src/cli/format';
import { revokeWebDeviceId } from '../src/shared/preferences';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';

const MIN = 60 * 1000;

// ---- the code and its limits ----

describe('pairing codes', () => {
  it('are eight characters of Crockford base32, shown with a dash, and forgiving to type', () => {
    const offers = new PairingOffers();
    const { code } = offers.start();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(PAIRING_ALPHABET).toHaveLength(32); // 8 × 5 = 40 bits
    expect(formatPairingCode('ABCDEF12')).toBe('ABCD-EF12');
    expect(normalizePairingCode(' abcd-ef12 ')).toBe('ABCDEF12');
    expect(normalizePairingCode('O1IL-2345')).toBe('01112345');
    expect(normalizePairingCode('ABCDEFGU')).toBeUndefined(); // U is not in the alphabet
    expect(normalizePairingCode('ABC')).toBeUndefined();
    expect(normalizePairingCode(undefined)).toBeUndefined();
  });

  it('work once, for five minutes, and a new offer replaces the old', () => {
    let now = 1_000_000;
    const offers = new PairingOffers(() => now);
    const first = offers.start();
    expect(first.expiresAt).toBe(now + PAIRING_TTL_MS);
    const second = offers.start();
    expect(offers.redeem(first.code, '10.0.0.2')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(offers.redeem(formatPairingCode(second.code).toLowerCase(), '10.0.0.2')).toEqual({ ok: true });
    expect(offers.redeem(second.code, '10.0.0.2')).toMatchObject({ ok: false, reason: 'invalid' });

    const third = offers.start();
    now += PAIRING_TTL_MS;
    expect(offers.current()).toBeUndefined();
    expect(offers.redeem(third.code, '10.0.0.3')).toMatchObject({ ok: false, reason: 'expired' });
    now -= 1;
    expect(offers.redeem(third.code, '10.0.0.3')).toMatchObject({ ok: false, reason: 'invalid' }); // spent by the expired try
  });

  it('withdraws an offer after five wrong codes, whoever sends them', () => {
    const offers = new PairingOffers();
    const { code } = offers.start();
    for (let i = 0; i < 4; i++) expect(offers.redeem('ZZZZZZZZ', `10.0.0.${i + 10}`)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(offers.redeem('ZZZZZZZZ', '10.0.0.20')).toMatchObject({ ok: false, offerWithdrawn: true });
    expect(offers.redeem(code, '10.0.0.21')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('locks an address out for fifteen minutes after five failures in ten, even for the right code', () => {
    let now = 5_000_000;
    const offers = new PairingOffers(() => now);
    const ip = '192.168.1.50';
    for (let i = 0; i < 4; i++) {
      offers.start();
      expect(offers.redeem('ZZZZZZZZ', ip).ok).toBe(false);
    }
    expect(offers.locked(ip)).toBe(false);
    const { code } = offers.start();
    expect(offers.redeem('ZZZZZZZZ', ip)).toMatchObject({ ok: false, lockedOut: 'address' });
    const fresh = offers.start();
    expect(offers.locked(ip)).toBe(true);
    expect(offers.redeem(fresh.code, ip)).toEqual({ ok: false, reason: 'locked' });
    // The lockout did not touch the offer, and another address can still use it.
    expect(offers.redeem(fresh.code, '192.168.1.51')).toEqual({ ok: true });
    expect(code).not.toBe(fresh.code);
    now += PAIRING_LOCKOUT_MS - 1;
    expect(offers.locked(ip)).toBe(true);
    now += 1;
    expect(offers.locked(ip)).toBe(false);
    const again = offers.start();
    expect(offers.redeem(again.code, ip)).toEqual({ ok: true });
  });

  it('forgets failures older than ten minutes', () => {
    let now = 9_000_000;
    const offers = new PairingOffers(() => now);
    const ip = '192.168.1.60';
    for (let i = 0; i < 4; i++) offers.redeem('ZZZZZZZZ', ip);
    now += PAIRING_FAILURE_WINDOW_MS + 1;
    for (let i = 0; i < 4; i++) offers.redeem('ZZZZZZZZ', ip);
    expect(offers.locked(ip)).toBe(false);
  });

  it('locks every address out after the global cap of failures', () => {
    const offers = new PairingOffers();
    let last;
    for (let i = 0; i < PAIRING_MAX_FAILURES_GLOBAL; i++) last = offers.redeem('ZZZZZZZZ', `10.1.${i}.1`);
    expect(last).toMatchObject({ lockedOut: 'global' });
    const { code } = offers.start();
    expect(offers.redeem(code, '10.9.9.9')).toEqual({ ok: false, reason: 'locked' });
  });
});

// ---- the QR encoder ----

/**
 * Read a code back: format information, unmask, the zigzag, de-interleave,
 * check every block's Reed–Solomon syndromes are zero, and parse byte mode.
 * Written from the standard independently of the encoder's own helpers but
 * the tables, so a placement or interleaving bug shows up here.
 */
function decodeQr(qr: QrCode): { text: string; ecc: QrEcc; mask: number } {
  const n = qr.size;
  const m = qr.modules;
  const version = (n - 17) / 4;
  // Format bits, first copy, as placed (bit 0 at (8,0) … ).
  const at = (x: number, y: number) => (m[y][x] ? 1 : 0);
  const coords: [number, number][] = [];
  for (let i = 0; i <= 5; i++) coords.push([8, i]);
  coords.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) coords.push([14 - i, 8]);
  let fmt = 0;
  coords.forEach(([x, y], i) => (fmt |= at(x, y) << i));
  const levels: QrEcc[] = ['L', 'M', 'Q', 'H'];
  let ecc: QrEcc | undefined;
  let mask = -1;
  for (const l of levels) for (let k = 0; k < 8; k++) if (formatBits(l, k) === fmt) [ecc, mask] = [l, k];
  if (!ecc) throw new Error('format information unreadable');
  // Function modules: finders + separators + format, timing, alignment, version.
  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) fn[y][x] = true;
  };
  mark(0, 0, 9, 9);
  mark(n - 8, 0, 8, 9);
  mark(0, n - 8, 9, 8);
  mark(6, 0, 1, n);
  mark(0, 6, n, 1);
  const align = alignmentPositions(version);
  for (const ax of align) {
    for (const ay of align) {
      if ((ax < 9 && ay < 9) || (ax > n - 9 && ay < 9) || (ax < 9 && ay > n - 9)) continue;
      mark(ax - 2, ay - 2, 5, 5);
    }
  }
  if (version >= 7) {
    mark(n - 11, 0, 3, 6);
    mark(0, n - 11, 6, 3);
  }
  const bits: number[] = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < n; v++) {
      const y = upward ? n - 1 - v : v;
      for (const x of [right, right - 1]) if (!fn[y][x]) bits.push(at(x, y) ^ (maskApplies(mask, x, y) ? 1 : 0));
    }
  }
  const raw = Math.floor(bits.length / 8);
  const codewords: number[] = [];
  for (let i = 0; i < raw; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  // De-interleave: blocks from the data capacity and the ECC length per block.
  const dataTotal = dataCodewords(version, ecc);
  const eccTotal = raw - dataTotal;
  let numBlocks = 0;
  let eccLen = 0;
  for (let b = 1; b <= 81 && !numBlocks; b++) if (eccTotal % b === 0 && eccTotal / b <= 30 && Math.floor(raw / b) - eccTotal / b > 0) {
    // The one block count that also reproduces the encoder's layout: short blocks first, ECC equal.
    const e = eccTotal / b;
    const short = Math.floor(raw / b);
    const numShort = b - (raw % b);
    if ((short - e) * numShort + (short - e + 1) * (b - numShort) === dataTotal && reedSolomonOk(b, e)) [numBlocks, eccLen] = [b, e];
  }
  function reedSolomonOk(b: number, e: number): boolean {
    const blocks = split(b, e);
    return blocks.every((blk) => syndromesZero(blk, e));
  }
  function split(b: number, e: number): number[][] {
    const short = Math.floor(raw / b);
    const numShort = b - (raw % b);
    const lens = Array.from({ length: b }, (_, i) => short - e + (i < numShort ? 0 : 1));
    const blocks: number[][] = lens.map(() => []);
    let k = 0;
    for (let i = 0; i < short - e + 1; i++) for (let j = 0; j < b; j++) if (i < lens[j]) blocks[j].push(codewords[k++]);
    for (let i = 0; i < e; i++) for (let j = 0; j < b; j++) blocks[j].push(codewords[k++]);
    return blocks;
  }
  if (!numBlocks) throw new Error('no block layout gives zero syndromes');
  const blocks = split(numBlocks, eccLen);
  const data = blocks.flatMap((blk) => blk.slice(0, blk.length - eccLen));
  const dbits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  const read = (from: number, len: number) => dbits.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
  if (read(0, 4) !== 0b0100) throw new Error('not byte mode');
  const ccBits = version <= 9 ? 8 : 16;
  const count = read(4, ccBits);
  const bytes = Array.from({ length: count }, (_, i) => read(4 + ccBits + i * 8, 8));
  return { text: Buffer.from(bytes).toString('utf8'), ecc, mask };
}

/** Polynomial evaluation at α^i is zero for i < e exactly when the block is a codeword. */
function syndromesZero(block: number[], e: number): boolean {
  const mul = (x: number, y: number) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  };
  let alpha = 1;
  for (let i = 0; i < e; i++) {
    let s = 0;
    for (const c of block) s = mul(s, alpha) ^ c;
    if (s !== 0) return false;
    alpha = mul(alpha, 2);
  }
  return true;
}

describe('the QR encoder', () => {
  it('matches the standard’s worked Reed–Solomon example (HELLO WORLD, 1-M)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomonRemainder(data, reedSolomonDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('matches the published format and version information strings', () => {
    const fmt = (l: QrEcc, k: number) => formatBits(l, k).toString(2).padStart(15, '0');
    expect(fmt('L', 0)).toBe('111011111000100');
    expect(fmt('M', 0)).toBe('101010000010010');
    expect(fmt('Q', 0)).toBe('011010101011111');
    expect(fmt('H', 0)).toBe('001011010001001');
    expect(fmt('M', 5)).toBe('100000011001110');
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
    expect(versionBits(40).toString(2).padStart(18, '0')).toBe('101000110001101001');
  });

  it('has the standard’s alignment positions and data capacities', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => dataCodewords(v, 'M'))).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
    expect(dataCodewords(40, 'L')).toBe(2956);
    expect(dataCodewords(40, 'H')).toBe(1276);
  });

  it('draws "hello" at 1-L exactly as a reference matrix (decoded by an independent reader)', () => {
    // Read back by Chrome's BarcodeDetector (macOS Vision) when this was written.
    const reference = [
      '#######..#.##.#######',
      '#.....#.##.#..#.....#',
      '#.###.#.##..#.#.###.#',
      '#.###.#..#.#..#.###.#',
      '#.###.#.#...#.#.###.#',
      '#.....#.#..##.#.....#',
      '#######.#.#.#.#######',
      '........#####........',
      '##.#..##.##...###.##.',
      '.#####.###....#....##',
      '..##.####.#.##...##.#',
      '...#.#..#..#.....#.##',
      '....#.##.##.#.#.#....',
      '........####...##.#.#',
      '#######.###..#.#.###.',
      '#.....#..#####.##....',
      '#.###.#..#.#..###...#',
      '#.###.#.#.##...#.####',
      '#.###.#..##.#...#.#.#',
      '#.....#.###..##......',
      '#######.#.###..#.#.#.',
    ];
    const qr = encodeQr('hello', 'L');
    expect([qr.version, qr.mask]).toEqual([1, 7]);
    expect(qr.modules.map((row) => row.map((d) => (d ? '#' : '.')).join(''))).toEqual(reference);
  });

  it.each([
    ['https://test-mac.local:7392/pair?code=ABCD2345', 'M' as QrEcc],
    ['short', 'H' as QrEcc],
    [`https://a-long-mac-name.local:7392/pair?code=0123ABCD&pad=${'y'.repeat(120)}`, 'M' as QrEcc],
    ['x'.repeat(400), 'Q' as QrEcc],
    ['ünïcödé ✓', 'L' as QrEcc],
  ])('round-trips %#: picks the smallest version, and every block is a codeword', (text, ecc) => {
    const qr = encodeQr(text, ecc);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(decodeQr(qr)).toEqual({ text, ecc, mask: qr.mask });
    if (qr.version > 1) expect(() => encodeQr(text, ecc, { minVersion: 1, mask: 0 })).not.toThrow();
  });

  it('decodes with every mask', () => {
    for (let mask = 0; mask < 8; mask++) expect(decodeQr(encodeQr('mask test', 'M', { mask })).text).toBe('mask test');
  });

  it('refuses what does not fit, and renders an SVG without style attributes and a terminal block', () => {
    expect(() => encodeQr('x'.repeat(3000), 'H')).toThrow(/do not fit/);
    const qr = encodeQr('https://test-mac.local:7392/pair?code=ABCD2345');
    const svg = qrToSvg(qr, { title: 'a <title>' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 41 41"/);
    expect(svg).not.toContain('style');
    expect(svg).toContain('a &#60;title&#62;');
    const term = qrToTerminal(qr, { border: 2 });
    expect(term.split('\n').filter(Boolean)).toHaveLength(Math.ceil((qr.size + 4) / 2));
    expect(qrToTerminal(qr, { ansi: true })).toContain('\x1b[30;107m');
  });
});

// ---- the device store ----

describe('the device store (#137)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-devs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('revokes by id: the credential stops verifying, the file forgets it, and listeners hear of it', () => {
    const file = path.join(dir, 'web-devices.json');
    const store = new WebDeviceStore(file);
    const { device, credential } = store.issue('Safari on iOS', undefined, 'lan');
    const revoked: string[] = [];
    let changes = 0;
    store.onDidRevoke((id) => revoked.push(id));
    store.onDidChange(() => changes++);
    expect(store.verify(credential, 'lan')?.id).toBe(device.id);
    expect(store.revoke(device.id)?.id).toBe(device.id);
    expect(store.revoke(device.id)).toBeUndefined();
    expect(revoked).toEqual([device.id]);
    expect(changes).toBe(1);
    expect(store.verify(credential, 'lan')).toBeUndefined();
    expect(store.has(device.id)).toBe(false);
    expect(new WebDeviceStore(file).list()).toEqual([]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('recovers a LAN device by its token: a new credential, the old one gone, the token kept, revoke ends it', () => {
    const file = path.join(dir, 'web-devices.json');
    const store = new WebDeviceStore(file);
    const { device, credential } = store.issue('Chrome on iOS', undefined, 'lan');
    const token = store.issueRecovery(device.id)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token);
    expect(store.recover('nope', 'lan')).toBeUndefined();
    expect(store.recover(token, 'loopback')).toBeUndefined();
    const again = store.recover(token, 'lan')!;
    expect(again.device.id).toBe(device.id);
    expect(store.verify(again.credential, 'lan')?.id).toBe(device.id);
    expect(store.verify(credential, 'lan')).toBeUndefined();
    expect(store.recover(token, 'lan')).toBeDefined();
    // A newer token replaces the older one.
    const newer = store.issueRecovery(device.id)!;
    expect(store.recover(token, 'lan')).toBeUndefined();
    expect(store.recover(newer, 'lan')).toBeDefined();
    // It survives a restart, and not a revoke.
    expect(new WebDeviceStore(file).recover(newer, 'lan')).toBeDefined();
    store.revoke(device.id);
    expect(store.recover(newer, 'lan')).toBeUndefined();
  });

  it('gives loopback devices and unknown ids no recovery token, and an expired device cannot recover', () => {
    let now = 1_000_000;
    const store = new WebDeviceStore(path.join(dir, 'web-devices.json'), () => now);
    expect(store.issueRecovery(store.issue('Chrome on macOS').device.id)).toBeUndefined();
    expect(store.issueRecovery('missing')).toBeUndefined();
    const { device } = store.issue('Safari on iOS', undefined, 'lan');
    const token = store.issueRecovery(device.id)!;
    now += DEVICE_TTL_MS + 1;
    expect(store.recover(token, 'lan')).toBeUndefined();
  });

  it('names iOS Chrome, Firefox and Edge by their own tokens', () => {
    const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ';
    expect(summarizeUserAgent(`${ios}CriOS/130.0.0.0 Mobile/15E148 Safari/604.1`)).toBe('Chrome on iOS');
    expect(summarizeUserAgent(`${ios}FxiOS/130.0 Mobile/15E148 Safari/605.1.15`)).toBe('Firefox on iOS');
    expect(summarizeUserAgent(`${ios}EdgiOS/130.0 Version/18.0 Mobile/15E148 Safari/605.1.15`)).toBe('Edge on iOS');
    expect(summarizeUserAgent(`${ios}Version/18.0 Mobile/15E148 Safari/604.1`)).toBe('Safari on iOS');
  });

  it('cleans a typed device name', () => {
    expect(cleanDeviceName('  My\u0000 phone\n\t ', 'fallback')).toBe('My phone');
    expect(cleanDeviceName('‮', 'Safari on iOS')).toBe('Safari on iOS');
    expect(cleanDeviceName('x'.repeat(200), 'f')).toHaveLength(60);
  });
});

// ---- the forms over real listeners ----

const HAS_OPENSSL = fs.existsSync('/usr/bin/openssl');
const HOST = 'test-mac';
const LAN_NAME = `${HOST}.local`;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe.skipIf(!HAS_OPENSSL)('pairing over the listeners', () => {
  let tmp: string;
  let caPem: string;
  let material: TlsMaterial;
  let dir: string;
  let server: WebServer;
  let store: WebDeviceStore;
  let registry: ClientRegistry;
  let conns: BrowserConnections;
  let audit: AccessAuditRecord[];
  let loopPort: number;
  let lanPort: number;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pairtls-'));
    const certs = new LocalCertificates({ dir: path.join(tmp, 'web-tls') });
    caPem = await certs.caCertificate(HOST);
    material = await certs.serverCertificate(HOST, ['192.168.1.20']);
  }, 60_000);

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pairweb-'));
    const webviewDir = path.join(dir, 'dist', 'webview');
    fs.mkdirSync(webviewDir, { recursive: true });
    for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
    audit = [];
    const gate = createAccessGate({ audit: { write: (r) => audit.push(r) } });
    store = new WebDeviceStore(path.join(dir, 'data', 'web-devices.json'));
    registry = new ClientRegistry({ log: () => undefined });
    conns = createBrowserConnections({
      clients: registry,
      log: () => undefined,
      build: () => 'test',
      isMutating: () => false,
      limits: { pingIntervalMs: 0 },
      createPanes: () => ({
        dashboard: { dispose() {} },
        conversation: { dispose() {} } as never,
      }),
    });
    server = new WebServer({
      port: 0,
      webviewDir,
      dataDir: path.join(dir, 'data'),
      gate,
      log: () => undefined,
      page: renderBrowserWorkbenchHtml,
      onClient: (ws, context) => conns.attach(ws, context),
      devices: store,
      onDeviceRevoked: (id) => conns.closeDevice(id),
      caCertificate: async () => caPem,
    });
    loopPort = await server.listen();
    const status = await server.setLan({ addresses: ['127.0.0.1'], names: [LAN_NAME, '192.168.1.20'], port: 0, cert: material.cert, key: material.key });
    lanPort = status[0].port!;
  });

  afterEach(() => {
    conns.dispose();
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lanOrigin = () => `https://${LAN_NAME}:${lanPort}`;
  const loopOrigin = () => `http://127.0.0.1:${loopPort}`;

  function lan(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: lanPort,
          servername: LAN_NAME,
          ca: caPem,
          path: pathname,
          method: opts.method ?? 'GET',
          headers: { host: `${LAN_NAME}:${lanPort}`, ...opts.headers },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  function loop(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: loopPort, path: pathname, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${loopPort}`, ...opts.headers }, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  const cookieValue = (r: Reply, name: string) =>
    (r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

  /** GET /pair: the form's token, as both cookie and hidden field. */
  async function lanForm(code = ''): Promise<{ token: string; reply: Reply }> {
    const reply = await lan(`/pair?code=${encodeURIComponent(code)}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' } });
    expect(reply.status).toBe(200);
    const token = cookieValue(reply, LAN_PAIR_FORM_COOKIE)!;
    expect(reply.body).toContain(`name="token" value="${token}"`);
    return { token, reply };
  }

  function postPair(fields: Record<string, string>, opts: { token?: string; cookieToken?: string; origin?: string | null; type?: string } = {}): Promise<Reply> {
    const body = new URLSearchParams({ ...(opts.token !== undefined ? { token: opts.token } : {}), ...fields }).toString();
    return lan('/pair', {
      method: 'POST',
      body,
      headers: {
        'content-type': opts.type ?? 'application/x-www-form-urlencoded',
        ...(opts.origin === null ? {} : { origin: opts.origin ?? lanOrigin() }),
        ...(opts.cookieToken !== undefined ? { cookie: `${LAN_PAIR_FORM_COOKIE}=${opts.cookieToken}` } : {}),
      },
    });
  }

  async function pairDevice(name = 'James phone'): Promise<{ credential: string; deviceId: string }> {
    const offer = server.pairingOffer()!;
    const { token } = await lanForm(offer.code);
    const r = await postPair({ code: offer.code, name }, { token, cookieToken: token });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/');
    const credential = cookieValue(r, LAN_DEVICE_COOKIE)!;
    const set = (r.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${LAN_DEVICE_COOKIE}=`))!;
    expect(set).toMatch(/HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
    const device = store.list().find((d) => d.name === name)!;
    return { credential, deviceId: device.id };
  }

  async function loopbackCredential(): Promise<string> {
    const code = new URL(server.loginLink().url).searchParams.get('code');
    const r = await loop(`/login?code=${code}`);
    return cookieValue(r, 'aw_device')!;
  }

  function connect(port: number, secure: boolean, cookie: string): Promise<{ ws: WebSocket; closed: Promise<number> } | { status: number }> {
    return new Promise((resolve) => {
      const origin = secure ? lanOrigin() : loopOrigin();
      const ws = new WebSocket(`${secure ? 'wss' : 'ws'}://127.0.0.1:${port}/ws`, {
        headers: { origin, cookie, host: secure ? `${LAN_NAME}:${port}` : `127.0.0.1:${port}` },
        ...(secure ? { ca: caPem, servername: LAN_NAME } : {}),
      });
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      ws.on('open', () => resolve({ ws, closed }));
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      });
      ws.on('error', () => undefined);
    });
  }

  it('pairs by the QR code’s link: the form is prefilled, one POST makes a LAN device and signs it in', async () => {
    expect(server.pairingOffer()?.url).toMatch(new RegExp(`^https://test-mac\\.local:${lanPort}/pair\\?code=[0-9A-Z]{8}$`));
    const offer = server.pairingOffer()!;
    const { reply } = await lanForm(offer.code);
    expect(reply.body).toContain(`value="${offer.code}"`);
    expect(reply.body).toContain('value="Safari on iOS"');
    expect(reply.headers['content-security-policy']).toContain("form-action 'self'");
    expect(reply.headers['content-security-policy']).not.toContain('script-src');
    const { credential, deviceId } = await pairDevice('Kitchen iPad');
    expect(store.list().find((d) => d.id === deviceId)).toMatchObject({ scope: 'lan', name: 'Kitchen iPad' });
    const page = await lan('/', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${credential}` } });
    expect(page.status).toBe(200);
    // Audited by id; neither the code nor the credential appears anywhere in it.
    expect(audit).toContainEqual(expect.objectContaining({ event: 'authorized', action: 'web.pair.redeem', resource: { kind: 'device', id: deviceId } }));
    expect(JSON.stringify(audit)).not.toContain(offer.code);
    expect(JSON.stringify(audit)).not.toContain(credential);
  });

  it('a code works once (expiry is covered with a clock above)', async () => {
    const { deviceId } = await pairDevice();
    expect(deviceId).toBeTruthy();
    // pairDevice spent the offer; a second try with any code fails.
    const { token } = await lanForm();
    const again = await postPair({ code: 'ABCD2345', name: 'x' }, { token, cookieToken: token });
    expect(again.status).toBe(401);
    expect(again.body).toContain('not right');
    expect(audit).toContainEqual(expect.objectContaining({ event: 'login-failed', action: 'web.pair.redeem', outcome: 'invalid' }));
  });

  it('refuses a POST without this server’s Origin, without the form token, of another type, or too large', async () => {
    const offer = server.pairingOffer()!;
    const { token } = await lanForm(offer.code);
    expect((await postPair({ code: offer.code }, { token, cookieToken: token, origin: null })).status).toBe(403);
    expect((await postPair({ code: offer.code }, { token, cookieToken: token, origin: 'https://evil.example' })).status).toBe(403);
    expect((await postPair({ code: offer.code }, { token, cookieToken: token, origin: `http://${LAN_NAME}:${lanPort}` })).status).toBe(403);
    // A cross-site form cannot read the cookie to copy the token, nor set it.
    expect((await postPair({ code: offer.code }, { token })).status).toBe(403);
    expect((await postPair({ code: offer.code }, { token: 'forged', cookieToken: token })).status).toBe(403);
    expect((await postPair({ code: offer.code }, { token, cookieToken: token, type: 'text/plain' })).status).toBe(415);
    expect((await postPair({ code: offer.code, name: 'x'.repeat(MAX_FORM_BYTES) }, { token, cookieToken: token })).status).toBe(413);
    // None of those counted as a guess or spent the code.
    const ok = await postPair({ code: offer.code, name: 'after' }, { token, cookieToken: token });
    expect(ok.status).toBe(303);
  });

  it('locks out brute force: five wrong codes and the address is refused, the right code included', async () => {
    const offer = server.pairingOffer()!;
    const { token } = await lanForm();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await postPair({ code: `ZZZZZZZ${i}` }, { token, cookieToken: token })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    const fresh = server.pairingOffer()!;
    const right = await postPair({ code: fresh.code }, { token, cookieToken: token });
    expect(right.status).toBe(429);
    expect(right.headers['retry-after']).toBe(String(PAIRING_LOCKOUT_MS / 1000));
    expect((await lan(`/pair?code=${fresh.code}`)).status).toBe(429);
    expect(store.list()).toEqual([]);
    expect(offer.code).not.toBe(fresh.code);
    expect(audit.filter((r) => r.event === 'login-failed').map((r) => r.outcome)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'locked-out-address']);
  });

  it('starts pairing from a signed-in browser on this Mac, behind its own form token', async () => {
    const cred = await loopbackCredential();
    expect((await loop('/pair/new')).status).toBe(401);
    const page = await loop('/pair/new', { headers: { cookie: `aw_device=${cred}` } });
    expect(page.status).toBe(200);
    const token = cookieValue(page, PAIR_FORM_COOKIE)!;
    const post = (headers: Record<string, string>, body: string) =>
      loop('/pair/new', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
    expect((await post({ cookie: `aw_device=${cred}; ${PAIR_FORM_COOKIE}=${token}` }, `token=${token}`)).status).toBe(403); // no Origin
    expect((await post({ origin: loopOrigin(), cookie: `aw_device=${cred}` }, `token=${token}`)).status).toBe(403); // no form cookie
    expect((await post({ origin: loopOrigin(), cookie: `${PAIR_FORM_COOKIE}=${token}` }, `token=${token}`)).status).toBe(401); // not signed in
    const shown = await post({ origin: loopOrigin(), cookie: `aw_device=${cred}; ${PAIR_FORM_COOKIE}=${token}` }, `token=${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toContain('<svg');
    const code = /class="code-big">([0-9A-Z]{4})-([0-9A-Z]{4})</.exec(shown.body);
    expect(code).not.toBeNull();
    expect(audit).toContainEqual(expect.objectContaining({ event: 'authorized', action: 'web.pair.start', via: 'browser' }));
    // The code shown is the one the LAN accepts.
    const { token: lanToken } = await lanForm();
    expect((await postPair({ code: `${code![1]}${code![2]}`, name: 'from page' }, { token: lanToken, cookieToken: lanToken })).status).toBe(303);
    // And /pair is not a loopback route, nor /pair/new a LAN one.
    expect((await loop('/pair', { headers: { cookie: `aw_device=${cred}` } })).status).toBe(404);
    expect((await lan('/pair/new')).status).toBe(401);
  });

  it('a loopback credential is still no credential on the LAN, nor a LAN one on loopback', async () => {
    const cred = await loopbackCredential();
    expect((await lan('/', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${cred}` } })).status).toBe(401);
    expect(await connect(lanPort, true, `${LAN_DEVICE_COOKIE}=${cred}`)).toEqual({ status: 401 });
    const { credential } = await pairDevice();
    expect((await loop('/', { headers: { cookie: `aw_device=${credential}` } })).status).toBe(401);
  });

  describe('recovery for a browser that lost its cookie', () => {
    const post = (p: string, headers: Record<string, string> = {}, body = '') =>
      lan(p, { method: 'POST', body, headers: { origin: lanOrigin(), 'content-type': 'application/x-www-form-urlencoded', ...headers } });

    it('hands a signed-in LAN device a token, and trades it for a new cookie', async () => {
      const { credential, deviceId } = await pairDevice();
      expect((await post('/reauth/token')).status).toBe(401);
      const issued = await post('/reauth/token', { cookie: `${LAN_DEVICE_COOKIE}=${credential}` });
      expect(issued.status).toBe(200);
      const { token } = JSON.parse(issued.body) as { token: string };
      const back = await post('/reauth', {}, new URLSearchParams({ token }).toString());
      expect(back.status).toBe(204);
      const fresh = cookieValue(back, LAN_DEVICE_COOKIE)!;
      expect((back.headers['set-cookie'] ?? [])[0]).toMatch(/HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
      expect((await lan('/', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${fresh}` } })).status).toBe(200);
      expect(store.list().find((d) => d.id === deviceId)).toBeDefined();
      expect(JSON.stringify(audit)).not.toContain(token);
    });

    it('refuses a wrong token, a foreign Origin, and a revoked device’s token', async () => {
      const { credential, deviceId } = await pairDevice();
      const { token } = JSON.parse((await post('/reauth/token', { cookie: `${LAN_DEVICE_COOKIE}=${credential}` })).body) as { token: string };
      const form = new URLSearchParams({ token }).toString();
      expect((await post('/reauth', {}, new URLSearchParams({ token: 'nope' }).toString())).status).toBe(401);
      expect((await post('/reauth', { origin: 'https://evil.example' }, form)).status).toBe(403);
      expect((await post('/reauth', { 'content-type': 'text/plain' }, form)).status).toBe(415);
      store.revoke(deviceId);
      expect((await post('/reauth', {}, form)).status).toBe(401);
    });

    it('is not offered on loopback', async () => {
      const cred = await loopbackCredential();
      const r = await loop('/reauth/token', { method: 'POST', headers: { origin: loopOrigin(), cookie: `aw_device=${cred}` } });
      expect(r.status).toBe(405);
    });

    it('answers a cookie-less page load with the pairing words and a nonce’d recovery script', async () => {
      const r = await lan('/');
      expect(r.status).toBe(401);
      expect(r.body).toContain('aw web pair');
      const nonce = /script-src 'nonce-([^']+)'/.exec(String(r.headers['content-security-policy']))?.[1];
      expect(nonce).toBeTruthy();
      expect(r.body).toContain(`<script nonce="${nonce}">`);
      expect(r.headers['content-security-policy']).not.toContain('unsafe-inline');
      // Assets and other paths stay plain 401s.
      expect((await lan('/workbench.js')).headers['content-type']).toContain('text/plain');
    });
  });

  it('revoking a paired device disconnects it at once and refuses it from then on', async () => {
    const { credential, deviceId } = await pairDevice();
    const other = await pairDevice('Other phone');
    const a = await connect(lanPort, true, `${LAN_DEVICE_COOKIE}=${credential}`);
    const b = await connect(lanPort, true, `${LAN_DEVICE_COOKIE}=${other.credential}`);
    if (!('ws' in a) || !('ws' in b)) throw new Error('did not connect');
    await until(() => conns.size === 2 && registry.size === 2);
    expect(server.connectionsOf(deviceId)).toBe(1);
    store.revoke(deviceId);
    // Pane hosts and the client registration go in the same tick.
    expect(conns.size).toBe(1);
    expect(registry.size).toBe(1);
    expect(server.connectionsOf(deviceId)).toBe(0);
    expect(await a.closed).toBe(1006);
    expect(await connect(lanPort, true, `${LAN_DEVICE_COOKIE}=${credential}`)).toEqual({ status: 401 });
    expect((await lan('/', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${credential}` } })).status).toBe(401);
    // The other device is untouched.
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    b.ws.close();
  });

  it('revoking a loopback device does the same on loopback', async () => {
    const cred = await loopbackCredential();
    const c = await connect(loopPort, false, `aw_device=${cred}`);
    if (!('ws' in c)) throw new Error('did not connect');
    await until(() => conns.size === 1);
    store.revoke(store.list()[0].id);
    expect(conns.size).toBe(0);
    expect(registry.size).toBe(0);
    await c.closed;
    expect(await connect(loopPort, false, `aw_device=${cred}`)).toEqual({ status: 401 });
  });

  it('offers nothing while LAN access is off, and turning it off withdraws the offer', async () => {
    const offer = server.pairingOffer()!;
    await server.setLan(undefined);
    expect(server.pairingOffer()).toBeUndefined();
    const status = await server.setLan({ addresses: ['127.0.0.1'], names: [LAN_NAME], port: 0, cert: material.cert, key: material.key });
    lanPort = status[0].port!;
    const { token } = await lanForm();
    expect((await postPair({ code: offer.code }, { token, cookieToken: token })).status).toBe(401);
  });

  describe('the plain-HTTP setup page the QR code opens', () => {
    function setup(setupUrl: string, pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
      const u = new URL(setupUrl);
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: Number(u.port), path: pathname, method: 'GET', headers: { host: `192.168.1.20:${u.port}`, ...headers }, agent: false },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as never, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    it('carries the code in the QR link, serves the profile and the way on to /pair, and does not spend the offer', async () => {
      const offer = server.pairingOffer()!;
      expect(offer.setupUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\?code=[0-9A-Z]{8}$/);
      const q = `?code=${offer.code}`;
      const page = await setup(offer.setupUrl!, `/setup${q}`, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Mobile Safari' });
      expect(page.status).toBe(200);
      expect(page.body).toContain(`/setup/ca.mobileconfig${q}`);
      expect(page.body).toContain(`https://192.168.1.20:${lanPort}/pair?code=${offer.code}`);
      expect(page.body).not.toContain('Windows</h2>');
      const profile = await setup(offer.setupUrl!, `/setup/ca.mobileconfig${q}`);
      expect(profile.status).toBe(200);
      expect(profile.headers['content-type']).toBe('application/x-apple-aspen-config');
      const pem = await setup(offer.setupUrl!, `/setup/ca.pem${q}`);
      expect(pem.body).toContain('BEGIN CERTIFICATE');
      // Still redeemable: the setup pages only looked.
      await pairDevice('Setup phone');
    });

    it('shows a Windows PC the Windows steps, and tells another browser on iOS to use Safari', async () => {
      const offer = server.pairingOffer()!;
      const q = `/setup?code=${offer.code}`;
      const win = await setup(offer.setupUrl!, q, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36' });
      expect(win.body).toContain('Windows</h2>');
      expect(win.body).not.toContain('iPhone or iPad</h2>');
      const chrome = await setup(offer.setupUrl!, q, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130 Mobile Safari' });
      expect(chrome.body).toContain('Open this page in Safari');
    });

    it('refuses without a live offer or the right code, counts wrong codes, and never answers another Host', async () => {
      const offer = server.pairingOffer()!;
      const base = offer.setupUrl!;
      expect((await setup(base, '/setup?code=ZZZZZZZZ')).status).toBe(404);
      expect((await setup(base, '/setup')).status).toBe(404);
      expect((await setup(base, `/setup?code=${offer.code}`, { host: 'evil.example:80' })).status).toBe(421);
      expect((await setup(base, '/anything-else')).status).toBe(404);
      for (let i = 0; i < 5; i++) await setup(base, '/setup?code=ZZZZZZZZ');
      // Five wrong codes withdrew the offer; the right one no longer opens anything.
      expect((await setup(base, `/setup?code=${offer.code}`)).status).toBe(429);
    });

    it('closes with LAN access', async () => {
      const offer = server.pairingOffer()!;
      await server.setLan(undefined);
      await expect(setup(offer.setupUrl!, `/setup?code=${offer.code}`)).rejects.toThrow();
    });
  });
});

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- the command line and Preferences ----

describe('aw web pair / devices (#137)', () => {
  it('parses', () => {
    expect(parseArgs(['web', 'pair'])).toEqual({ kind: 'webPair' });
    expect(parseArgs(['web', 'devices'])).toEqual({ kind: 'webDevices', json: false });
    expect(parseArgs(['web', 'devices', '--json'])).toEqual({ kind: 'webDevices', json: true });
    expect(parseArgs(['web', 'devices', 'revoke', 'abcd1234'])).toEqual({ kind: 'webRevoke', id: 'abcd1234' });
    expect(parseArgs(['web', 'devices', 'revoke'])).toHaveProperty('error');
    expect(parseArgs(['web', 'devices', 'revoke', 'a', 'b'])).toHaveProperty('error');
    expect(parseArgs(['web', 'devices', 'revoke', 'a', '--json'])).toHaveProperty('error');
    expect(parseArgs(['web', 'devices', 'remove', 'a'])).toHaveProperty('error');
    expect(parseArgs(['web', 'pair', 'now'])).toHaveProperty('error');
    expect(parseArgs(['web', 'pair', '--json'])).toHaveProperty('error');
    expect(parseArgs(['web', 'open'])).toEqual({ kind: 'web', action: 'open' });
  });

  it('refuses pair and revoke in an agent’s shell, but not the list', () => {
    const inside = 'a Claude Code session';
    expect(webRefusal({ kind: 'webPair' }, inside)).toMatch(/^aw web pair: refused/);
    expect(webRefusal({ kind: 'webRevoke', id: 'x' }, inside)).toMatch(/^aw web devices revoke: refused/);
    expect(webRefusal({ kind: 'webDevices', json: false }, inside)).toBeUndefined();
    expect(webRefusal({ kind: 'webPair' }, undefined)).toBeUndefined();
  });

  it('prints the device list and the pairing instructions', () => {
    const now = 10 * 24 * 60 * MIN;
    const text = formatWebDevices(
      [
        { id: 'aaaaaaaa-1111', name: 'Safari on iOS', scope: 'lan', createdAt: now - 2 * 24 * 60 * MIN, lastSeen: now - 5 * MIN },
        { id: 'bbbbbbbb-2222', name: 'Chrome on macOS', scope: 'loopback', createdAt: now - 3 * 24 * 60 * MIN, lastSeen: now - 2 * 60 * MIN },
      ],
      now,
    );
    expect(text.split('\n').slice(0, 3)).toEqual([
      'ID        WHERE         ADDED   LAST SEEN  NAME',
      'aaaaaaaa  home network  2d ago  5m ago     Safari on iOS',
      'bbbbbbbb  this Mac      3d ago  2h ago     Chrome on macOS',
    ]);
    expect(formatWebDevices([], now)).toMatch(/^No browser devices/);
    const pair = formatWebPair({ url: 'https://test-mac.local:7392/pair?code=ABCD2345', code: 'ABCD2345', expiresAt: now + 5 * MIN }, now);
    expect(pair).toContain('open https://test-mac.local:7392/pair on it');
    expect(pair).toContain('    ABCD-2345');
    expect(pair).toContain('for 5 minutes');
  });

  it('Preferences only revokes a well-formed id', () => {
    expect(revokeWebDeviceId({ type: 'revokeWebDevice', id: 'abc' })).toBe('abc');
    expect(revokeWebDeviceId({ type: 'revokeWebDevice', id: '' })).toBeUndefined();
    expect(revokeWebDeviceId({ type: 'revokeWebDevice', id: 5 })).toBeUndefined();
    expect(revokeWebDeviceId({ type: 'set', id: 'abc' })).toBeUndefined();
  });
});
