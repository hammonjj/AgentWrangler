/**
 * Mission review's buttons that reach past AW's own worktrees
 * (`docs/plans/intelligent-orchestration.md` §13.1 rule 3, §13.3 step 5; #43, #46):
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
 * - **Gated merge locally** (`mergeLocalGated`, a planned mission's merge,
 *   #46): the merge commit is made first in the mission's integration
 *   worktree, detached at the base's tip, so the base does not move; the
 *   repository's gate (typecheck, tests, build) runs on that merged result;
 *   only if it passes is the base fast-forwarded to exactly that commit in the
 *   primary checkout. A failure leaves the base where it was. Nothing is
 *   installed; the caller says an install may be needed.
 * - **Pull request** pushes the one branch to `origin` and opens the PR with
 *   `gh`; nothing else is pushed.
 */
import type { Exec } from '../worktrees/exec';

export type FinishOutcome<T> = ({ ok: true } & T) | { ok: false; why: string };

/** The gate's answer for the merged result (§13.3 step 5). */
export interface GateResult {
  passed: boolean;
  /** One line: what ran, or what failed. */
  summary: string;
}

export interface MissionFinisherDeps {
  exec: Exec;
  /** The primary checkout. */
  repoRoot: string;
  log?: (msg: string) => void;
}

const MERGE_TIMEOUT_MS = 5 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

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
   * The gated merge (§13.3 step 5, #46). `branch` is the mission branch,
   * checked out in `integrationPath`. The merge commit is built there,
   * detached at the base's tip, and `gate` runs on it; the base in the primary
   * checkout is fast-forwarded to that very commit only if the gate passes.
   * The integration worktree is back on `branch` afterwards, whatever
   * happened, and the mission branch itself never moves.
   */
  async mergeLocalGated(opts: {
    branch: string;
    baseRef: string;
    message: string;
    integrationPath: string;
    gate: (tree: string, mergeCommit: string) => Promise<GateResult>;
  }): Promise<FinishOutcome<{ mergeCommit: string; into: string; gate: string }>> {
    if (!opts.branch.startsWith('aw/')) return { ok: false, why: `${opts.branch} is not a branch Agent Wrangler made.` };
    const primary = await this.primaryReady(opts.baseRef);
    if (!primary.ok) return primary;
    const { into } = primary;
    const tip = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${into}`]);
    if (tip.code !== 0) return { ok: false, why: `Could not read ${into}.` };
    const baseTip = tip.stdout.trim();

    const inTree = (args: string[], timeoutMs?: number) => this.deps.exec('git', args, { cwd: opts.integrationPath, timeoutMs });
    const on = await inTree(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (on.code !== 0 || on.stdout.trim() !== opts.branch) return { ok: false, why: `The mission's integration worktree is not on ${opts.branch}; nothing was merged.` };
    const dirty = await inTree(['status', '--porcelain=v1', '--untracked-files=no']);
    if (dirty.code !== 0 || dirty.stdout.trim() !== '') return { ok: false, why: 'The mission’s integration worktree has uncommitted changes; nothing was merged.' };

    const detach = await inTree(['checkout', '--quiet', '--detach', baseTip]);
    if (detach.code !== 0) return { ok: false, why: `Could not check out ${into} in the integration worktree: ${detach.stderr.trim()}` };
    try {
      const merge = await inTree([...NO_HOOKS, 'merge', '--no-ff', '--no-edit', '-m', opts.message, '--end-of-options', opts.branch], MERGE_TIMEOUT_MS);
      if (merge.code !== 0) {
        if ((await inTree(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0) await inTree(['merge', '--abort']);
        const why = (merge.stderr.trim() || merge.stdout.trim()).split('\n').slice(0, 4).join(' ');
        return { ok: false, why: `${opts.branch} does not merge cleanly into ${into}, so ${into} was left alone: ${why || `exit ${merge.code}`}` };
      }
      const made = (await inTree(['rev-parse', 'HEAD'])).stdout.trim();
      let gate: GateResult;
      try {
        gate = await opts.gate(opts.integrationPath, made);
      } catch (e) {
        return { ok: false, why: `The check on the merged result could not run, so ${into} was left alone: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!gate.passed) return { ok: false, why: `The merged result failed its check, so ${into} was left alone: ${gate.summary}` };

      // The user may have moved in the meantime: the checkout must still be clean, on the base, at the tip the gate saw.
      const again = await this.primaryReady(opts.baseRef);
      if (!again.ok) return again;
      const tipNow = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${into}`]);
      if (tipNow.stdout.trim() !== baseTip) return { ok: false, why: `${into} moved while the check ran; merge again to check the new result.` };
      const ff = await this.git(['merge', '--ff-only', '--quiet', made], MERGE_TIMEOUT_MS);
      if (ff.code !== 0) return { ok: false, why: `Could not move ${into} to the checked result: ${ff.stderr.trim() || `exit ${ff.code}`}` };
      this.log(`merged ${opts.branch} into ${into} at ${made.slice(0, 8)} after ${gate.summary}`);
      return { ok: true, mergeCommit: made, into, gate: gate.summary };
    } finally {
      const back = await inTree(['checkout', '--quiet', opts.branch]);
      if (back.code !== 0) this.log(`could not put the integration worktree back on ${opts.branch}: ${back.stderr.trim()}`);
    }
  }

  /** The primary checkout can take a merge: on the base branch, and no uncommitted changes to tracked files. */
  private async primaryReady(baseRef: string): Promise<FinishOutcome<{ into: string }>> {
    const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const on = current.stdout.trim();
    if (current.code !== 0 || !on) return { ok: false, why: 'The primary checkout is not on a branch (detached HEAD); check out the base branch there first.' };
    const into = baseBranch(baseRef) ?? on;
    if (on !== into) return { ok: false, why: `The primary checkout is on ${on}, not ${into}. Check out ${into} there to merge, or open a pull request instead.` };
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=no']);
    if (status.code !== 0) return { ok: false, why: `Could not read the primary checkout's status: ${status.stderr.trim()}` };
    if (status.stdout.trim() !== '') return { ok: false, why: `The primary checkout has uncommitted changes on ${into}; commit or stash them, then merge.` };
    return { ok: true, into };
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

  /**
   * The base branch a merge would go into, and its tip now: recorded before
   * the merge (write-ahead) so that a cut-off merge can be judged afterwards.
   * Undefined when the checkout is not on a branch; the merge refuses that itself.
   */
  async branchTipOf(branch: string): Promise<string | undefined> {
    const tip = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return tip.code === 0 ? tip.stdout.trim() || undefined : undefined;
  }

  async baseTipOf(baseRef: string): Promise<{ into: string; tip: string } | undefined> {
    let into = baseBranch(baseRef);
    if (!into) {
      const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      into = current.code === 0 ? current.stdout.trim() || undefined : undefined;
    }
    if (!into) return undefined;
    const tip = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${into}`]);
    return tip.code === 0 ? { into, tip: tip.stdout.trim() } : undefined;
  }

  /**
   * Did a merge that was cut off (a restart, or a fault before its outcome was
   * recorded) go through? Read from git, never assumed: the result branch is
   * in the base branch, or it is not. A merge left half-made by AW — in the
   * primary checkout, or in the integration worktree — is aborted first, and
   * the integration worktree is put back on the mission branch, so that "not
   * merged" also means "nothing half-done is left behind".
   */
  async reconcileMerge(opts: { branch: string; branchTip?: string; baseRef: string; into?: string; baseTip?: string; integrationPath?: string }): Promise<Reconciled> {
    if (!opts.branch.startsWith('aw/')) return { state: 'unknown', why: `${opts.branch} is not a branch Agent Wrangler made.` };
    // The tip recorded when the finish began: a merge that went through deletes the branch while tidying up.
    let branchTip = opts.branchTip;
    if (!branchTip) {
      const tipRead = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`]);
      if (tipRead.failure === 'spawn') return { state: 'unknown', why: 'git could not be run.' };
      if (tipRead.code !== 0) return { state: 'unknown', why: `${opts.branch} is gone, so whether it was merged cannot be read.` };
      branchTip = tipRead.stdout.trim();
    }

    const tree = opts.integrationPath;
    if (tree) {
      const inTree = (args: string[]) => this.deps.exec('git', args, { cwd: tree });
      if ((await inTree(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0) await inTree(['merge', '--abort']);
      const on = await inTree(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (on.failure !== 'spawn' && on.stdout.trim() !== opts.branch) {
        const back = await inTree(['checkout', '--quiet', opts.branch]);
        if (back.code !== 0) this.log(`could not put the integration worktree back on ${opts.branch}: ${back.stderr.trim()}`);
      }
    }
    // Only a merge of this very branch is AW's to abort; anything else in progress is the user's.
    const mergeHead = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    if (mergeHead.code === 0 && mergeHead.stdout.trim() === branchTip) await this.git(['merge', '--abort']);

    let into = opts.into ?? baseBranch(opts.baseRef);
    if (!into) {
      const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      into = current.code === 0 ? current.stdout.trim() || undefined : undefined;
    }
    if (!into) return { state: 'unknown', why: 'Cannot tell which branch the merge was going into.' };
    const contained = await this.git(['merge-base', '--is-ancestor', branchTip, `refs/heads/${into}`]);
    if (contained.code === 1) return { state: 'not-done', note: `${opts.branch} is not in ${into}: the merge did not happen, and nothing was left half-done.` };
    if (contained.code !== 0) return { state: 'unknown', why: `Could not compare ${opts.branch} with ${into}: ${contained.stderr.trim() || `exit ${contained.code}`}` };

    // Merged. The merge commit is the first-parent merge whose second parent is the branch's tip.
    let mergeCommit: string | undefined;
    if (opts.baseTip) {
      const merges = await this.git(['rev-list', '--first-parent', '--merges', '--parents', `${opts.baseTip}..refs/heads/${into}`]);
      mergeCommit = merges.stdout
        .split('\n')
        .map((l) => l.trim().split(' '))
        .find((ids) => ids.slice(1).includes(branchTip))?.[0];
    }
    if (!mergeCommit) mergeCommit = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${into}`])).stdout.trim() || undefined;
    return { state: 'done', into, ...(mergeCommit ? { mergeCommit } : {}) };
  }

  /** Was a pull request opened for the branch? Read from `gh`; "no" only when `gh` answered. */
  async reconcilePullRequest(opts: { branch: string }): Promise<Reconciled> {
    const pr = await this.deps.exec('gh', ['pr', 'list', '--head', opts.branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url'], { cwd: this.deps.repoRoot, timeoutMs: PUSH_TIMEOUT_MS });
    if (pr.code !== 0) {
      const why = pr.failure === 'spawn' ? 'the GitHub CLI (gh) is not installed' : pr.stderr.trim().split('\n').slice(-2).join(' ') || `exit ${pr.code}`;
      return { state: 'unknown', why: `Could not ask GitHub whether the pull request was opened: ${why}` };
    }
    const url = pr.stdout.trim().split('\n').filter(Boolean).at(-1);
    return url ? { state: 'done', url } : { state: 'not-done', note: `No pull request was opened for ${opts.branch}.` };
  }

  private git(args: string[], timeoutMs?: number) {
    return this.deps.exec('git', args, { cwd: this.deps.repoRoot, timeoutMs });
  }
}

/** What a cut-off finish turned out to have done, read back from git or GitHub. */
export type Reconciled =
  | { state: 'done'; mergeCommit?: string; into?: string; url?: string }
  | { state: 'not-done'; note: string }
  /** The record cannot be settled from here: the finish buttons stay off. */
  | { state: 'unknown'; why: string };

/** A branch name from a base ref: `main`, `refs/heads/main` → `main`; `HEAD` or a commit → undefined. */
export function baseBranch(ref: string): string | undefined {
  const r = ref.trim();
  if (!r || r === 'HEAD' || /^[0-9a-f]{7,64}$/.test(r)) return undefined;
  return r.startsWith('refs/heads/') ? r.slice('refs/heads/'.length) : r;
}
