/**
 * Running a task's verification plan (`docs/plans/intelligent-orchestration.md`
 * §14.2–14.3; #35).
 *
 * The core runs the checks, never the agent. That is the whole point: a result
 * an agent verified is a result the agent graded, and the one thing this phase
 * exists to establish is a pass/fail signal that every later phase — retries,
 * escalation, routing evaluation, analytics — can trust.
 *
 * What that costs in care:
 *
 * - **Commands come only from repo policy** (§14.2). A stage names one
 *   (`command:typecheck`); `commandForStrategy` looks it up; a name the policy
 *   does not define is `unavailable`, never a guess. There is no path from a
 *   model's output to an argv here.
 * - **A failure is checked against the base commit** before it is blamed on
 *   the agent (§14.3). A repository whose tests were already red would
 *   otherwise fail every attempt forever, and the escalation logic would
 *   dutifully spend a frontier model on it.
 * - **A failing test stage is re-run once** on the unchanged tree. Passing on
 *   the second run is `flaky`, which is a fact about the repository, not a
 *   verdict on the attempt.
 * - **A crash or a timeout is `error`, not `failed`** — our infrastructure
 *   broke, and the agent must not be charged for it.
 *
 * Output goes to `orchestration/logs/<attemptId>/<stage>.log`; the mission
 * record keeps a summary, the failing names and a signature, never the log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentEnv } from '../../sessionHost/env';
import {
  commandForStrategy,
  type RepoPolicy,
  type VerificationCommand,
} from '../../shared/orchestration/repoPolicy';
import {
  DIFF_SANITY,
  HUMAN,
  REGRESSION_TEST,
  REVIEW,
  REVIEW_TIMEOUT_SEC,
  diffSanityFindings,
  failingNames,
  normalizeSignature,
  outputTail,
  reviewOutcome,
  stageApplies,
  stripAnsi,
} from '../../shared/orchestration/verification';
import type {
  Risk,
  Task,
  Verifiability,
  VerificationPlan,
  VerificationResult,
  VerificationStage,
  WorktreeAssignment,
} from '../../shared/orchestration/types';
import type { Exec, ExecResult } from '../worktrees/exec';
import type { Reviewer } from './reviewer';

/** What a stage is being run against. */
export interface VerifyContext {
  attemptId: string;
  task: Task;
  policy: RepoPolicy;
  worktree: WorktreeAssignment;
  /** The commit the attempt produced. Absent when it committed nothing. */
  headCommit?: string;
  /** What the task's newest assessment said, for stages with `onlyIf` (#36). Absent: not assessed. */
  assessment?: { risk: Risk; verifiability: Verifiability };
}

export interface VerifierDeps {
  exec: Exec;
  /** Where `orchestration/logs/<attemptId>/` goes. */
  logsDir: string;
  /**
   * Run something in a throwaway checkout of the base commit, for the
   * pre-existing check. Absent: the check is skipped and a failure is taken at
   * face value, which is the safe direction — it blames the attempt for
   * something that may not be its fault, and says so in the summary rather
   * than silently calling a red repository green.
   */
  withBaseCheckout?<T>(baseCommit: string, fn: (tree: string) => Promise<T>): Promise<T>;
  /** The whole diff, for `diff-sanity`. */
  diffText(): Promise<string>;
  /** Per-file numbers, for `diff-sanity`: a pure deletion has no `+` lines to read a path from. */
  changedFiles(): Promise<{ file: string; insertions: number; deletions: number }[]>;
  /** The review-agent verifier (#36). Absent: a `review` stage is `unavailable`. */
  reviewer?: Pick<Reviewer, 'review'>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** A stage's result, before it is written into the attempt. */
type Outcome = Omit<VerificationResult, 'strategy' | 'state' | 'startedAt'>;

const DEFAULT_TIMEOUT_SEC = 600;
/** How long a base-commit check may take before it is abandoned as unknowable. */
const BASE_CHECK_FACTOR = 1;

export class Verifier {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /**
   * Whether a command was already failing at a base commit.
   *
   * Cached per `<baseCommit>\0<command name>` for the life of the verifier
   * (§14.3): three attempts on one base must not each pay for a full checkout
   * and test run to learn the same thing.
   */
  private readonly baseFailures = new Map<string, boolean>();

