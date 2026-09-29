/**
 * Mission branch integration (`docs/plans/intelligent-orchestration.md` §13.3, §23.2, #46):
 * merging verified task branches into the mission branch one at a time, verifying the
 * mission branch after each merge. A single instance per mission, guarding the mission
 * worktree; never rebases a branch an agent is using.
 *
 * - `integrate(taskBranch)`: run `git merge --no-ff` after persisting the pre-merge head.
 *   On conflict, abort and return the files. On clean merge, verify the mission branch.
 *   On verification failure, revert with a revert commit (never a reset).
 * - `recover()`: if MERGE_HEAD is present and equals the recorded pre-merge head, abort
 *   and redo. If the merge was already committed, run the missing verification.
 * - Never touches the base or the primary checkout, never rebases.
 */
import type { Exec } from '../worktrees/exec';

export type IntegrationOutcome =
  | { ok: true; outcome: 'merged'; mergeCommit: string }
  | { ok: true; outcome: 'reverted'; revertCommit: string; evidence: VerificationFailure }
  | { ok: false; outcome: 'conflict'; conflictingFiles: string[] }
  | { ok: false; outcome: 'error'; error: string };

export interface VerificationFailure {
  stage: string;
  summary: string;
  exitCode?: number;
  failingTests?: string[];
}

/** Minimal verifier interface for the integrator's mission-level verification. */
export interface MissionVerifier {
  verifyMission(opts: {
    worktreePath: string;
    baseCommit: string;
    headCommit: string;
    log?: (msg: string) => void;
  }): Promise<{
    passed: boolean;
    failure?: VerificationFailure;
  }>;
}

export interface IntegratorDeps {
  exec: Exec;
  verifier: MissionVerifier;
  /** The mission branch being integrated into. */
  missionBranch: string;
  /** Path to the mission's integration worktree. */
  worktreePath: string;
  /** Base commit the mission was cut from. */
  baseCommit: string;
  /** Called after meaningful steps. */
  log?: (msg: string) => void;
}

interface PreMergeRecord {
  head: string;
  at: number;
}

/**
 * Manages one mission's branch integration in its `_integration` worktree.
 * Every merge is recorded write-ahead before the command runs, and every
 * verification runs on the mission branch after a clean merge.
 */
export class Integrator {
  private readonly log: (msg: string) => void;
  private preMergeRecords = new Map<string, PreMergeRecord>();

