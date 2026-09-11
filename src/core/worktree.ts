/**
 * "Is this session working in a linked git worktree, and which one?"
 *
 * Several agents on one repo means several worktrees, and a row that says only
 * `main` is then actively misleading — the tree is what says who is where. This
 * answers it without running git: a linked worktree has a `.git` FILE holding
 * `gitdir: <repo>/.git/worktrees/<name>`, where a main checkout has a `.git`
 * directory. So the whole check is one stat and, at most, one small read.
 *
 * Results are cached by directory: worktrees are created and removed, but a
 * given path does not change its mind, and the dashboard asks for the same
 * handful of cwds every poll.
 */
import * as fsSync from 'node:fs';
import * as path from 'node:path';

export interface WorktreeInfo {
  /** The name `git worktree add` registered — its directory name, in practice. */
  name: string;
  /** Root of the worktree (the directory holding the `.git` file). */
  root: string;
  /** The main checkout this worktree belongs to, when the gitdir path reveals it. */
  mainRepo?: string;
}

/**
 * Read a worktree out of the contents of a `.git` file. Returns undefined for
 * anything that is not a link into `…/.git/worktrees/<name>` — a submodule's
 * `.git` file is the same shape but points at `…/modules/<name>`, and that is
 * not a worktree.
 *
 * Pure; the file is foreign input.
 */
export function parseWorktreeGitdir(contents: string): { name: string; mainRepo?: string } | undefined {
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!m) return undefined;
  // POSIX separators only: git writes this file itself and always uses them.
  const link = m[1].replace(/\\/g, '/').replace(/\/+$/, '');
  const at = link.lastIndexOf('/.git/worktrees/');
  if (at === -1) return undefined;
  const name = link.slice(at + '/.git/worktrees/'.length);
  if (name.length === 0 || name.includes('/')) return undefined;
  return { name, mainRepo: link.slice(0, at) || undefined };
}

/** How far up from cwd to look before giving up. Deep enough for any real repo. */
const MAX_DEPTH = 24;

/**
 * The worktree containing `dir`, or undefined for a main checkout, a path that
 * is not in git at all, or anything unreadable. Walks up until it finds a
 * `.git`, exactly as git does, so a session sitting in a subdirectory of the
 * worktree still resolves.
 */
export function findWorktree(dir: string): WorktreeInfo | undefined {
  let cur = path.resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = path.join(cur, '.git');
    let st: fsSync.Stats | undefined;
    try {
      st = fsSync.statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return undefined; // the main checkout of this repo
    if (st?.isFile()) {
      try {
        const parsed = parseWorktreeGitdir(fsSync.readFileSync(dotGit, 'utf8'));
        return parsed ? { name: parsed.name, root: cur, mainRepo: parsed.mainRepo } : undefined;
      } catch {
        return undefined;
      }
    }
    const up = path.dirname(cur);
    if (up === cur) return undefined; // filesystem root
    cur = up;
  }
  return undefined;
}

/** Bounded so a long-lived window that has seen hundreds of cwds cannot grow forever. */
const MAX_CACHE = 512;
const cache = new Map<string, WorktreeInfo | undefined>();

/** `findWorktree`, memoized per directory. What the provider calls. */
export function worktreeFor(dir: string | undefined): WorktreeInfo | undefined {
  if (!dir) return undefined;
  if (cache.has(dir)) return cache.get(dir);
  const info = findWorktree(dir);
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(dir, info);
  return info;
}

/** Forget everything — the manual Refresh, which is the one place a re-check is asked for. */
export function clearWorktreeCache(): void {
  cache.clear();
}
