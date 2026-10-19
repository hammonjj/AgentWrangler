/**
 * Contention between tasks (§13.4–13.5, #47), the pure half: how an attempt's
 * changed files compare with its predicted scope, and which exclusive
 * resources a task needs leased before it starts. The scheduler's overlap
 * wait is in `scheduler.ts`; the leases themselves are the core's
 * `LeaseService` (#68), reached through the task runner.
 */
import type { RepoPolicy } from '../../shared/orchestration/repoPolicy';
import type { AttemptScopeCheck } from '../../shared/orchestration/types';
import { matchesAny, overlapping } from '../policy/globs';

/** How many outside files an attempt keeps by name. */
const OUTSIDE_KEPT = 5;
/**
 * Below this share of changed files inside the predicted scope, the attempt
 * "wrote well outside its scope" (§13.4) and review says so. A stray file or
 * two beside a larger change in scope is ordinary; most of the change outside
 * it is not.
 */
export const OUT_OF_SCOPE_BELOW = 0.75;

/**
 * Changed files against the predicted scope. Undefined when nothing was
 * predicted (no paths: there is nothing to be accurate about) or nothing
 * changed.
 */
export function scopeCheck(files: readonly string[], scopePaths: readonly string[]): AttemptScopeCheck | undefined {
  if (scopePaths.length === 0 || files.length === 0) return undefined;
  const outside = files.filter((f) => !matchesAny(f, scopePaths));
  return {
    accuracy: (files.length - outside.length) / files.length,
    changed: files.length,
    outside: outside.slice(0, OUTSIDE_KEPT),
    outsideCount: outside.length,
  };
}

export function wroteOutsideScope(check: AttemptScopeCheck | undefined): boolean {
  return !!check && check.outsideCount > 0 && check.accuracy < OUT_OF_SCOPE_BELOW;
}

/** What review shows for it. */
export function outOfScopeText(check: AttemptScopeCheck): string {
  const names = check.outside.join(', ');
  const more = check.outsideCount > check.outside.length ? `, and ${check.outsideCount - check.outside.length} more` : '';
  return `${check.outsideCount} of ${check.changed} changed files are outside the task's predicted scope (${names}${more})`;
}

export const EXCLUSIVE_PREFIX = 'exclusive:';

/**
 * The exclusive resources a task needs (§13.5): the repository policy's,
 * where the task's scope reaches their paths (or every one with no paths),
 * and any its latest assessment named. Lease names, without the prefix, sorted.
 */
export function exclusiveLeaseNames(policy: Pick<RepoPolicy, 'exclusive'> | undefined, scopePaths: readonly string[], requires: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const r of requires) if (r.startsWith(EXCLUSIVE_PREFIX) && r.length > EXCLUSIVE_PREFIX.length) out.add(r.slice(EXCLUSIVE_PREFIX.length));
  for (const r of policy?.exclusive ?? []) {
    if (!r.paths || r.paths.length === 0 || overlapping(r.paths, scopePaths).length > 0) out.add(r.id);
  }
  return [...out].sort();
}
