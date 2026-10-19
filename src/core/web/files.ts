/**
 * Files between a remote browser and the daemon host (#139, plan §6), served
 * from `WebServer` through one small hook (`WebServerOptions.files`).
 *
 * - **Upload** (`POST /upload`). The raw body is streamed into a per-
 *   conversation staging directory, `<dataDir>/uploads/<hash of the session
 *   key>/<uuid>-<name>`: files 0600 in directories 0700, nothing older than a
 *   week kept (`cleanup`, at start and daily). The reply carries the **host
 *   path**; the conversation pane then refers to the file by it. The server has already made
 *   sure the request came from this site (`Origin`) and from a signed-in
 *   device; this adds the `X-AW-Upload: 1` header, a size cap, and a per-device
 *   rate limit.
 * - **Download** (`GET /files?path=`). Only inside an allowlist of roots, by
 *   the file's *real* path, so `..` and a symlink that leads out are refused.
 *   `attachment`, `nosniff`, with a `Content-Length`.
 * - **Folder browser** (`GET /api/dirs?path=`). Directories only, below the
 *   home folder or a known project; known projects are offered first.
 *
 * The rule all three keep: a path a client sends is never used as a host path
 * because the client sent it. It is used when it is inside the allowlist, or
 * it is the path an upload was answered with.
 *
 * Audit lines carry the device, the conversation's key and a size; never a
 * file's name, path or content (`access.ts`).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPathAllowlist, isWithin, type PathAllowlist } from './pathAllowlist';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestContext, AccessGate } from '../access';
import type { Disposable } from '../events';
import {
  CONVERSATION_HEADER,
  FILENAME_HEADER,
  MAX_DIR_ENTRIES,
  MAX_UPLOAD_BYTES,
  UPLOAD_HEADER,
  type DirEntry,
  type DirListing,
  type DirProject,
  type UploadResult,
} from '../../shared/files';

export const UPLOADS_DIR = 'uploads';
export const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_CHARS = 120;
const MAX_KEY_CHARS = 256;
const MAX_PATH_CHARS = 4096;

const HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export interface WebFilesOptions {
  dataDir: string;
  gate: AccessGate;
  log: (line: string) => void;
  /**
   * Directories `GET /files` may read below: working directories of the known
   * sessions and their worktrees, and transcript directories. Asked on every
   * request, so a new session's folder is there at once. The staging directory
   * is always included.
   */
  downloadRoots: () => string[];
  /** The projects the folder browser offers first. */
  projects: () => Array<{ name: string; dir: string }>;
  home?: string;
  now?: () => number;
  /** Test knobs; the defaults are the product's. */
  maxUploadBytes?: number;
  uploadsPerMinute?: number;
  maxDirEntries?: number;
}

