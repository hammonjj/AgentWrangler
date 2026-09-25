/**
 * Where AW's worktrees go and what their branches are called
 * (`docs/plans/intelligent-orchestration.md` §13.2), and the path checks that
 * keep every git operation inside the directory AW owns.
 *
 * ```text
 * <repo>                                   primary checkout — untouched
 * <repo>.aw/<mission>/_integration         aw/<mission>/mission
 * <repo>.aw/<mission>/t1                   aw/<mission>/t1
 * <repo>.aw/<mission>/t2-a2                aw/<mission>/t2-a2   (a fresh retry)
 * ```
 *
 * The mission branch is `…/mission` because git cannot have a branch that is
 * also a directory of branches. Pure: no filesystem, no git.
 */
import * as path from 'node:path';

/** Every AW branch starts with this, so AW's branches are easy to tell from the user's. */
export const BRANCH_PREFIX = 'aw';
export const INTEGRATION_DIR = '_integration';
export const MISSION_BRANCH_LEAF = 'mission';

/**
 * A mission slug or task key: lower-case letters, digits and single hyphens.
 * Narrow on purpose: it becomes a directory name and a ref component, and
 * this is safe as both on every filesystem git runs on.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG = 48;

export class WorktreeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeNameError';
  }
}

export function isValidSlug(s: string): boolean {
  return s.length > 0 && s.length <= MAX_SLUG && SLUG.test(s) && s !== MISSION_BRANCH_LEAF;
}

function checkSlug(kind: string, s: string): void {
  if (!isValidSlug(s)) throw new WorktreeNameError(`${kind} "${s}" must be 1–${MAX_SLUG} of a-z, 0-9 and single hyphens, and not "${MISSION_BRANCH_LEAF}"`);
}

/** A slug from a title: "Fix the flaky login test!" → "fix-the-flaky-login-test". Falls back to `fallback`. */
export function slugify(title: string, fallback = 'mission'): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return isValidSlug(s) ? s : fallback;
}

/** `t1` for the first attempt, `t1-a2` for the second, and so on. */
export function taskLeaf(taskKey: string, attempt = 1): string {
  checkSlug('task key', taskKey);
  if (!Number.isInteger(attempt) || attempt < 1) throw new WorktreeNameError(`attempt must be a positive integer, not ${attempt}`);
  if (/-a\d+$/.test(taskKey)) throw new WorktreeNameError(`task key "${taskKey}" looks like a retry suffix`);
  return attempt === 1 ? taskKey : `${taskKey}-a${attempt}`;
}

export function taskBranch(missionSlug: string, taskKey: string, attempt = 1): string {
  checkSlug('mission slug', missionSlug);
  return `${BRANCH_PREFIX}/${missionSlug}/${taskLeaf(taskKey, attempt)}`;
}

export function missionBranch(missionSlug: string): string {
  checkSlug('mission slug', missionSlug);
  return `${BRANCH_PREFIX}/${missionSlug}/${MISSION_BRANCH_LEAF}`;
}

/** The default worktree root: `<parent>/<repo>.aw`, a sibling of the primary checkout. */
export function defaultWorktreeRoot(repoRoot: string): string {
  const r = path.resolve(repoRoot);
  return path.join(path.dirname(r), `${path.basename(r)}.aw`);
}

/**
 * A configured root (repo policy's `worktrees.root`), with `<repo>` replaced
 * by the repository's directory name and a relative path taken from the
 * repository root: `../<repo>.aw` is the default.
 */
export function resolveWorktreeRoot(repoRoot: string, configured?: string): string {
  if (!configured) return defaultWorktreeRoot(repoRoot);
  const r = path.resolve(repoRoot);
  return path.resolve(r, configured.split('<repo>').join(path.basename(r)));
}

/** True when `child` is strictly inside `parent`. Both should already be canonical. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The root must be neither the primary checkout, nor inside it (its file
 * watchers, and `git status`, would see every attempt), nor contain it.
 */
export function checkRoot(repoRoot: string, root: string): void {
  if (root === repoRoot || isInside(repoRoot, root)) throw new WorktreeNameError(`worktree root ${root} is inside the primary checkout`);
  if (isInside(root, repoRoot)) throw new WorktreeNameError(`worktree root ${root} contains the primary checkout`);
}

/** `<root>/<mission>/<leaf>`, checked to be inside `root`. */
export function worktreePath(root: string, missionSlug: string, leaf: string): string {
  checkSlug('mission slug', missionSlug);
  if (leaf !== INTEGRATION_DIR && !isValidSlug(leaf)) throw new WorktreeNameError(`bad worktree directory "${leaf}"`);
  const p = path.join(root, missionSlug, leaf);
  if (!isInside(root, p)) throw new WorktreeNameError(`${p} is outside ${root}`);
  return p;
}

/**
 * A path from a setup step, which must stay inside the checkout it is applied
 * to: relative, no `..`, and not git's own directory.
 */
export function checkSetupPath(rel: string): string {
  if (rel.length === 0 || path.isAbsolute(rel)) throw new WorktreeNameError(`setup path "${rel}" must be relative`);
  const norm = path.normalize(rel).replace(/\/+$/, '');
  const parts = norm.split('/');
  if (norm === '.' || parts.includes('..')) throw new WorktreeNameError(`setup path "${rel}" must stay inside the checkout`);
  if (parts[0] === '.git') throw new WorktreeNameError(`setup path "${rel}" may not touch .git`);
  return norm;
}
