/**
 * The read-only file and diff view a browser gets in place of "open in the
 * editor" (#140): `GET /api/view?path=<absolute path>`.
 *
 * - The path must pass the allowlist (`pathAllowlist.ts`): session working
 *   directories, orchestration's staging and diffs, transcript directories.
 *   Anything else is a 403, whatever the signed-in device. A symlink out of a
 *   root, or `..`, does not pass: the check is on the real path.
 * - A text file comes back as JSON, at most `FILE_VIEW_MAX_BYTES` of it, with
 *   `truncated` set when there was more. `.diff` and `.patch` are `kind:
 *   'diff'`. A binary file (a NUL in its first 8 KiB, or not UTF-8) has no
 *   text; the page offers `&download=1`, which sends the file as an attachment.
 * - Only regular files: a directory, device or socket is a 404.
 *
 * Reading is by file descriptor, bounded, so a multi-gigabyte log costs 256
 * KiB and a FIFO cannot hang the request.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FILE_VIEW_MAX_BYTES, FILE_VIEW_ROUTE, isDiffFile, type FileView } from '../../shared/shellProtocol';
import type { PathAllowlist } from './pathAllowlist';
import type { WebRoute } from './server';

const SNIFF_BYTES = 8 * 1024;

export type FileViewOutcome = { ok: true; view: FileView } | { ok: false; reason: 'not-a-file' | 'unreadable' };

/** Read `realPath` for the viewer. `displayPath` is what the user asked for and is shown. */
export async function readFileView(realPath: string, displayPath: string, maxBytes = FILE_VIEW_MAX_BYTES): Promise<FileViewOutcome> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(realPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
    const base = { path: displayPath, name: path.basename(displayPath), size: stat.size };
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = buf.length > 0 ? await handle.read(buf, 0, buf.length, 0) : { bytesRead: 0 };
    const bytes = buf.subarray(0, bytesRead);
    if (isBinary(bytes)) return { ok: true, view: { ...base, kind: 'binary', truncated: false } };
    // A cut can land inside a multi-byte character: drop the partial one rather than show a replacement mark.
    const truncated = stat.size > bytesRead;
    const text = decodeUtf8(truncated ? trimPartial(bytes) : bytes);
    if (text === undefined) return { ok: true, view: { ...base, kind: 'binary', truncated: false } };
    return { ok: true, view: { ...base, kind: isDiffFile(displayPath) ? 'diff' : 'text', text, truncated } };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0);
}

/** Drop a trailing incomplete UTF-8 sequence (at most three bytes). */
function trimPartial(bytes: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back]!;
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: keep looking for its lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The roots the browser may be shown (the allowlist's input): every session's
 * working directory and worktree, the directory its transcript lives in, and
 * orchestration's own directory (its diffs and staging) under the data dir.
 */
export function appPathRoots(
  sessions: () => ReadonlyArray<{ cwd?: string; worktreePath?: string; transcriptPath?: string }>,
  dataDir: string,
): () => string[] {
  return () => {
    const roots = [path.join(dataDir, 'orchestration')];
    for (const s of sessions()) {
      if (s.cwd) roots.push(s.cwd);
      if (s.worktreePath) roots.push(s.worktreePath);
      if (s.transcriptPath) roots.push(path.dirname(s.transcriptPath));
    }
    return roots;
  };
}

const SECURITY = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
} as const;

export function createFileViewRoute(opts: { allowlist: PathAllowlist; log: (line: string) => void }): WebRoute {
  const fail = (res: import('node:http').ServerResponse, status: number, message: string) => {
    res.writeHead(status, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${message}\n`);
  };
  return {
    match: (pathname) => pathname === FILE_VIEW_ROUTE,
    async handle({ res, url }) {
      const wanted = url.searchParams.get('path');
      if (!wanted) return fail(res, 400, 'No path.');
      const verdict = await opts.allowlist.check(wanted);
      if (!verdict.ok) {
        if (verdict.reason === 'not-found') return fail(res, 404, 'No such file.');
        if (verdict.reason === 'not-absolute') return fail(res, 400, 'Not an absolute path.');
        opts.log(`web: refused to show a file (${verdict.reason})`);
        return fail(res, 403, 'That file is not available to the browser.');
      }
      if (url.searchParams.get('download') === '1') {
        const stat = await fs.promises.stat(verdict.realPath).catch(() => undefined);
        if (!stat?.isFile()) return fail(res, 404, 'No such file.');
        res.writeHead(200, {
          ...SECURITY,
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(verdict.realPath))}`,
        });
        const stream = fs.createReadStream(verdict.realPath);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      const out = await readFileView(verdict.realPath, wanted);
      if (!out.ok) return fail(res, out.reason === 'not-a-file' ? 404 : 500, out.reason === 'not-a-file' ? 'Not a file.' : 'Could not read it.');
      res.writeHead(200, { ...SECURITY, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out.view));
    },
  };
}
