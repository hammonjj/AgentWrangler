/**
 * The git worktree a child conversation works in (#198): its own directory and
 * its own branch, cut from the parent's repository HEAD, beside the checkout.
 *
 * ```text
 * <parent>/<repo>                      the parent's checkout — untouched
 * <parent>/<repo>-child-<slug>         child/<slug>
 * ```
 *
 * Deliberately not the mission layout (`<repo>.aw/<mission>/…`, `aw/…`
 * branches), so the two never collide, and standalone: `src/orchestration`
 * goes in #199. Git is run by argv, never a shell, and a worktree is never
 * removed with `--force`: a discard cleans the tree explicitly first.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CHILD_BRANCH_PREFIX = 'child/';
const MAX_CHILD_SLUG = 40;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GitExec = (args: readonly string[], cwd: string) => Promise<GitResult>;

export const nodeGit: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message });
      },
    );
  });

// ---- naming (pure) ----

/** A slug from a name or a prompt's first words: "Fix the login test!" → "fix-the-login-test". */
export function childSlug(text: string, fallback = 'child'): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, MAX_CHILD_SLUG)
    .replace(/-+$/g, '');
  return SLUG.test(s) ? s : fallback;
}

export function childBranch(slug: string): string {
  return `${CHILD_BRANCH_PREFIX}${slug}`;
}

/** `<parent of repo>/<repo>-child-<slug>`: a sibling of the checkout, never inside it. */
export function childWorktreePath(repoRoot: string, slug: string): string {
  const r = path.resolve(repoRoot);
  return path.join(path.dirname(r), `${path.basename(r)}-child-${slug}`);
}

/** The first slug, `slug`, `slug-2`, … that `taken` does not refuse. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean, max = 50): string | undefined {
  for (let n = 1; n <= max; n++) {
    const s = n === 1 ? base : `${base.slice(0, MAX_CHILD_SLUG - 3).replace(/-+$/, '')}-${n}`;
    if (!taken(s)) return s;
  }
  return undefined;
}

/** The repository's default branch: origin's HEAD when it is a local branch too, else main, else master. */
export function pickDefaultBranch(originHead: string | undefined, localBranches: readonly string[]): string | undefined {
  const fromOrigin = originHead?.trim().replace(/^origin\//, '');
  if (fromOrigin && localBranches.includes(fromOrigin)) return fromOrigin;
  return ['main', 'master'].find((b) => localBranches.includes(b));
}

/** What `aw child done` may do, from what it found. Pure; a refusal changes nothing. */
export function doneDecision(f: { registered: boolean; dirty: readonly string[]; merged: boolean | undefined; working: boolean; discard: boolean; defaultBranch?: string; branch: string }):
  | { ok: true; clean: boolean; deleteBranch: boolean }
  | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (f.working && !f.discard) reasons.push('it is still working; wait for it, stop it with aw child stop, or pass --discard');
  if (f.registered && f.dirty.length > 0 && !f.discard) reasons.push(`its worktree has uncommitted changes (${f.dirty.slice(0, 5).join(', ')}${f.dirty.length > 5 ? ', …' : ''})`);
  if (f.merged === false && !f.discard) reasons.push(`${f.branch} has commits not in ${f.defaultBranch ?? 'the default branch'}; merge it first`);
  if (f.merged === undefined && !f.discard) reasons.push(`could not tell whether ${f.branch} is merged${f.defaultBranch ? ` into ${f.defaultBranch}` : ' (no main or master branch)'}`);
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, clean: f.registered && f.dirty.length > 0, deleteBranch: f.merged === true };
}

// ---- git (impure) ----

export interface ChildWorktree {
  repoRoot: string;
  path: string;
  branch: string;
  slug: string;
}

/** The git toplevel of `dir`, or an error to show. */
export async function repoRootOf(dir: string, git: GitExec = nodeGit): Promise<{ root: string } | { error: string }> {
  if (!path.isAbsolute(dir) || !fs.existsSync(dir)) return { error: `${dir} does not exist.` };
  const r = await git(['rev-parse', '--show-toplevel'], dir);
  if (r.code !== 0) return { error: `${dir} is not in a git repository.` };
  return { root: r.stdout.trim() };
}

/**
 * A new worktree and branch, cut from `repoRoot`'s HEAD. `node_modules` is
 * linked when the checkout has one, as CLAUDE.md does by hand.
 */
