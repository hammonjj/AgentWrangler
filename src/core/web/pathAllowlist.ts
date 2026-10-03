/**
 * Which host paths a browser may be shown or sent (#140; the downloads in
 * #139 use the same check).
 *
 * A browser never names a file the app has not already got a reason to
 * expose. The roots are what the app itself works in: session working
 * directories and their worktrees, orchestration's staging and diffs, and the
 * directories transcripts live in. They are looked up on every call, because
 * sessions come and go.
 *
 * A path is allowed when its *real* path (symlinks resolved, `..` gone) is
 * inside the real path of a root, so a link out of a project, or a path that
 * climbs out of it, does not pass. Files that are secrets by name (`*.key`, the
 * session keys) are refused even inside a root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AllowlistVerdict =
  | { ok: true; realPath: string }
  | { ok: false; reason: 'not-absolute' | 'not-found' | 'outside' | 'secret' };

export interface PathAllowlist {
  /** The real path of `target` if it is under an allowed root and is not a secret. */
  check(target: string): Promise<AllowlistVerdict>;
}

/** `child` is `root` or inside it. Both already resolved. */
export function isWithin(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Names that are credentials wherever they sit. */
export function isSecretName(realPath: string): boolean {
  const base = path.basename(realPath).toLowerCase();
  return base.endsWith('.key') || base.endsWith('.pem') || base === '.env' || base.startsWith('.env.') || base === 'id_rsa' || base === 'id_ed25519';
}

export function createPathAllowlist(roots: () => Iterable<string | undefined>): PathAllowlist {
  return {
    async check(target) {
      if (typeof target !== 'string' || target.includes('\0') || !path.isAbsolute(target)) return { ok: false, reason: 'not-absolute' };
      let real: string;
      try {
        real = await fs.promises.realpath(target);
      } catch {
        return { ok: false, reason: 'not-found' };
      }
      if (isSecretName(real)) return { ok: false, reason: 'secret' };
      for (const root of new Set(roots())) {
        if (!root || !path.isAbsolute(root)) continue;
        let realRoot: string;
        try {
          realRoot = await fs.promises.realpath(root);
        } catch {
          continue; // a root that is gone allows nothing
        }
        // A root of `/` would allow the machine: never a root.
        if (realRoot === path.parse(realRoot).root) continue;
        if (isWithin(realRoot, real)) return { ok: true, realPath: real };
      }
      return { ok: false, reason: 'outside' };
    },
  };
}