/** What `WebServer` calls. A request reaching one of these is signed in, same-origin and on a good Host. */
export interface WebFileRoutes {
  upload(ctx: RequestContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  download(ctx: RequestContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void>;
  dirs(ctx: RequestContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void>;
}

export class WebFiles implements WebFileRoutes, Disposable {
  private readonly root: string;
  private readonly home: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly perMinute: number;
  private readonly maxEntries: number;
  /** The one allowlist for what a browser may read: `GET /files`, and `/api/view` (#140) when given this. */
  readonly allowlist: PathAllowlist;
  private readonly recent = new Map<string, number[]>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: WebFilesOptions) {
    this.root = path.join(opts.dataDir, UPLOADS_DIR);
    this.home = opts.home ?? os.homedir();
    this.now = opts.now ?? (() => Date.now());
    this.maxBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;
    this.perMinute = opts.uploadsPerMinute ?? 30;
    this.maxEntries = opts.maxDirEntries ?? MAX_DIR_ENTRIES;
    this.allowlist = createPathAllowlist(() => [this.root, ...opts.downloadRoots()], { home: this.home });
  }

  /** Clean up now and daily. */
  start(): void {
    if (this.timer) return;
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), DAY_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The staging directory for one conversation. Not created. */
  stagingDir(sessionKey: string): string {
    return path.join(this.root, crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0, 32));
  }

  /** Delete uploads older than a week, and the directories they leave empty. Returns how many files went. */
  cleanup(): number {
    let removed = 0;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.root);
    } catch {
      return 0;
    }
    for (const d of dirs) {
      const dir = path.join(this.root, d);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(dir, n);
        try {
          const st = fs.lstatSync(file);
          if (this.now() - st.mtimeMs > UPLOAD_MAX_AGE_MS) {
            fs.rmSync(file, { force: true, recursive: true });
            removed++;
          }
        } catch {
          // Gone already, or not ours to read: next time.
        }
      }
      try {
        fs.rmdirSync(dir); // only if empty
      } catch {
        // Not empty.
      }
    }
    if (removed > 0) this.opts.log(`web: removed ${removed} old upload(s)`);
    return removed;
  }

  /** Whether `file` is a staged upload: the one thing a client's path may be, in a conversation. */
  isStaged(file: string): boolean {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
    try {
      return inside(fs.realpathSync(file), fs.realpathSync(this.root));
    } catch {
      return false;
    }
  }

  // ---- upload ----

  async upload(ctx: RequestContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers[UPLOAD_HEADER] !== '1') return this.refuse(req, res, 400, `Missing ${UPLOAD_HEADER}.`);
    const name = sanitizeName(headerValue(req.headers[FILENAME_HEADER]));
    const key = headerValue(req.headers[CONVERSATION_HEADER]);
    if (name === undefined || !key || key.length > MAX_KEY_CHARS) return this.refuse(req, res, 400, 'Missing or bad file name or conversation.');
    const declared = Number(req.headers['content-length']);
    if (req.headers['content-length'] === undefined || !Number.isInteger(declared) || declared < 0) {
      return this.refuse(req, res, 411, 'A Content-Length is required.');
    }
    if (declared > this.maxBytes) return this.refuse(req, res, 413, `Over the ${Math.floor(this.maxBytes / 1024 / 1024)} MB limit.`);
    if (!this.allowRate(ctx.deviceId ?? 'unknown')) {
      res.setHeader('retry-after', '60');
      return this.refuse(req, res, 429, 'Too many uploads; wait a minute.');
    }
    const id = crypto.randomUUID();
    if (!this.opts.gate.admit(ctx, 'file.upload', { kind: 'file', id, size: declared })) return this.refuse(req, res, 403, 'Not permitted.');

    const dir = this.stagingDir(key);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask and ignored for a directory that exists.
    await fs.promises.chmod(this.root, 0o700);
    await fs.promises.chmod(dir, 0o700);
    const file = path.join(dir, `${id}-${name}`);
    const part = `${file}.part`;
    let size = 0;
    let overflow = false;
    const count = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        size += chunk.length;
        if (size > this.maxBytes) {
          overflow = true;
          cb(new Error('too large'));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, count, fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }));
      if (size !== declared) throw new Error('short body');
      await fs.promises.rename(part, file);
    } catch (err) {
      await fs.promises.rm(part, { force: true });
      if (!res.headersSent && !res.writableEnded) {
        // The rest of an oversized body is not worth reading: close after answering.
        res.setHeader('connection', 'close');
        if (overflow) this.json(res, 413, { error: 'File too large.' });
        else this.json(res, 400, { error: 'The upload did not complete.' });
      }
      this.opts.log(`web: upload ${id} failed (${overflow ? 'too large' : (err as Error).message})`);
      return;
    }
    const result: UploadResult = { path: file, name, size };
    this.json(res, 200, result);
  }

  private allowRate(device: string): boolean {
    const now = this.now();
    const times = (this.recent.get(device) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= this.perMinute) {
      this.recent.set(device, times);
      return false;
    }
    times.push(now);
    this.recent.set(device, times);
    if (this.recent.size > 1000) for (const [k, v] of this.recent) if (v.every((t) => now - t >= 60_000)) this.recent.delete(k);
    return true;
  }

  // ---- download ----

  async download(ctx: RequestContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const wanted = url.searchParams.get('path');
    if (!wanted || wanted.length > MAX_PATH_CHARS || wanted.includes('\0') || !path.isAbsolute(wanted)) {
      return this.refuse(req, res, 400, 'An absolute path is required.');
    }
    const verdict = await this.allowlist.check(wanted);
    if (!verdict.ok) {
      if (verdict.reason === 'not-found') return this.refuse(req, res, 404, 'Not available.');
      if (verdict.reason !== 'not-absolute') this.opts.log('web: refused a download outside the allowed folders');
      return this.refuse(req, res, verdict.reason === 'not-absolute' ? 400 : 403, 'Not available.');
    }
    const real = verdict.realPath;
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(real);
    } catch {
      return this.refuse(req, res, 404, 'Not available.');
    }
    if (!st.isFile()) return this.refuse(req, res, 404, 'Not available.');
    const id = crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
    if (!this.opts.gate.admit(ctx, 'file.download', { kind: 'file', id, size: st.size })) return this.refuse(req, res, 403, 'Not permitted.');
    const base = path.basename(real);
    res.writeHead(200, {
      ...HEADERS,
      'content-type': 'application/octet-stream',
      'content-length': String(st.size),
      'content-disposition': `attachment; filename="${asciiName(base)}"; filename*=UTF-8''${encodeURIComponent(base).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    });
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ---- folder browser ----

  /** What a client may be shown, or choose: below the home folder or below a known project. */
  private async listRoots(): Promise<string[]> {
    return this.realRoots([this.home, ...this.opts.projects().map((p) => p.dir)]);
  }

  private async realRoots(roots: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of roots) {
      try {
        out.push(await fs.promises.realpath(r));
      } catch {
        // A folder that is gone grants nothing.
      }
    }
    return out;
  }

  /** `dir` is a directory a client may choose (the answer to a folder prompt is checked with this). */
  async folderAllowed(dir: string): Promise<boolean> {
    if (typeof dir !== 'string' || dir.length > MAX_PATH_CHARS || dir.includes('\0') || !path.isAbsolute(dir)) return false;
    try {
      const real = await fs.promises.realpath(dir);
      if (!(await fs.promises.stat(real)).isDirectory()) return false;
      return (await this.listRoots()).some((r) => inside(real, r));
    } catch {
      return false;
    }
  }

  async dirs(_ctx: RequestContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const asked = url.searchParams.get('path');
    const hidden = url.searchParams.get('hidden') === '1';
    const roots = await this.listRoots();
    const start = !asked;
    if (!start && (asked.length > MAX_PATH_CHARS || asked.includes('\0') || !path.isAbsolute(asked))) {
      return this.refuse(req, res, 400, 'An absolute path is required.');
    }
    let real: string;
    try {
      real = await fs.promises.realpath(start ? this.home : asked);
    } catch {
      return this.refuse(req, res, 404, 'Not available.');
    }
    if (!roots.some((r) => inside(real, r))) return this.refuse(req, res, 403, 'Not available.');
    const entries: DirEntry[] = [];
    let truncated = false;
    try {
      const d = await fs.promises.opendir(real);
      for await (const e of d) {
        if (!hidden && e.name.startsWith('.')) continue;
        let isDir = e.isDirectory();
        if (!isDir && e.isSymbolicLink()) isDir = await fs.promises.stat(path.join(real, e.name)).then((s) => s.isDirectory(), () => false);
        if (!isDir) continue;
        if (entries.length >= this.maxEntries) {
          truncated = true;
          break;
        }
        entries.push({ name: e.name, path: path.join(real, e.name) });
      }
    } catch {
      return this.refuse(req, res, 404, 'Not available.');
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(real);
    const projects: DirProject[] = start
      ? this.opts.projects().filter((p) => p.dir && path.isAbsolute(p.dir)).map((p) => ({ name: p.name, path: p.dir }))
      : [];
    const listing: DirListing = {
      path: real,
      ...(parent !== real && roots.some((r) => inside(parent, r)) ? { parent } : {}),
      home: this.home,
      projects,
      entries,
      truncated,
      hidden,
    };
    this.json(res, 200, listing);
  }

  // ---- replies ----

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  /** Refuse a request, discarding what the client was going to send (a little of it, then the connection). */
  private refuse(req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
      res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...(req.method === 'POST' ? { connection: 'close' } : {}) });
      res.end(JSON.stringify({ error: message }));
    }
    if (req.method === 'POST' && !req.complete) {
      let drained = 0;
      req.on('data', (c: Buffer) => {
        drained += c.length;
        if (drained > 1024 * 1024) req.destroy();
      });
    }
  }
}

const inside = (child: string, root: string): boolean => isWithin(root, child);

function headerValue(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * A client's file name as a plain name: url-decoded, only the last component
 * (either separator), no control characters, bounded. `undefined`: not a name.
 */
export function sanitizeName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  let name = decoded.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name === '' || name === '.' || name === '..') name = 'file';
  if (name.length > MAX_NAME_CHARS) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name;
}

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\]/g, '_');
}
