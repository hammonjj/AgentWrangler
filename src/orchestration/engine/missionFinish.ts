/**
 * Mission review's actions that reach past AW's own worktrees
 * (`docs/plans/intelligent-orchestration.md` §13.1 rule 3, §13.3 step 5; #43, #46):
 * merge the mission branch into the base locally (gated by typecheck/tests/build, #46),
 * or push it and open a pull request. Both run only on the user's click.
 *
 * What this refuses rather than risks:
 * - **Merge locally** (gated) builds the merge in the integration worktree, runs the
 *   repository's full check (typecheck, tests, build), and moves the base branch in
 *   the primary checkout only if the check passes. The merge is made with `--no-ff`.
 *   A failed check leaves the base unchanged and reports the failure.
 * - **Pull request** pushes the one branch to `origin` and opens the PR with
 *   `gh`; nothing else is pushed.
 * - The check and gating (§13.3) are the Integrator's, with #46.
 */
import type { Exec } from '../worktrees/exec';

export type FinishOutcome<T> = ({ ok: true } & T) | { ok: false; why: string };

export interface MissionFinisherDeps {
  exec: Exec;
  /** The primary checkout. */
  repoRoot: string;
  /** For gated merge (#46): verification function that takes worktree and returns pass/fail. */
  verifyGate?: (opts: { worktreePath: string; baseCommit: string; headCommit: string }) => Promise<boolean>;
  /** Integration worktree path for gated merge (#46). */
  integrationWorktreePath?: string;
  /** Base commit for gated merge verification (#46). */
  baseCommit?: string;
  log?: (msg: string) => void;
}

const MERGE_TIMEOUT_MS = 5 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;

export class MissionFinisher {
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: MissionFinisherDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * `git merge --no-ff <branch>` in the primary checkout. `baseRef` is the
   * mission's base: a branch name, or `HEAD` for "whatever the checkout is on".
   */
  async mergeLocal(opts: { branch: string; baseRef: string; message: string }): Promise<FinishOutcome<{ mergeCommit: string; into: string }>> {
    if (!opts.branch.startsWith('aw/')) return { ok: false, why: `${opts.branch} is not a branch Agent Wrangler made.` };
    const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const on = current.stdout.trim();
    if (current.code !== 0 || !on) return { ok: false, why: 'The primary checkout is not on a branch (detached HEAD); check out the base branch there first.' };
    const into = baseBranch(opts.baseRef) ?? on;
    if (on !== into) return { ok: false, why: `The primary checkout is on ${on}, not ${into}. Check out ${into} there to merge, or open a pull request instead.` };
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=no']);
    if (status.code !== 0) return { ok: false, why: `Could not read the primary checkout's status: ${status.stderr.trim()}` };
    if (status.stdout.trim() !== '') return { ok: false, why: `The primary checkout has uncommitted changes on ${into}; commit or stash them, then merge.` };
    const merge = await this.git(
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', opts.message, '--end-of-options', opts.branch],
      MERGE_TIMEOUT_MS,
    );
    if (merge.code !== 0) {
      const inMerge = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
      if (inMerge.code === 0) await this.git(['merge', '--abort']);
      const why = (merge.stderr.trim() || merge.stdout.trim()).split('\n').slice(0, 4).join(' ');
      return { ok: false, why: `The merge into ${into} did not go through, and was undone: ${why || `exit ${merge.code}`}` };
    }
    const head = await this.git(['rev-parse', 'HEAD']);
    this.log(`merged ${opts.branch} into ${into} at ${head.stdout.trim().slice(0, 8)}`);
    return { ok: true, mergeCommit: head.stdout.trim(), into };
  }

