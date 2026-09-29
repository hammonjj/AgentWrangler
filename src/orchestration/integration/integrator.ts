/**
 * Mission branch integration (`docs/plans/intelligent-orchestration.md` §13.3,
 * §23.2–23.3; #46): a verified task branch is merged into the mission branch
 * in the mission's integration worktree, and the mission branch is verified
 * after the merge.
 *
 * - **Write-ahead.** `integrate` hands the pre-merge head to `beforeMerge`
 *   (the caller persists it in the mission store) before `git merge` runs, so
 *   a crash mid-merge leaves a record that says where the branch was.
 * - **`merge --no-ff`**, hooks and signing off, as every commit AW makes.
 * - **Conflict** → `merge --abort`, and the conflicting files are returned.
 * - **Mission verification** after every clean merge. A failure is blamed on
 *   that merge and undone with a revert commit (`revert -m 1`), never a reset:
 *   the mission branch's history is not rewritten.
 * - **`recover`** takes the persisted record after a restart: a merge still in
 *   progress is aborted and done again; a merge that was committed but never
 *   verified is verified now; a revert already made is reported as one.
 *
 * One instance per call is fine: nothing is kept in memory. Serialising the
 * merges of one mission is the caller's job (the task runner's per-mission
 * queue). Only the integration worktree is written; the base and the primary
 * checkout are never touched, and nothing is rebased.
 */
import type { Exec } from '../worktrees/exec';

export interface VerificationFailure {
  stage: string;
  summary: string;
  exitCode?: number;
  failingTests?: string[];
  signature?: string;
}

export interface MissionVerification {
  passed: boolean;
  failure?: VerificationFailure;
}

/** The mission-level check (§13.3 step 4), run in the integration worktree at `headCommit`. */
export interface MissionVerifier {
  verifyMission(opts: { worktreePath: string; baseCommit: string; headCommit: string }): Promise<MissionVerification>;
}

export type IntegrationOutcome =
  | { ok: true; outcome: 'merged'; preMergeHead: string; mergeCommit: string }
  | { ok: false; outcome: 'reverted'; preMergeHead: string; mergeCommit: string; revertCommit: string; evidence: VerificationFailure }
  | { ok: false; outcome: 'conflict'; preMergeHead: string; conflictingFiles: string[] }
  | { ok: false; outcome: 'error'; error: string; preMergeHead?: string };

/** What the caller persisted before the merge ran. */
export interface PendingMergeRecord {
  taskBranch: string;
  message: string;
  preMergeHead: string;
}

export interface IntegratorDeps {
  exec: Exec;
  verifier: MissionVerifier;
  /** The mission branch, checked out in `worktreePath`. */
  missionBranch: string;
  /** The mission's integration worktree. */
  worktreePath: string;
  /** The commit the mission was cut from. */
  baseCommit: string;
  /** Persist the intent before `git merge` runs (§23.2). A throw stops the merge. */
  beforeMerge?: (record: PendingMergeRecord) => Promise<void> | void;
  log?: (msg: string) => void;
}

const MERGE_TIMEOUT_MS = 5 * 60_000;
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

export class Integrator {
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: IntegratorDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /** Merge `taskBranch` into the mission branch, then verify the mission branch. */
  async integrate(opts: { taskBranch: string; message: string }): Promise<IntegrationOutcome> {
    if (!opts.taskBranch.startsWith('aw/')) return { ok: false, outcome: 'error', error: `${opts.taskBranch} is not a branch Agent Wrangler made` };
    const ready = await this.readyToMerge();
    if (ready) return { ok: false, outcome: 'error', error: ready };
    const head = await this.revParse('HEAD');
    if (!head) return { ok: false, outcome: 'error', error: 'could not read the mission branch head' };
    try {
      await this.deps.beforeMerge?.({ taskBranch: opts.taskBranch, message: opts.message, preMergeHead: head });
    } catch (e) {
      return { ok: false, outcome: 'error', error: `could not record the merge before making it: ${errorText(e)}`, preMergeHead: head };
    }
    return this.mergeFrom(head, opts);
  }

