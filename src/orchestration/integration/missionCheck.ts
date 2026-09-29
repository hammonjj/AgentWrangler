/**
 * The mission-level check (§13.3 step 4, §14.4; #46): the repository's own
 * commands, run on the mission branch in its integration worktree after each
 * merge, and on the merged result before a gated local merge moves the base.
 *
 * Built on the task `Verifier`, so the same rules hold: commands come only
 * from repo policy, a failing command is re-run once (a pass then is flaky,
 * not a failure), and a command that already fails at the mission's base is
 * not blamed on the merge. Anything else that is not a pass — a failure, a
 * timeout, a command that could not start — counts as a failure here: the
 * mission branch must stay a branch that verified.
 */
import type { RepoPolicy } from '../../shared/orchestration/repoPolicy';
import type { Task, VerificationResult, WorktreeAssignment } from '../../shared/orchestration/types';
import type { Verifier } from '../verify/verifier';
import type { MissionVerification, MissionVerifier } from './integrator';

/**
 * What runs on the mission branch: the policy's `missionDefault`, or with none
 * named, every command the policy has (the repository's full check).
 */
export function missionCommands(policy: RepoPolicy): string[] {
  return policy.verification.missionDefault.length > 0 ? [...policy.verification.missionDefault] : Object.keys(policy.verification.commands).sort();
}

/** What the gated merge runs (§13.3 step 5): `finish.gate`, else the mission check. */
export function gateCommands(policy: RepoPolicy): string[] {
  return policy.finish.gate.length > 0 ? [...policy.finish.gate] : missionCommands(policy);
}

export interface MissionCheckOptions {
  verifier: Pick<Verifier, 'run'>;
  policy: RepoPolicy;
  commands: readonly string[];
  /** The task whose merge is being checked (the verifier's context); logs go under `runId`. */
  task: Task;
  runId: string;
  /** The integration worktree; its `baseCommit` is the mission's base, for the pre-existing check. */
  tree: WorktreeAssignment;
}

/** Run the commands once and read the results as pass or fail. */
export async function runMissionCheck(opts: MissionCheckOptions, headCommit: string): Promise<MissionVerification & { results: VerificationResult[] }> {
  if (opts.commands.length === 0) return { passed: true, results: [] };
  const results = await opts.verifier.run(
    { stages: opts.commands.map((name) => ({ strategy: `command:${name}`, required: true })) },
    { attemptId: opts.runId, task: opts.task, policy: opts.policy, worktree: opts.tree, headCommit },
  );
  const bad = results.find((r) => !(r.outcome === 'passed' || (r.outcome === 'inconclusive' && r.preExisting)));
  if (!bad) return { passed: true, results };
  return {
    passed: false,
    results,
    failure: {
      stage: bad.strategy,
      summary: bad.summary ?? `${bad.strategy} ${bad.outcome}`,
      ...(bad.evidence?.exitCode !== undefined ? { exitCode: bad.evidence.exitCode } : {}),
      ...(bad.evidence?.failing?.length ? { failingTests: bad.evidence.failing } : {}),
      ...(bad.evidence?.signature ? { signature: bad.evidence.signature } : {}),
    },
  };
}

/** `runMissionCheck` as the Integrator's verifier. */
export function missionVerifier(opts: MissionCheckOptions): MissionVerifier {
  return { verifyMission: ({ headCommit }) => runMissionCheck(opts, headCommit) };
}

/** A one-line summary of a passing check, for the finish result. */
export function checkSummary(commands: readonly string[]): string {
  return commands.length > 0 ? `${commands.join(', ')} passed` : 'no checks: the repository policy names none';
}
