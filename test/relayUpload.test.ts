/**
 * Chunked upload over the relay (#200): `WebFiles.stageChunk` stages a file sent as pane
 * messages the way `POST /upload` stages one sent as a body.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGate } from '../src/core/access';
import { WebFiles } from '../src/core/web/files';
import { RELAY_UPLOAD_CHUNK_BYTES, RELAY_UPLOAD_MAX_BYTES, type UploadChunk } from '../src/shared/files';

let dir: string;
let files: WebFiles;
const KEY = 'claude:synthetic-1';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-relay-upload-')));
  files = new WebFiles({
    dataDir: path.join(dir, 'data'),
    gate: createAccessGate(),
    log: () => undefined,
    downloadRoots: () => [],
    projects: () => [],
    home: dir,
    uploadsPerMinute: 50,
  });
});

afterEach(() => {
  files.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The chunks a page would send for `bytes`. */
function chunksOf(id: string, name: string, bytes: Buffer, per = RELAY_UPLOAD_CHUNK_BYTES): UploadChunk[] {
  const count = Math.max(1, Math.ceil(bytes.length / per));
  return Array.from({ length: count }, (_, index) => ({
    id,
    name,
    index,
    count,
    size: bytes.length,
    data: bytes.subarray(index * per, (index + 1) * per).toString('base64'),
  }));
}

describe('stageChunk', () => {
  it('assembles chunks into a 0600 file in the conversation’s staging directory and reports its host path', async () => {
    const body = Buffer.from('0123456789abcdef');
    const chunks = chunksOf('u1', 'report.txt', body, 5);
    expect(chunks).toHaveLength(4);
    for (const c of chunks.slice(0, -1)) expect(await files.stageChunk('dev', KEY, c)).toEqual({ id: 'u1', index: c.index });
    const last = await files.stageChunk('dev', KEY, chunks[3]!);
    expect(last.error).toBeUndefined();
    expect(last.result).toMatchObject({ name: 'report.txt', size: 16 });
    const file = last.result!.path;
    expect(path.dirname(file)).toBe(files.stagingDir(KEY));
    expect(fs.readFileSync(file)).toEqual(body);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(files.stagingDir(KEY)).some((n) => n.endsWith('.part'))).toBe(false);
    expect(files.isStaged(file)).toBe(true);
  });

  it('takes an empty file as one chunk', async () => {
    const ack = await files.stageChunk('dev', KEY, chunksOf('u2', 'empty.txt', Buffer.alloc(0))[0]!);
    expect(ack.result).toMatchObject({ name: 'empty.txt', size: 0 });
  });

  it('keeps only the base name of a file name', async () => {
    const ack = await files.stageChunk('dev', KEY, chunksOf('u3', '../../etc/passwd', Buffer.from('x'))[0]!);
    expect(path.basename(ack.result!.path).endsWith('-passwd')).toBe(true);
    expect(path.dirname(ack.result!.path)).toBe(files.stagingDir(KEY));
  });

  it('refuses a file over the relay cap before it writes anything', async () => {
    const ack = await files.stageChunk('dev', KEY, { id: 'big', name: 'big.bin', index: 0, count: 300, size: RELAY_UPLOAD_MAX_BYTES + 1, data: 'AAAA' });
    expect(ack.error).toMatch(/25 MB/);
    expect(fs.existsSync(files.stagingDir(KEY))).toBe(false);
  });

  it('refuses a chunk that skips ahead and removes the part file', async () => {
    const chunks = chunksOf('u4', 'a.bin', Buffer.alloc(30, 1), 10);
    await files.stageChunk('dev', KEY, chunks[0]!);
    const ack = await files.stageChunk('dev', KEY, chunks[2]!);
    expect(ack.error).toMatch(/missed/);
    expect(fs.readdirSync(files.stagingDir(KEY))).toEqual([]);
    // The upload is gone: its next chunk is refused too.
    expect((await files.stageChunk('dev', KEY, chunks[1]!)).error).toMatch(/not in progress/);
  });

  it('refuses a continuation that names another conversation', async () => {
    const chunks = chunksOf('u5', 'a.bin', Buffer.alloc(20, 1), 10);
    await files.stageChunk('dev', KEY, chunks[0]!);
    expect((await files.stageChunk('dev', 'claude:other', chunks[1]!)).error).toMatch(/not in progress/);
  });

  it('refuses more bytes than the declared size', async () => {
    const ack = await files.stageChunk('dev', KEY, { id: 'u6', name: 'a.bin', index: 0, count: 1, size: 2, data: Buffer.alloc(5).toString('base64') });
    expect(ack.error).toMatch(/larger/);
  });

  it('refuses a file that ends short of its declared size', async () => {
    const ack = await files.stageChunk('dev', KEY, { id: 'u7', name: 'a.bin', index: 0, count: 1, size: 9, data: Buffer.alloc(5).toString('base64') });
    expect(ack.error).toMatch(/did not complete/);
    expect(fs.readdirSync(files.stagingDir(KEY))).toEqual([]);
  });

  it('refuses a chunk over the chunk size and an id that is not a plain token', async () => {
    const huge = Buffer.alloc(RELAY_UPLOAD_CHUNK_BYTES + 1).toString('base64');
    expect((await files.stageChunk('dev', KEY, { id: 'u8', name: 'a', index: 0, count: 1, size: RELAY_UPLOAD_CHUNK_BYTES + 1, data: huge })).error).toMatch(/too large/);
    expect((await files.stageChunk('dev', KEY, { id: '../x', name: 'a', index: 0, count: 1, size: 1, data: 'AA==' })).error).toMatch(/Bad upload id/);
  });

  it('allows a 25 MB file in chunks', async () => {
    const body = Buffer.alloc(RELAY_UPLOAD_MAX_BYTES, 7);
    let last;
    for (const c of chunksOf('u9', 'max.bin', body)) last = await files.stageChunk('dev', KEY, c);
    expect(last?.result?.size).toBe(RELAY_UPLOAD_MAX_BYTES);
    expect(fs.statSync(last!.result!.path).size).toBe(RELAY_UPLOAD_MAX_BYTES);
  });
});
