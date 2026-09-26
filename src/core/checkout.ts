/**
 * Which git checkout a folder is in, read from the files alone: the repo root,
 * the linked worktree if it is one, and the branch checked out. No `git`
 * subprocess, so it is cheap enough to call at every launch.
 *
 * The session registry records this at launch (`repoRoot`, `worktree`,
 * `branchAtStart`), so "sessions in this repo" and "two sessions in one
 * checkout" can be answered later without re-deriving where a session started.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseWorktreeGitdir } from './worktree';

export interface CheckoutInfo {
  /** The main repository's root. For a linked worktree, the checkout it belongs to. */
  repoRoot?: string;
  /** The linked worktree's root, when the folder is in one. */
  worktree?: string;
  /** The branch checked out, or undefined on a detached HEAD. */
  branch?: string;
}

/** Read a folder's checkout. Anything unreadable just leaves a field out. */
export function checkoutFor(cwd: string): CheckoutInfo {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return { repoRoot: dir, branch: branchOf(path.join(dotGit, 'HEAD')) };
    if (stat?.isFile()) return fromGitFile(dir, dotGit);
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

function fromGitFile(dir: string, dotGit: string): CheckoutInfo {
  let contents: string;
  try {
    contents = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return {};
  }
  const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(contents)?.[1];
  if (!gitdir) return {};
  const resolved = path.resolve(dir, gitdir);
  const worktree = parseWorktreeGitdir(contents);
  // A submodule's `.git` file points into `modules/`, not `worktrees/`: its own root is the repo.
  if (!worktree) return { repoRoot: dir, branch: branchOf(path.join(resolved, 'HEAD')) };
  return { repoRoot: worktree.mainRepo, worktree: dir, branch: branchOf(path.join(resolved, 'HEAD')) };
}

/** Bounded like the worktree cache, for the same reason. */
const MAX_ROOT_CACHE = 512;
const rootCache = new Map<string, string | undefined>();

/**
 * The checkout root a folder is in — its linked worktree's root, else its
 * repository's — memoized per folder, because the dashboard asks for every
 * live row on every snapshot. Undefined outside git.
 */
export function checkoutRootFor(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  const info = checkoutFor(cwd);
  const root = info.worktree ?? info.repoRoot;
  if (rootCache.size >= MAX_ROOT_CACHE) rootCache.clear();
  rootCache.set(cwd, root);
  return root;
}

/**
 * The project a folder belongs to, as the table names and groups it: the
 * main repository's folder name, so a linked worktree (`AgentWrangler-foo`)
 * and a subfolder (`AgentWrangler/src`) both read as `AgentWrangler`, and the
 * Worktree column says which tree. Outside git, the folder's own name.
 * A repository at the home folder itself (a dotfiles repo) is ignored, or
 * every folder under home would be one project.
 */
export function projectNameFor(cwd: string | undefined, home: string = os.homedir()): string | undefined {
  if (!cwd) return undefined;
  if (projectCache.has(cwd)) return projectCache.get(cwd);
  const repo = checkoutFor(cwd).repoRoot;
  const dir = repo && path.resolve(repo) !== path.resolve(home) ? repo : cwd;
  const name = path.basename(dir) || undefined;
  if (projectCache.size >= MAX_ROOT_CACHE) projectCache.clear();
  projectCache.set(cwd, name);
  return name;
}
const projectCache = new Map<string, string | undefined>();

/** Forget every root — the manual Refresh, alongside `clearWorktreeCache`. */
export function clearCheckoutRootCache(): void {
  rootCache.clear();
  projectCache.clear();
}

/** `ref: refs/heads/<branch>` → `<branch>`; a detached HEAD (a bare sha) has none. */
export function parseHead(contents: string): string | undefined {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(contents);
  return m?.[1];
}

function branchOf(headFile: string): string | undefined {
  try {
    return parseHead(fs.readFileSync(headFile, 'utf8'));
  } catch {
    return undefined;
  }
}