  /**
   * `git merge --no-ff <branch>` in the primary checkout, gated on the repository's
   * full check (typecheck, tests, build) run in the integration worktree (§13.3 #46).
   * The base branch moves only if the check passes. Reports that an install is needed.
   */
  async mergeLocalGated(opts: {
    branch: string;
    baseRef: string;
    message: string;
  }): Promise<FinishOutcome<{ mergeCommit: string; into: string; installNeeded: true }>> {
    if (!opts.branch.startsWith('aw/')) return { ok: false, why: `${opts.branch} is not a branch Agent Wrangler made.` };

    // Verify gates in integration worktree (§13.3, #46)
    if (!this.deps.verifyGate || !this.deps.integrationWorktreePath || !this.deps.baseCommit) {
      return { ok: false, why: 'Gated merge is not configured (missing verification gate or integration worktree)' };
    }

    // Check primary checkout status first
    const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const on = current.code === 0 ? current.stdout.trim() : undefined;
    if (!on) return { ok: false, why: 'The primary checkout is not on a branch (detached HEAD); check out the base branch there first.' };

    const into = baseBranch(opts.baseRef) ?? on;
    if (on !== into) return { ok: false, why: `The primary checkout is on ${on}, not ${into}. Check out ${into} there to merge, or open a pull request instead.` };

    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=no']);
    if (status.code !== 0) return { ok: false, why: `Could not read the primary checkout's status: ${status.stderr.trim()}` };
    if (status.stdout.trim() !== '') return { ok: false, why: `The primary checkout has uncommitted changes on ${into}; commit or stash them, then merge.` };

    // Get the mission branch head to verify the gate on
    const headCommit = await this.git(['rev-parse', opts.branch]);
    if (headCommit.code !== 0) {
      return { ok: false, why: `Could not read ${opts.branch}: ${headCommit.stderr}` };
    }

    // Run the verification gate on the mission branch
    try {
      const gatePass = await this.deps.verifyGate({
        worktreePath: this.deps.integrationWorktreePath,
        baseCommit: this.deps.baseCommit,
        headCommit: headCommit.stdout.trim(),
      });

      if (!gatePass) {
        return { ok: false, why: `Finish gate verification failed on ${opts.branch}` };
      }
    } catch (e) {
      return {
        ok: false,
        why: `Finish gate verification error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Gate passed: now merge in the primary
    const merge = await this.git(
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', opts.message, '--end-of-options', opts.branch],
      MERGE_TIMEOUT_MS,
    );

    if (merge.code !== 0) {
      const inMerge = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
      if (inMerge.code === 0) await this.git(['merge', '--abort']);
      const why = (merge.stderr.trim() || merge.stdout.trim()).split('\n').slice(0, 4).join(' ');
      return { ok: false, why: `The merge into ${into} did not go through, and was undone: ${why || `exit ${merge.code}`}` };
    }

    const head = await this.git(['rev-parse', 'HEAD']);
    this.log(`merged ${opts.branch} into ${into} at ${head.stdout.trim().slice(0, 8)} (gated)`);
    return { ok: true, mergeCommit: head.stdout.trim(), into, installNeeded: true };
  }

  /** Push the branch to `origin` and open a pull request against the base with `gh`. */
  async openPullRequest(opts: { branch: string; baseRef: string; title: string; body: string }): Promise<FinishOutcome<{ url: string }>> {
    if (!opts.branch.startsWith('aw/')) return { ok: false, why: `${opts.branch} is not a branch Agent Wrangler made.` };
    let base = baseBranch(opts.baseRef);
    if (!base) {
      const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      base = current.code === 0 ? current.stdout.trim() || undefined : undefined;
    }
    if (!base) return { ok: false, why: 'Cannot tell which branch the pull request should target.' };
    const push = await this.git(['push', '--set-upstream', 'origin', `refs/heads/${opts.branch}:refs/heads/${opts.branch}`], PUSH_TIMEOUT_MS);
    if (push.code !== 0) return { ok: false, why: `Could not push ${opts.branch}: ${push.stderr.trim().split('\n').slice(-2).join(' ') || `exit ${push.code}`}` };
    const pr = await this.deps.exec('gh', ['pr', 'create', '--head', opts.branch, '--base', base, '--title', opts.title, '--body', opts.body], {
      cwd: this.deps.repoRoot,
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    if (pr.code !== 0) {
      const why = pr.failure === 'spawn' ? 'the GitHub CLI (gh) is not installed' : pr.stderr.trim().split('\n').slice(-2).join(' ') || `exit ${pr.code}`;
      return { ok: false, why: `${opts.branch} was pushed, but the pull request was not opened: ${why}` };
    }
    const url = pr.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    this.log(`opened a pull request for ${opts.branch}: ${url}`);
    return { ok: true, url };
  }

  private git(args: string[], timeoutMs?: number) {
    return this.deps.exec('git', args, { cwd: this.deps.repoRoot, timeoutMs });
  }
}

/** A branch name from a base ref: `main`, `refs/heads/main` → `main`; `HEAD` or a commit → undefined. */
export function baseBranch(ref: string): string | undefined {
  const r = ref.trim();
  if (!r || r === 'HEAD' || /^[0-9a-f]{7,64}$/.test(r)) return undefined;
  return r.startsWith('refs/heads/') ? r.slice('refs/heads/'.length) : r;
}
