/**
 * The web workbench's static files (#127): `dist/webview` and nothing else,
 * under content-hashed names a browser may cache for good.
 *
 * Hashed at serve time rather than by esbuild: the window's `aw://` scheme and
 * the session of a developer running `npm run watch` both keep the plain names,
 * and there is no manifest file to fall out of step with the bundles. The hash
 * is recomputed when a file's size or mtime changes, so a rebuild is picked up
 * by the next page load without a restart.
 *
 * A request names a file by a pattern, never by a path: `<name>.<hash>.<js|css>`
 * for an asset (the hash must be the file's current one), `<name>.<js|css>.map`
 * for a source map. No slash, no `..`, nothing outside the one directory, and
 * the resolved path is checked to be inside it anyway.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const HASH_CHARS = 16;
const HASHED = new RegExp(`^([A-Za-z0-9_-]+)\\.([0-9a-f]{${HASH_CHARS}})\\.(js|css)$`);
const SOURCE_MAP = /^([A-Za-z0-9_-]+)\.(js|css)\.map$/;

export interface ResolvedAsset {
  file: string;
  contentType: string;
  /** Hashed: cache for a year, immutable. A source map is not, and is revalidated. */
  immutable: boolean;
}

interface Entry {
  hash: string;
  size: number;
  mtimeMs: number;
}

/** Whether `file` is strictly inside `root` once both are resolved. */
export function isInside(root: string, file: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(file);
  return f.startsWith(r + path.sep);
}

export class AssetManifest {
  private readonly root: string;
  private readonly entries = new Map<string, Entry>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * The URL path for an asset by its plain name (`workbench.js` →
   * `/workbench.<hash>.js`). Throws if the file is missing: a page that
   * references nothing is a broken build, and better said than served.
   */
  url(name: string): string {
    const hash = this.hashOf(name);
    if (!hash) throw new Error(`web: ${name} is not in the webview build`);
    const ext = path.extname(name);
    return `/${name.slice(0, -ext.length)}.${hash}${ext}`;
  }

  /** What a request path names, or undefined: 404. */
  resolve(urlPath: string): ResolvedAsset | undefined {
    let name: string;
    try {
      name = decodeURIComponent(urlPath).replace(/^\/+/, '');
    } catch {
      return undefined;
    }
    const hashed = HASHED.exec(name);
    if (hashed) {
      const plain = `${hashed[1]}.${hashed[3]}`;
      // A stale hash (an old page after a rebuild) is a miss, not the new file
      // under the old name: an immutable response must never change.
      if (this.hashOf(plain) !== hashed[2]) return undefined;
      return this.found(plain, true);
    }
    const map = SOURCE_MAP.exec(name);
    if (map) return this.found(name, false);
    return undefined;
  }

  private found(plain: string, immutable: boolean): ResolvedAsset | undefined {
    const file = path.join(this.root, plain);
    if (!isInside(this.root, file)) return undefined;
    const type = TYPES[path.extname(plain)];
    if (!type) return undefined;
    try {
      if (!fs.statSync(file).isFile()) return undefined;
    } catch {
      return undefined;
    }
    return { file, contentType: type, immutable };
  }

  private hashOf(plain: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+\.(js|css)$/.test(plain)) return undefined;
    const file = path.join(this.root, plain);
    if (!isInside(this.root, file)) return undefined;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.entries.delete(plain);
      return undefined;
    }
    if (!st.isFile()) return undefined;
    const known = this.entries.get(plain);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.hash;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, HASH_CHARS);
    this.entries.set(plain, { hash, size: st.size, mtimeMs: st.mtimeMs });
    return hash;
  }
}