  constructor(private readonly deps: VerifierDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * Run a plan, in order, stopping after a required stage fails.
   *
   * Stopping matters for more than speed: once a required stage has failed the
   * task is going back to the user either way, and running the rest would
   * spend a test suite on an answer nobody is waiting for. Advisory failures
   * never stop anything — they are warnings attached to a result.
   */
  async run(plan: VerificationPlan, ctx: VerifyContext): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const stage of plan.stages) {
      const startedAt = this.now();
      let outcome: Outcome;
      try {
        outcome = await this.stage(stage, ctx);
      } catch (e) {
        // A verifier that threw is infrastructure, not a verdict (§14.3).
        outcome = {
          outcome: 'error',
          summary: `${stage.strategy} could not run: ${errorText(e)}`,
        };
      }
      const result: VerificationResult = {
        strategy: stage.strategy,
        state: 'finished',
        startedAt,
        durationMs: Math.max(0, this.now() - startedAt),
        ...outcome,
      };
      results.push(result);
      this.log(`verify ${ctx.attemptId}: ${result.strategy} → ${result.outcome}${result.flaky ? ' (flaky)' : ''}${result.preExisting ? ' (base is red)' : ''}`);
      if (stage.required && result.outcome !== 'passed') break;
    }
    return results;
  }

  private stage(stage: VerificationStage, ctx: VerifyContext): Promise<Outcome> {
    if (stage.strategy === DIFF_SANITY) return this.diffSanity(ctx);
    if (stage.strategy === HUMAN) {
      // Not something that can be run: it is the user's approval, and the task
      // sits in `needs-human` until they give it. `unavailable` is what makes
      // the summary `unverified` rather than a pass nobody granted.
      return Promise.resolve({ outcome: 'unavailable', summary: 'waiting for you to accept the result' });
    }
    if (!stageApplies(stage, ctx.assessment)) {
      return Promise.resolve({
        outcome: 'unavailable',
        skipped: true,
        summary: `not run: the task was assessed ${ctx.assessment?.risk} risk with ${ctx.assessment?.verifiability} verifiability, so its checks already say enough`,
      });
    }
    if (stage.strategy === REVIEW) return this.review(stage, ctx);
    if (stage.strategy === REGRESSION_TEST) {
      // Declared so a plan can name it. Saying so is better than silently
      // passing a stage that never ran.
      return Promise.resolve({ outcome: 'unavailable', summary: `${stage.strategy} is not implemented yet` });
    }
    const command = commandForStrategy(ctx.policy, stage.strategy);
    if (!command) {
      return Promise.resolve({
        outcome: 'unavailable',
        summary: `no verification command named ${stage.strategy.replace(/^command:/, '')} in this repository's policy`,
      });
    }
    return this.command(stage, command, ctx);
  }

  // ---- command (§14.1) ----