  /**
   * Finish a merge the core was making when it stopped, from the persisted
   * record: abort and redo one still in progress, verify one committed but not
   * verified, report a revert already made.
   */
  async recover(record: PendingMergeRecord): Promise<IntegrationOutcome> {
    const pre = record.preMergeHead;
    if (await this.hasRef('MERGE_HEAD')) {
      this.log(`recovery: aborting the interrupted merge of ${record.taskBranch}`);
      const abort = await this.git(['merge', '--abort']);
      if (abort.code !== 0) return { ok: false, outcome: 'error', error: `could not abort the interrupted merge: ${abort.stderr.trim()}`, preMergeHead: pre };
    }
    if (await this.hasRef('REVERT_HEAD')) {
      const abort = await this.git(['revert', '--abort']);
      if (abort.code !== 0) return { ok: false, outcome: 'error', error: `could not abort the interrupted revert: ${abort.stderr.trim()}`, preMergeHead: pre };
    }
    const head = await this.revParse('HEAD');
    if (!head) return { ok: false, outcome: 'error', error: 'could not read the mission branch head', preMergeHead: pre };
    if (head === pre) {
      // Nothing was committed. Put the tree back as it was (only AW writes in it), then merge again.
      const clean = await this.git(['reset', '--hard', '--quiet', 'HEAD']);
      if (clean.code !== 0) return { ok: false, outcome: 'error', error: `could not clean the integration worktree: ${clean.stderr.trim()}`, preMergeHead: pre };
      this.log(`recovery: merging ${record.taskBranch} again from ${pre.slice(0, 8)}`);
      return this.mergeFrom(pre, record);
    }
    const task = await this.revParse(record.taskBranch);
    const parents = await this.parents(head);
    if (parents[0] === pre && parents.length === 2 && parents[1] === task) {
      // The merge was committed; its verification never finished.
      this.log(`recovery: ${record.taskBranch} was merged at ${head.slice(0, 8)}; verifying it`);
      return this.verifyMerge(pre, head);
    }
    if (parents.length === 1) {
      const mergeParents = await this.parents(parents[0]);
      if (mergeParents[0] === pre && mergeParents[1] === task && (await this.isRevertOf(head, parents[0]))) {
        return {
          ok: false,
          outcome: 'reverted',
          preMergeHead: pre,
          mergeCommit: parents[0],
          revertCommit: head,
          evidence: { stage: 'mission', summary: 'mission verification failed before the restart; the merge was reverted' },
        };
      }
    }
    return { ok: false, outcome: 'error', error: `the mission branch moved past ${pre.slice(0, 8)} in a way the recorded merge does not explain`, preMergeHead: pre };
  }

  private async mergeFrom(pre: string, opts: { taskBranch: string; message: string }): Promise<IntegrationOutcome> {
    this.log(`merging ${opts.taskBranch} into ${this.deps.missionBranch}`);
    const merge = await this.git([...NO_HOOKS, 'merge', '--no-ff', '--no-edit', '-m', opts.message, '--end-of-options', opts.taskBranch], MERGE_TIMEOUT_MS);
    if (merge.code === 0) {
      const head = await this.revParse('HEAD');
      if (!head) return { ok: false, outcome: 'error', error: 'could not read the merge commit', preMergeHead: pre };
      return this.verifyMerge(pre, head);
    }
    const files = await this.conflictingFiles();
    if (await this.hasRef('MERGE_HEAD')) {
      const abort = await this.git(['merge', '--abort']);
      if (abort.code !== 0) return { ok: false, outcome: 'error', error: `the merge conflicted and could not be aborted: ${abort.stderr.trim()}`, preMergeHead: pre };
    }
    if (files.length === 0) {
      const why = (merge.stderr.trim() || merge.stdout.trim()).split('\n').slice(0, 3).join(' ');
      return { ok: false, outcome: 'error', error: `the merge did not go through: ${why || `exit ${merge.code}`}`, preMergeHead: pre };
    }
    this.log(`merge of ${opts.taskBranch} conflicts in ${files.join(', ')}`);
    return { ok: false, outcome: 'conflict', preMergeHead: pre, conflictingFiles: files };
  }

