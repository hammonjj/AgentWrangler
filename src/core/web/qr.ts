/**
 * A small QR Code encoder (ISO/IEC 18004), for pairing a phone (#137): the
 * phone's camera reads the pairing URL off the Mac's screen or terminal.
 *
 * Byte mode only, every version (1–40) and error-correction level, the mask
 * picked by the standard's penalty rules unless one is asked for. That covers
 * a URL, which is all it is for. Written for this project rather than taken
 * as a dependency, to keep the runtime free of one for ~300 lines; the
 * algorithm is the standard's, laid out the way most compact encoders do it.
 *
 * Pure: no Node or DOM APIs, so the CLI, the server and tests share it.
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  version: number;
  /** Modules per side: `version * 4 + 17`. */
  size: number;
  ecc: QrEcc;
  mask: number;
  /** `modules[y][x]`, true is dark. */
  modules: boolean[][];
}

const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format-information bits for each level (the standard's table, not the ordinal). */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed [level ordinal][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * Encode `data` (a string is UTF-8) as a QR code at `ecc`, in the smallest
 * version that holds it. Throws if even version 40 cannot.
 */
export function encodeQr(data: string | Uint8Array, ecc: QrEcc = 'M', opts: { mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let version = Math.max(1, Math.min(40, opts.minVersion ?? 1));
  for (; ; version++) {
    if (version > 40) throw new Error(`QR: ${bytes.length} bytes do not fit at level ${ecc}`);
    const needed = 4 + charCountBits(version) + bytes.length * 8;
    if (needed <= dataCodewords(version, ecc) * 8) break;
  }

  // The data bit stream: mode, count, bytes, terminator, padding.
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, charCountBits(version));
  for (const b of bytes) appendBits(bits, b, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  const qr = new Builder(version, ecc);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(codewords, version, ecc));

  let mask = opts.mask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      qr.applyMask(m);
      qr.drawFormatBits(m);
      const penalty = qr.penalty();
      if (penalty < best) {
        best = penalty;
        mask = m;
      }
      qr.applyMask(m); // XOR again: undone
    }
  }
  if (mask === undefined || mask < 0 || mask > 7) throw new Error('QR: mask must be 0–7');
  qr.applyMask(mask);
  qr.drawFormatBits(mask);
  return { version, size: qr.size, ecc, mask, modules: qr.modules };
}

/** Bits in the byte-mode character count: 8 up to version 9, 16 after. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function appendBits(out: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) out.push((value >>> i) & 1);
}

/** Modules left for data and error correction once the function patterns are drawn. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (before error correction) a version and level hold. */
export function dataCodewords(version: number, ecc: QrEcc): number {
  const e = ECC_ORDINAL[ecc];
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[e][version] * NUM_ERROR_CORRECTION_BLOCKS[e][version];
}

/** Split into blocks, add each block's Reed–Solomon codewords, and interleave. */
function addEccAndInterleave(data: number[], version: number, ecc: QrEcc): number[] {
  const e = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[e][version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = reedSolomonDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const block = [...dat, ...reedSolomonRemainder(dat, divisor)];
    // A placeholder keeps short blocks aligned with long ones for interleaving.
    if (i < numShort) block.splice(shortLen - eccLen, 0, -1);
    blocks.push(block);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (const block of blocks) if (block[i] !== -1) out.push(block[i]);
  }
  return out;
}

/** GF(2^8) multiplication modulo x^8 + x^4 + x^3 + x^2 + 1. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of `degree`, highest term implied, coefficients high to low. */
export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for `data`. */
export function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/** The 15 format bits for a level and mask, BCH-coded and XOR-masked. */
export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** Centres of the alignment patterns, on both axes. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

/** Whether mask `m` flips the module at (x, y). */
export function maskApplies(m: number, x: number, y: number): boolean {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error('QR: mask must be 0–7');
  }
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(private readonly version: number, private readonly ecc: QrEcc) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const align = alignmentPositions(this.version);
    const last = align.length - 1;
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        // Not over the three finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlignment(align[i], align[j]);
      }
    }
    // Reserve the format areas now (overwritten per mask), then the version.
    this.drawFormatBits(0);
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }

  drawFormatBits(mask: number): void {
    const bits = formatBits(this.ecc, mask);
    const size = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true); // the dark module
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  /** The codewords, in the standard's two-column zigzag from the bottom right. */
  drawCodewords(data: readonly number[]): void {
    const size = this.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing pattern
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** XOR the mask over every data module. Applying it twice undoes it. */
  applyMask(m: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && maskApplies(m, x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** The standard's four penalty rules; the mask with the lowest total is used. */
  penalty(): number {
    const size = this.size;
    const m = this.modules;
    let result = 0;
    const line = (get: (i: number) => boolean): void => {
      // Rule 1: runs of five or more.
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) {
          run++;
          continue;
        }
        if (run >= 5) result += PENALTY_N1 + (run - 5);
        run = 1;
      }
      // Rule 3: a finder-like 1:1:3:1:1 with four light modules on either side
      // (outside the symbol counts as light).
      const at = (i: number): boolean => (i >= 0 && i < size ? get(i) : false);
      const core = [true, false, true, true, true, false, true];
      for (let i = -4; i < size; i++) {
        if (!core.every((c, k) => at(i + k) === c)) continue;
        const before = [1, 2, 3, 4].every((k) => !at(i - k));
        const after = [7, 8, 9, 10].every((k) => !at(i + k));
        if (before) result += PENALTY_N3;
        if (after) result += PENALTY_N3;
      }
    };
    for (let y = 0; y < size; y++) line((x) => m[y][x]);
    for (let x = 0; x < size; x++) line((y) => m[y][x]);
    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    // Rule 4: how far the dark share is from half.
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(0, k) * PENALTY_N4;
    return result;
  }
}

/**
 * An SVG of the code: dark modules as one path on a white square, with the
 * standard's four-module quiet zone. Attributes only, no `style`, so it passes
 * a CSP without `'unsafe-inline'`.
 */
export function qrToSvg(qr: QrCode, opts: { border?: number; title?: string } = {}): string {
  const border = opts.border ?? 4;
  const dim = qr.size + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
  }
  const title = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img">` +
    `${title}<rect width="100%" height="100%" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`
  );
}

/**
 * The code for a terminal, two module rows per text line with half blocks.
 * `ansi`: black on bright white whatever the terminal's theme (a camera needs
 * dark on light). Without it, for a pipe or a file, dark modules are full
 * blocks, which reads correctly on a light background.
 */
export function qrToTerminal(qr: QrCode, opts: { border?: number; ansi?: boolean } = {}): string {
  const border = opts.border ?? 2;
  const dim = qr.size + border * 2;
  const dark = (x: number, y: number): boolean => {
    const mx = x - border;
    const my = y - border;
    return mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx];
  };
  const lines: string[] = [];
  for (let y = 0; y < dim; y += 2) {
    let line = '';
    for (let x = 0; x < dim; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < dim && dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(opts.ansi ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return `${lines.join('\n')}\n`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