  private async command(stage: VerificationStage, command: VerificationCommand, ctx: VerifyContext): Promise<Outcome> {
    const name = stage.strategy.replace(/^command:/, '');
    const timeoutMs = (stage.timeoutSec ?? command.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const first = await this.runCommand(command, ctx.worktree.path, timeoutMs);
    const logPath = this.writeLog(ctx.attemptId, name, command, first);

    if (first.failure) {
      return {
        outcome: 'error',
        summary:
          first.failure === 'timeout'
            ? `${name} timed out after ${Math.round(timeoutMs / 1000)}s`
            : `${name} could not be started: ${outputTail(first.stderr, 200)}`,
        evidence: { logPath },
      };
    }
    if (first.code === 0) return { outcome: 'passed', summary: `${name} passed`, evidence: { exitCode: 0, logPath } };

    // Failed once. Run it again on the same tree: a test that passes now was
    // flaky, and flakiness is the repository's property, not the attempt's.
    const second = await this.runCommand(command, ctx.worktree.path, timeoutMs);
    if (second.failure === undefined && second.code === 0) {
      const retryLog = this.writeLog(ctx.attemptId, `${name}-rerun`, command, second);
      return {
        outcome: 'passed',
        flaky: true,
        summary: `${name} failed once and passed on a re-run of the same tree`,
        evidence: {
          exitCode: 0,
          logPath: retryLog ?? logPath,
          failing: failingNames(output(first)),
          signature: normalizeSignature({ strategy: name, failing: failingNames(output(first)), text: output(first), root: ctx.worktree.path }),
        },
      };
    }

    const failing = failingNames(output(first));
    const signature = normalizeSignature({ strategy: name, failing, text: output(first), root: ctx.worktree.path });

    // It really fails. Was it already failing before the agent touched it?
    const preExisting = await this.failsOnBase(name, command, ctx, timeoutMs);
    if (preExisting === true) {
      return {
        outcome: 'inconclusive',
        preExisting: true,
        summary: `${name} fails on the base commit too — the repository was already red, so this is not the attempt's doing`,
        evidence: { exitCode: first.code, logPath, failing, signature },
      };
    }
    return {
      outcome: 'failed',
      summary:
        failing.length > 0
          ? `${name} failed: ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? ` and ${failing.length - 3} more` : ''}`
          : `${name} exited ${first.code}`,
      evidence: { exitCode: first.code, logPath, failing, signature },
    };
  }

  private runCommand(command: VerificationCommand, cwd: string, timeoutMs: number): Promise<ExecResult> {
    return this.deps.exec(command.run[0], command.run.slice(1), {
      cwd,
      timeoutMs,
      // The same stripped environment a hosted agent gets: a test suite must
      // not inherit `ELECTRON_*` and conclude it is running inside Electron,
      // and `AW_*` is ours and nobody else's business.
      env: agentEnv(process.env),
    });
  }

  /**
   * Whether this command already fails at the task's base commit.
   *
   * `undefined` means it could not be found out — no base checkout available,
   * or the check itself broke. That is reported as "not pre-existing", because
   * the alternative is to excuse a real failure on a guess.
   */
  private async failsOnBase(
    name: string,
    command: VerificationCommand,
    ctx: VerifyContext,
    timeoutMs: number,
  ): Promise<boolean | undefined> {
    const base = ctx.worktree.baseCommit;
    const withBase = this.deps.withBaseCheckout;
    if (!withBase || !base) return undefined;
    const key = `${base}\0${name}`;
    const cached = this.baseFailures.get(key);
    if (cached !== undefined) return cached;
    try {
      const failed = await withBase(base, async (tree) => {
        const r = await this.runCommand(command, tree, timeoutMs * BASE_CHECK_FACTOR);
        // A base check that could not run says nothing; only a clean non-zero
        // exit proves the base was red.
        if (r.failure) throw new Error(r.failure === 'timeout' ? 'the base check timed out' : 'the base check could not start');
        this.writeLog(ctx.attemptId, `${name}-base`, command, r);
        return r.code !== 0;
      });
      this.baseFailures.set(key, failed);
      return failed;
    } catch (e) {
      this.log(`verify ${ctx.attemptId}: could not check ${name} against base ${base.slice(0, 8)}: ${errorText(e)}`);
      return undefined;
    }
  }

  // ---- review (§14.1, #36) ----

  /**
   * Ask a read-only reviewer whether each acceptance criterion is met.
   *
   * No reviewer configured is `unavailable` (nobody said), a reviewer that
   * could not answer is `error` (infrastructure, §14.3), and an answer maps to
   * `passed`/`failed`/`inconclusive` by `reviewOutcome`. The verdict itself is
   * kept on the result either way it came out, because the per-criterion
   * reasons are the point — a bare "inconclusive" tells the user nothing.
   */
  private async review(stage: VerificationStage, ctx: VerifyContext): Promise<Outcome> {
    // A review the policy requires and that could not happen is not a pass
    // nobody granted: it is inconclusive, and the task waits for the user.
    const nobody = stage.required ? 'inconclusive' : 'unavailable';
    const reviewer = this.deps.reviewer;
    if (!reviewer) return { outcome: nobody, summary: 'no reviewer is configured' };
    if (ctx.task.acceptanceCriteria.length === 0) return { outcome: nobody, summary: 'the task has no acceptance criteria to review' };
    const diff = await this.deps.diffText();
    const r = await reviewer.review({
      task: ctx.task,
      diff,
      cwd: ctx.worktree.path,
      timeoutMs: (stage.timeoutSec ?? REVIEW_TIMEOUT_SEC) * 1000,
    });
    if (!r.ok) {
      if (r.reason === 'no-completion') return { outcome: nobody, summary: `no reviewer: ${r.message}` };
      return {
        outcome: 'error',
        summary: r.reason === 'timeout' ? 'the reviewer timed out' : `the reviewer could not answer: ${r.message}`,
        evidence: { signature: `review:${r.reason}` },
      };
    }
    const o = reviewOutcome(r.verdict);
    const unmet = r.verdict.criteria.filter((c) => c.verdict !== 'met').map((c) => c.id);
    return {
      outcome: o.outcome,
      summary: o.summary,
      review: r.verdict,
      ...(unmet.length > 0 ? { evidence: { failing: unmet, signature: `review:${unmet.join(',')}` } } : {}),
    };
  }

  // ---- diff-sanity (§14.1) ----

  private async diffSanity(ctx: VerifyContext): Promise<Outcome> {
    const [diff, changedFiles] = await Promise.all([this.deps.diffText(), this.deps.changedFiles()]);
    const findings = diffSanityFindings({
      diff,
      changedFiles,
      kind: ctx.task.kindHint,
      scope: ctx.task.scope.paths.length > 0 ? ctx.task.scope.paths : undefined,
    });
    if (findings.length === 0) {
      return { outcome: 'passed', summary: `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed, nothing suspicious` };
    }
    const fatal = findings.filter((f) => f.fatal);
    const worst = fatal[0] ?? findings[0];
    const files = findings.flatMap((f) => f.files ?? []);
    return {
      outcome: fatal.length > 0 ? 'failed' : 'passed',
      summary: findings.map((f) => f.message).join('; '),
      evidence: {
        failing: files.length > 0 ? [...new Set(files)] : undefined,
        signature: `diff-sanity:${worst.code}`,
      },
    };
  }

  // ---- logs ----

  /**
   * Write a stage's output where the user can open it.
   *
   * Never fatal: a log that could not be written must not turn a passing
   * check into a failing one, so a failure here costs the `logPath` and
   * nothing else.
   */
  private writeLog(attemptId: string, stage: string, command: VerificationCommand, r: ExecResult): string | undefined {
    try {
      const dir = path.join(this.deps.logsDir, attemptId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${stage}.log`);
      const head = `$ ${command.run.join(' ')}\n${r.failure ? `[${r.failure}]` : `[exit ${r.code}]`}\n\n`;
      fs.writeFileSync(file, head + stripAnsi(r.stdout) + (r.stderr ? `\n--- stderr ---\n${stripAnsi(r.stderr)}` : ''), 'utf8');
      return file;
    } catch (e) {
      this.log(`verify ${attemptId}: could not write the ${stage} log: ${String(e)}`);
      return undefined;
    }
  }
}

/** Both streams, in the order a person reads them: what it said, then what went wrong. */
function output(r: ExecResult): string {
  return r.stderr ? `${r.stdout}\n${r.stderr}` : r.stdout;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