  private async verifyMerge(pre: string, mergeCommit: string): Promise<IntegrationOutcome> {
    let v: MissionVerification;
    try {
      v = await this.deps.verifier.verifyMission({ worktreePath: this.deps.worktreePath, baseCommit: this.deps.baseCommit, headCommit: mergeCommit });
    } catch (e) {
      // Our infrastructure, not the task's: the merge stays, unverified, and the caller decides.
      return { ok: false, outcome: 'error', error: `mission verification could not run: ${errorText(e)}`, preMergeHead: pre };
    }
    if (v.passed) return { ok: true, outcome: 'merged', preMergeHead: pre, mergeCommit };
    this.log(`mission verification failed after ${mergeCommit.slice(0, 8)}; reverting it`);
    const revert = await this.git([...NO_HOOKS, 'revert', '-m', '1', '--no-edit', mergeCommit], MERGE_TIMEOUT_MS);
    if (revert.code !== 0) {
      if (await this.hasRef('REVERT_HEAD')) await this.git(['revert', '--abort']);
      return { ok: false, outcome: 'error', error: `mission verification failed, and the revert did not go through: ${revert.stderr.trim()}`, preMergeHead: pre };
    }
    const revertCommit = await this.revParse('HEAD');
    return {
      ok: false,
      outcome: 'reverted',
      preMergeHead: pre,
      mergeCommit,
      revertCommit: revertCommit ?? '',
      evidence: v.failure ?? { stage: 'mission', summary: 'mission verification failed' },
    };
  }

  /** Why a merge cannot start now: a merge or revert already in progress, the wrong branch, or a dirty tree. */
  private async readyToMerge(): Promise<string | undefined> {
    if (await this.hasRef('MERGE_HEAD')) return 'a merge is already in progress in the integration worktree; recover it first';
    if (await this.hasRef('REVERT_HEAD')) return 'a revert is already in progress in the integration worktree; recover it first';
    const on = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (on.code !== 0 || on.stdout.trim() !== this.deps.missionBranch) return `the integration worktree is not on ${this.deps.missionBranch}`;
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=no']);
    if (status.code !== 0) return `could not read the integration worktree's status: ${status.stderr.trim()}`;
    if (status.stdout.trim() !== '') return 'the integration worktree has uncommitted changes';
    return undefined;
  }

  private async conflictingFiles(): Promise<string[]> {
    const r = await this.git(['diff', '--name-only', '--diff-filter=U', '-z']);
    if (r.code !== 0) return [];
    return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
  }

  private async isRevertOf(commit: string, merge: string): Promise<boolean> {
    const r = await this.git(['log', '-1', '--format=%B', commit]);
    return r.code === 0 && r.stdout.includes(`This reverts commit ${merge}`);
  }

  private async parents(commit: string): Promise<string[]> {
    const r = await this.git(['rev-list', '--parents', '-n', '1', commit]);
    return r.code === 0 ? r.stdout.trim().split(/\s+/).slice(1) : [];
  }

  private async hasRef(ref: string): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '--quiet', ref])).code === 0;
  }

  private async revParse(ref: string): Promise<string | undefined> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  private git(args: string[], timeoutMs?: number) {
    return this.deps.exec('git', args, { cwd: this.deps.worktreePath, timeoutMs });
  }
}

/**
 * Before a conflict-resolution attempt (§13.3 step 3): merge the mission
 * branch into the task's branch, in the task's own worktree, and leave any
 * conflict in place (markers in the files, `MERGE_HEAD` set) for the agent to
 * resolve. The agent's result is committed as the merge commit when the
 * attempt finishes. `clean`: it merged without a conflict after all, and the
 * merge is committed.
 */
export async function mergeMissionIntoTask(
  exec: Exec,
  treePath: string,
  missionBranch: string,
  message: string,
): Promise<{ outcome: 'clean' } | { outcome: 'conflict'; files: string[] } | { outcome: 'error'; error: string }> {
  const git = (args: string[]) => exec('git', args, { cwd: treePath, timeoutMs: MERGE_TIMEOUT_MS });
  if ((await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0) return { outcome: 'error', error: 'a merge is already in progress in the task’s worktree' };
  const merge = await git([...NO_HOOKS, 'merge', '--no-ff', '--no-edit', '-m', message, '--end-of-options', missionBranch]);
  if (merge.code === 0) return { outcome: 'clean' };
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z']);
  const files = r.code === 0 ? [...new Set(r.stdout.split('\0').filter(Boolean))].sort() : [];
  if (files.length > 0) return { outcome: 'conflict', files };
  if ((await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0) await git(['merge', '--abort']);
  return { outcome: 'error', error: (merge.stderr.trim() || merge.stdout.trim()).split('\n').slice(0, 3).join(' ') || `exit ${merge.code}` };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