  constructor(private readonly deps: IntegratorDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * Merge a task branch into the mission branch with `git merge --no-ff`.
   * Records the pre-merge head first; on conflict, aborts; on clean merge,
   * verifies the mission branch; on verification failure, reverts.
   */
  async integrate(opts: { taskBranch: string; message: string }): Promise<IntegrationOutcome> {
    const taskKey = opts.taskBranch;

    // Refuse if already merging
    const mergeHead = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    if (mergeHead.code === 0) {
      return {
        ok: false,
        outcome: 'error',
        error: 'MERGE_HEAD is present; call recover() first',
      };
    }

    // Persist pre-merge head
    const before = await this.git(['rev-parse', 'HEAD']);
    if (before.code !== 0) {
      return { ok: false, outcome: 'error', error: `Could not read HEAD: ${before.stderr}` };
    }
    const preHead = before.stdout.trim();
    this.preMergeRecords.set(taskKey, { head: preHead, at: Date.now() });

    // Run the merge
    this.log(`merging ${opts.taskBranch} into ${this.deps.missionBranch}`);
    const merge = await this.git(
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        opts.message,
        '--end-of-options',
        opts.taskBranch,
      ],
      5 * 60_000,
    );

    if (merge.code === 0) {
      // Clean merge: verify the mission branch
      const mergeCommit = await this.git(['rev-parse', 'HEAD']);
      if (mergeCommit.code !== 0) {
        return {
          ok: false,
          outcome: 'error',
          error: `Could not read merged HEAD: ${mergeCommit.stderr}`,
        };
      }

      this.log(`merged ${opts.taskBranch} at ${mergeCommit.stdout.trim().slice(0, 8)}`);

      // Run verification on the mission branch
      try {
        const verifyResult = await this.deps.verifier.verifyMission({
          worktreePath: this.deps.worktreePath,
          baseCommit: this.deps.baseCommit,
          headCommit: mergeCommit.stdout.trim(),
          log: this.log,
        });

        if (verifyResult.passed) {
          // Verification passed: we're done
          return { ok: true, outcome: 'merged', mergeCommit: mergeCommit.stdout.trim() };
        }

        // Verification failed: revert the merge
        this.log(`verification failed after merge; reverting with revert commit`);
        const revert = await this.git([
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          'revert',
          '-m',
          '1',
          '--no-edit',
          mergeCommit.stdout.trim(),
        ]);

        if (revert.code !== 0) {
          return {
            ok: false,
            outcome: 'error',
            error: `Revert of merge failed: ${revert.stderr}`,
          };
        }

        const revertCommit = await this.git(['rev-parse', 'HEAD']);
        this.log(`reverted merge at ${revertCommit.stdout.trim().slice(0, 8)}`);

        const failure: VerificationFailure = verifyResult.failure || {
          stage: 'unknown',
          summary: 'Mission-level verification failed',
        };

        return { ok: true, outcome: 'reverted', revertCommit: revertCommit.stdout.trim(), evidence: failure };
      } catch (e) {
        return {
          ok: false,
          outcome: 'error',
          error: `Verification error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // Merge conflict: get conflicting files before aborting
    const conflictStatus = await this.git(['ls-files', '-u']);
    const conflictingFiles = new Set<string>();
    if (conflictStatus.code === 0) {
      // Parse git ls-files -u output: [stage] filename
      for (const line of conflictStatus.stdout.split('\n')) {
        if (line.trim()) {
          const match = line.match(/^.*\t(.+)$/);
          if (match) conflictingFiles.add(match[1]);
        }
      }
    }

    const inMerge = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    if (inMerge.code === 0) {
      // Abort the merge
      const abort = await this.git(['merge', '--abort']);
      if (abort.code !== 0) {
        return {
          ok: false,
          outcome: 'error',
          error: `Merge conflict, and abort failed: ${abort.stderr}`,
        };
      }
    }

    const conflictList = Array.from(conflictingFiles);
    this.log(`merge conflict in ${opts.taskBranch}: ${conflictList.join(', ')}`);
    return { ok: false, outcome: 'conflict', conflictingFiles: conflictList };
  }

  /**
   * Recover from a crash mid-merge. If MERGE_HEAD is present and equals the
   * recorded pre-merge head, abort and redo. If the merge was already committed,
   * run the missing verification.
   */
  async recover(opts: { taskBranch: string; message: string }): Promise<IntegrationOutcome | undefined> {
    const mergeHead = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    const taskKey = opts.taskBranch;
    const record = this.preMergeRecords.get(taskKey);

    if (mergeHead.code === 0 && record) {
      // MERGE_HEAD is present: check if it's the recorded pre-merge head
      const currentHead = await this.git(['rev-parse', 'HEAD']);
      if (currentHead.code === 0 && currentHead.stdout.trim() === record.head) {
        // Abort and redo the merge
        this.log(`recovering from crash: aborting merge of ${opts.taskBranch}`);
        const abort = await this.git(['merge', '--abort']);
        if (abort.code !== 0) {
          return {
            ok: false,
            outcome: 'error',
            error: `Abort failed during recovery: ${abort.stderr}`,
          };
        }
        // Redo the merge
        return this.integrate(opts);
      }
    }

    // Check if the merge was already committed: the HEAD is past the recorded pre-merge head
    if (record) {
      const ancestor = await this.git(['merge-base', '--is-ancestor', record.head, 'HEAD']);
      if (ancestor.code === 0) {
        // The recorded pre-merge head is an ancestor: the merge was committed
        // Run the missing verification
        this.log(`recovering from crash: merge was already committed, running verification`);
        const headCommit = await this.git(['rev-parse', 'HEAD']);
        if (headCommit.code !== 0) {
          return {
            ok: false,
            outcome: 'error',
            error: `Could not read HEAD: ${headCommit.stderr}`,
          };
        }

        try {
          const verifyResult = await this.deps.verifier.verifyMission({
            worktreePath: this.deps.worktreePath,
            baseCommit: this.deps.baseCommit,
            headCommit: headCommit.stdout.trim(),
            log: this.log,
          });

          if (verifyResult.passed) {
            return { ok: true, outcome: 'merged', mergeCommit: headCommit.stdout.trim() };
          }

          // Verification failed: revert the merge
          this.log(`verification failed during recovery; reverting`);
          const revert = await this.git([
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            'revert',
            '-m',
            '1',
            '--no-edit',
            headCommit.stdout.trim(),
          ]);

          if (revert.code !== 0) {
            return {
              ok: false,
              outcome: 'error',
              error: `Revert of merge failed during recovery: ${revert.stderr}`,
            };
          }

          const revertCommit = await this.git(['rev-parse', 'HEAD']);
          const failure: VerificationFailure = verifyResult.failure || {
            stage: 'unknown',
            summary: 'Mission-level verification failed',
          };

          return { ok: true, outcome: 'reverted', revertCommit: revertCommit.stdout.trim(), evidence: failure };
        } catch (e) {
          return {
            ok: false,
            outcome: 'error',
            error: `Verification error during recovery: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
    }

    // No recovery needed
    return undefined;
  }

  private git(args: string[], timeoutMs?: number) {
    return this.deps.exec('git', args, {
      cwd: this.deps.worktreePath,
      timeoutMs,
    });
  }
}
