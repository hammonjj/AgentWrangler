/**
 * Mission review's two buttons that reach past AW's own worktrees
 * (`docs/plans/intelligent-orchestration.md` §13.1 rule 3, §13.3 step 5; #43):
 * merge the result branch into the base in the primary checkout, or push it
 * and open a pull request. Both run only on the user's click.
 *
 * What this refuses rather than risks:
 * - **Merge locally** only into the branch the primary checkout already has
 *   checked out, and only when that checkout has no uncommitted changes to
 *   tracked files: AW never switches the user's branch or mixes a merge into
 *   their edits. `--no-ff`, as this repository merges by hand. A conflict is
 *   aborted, leaving the checkout exactly as it was. Hooks and signing are
 *   off, as for every commit AW makes: a hook from the merged tree must not
 *   run outside any agent's sandbox, and a pinentry prompt would hang.
 * - **Pull request** pushes the one branch to `origin` and opens the PR with
 *   `gh`; nothing else is pushed.
 *
 * The full repository check on the merged result before the base moves
 * (§13.3's gated merge) is the Integrator's, with #46.
 */
import type { Exec } from '../worktrees/exec';

export type FinishOutcome<T> = ({ ok: true } & T) | { ok: false; why: string };

export interface MissionFinisherDeps {
  exec: Exec;
  /** The primary checkout. */
  repoRoot: string;
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