export async function createChildWorktree(repoRoot: string, name: string, opts: { reserved?: ReadonlySet<string>; git?: GitExec } = {}): Promise<ChildWorktree> {
  const git = opts.git ?? nodeGit;
  const head = await git(['rev-parse', '--verify', 'HEAD^{commit}'], repoRoot);
  if (head.code !== 0) throw new Error(`${repoRoot} has no commit to branch from.`);
  const locals = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoRoot);
  const branches = new Set(locals.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  const base = childSlug(name);
  // `reserved`: other children's ids, so a child id stays unique across repositories.
  const slug = uniqueSlug(base, (s) => opts.reserved?.has(s) === true || branches.has(childBranch(s)) || fs.existsSync(childWorktreePath(repoRoot, s)));
  if (!slug) throw new Error(`Too many child worktrees named ${base}; give --name.`);
  const wt = childWorktreePath(repoRoot, slug);
  const branch = childBranch(slug);
  const add = await git(['worktree', 'add', '--quiet', '-b', branch, wt, head.stdout.trim()], repoRoot);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim() || `exit ${add.code}`}`);
  const modules = path.join(repoRoot, 'node_modules');
  const link = path.join(wt, 'node_modules');
  try {
    if (fs.existsSync(modules) && !fs.existsSync(link)) fs.symlinkSync(modules, link);
  } catch {
    // Without the link the child runs npm install itself; not a reason to fail the spawn.
  }
  return { repoRoot, path: wt, branch, slug };
}

/** Whether `wt/node_modules` is the link `createChildWorktree` made (so it is not the child's work). */
function ourModulesLink(wt: string): boolean {
  try {
    return fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface DoneFacts {
  registered: boolean;
  dirty: string[];
  merged: boolean | undefined;
  defaultBranch?: string;
}

/** What `done` needs to decide, read without changing anything. */
export async function inspectChildWorktree(c: { repoRoot: string; path: string; branch: string }, git: GitExec = nodeGit): Promise<DoneFacts> {
  const list = await git(['worktree', 'list', '--porcelain'], c.repoRoot);
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const want = real(c.path);
  const registered = list.code === 0 && list.stdout.split('\n').some((l) => l.startsWith('worktree ') && real(l.slice('worktree '.length)) === want) && fs.existsSync(c.path);
  let dirty: string[] = [];
  if (registered) {
    const st = await git(['status', '--porcelain=v1', '--untracked-files=all'], c.path);
    dirty = st.code !== 0 ? ['(status could not be read)'] : st.stdout.split('\n').map((l) => l.slice(3).replace(/\/$/, '')).filter((p) => p && !(p === 'node_modules' && ourModulesLink(c.path)));
  }
  const originHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], c.repoRoot);
  const locals = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], c.repoRoot);
  const defaultBranch = pickDefaultBranch(originHead.code === 0 ? originHead.stdout : undefined, locals.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  let merged: boolean | undefined;
  const head = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`], c.repoRoot);
  if (head.code !== 0) merged = true; // the branch is gone already: nothing left to lose
  else if (defaultBranch) {
    const anc = await git(['merge-base', '--is-ancestor', head.stdout.trim(), `refs/heads/${defaultBranch}`], c.repoRoot);
    merged = anc.code === 0 ? true : anc.code === 1 ? false : undefined;
  }
  return { registered, dirty, merged, ...(defaultBranch ? { defaultBranch } : {}) };
}

/**
 * Remove the worktree (never `--force`: a discard resets and cleans it first)
 * and, when merged, delete its branch with `-d`, which git itself refuses for
 * an unmerged branch. An unmerged branch is kept: discarding the tree is not
 * deleting the commits.
 */
export async function removeChildWorktree(c: { repoRoot: string; path: string; branch: string }, opts: { registered: boolean; clean: boolean; deleteBranch: boolean }, git: GitExec = nodeGit): Promise<{ branchKept: boolean }> {
  if (!c.branch.startsWith(CHILD_BRANCH_PREFIX)) throw new Error(`${c.branch} is not a child branch; not removing it.`);
  if (opts.registered) {
    if (opts.clean) {
      await git(['reset', '--hard', '--quiet'], c.path);
      await git(['clean', '-fd', '--quiet'], c.path);
    }
    if (ourModulesLink(c.path)) fs.rmSync(path.join(c.path, 'node_modules'));
    const r = await git(['worktree', 'remove', c.path], c.repoRoot);
    if (r.code !== 0) throw new Error(`git worktree remove refused: ${r.stderr.trim() || `exit ${r.code}`}`);
  } else {
    await git(['worktree', 'prune'], c.repoRoot);
  }
  if (!opts.deleteBranch) return { branchKept: true };
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`], c.repoRoot);
  if (exists.code !== 0) return { branchKept: false };
  const del = await git(['branch', '-d', c.branch], c.repoRoot);
  return { branchKept: del.code !== 0 };
}
