/**
 * What "done" means (`docs/plans/intelligent-orchestration.md` §14; #35).
 *
 * A task is `done` because checks the user wrote passed on its result, or
 * because the user explicitly accepted it — never because an agent stopped
 * talking. This module is the pure half of that: which stages a task's plan
 * has, how a stage's failure is named so two runs of the same failure look the
 * same, and how a set of stage results adds up to one verdict and one badge.
 *
 * Running the stages is `src/orchestration/verify/`; it is separate because
 * everything here has to be callable from the webviews (the task strip draws
 * the badge) and from tests without a repository.
 *
 * The rules this file encodes:
 * - **Commands come only from repo policy** (§14.2). A strategy id may name
 *   one (`command:typecheck`); nothing here ever holds an argv, so no model
 *   output can become a process by passing through this module.
 * - **A repository with no checks yields `unverified`, not `passed`** (§14.3).
 *   Silence is not a pass, and the task then needs the user to accept it.
 * - **An infrastructure failure is not a quality verdict.** A verifier that
 *   crashed or timed out is `error`, and the agent is not blamed for it.
 */
import { commandForStrategy, hasVerification, type RepoPolicy } from './repoPolicy';
import type {
  ReviewVerdict,
  Risk,
  TaskKind,
  Verifiability,
  VerificationOutcomeKind,
  VerificationPlan,
  VerificationResult,
  VerificationStage,
} from './types';

// ---------------------------------------------------------------------------
// The built-in strategies
// ---------------------------------------------------------------------------

/**
 * Strategies that are not a repo command. Anything else in a stage is a
 * `command:<name>` and is looked up in the policy.
 */
export const DIFF_SANITY = 'diff-sanity';
export const REGRESSION_TEST = 'regression-test';
export const HUMAN = 'human';
/** The review-agent verifier (#36): a read-only reviewer's verdict per acceptance criterion. */
export const REVIEW = 'review';
/** How long a review may take before it is abandoned as `error`. */
export const REVIEW_TIMEOUT_SEC = 600;

/** Strategy ids that are built in rather than named commands. */
export const BUILT_IN_STRATEGIES: readonly string[] = [DIFF_SANITY, REGRESSION_TEST, HUMAN, REVIEW];

/**
 * Task kinds whose result is expected to change files.
 *
 * `diff-sanity` fails an empty diff for these and only these: an
 * investigation that concluded "no change needed" is a perfectly good result,
 * and failing it would teach the user to ignore the verdict.
 */
const EXPECTS_A_DIFF: readonly TaskKind[] = [
  'bugfix',
  'feature',
  'refactor',
  'migration',
  'docs',
  'test',
  'chore',
  'conflict-resolution',
];

export function expectsDiff(kind: TaskKind | undefined): boolean {
  return kind !== undefined && EXPECTS_A_DIFF.includes(kind);
}

/**
 * Kinds for which the tests the attempt touched are worth running against the
 * base commit (§14.1, SWE-agent's discipline): a bug fix should come with a
 * test that fails without it.
 */
const WANTS_REGRESSION_TEST: readonly TaskKind[] = ['bugfix'];

export function wantsRegressionTest(kind: TaskKind | undefined): boolean {
  return kind !== undefined && WANTS_REGRESSION_TEST.includes(kind);
}

// ---------------------------------------------------------------------------
// Plans (§14.2)
// ---------------------------------------------------------------------------

/**
 * Build a task's verification plan.
 *
 * Order is cheapest-first, so a run that is going to fail fails before a test
 * suite has been paid for: `diff-sanity`, then the repository's commands in
 * the order the user listed them, then `regression-test`, which needs a second
 * checkout of the base and is therefore the most expensive thing here.
 *
 * `suggested` is what a planner proposed. It can only ever *narrow* the
 * command stages to ones the policy already defines — a name that is not in
 * the policy is dropped, which is the rule that keeps a model from introducing
 * a command. It cannot add `human`, which is the user's to ask for.
 */
export function buildVerificationPlan(opts: {
  kind: TaskKind | undefined;
  policy: RepoPolicy;
  /** Command names a planner or the user suggested. Absent: every command the policy defines. */
  suggested?: readonly string[];
  /** The user asked to approve this task by hand whatever the checks say. */
  requireHuman?: boolean;
  /** How many acceptance criteria the task has. None: there is nothing for a reviewer to judge. */
  criteria?: number;
}): VerificationPlan {
  const { kind, policy, suggested, requireHuman } = opts;
  const stages: VerificationStage[] = [];

  if (expectsDiff(kind)) {
    // Required: an agent that changed nothing has not done a task that was
    // supposed to change something, whatever its final message said.
    stages.push({ strategy: DIFF_SANITY, required: true });
  } else if (kind !== undefined) {
    // Still worth running — it catches conflict markers and stray secrets —
    // but not a reason to fail a task that was never going to edit anything.
    stages.push({ strategy: DIFF_SANITY, required: false });
  }

  for (const name of taskCommandNames(policy, suggested)) {
    const command = policy.verification.commands[name];
    stages.push({ strategy: `command:${name}`, required: true, timeoutSec: command.timeoutSec });
  }

  if (wantsRegressionTest(kind) && hasVerification(policy)) {
    // Advisory: a fix can be right without a new test, and calling that a
    // failure would be a style opinion enforced as a gate.
    stages.push({ strategy: REGRESSION_TEST, required: false });
  }

  const review = reviewStage(kind, policy, opts.criteria ?? 0);
  if (review) stages.push(review);

  if (requireHuman) stages.push({ strategy: HUMAN, required: true });

  return { stages };
}

/**
 * The `review` stage a task gets, if any (#36).
 *
 * Last of the automatic stages, because it is the most expensive one and the
 * least certain: a result that already failed its tests is not worth a
 * reviewer's time, and the runner stops at the first required failure.
 *
 * A kind the policy lists in `requiredFor` always gets a required review,
 * whatever `when` says — naming a kind there is the more specific instruction.
 * Otherwise the review is advisory, and under `auto` it only runs when the
 * assessment says the repository's own checks say little about the task.
 */
function reviewStage(kind: TaskKind | undefined, policy: RepoPolicy, criteria: number): VerificationStage | undefined {
  if (criteria === 0) return undefined;
  const required = kind !== undefined && policy.review.requiredFor.includes(kind);
  if (required) return { strategy: REVIEW, required: true, timeoutSec: REVIEW_TIMEOUT_SEC };
  if (policy.review.when === 'never') return undefined;
  return {
    strategy: REVIEW,
    required: false,
    timeoutSec: REVIEW_TIMEOUT_SEC,
    ...(policy.review.when === 'auto' ? { onlyIf: 'risky-or-weakly-verified' as const } : {}),
  };
}

/**
 * Whether a stage with `onlyIf` should run, given what the assessment said.
 *
 * No assessment (the assessor is off, or has not answered yet) runs it: not
 * knowing the risk is not knowing it is low, and a review that was not needed
 * costs a little money where one that was skipped costs a bad merge.
 */
export function stageApplies(
  stage: VerificationStage,
  assessment: { risk: Risk; verifiability: Verifiability } | undefined,
): boolean {
  if (stage.onlyIf !== 'risky-or-weakly-verified') return true;
  if (!assessment) return true;
  return assessment.risk !== 'low' || assessment.verifiability === 'none' || assessment.verifiability === 'weak';
}

/**
 * Which of the policy's commands a task runs.
 *
 * With nothing suggested, all of them: a repository that defines `typecheck`
 * and `test` means both, and a task that quietly skipped one would produce a
 * `passed` that does not mean what it says. `suggested` filters that list and
 * never extends it.
 */
function taskCommandNames(policy: RepoPolicy, suggested: readonly string[] | undefined): string[] {
  const all = Object.keys(policy.verification.commands);
  if (!suggested) return all;
  const wanted = new Set(suggested.map(stripCommandPrefix));
  return all.filter((name) => wanted.has(name));
}

/** `command:test` and `test` both name the command `test`. */
function stripCommandPrefix(s: string): string {
  return s.startsWith('command:') ? s.slice('command:'.length) : s;
}

/**
 * Whether a plan can actually say anything about a result.
 *
 * `diff-sanity` alone is deliberately not enough: it proves the agent touched
 * files, not that the files are right, and treating that as verification is
 * exactly the "a completed process is a successful task" mistake this phase
 * exists to stop.
 */
export function planCanVerify(plan: VerificationPlan, policy: RepoPolicy): boolean {
  return plan.stages.some((s) => commandForStrategy(policy, s.strategy) !== undefined || s.strategy === HUMAN);
}

// ---------------------------------------------------------------------------
// diff-sanity (§14.1)
// ---------------------------------------------------------------------------

/** One thing wrong with a diff. `fatal` fails the stage; the rest are warnings. */
export interface DiffFinding {
  code: 'no-diff' | 'conflict-markers' | 'secret' | 'deleted-tests' | 'skipped-tests' | 'outside-scope';
  fatal: boolean;
  message: string;
  /** Repository-relative paths the finding is about, at most a few. */
  files?: string[];
}

/** A conflict marker at the start of a line, which is the only place git writes one. */
const CONFLICT_MARKER = /^[+](?:<{7}|={7}|>{7})(?:\s|$)/;

/**
 * Things that look like a credential.
 *
 * Deliberately narrow: these are shapes that are nearly always a real secret
 * and almost never a variable name, because a `diff-sanity` that cries wolf is
 * one the user turns off. A miss here is caught by review; a false positive
 * costs the user a failed task they have to override.
 */
const SECRET_PATTERNS: readonly { re: RegExp; what: string }[] = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/, what: 'an API key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, what: 'a GitHub token' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, what: 'a private key' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, what: 'a Slack token' },
];

/** Paths that look like a test, for the "did it delete the tests" check. */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$|Test[A-Z_]/;

export function isTestPath(file: string): boolean {
  return TEST_PATH.test(file);
}

/** A line a test runner would skip: `it.skip`, `xit`, `@pytest.mark.skip`, `t.Skip()`. */
const SKIP_LINE = /^\+\s*(?:x(?:it|describe)\b|(?:it|test|describe|context)\.(?:skip|todo)\b|@pytest\.mark\.skip|t\.Skip\(|@Ignore\b|\.skip\()/;

/**
 * What is wrong with a diff, if anything (§14.1).
 *
 * Takes the diff as text rather than reading git itself, so the rules are
 * testable against a fixture and the same function can one day judge a mission
 * branch. `changedFiles` comes from `--numstat` because a diff of a deletion
 * carries no `+` lines to find the path in.
 */
export function diffSanityFindings(input: {
  diff: string;
  changedFiles: readonly { file: string; insertions: number; deletions: number }[];
  kind: TaskKind | undefined;
  /** Globs the task said it would touch. A change outside them is a warning, never a failure. */
  scope?: readonly string[];
}): DiffFinding[] {
  const { diff, changedFiles, kind } = input;
  const out: DiffFinding[] = [];

  if (changedFiles.length === 0) {
    if (expectsDiff(kind)) {
      out.push({
        code: 'no-diff',
        fatal: true,
        message: 'the attempt changed nothing, and this kind of task is supposed to change something',
      });
    }
    // Nothing else can be true of a diff that does not exist.
    return out;
  }

  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

  const conflicted = new Set<string>();
  const secrets: { file: string; what: string }[] = [];
  let file = '';
  for (const raw of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.*)$/.exec(raw);
    if (header) {
      file = header[1];
      continue;
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    if (CONFLICT_MARKER.test(raw)) conflicted.add(file);
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(raw)) secrets.push({ file, what: p.what });
    }
  }

  if (conflicted.size > 0) {
    out.push({
      code: 'conflict-markers',
      fatal: true,
      message: 'the diff adds conflict markers — an unfinished merge was committed',
      files: [...conflicted].slice(0, 5),
    });
  }
  if (secrets.length > 0) {
    const first = secrets[0];
    out.push({
      code: 'secret',
      fatal: true,
      message: `the diff adds what looks like ${first.what}`,
      files: [...new Set(secrets.map((s) => s.file))].slice(0, 5),
    });
  }

  // Deleting the tests is the cheapest way to make a suite pass, so it is
  // always worth saying — but a refactor legitimately moves tests around, and
  // this cannot tell the two apart, so it warns rather than failing.
  const deletedTests = changedFiles.filter((f) => isTestPath(f.file) && f.insertions === 0 && f.deletions > 0);
  if (deletedTests.length > 0 && kind !== 'refactor') {
    out.push({
      code: 'deleted-tests',
      fatal: false,
      message: `${deletedTests.length} test file${deletedTests.length === 1 ? '' : 's'} had only deletions`,
      files: deletedTests.map((f) => f.file).slice(0, 5),
    });
  }

  const skipped = added.filter((l) => SKIP_LINE.test(l));
  if (skipped.length > 0) {
    out.push({
      code: 'skipped-tests',
      fatal: false,
      message: `the diff adds ${skipped.length} skipped or todo test${skipped.length === 1 ? '' : 's'}`,
    });
  }

  const scope = input.scope;
  if (scope && scope.length > 0) {
    const outside = changedFiles.filter((f) => !scope.some((g) => matchesGlob(f.file, g))).map((f) => f.file);
    if (outside.length > 0) {
      out.push({
        code: 'outside-scope',
        fatal: false,
        message: `${outside.length} changed file${outside.length === 1 ? '' : 's'} outside the task's predicted scope`,
        files: outside.slice(0, 5),
      });
    }
  }

  return out;
}

/**
 * The small glob subset a scope uses: `*` within a path segment, `**` across
 * segments, `?` for one character. Not a general matcher — scopes come from
 * the assessor and the user, and anything fancier would be a rule nobody could
 * predict the behaviour of.
 */
export function matchesGlob(file: string, glob: string): boolean {
  const re = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:[^/]+/)*';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${re}$`).test(file);
}

// ---------------------------------------------------------------------------
// Failure signatures (§15.1)
// ---------------------------------------------------------------------------

const MAX_SIGNATURE_LEN = 200;

/**
 * A stable name for *what* failed, so the same failure twice running is
 * recognisably the same and escalation (#41) can tell "it failed again" from
 * "it failed differently".
 *
 * Everything that varies between two runs of one failure is removed: line and
 * column numbers, durations, hex ids, temporary paths, memory addresses, and
 * the worktree's own path (which contains the attempt number, so leaving it in
 * would make every attempt's failure unique — the exact thing a signature is
 * for).
 */
export function normalizeSignature(input: {
  strategy: string;
  /** Failing test names, when the output named any. The most reliable signature there is. */
  failing?: readonly string[];
  /** A line of output to fall back on. */
  text?: string;
  /** The worktree path, removed wherever it appears. */
  root?: string;
}): string | undefined {
  const { strategy, failing, text, root } = input;
  const head = `${strategy}:`;
  if (failing && failing.length > 0) {
    // Sorted, so two runs that reported the same failures in a different order
    // are one signature. Capped: a suite that broke everywhere is "many", and
    // the first few names say which area.
    const names = [...failing].map((f) => scrub(f, root)).sort();
    const shown = names.slice(0, 5).join(',');
    return clamp(`${head}${shown}${names.length > 5 ? `+${names.length - 5}` : ''}`);
  }
  const line = firstMeaningfulLine(text, root);
  return line ? clamp(head + line) : undefined;
}

/**
 * The first line of output worth naming a failure after.
 *
 * Blank lines and the noise every runner prints ("npm ERR!", a stack frame,
 * the command that was run) say nothing about which failure this is, so they
 * are skipped in favour of the first line that does.
 */
function firstMeaningfulLine(text: string | undefined, root: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^(npm ERR!|yarn |at\s|\.\.\.|\$ |> )/.test(line)) continue;
    if (/^-+$/.test(line)) continue;
    const s = scrub(line, root);
    if (s !== '') return s;
  }
  return undefined;
}

/** Remove everything that differs between two runs of the same failure. */
function scrub(s: string, root: string | undefined): string {
  let out = s;
  if (root && root.length > 0) out = out.split(root).join('<worktree>');
  return out
    .replace(/\/(?:private\/)?(?:var|tmp)\/[^\s:)'"]+/g, '<tmp>')
    .replace(/0x[0-9a-fA-F]+/g, '<addr>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m)\b/g, '<time>')
    // `file.ts:12:34` → `file.ts` — the file is the failure, the position is not.
    .replace(/(:\d+){1,2}(?=\b|:)/g, '')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(s: string): string {
  return s.length <= MAX_SIGNATURE_LEN ? s : `${s.slice(0, MAX_SIGNATURE_LEN - 1)}…`;
}

// ---------------------------------------------------------------------------
// Reading a runner's output
// ---------------------------------------------------------------------------

/** How many failing names are worth keeping; past this the count is the story. */
const MAX_FAILING = 20;

/**
 * The names of the tests that failed, from a command's output.
 *
 * Best-effort and deliberately runner-agnostic: AW does not know which test
 * runner a repository uses and must not be configured with one, so this
 * recognises the handful of shapes the common ones share (`FAIL <path>`,
 * vitest/jest `× name`, `AssertionError` headers, tsc's `file.ts(1,2): error`)
 * and returns nothing when it recognises none. Nothing downstream depends on
 * finding names — they make a failure readable, and the exit code is what
 * decides it.
 */
export function failingNames(output: string): string[] {
  const names = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = stripAnsi(raw).trim();
    if (line === '') continue;

    // pytest: `FAILED tests/test_x.py::test_y - AssertionError: …`. Checked
    // before the general `FAIL` shape below, which would otherwise take the
    // reason along with the name and give every distinct message its own
    // "test" — the one thing a signature must not do.
    const pytest = /^(?:FAILED\s+)?([\w./-]+::[\w:.[\]-]+)(?:\s+-\s+.*)?$/.exec(line);
    if (pytest) {
      names.add(pytest[1]);
      continue;
    }
    // `FAIL  test/foo.test.ts > suite > case`
    const fail = /^(?:FAIL|FAILED|✗|×)\s+(.+)$/.exec(line);
    if (fail) {
      names.add(fail[1].replace(/\s+\d+\s*ms$/, '').trim());
      continue;
    }
    // go: `--- FAIL: TestThing (0.00s)`
    const go = /^---\s+FAIL:\s+(\S+)/.exec(line);
    if (go) {
      names.add(go[1]);
      continue;
    }
    // tsc: `src/foo.ts(12,3): error TS2345: …` — the file is the failure.
    const tsc = /^(\S+?)\(\d+,\d+\):\s+error\s+(TS\d+)/.exec(line);
    if (tsc) {
      names.add(`${tsc[1]} ${tsc[2]}`);
      continue;
    }
    // eslint/tsc `error  message  rule` lines carry no name worth keeping.
    if (names.size >= MAX_FAILING) break;
  }
  return [...names].slice(0, MAX_FAILING);
}

/** Colour codes make two runs of one failure look different; they never help a signature. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * The tail of a command's output, for the strip and the notification.
 *
 * The tail rather than the head: a test runner puts its summary last, and the
 * first 2 KB of a failing `npm test` is almost always the banner.
 */
export function outputTail(output: string, maxChars = 2000): string {
  const clean = stripAnsi(output).trimEnd();
  return clean.length <= maxChars ? clean : `…${clean.slice(clean.length - maxChars)}`;
}

// ---------------------------------------------------------------------------
// The reviewer's verdict (#36)
// ---------------------------------------------------------------------------

/** The id the reviewer is asked to use for the task's `i`th criterion (0-based). */
export function criterionId(i: number): string {
  return `c${i + 1}`;
}

const MAX_WHY = 500;
const MAX_CONCERNS = 10;

/**
 * Turn what the reviewer said into one entry per criterion, in the task's order.
 *
 * The schema already guarantees the shape; this guarantees the *coverage*,
 * which a schema cannot: a criterion the reviewer skipped is `unclear` rather
 * than silently absent, a criterion it answered twice keeps its first answer,
 * and an id that names no criterion is dropped. Each repair is counted, so a
 * reviewer that keeps getting this wrong shows up in telemetry.
 */
export function normaliseReview(
  criteriaCount: number,
  raw: { criteria: readonly { id: string; verdict: string; why: string }[]; concerns: readonly string[] },
): { criteria: ReviewVerdict['criteria']; concerns: string[]; repaired: number } {
  const byId = new Map<string, { verdict: ReviewVerdict['criteria'][number]['verdict']; why: string }>();
  let repaired = 0;
  for (const c of raw.criteria) {
    const id = c.id.trim().toLowerCase();
    const verdict = c.verdict === 'met' || c.verdict === 'unmet' || c.verdict === 'unclear' ? c.verdict : undefined;
    if (!verdict || byId.has(id)) {
      repaired++;
      continue;
    }
    byId.set(id, { verdict, why: clip(c.why.trim(), MAX_WHY) });
  }
  const criteria: ReviewVerdict['criteria'] = [];
  for (let i = 0; i < criteriaCount; i++) {
    const id = criterionId(i);
    const got = byId.get(id);
    if (got) {
      criteria.push({ id, ...got });
      byId.delete(id);
    } else {
      repaired++;
      criteria.push({ id, verdict: 'unclear', why: 'The reviewer gave no verdict for this criterion.' });
    }
  }
  // Whatever is left named no criterion.
  repaired += byId.size;
  const concerns = raw.concerns
    .map((c) => clip(c.trim(), MAX_WHY))
    .filter((c) => c !== '')
    .slice(0, MAX_CONCERNS);
  return { criteria, concerns, repaired };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function reviewCounts(v: ReviewVerdict): { met: number; unmet: number; unclear: number } {
  const out = { met: 0, unmet: 0, unclear: 0 };
  for (const c of v.criteria) out[c.verdict]++;
  return out;
}

/**
 * What a review verdict means as a stage outcome.
 *
 * Any `unmet` fails it, any `unclear` (with nothing unmet) is `inconclusive`,
 * and only every criterion `met` passes. Whether that outcome then decides
 * the task is the plan's business: advisory unless the policy made it
 * required, and never counted as verification on its own (`verifies`).
 */
export function reviewOutcome(v: ReviewVerdict): { outcome: VerificationOutcomeKind; summary: string } {
  const n = reviewCounts(v);
  const total = v.criteria.length;
  const ids = (verdict: 'unmet' | 'unclear') =>
    v.criteria
      .filter((c) => c.verdict === verdict)
      .map((c) => c.id)
      .join(', ');
  if (total === 0) return { outcome: 'unavailable', summary: 'the task has no acceptance criteria to review' };
  if (n.unmet > 0) {
    return { outcome: 'failed', summary: `the reviewer found ${n.unmet} of ${total} criteria unmet (${ids('unmet')})` };
  }
  if (n.unclear > 0) {
    return { outcome: 'inconclusive', summary: `the reviewer could not tell whether ${n.unclear} of ${total} criteria are met (${ids('unclear')})` };
  }
  return { outcome: 'passed', summary: `the reviewer found all ${total} ${total === 1 ? 'criterion' : 'criteria'} met` };
}

// ---------------------------------------------------------------------------
// Adding the stages up (§14.3)
// ---------------------------------------------------------------------------

/** What the whole of a task's verification came to. */
export type VerificationVerdict =
  /** Every required stage passed. Some may have been flaky, and advisory ones may have failed. */
  | 'passed'
  /** A required stage failed, and it was this attempt's doing. */
  | 'failed'
  /** Nothing could say. No checks exist, or every required stage was unavailable. */
  | 'unverified'
  /** A required stage could not reach a verdict — including a failure the base commit has too. */
  | 'inconclusive'
  /** A verifier crashed or timed out: infrastructure, not the agent (§14.3). */
  | 'error';

/**
 * Whether passing this strategy is evidence that the *work* is right.
 *
 * `diff-sanity` is a smoke test on the shape of the diff and `review` is
 * advisory, so neither can carry a result on its own; a repo command and a
 * human's approval can.
 */
function verifies(strategy: string): boolean {
  return strategy.startsWith('command:') || strategy === REGRESSION_TEST;
}

export interface VerificationSummary {
  verdict: VerificationVerdict;
  /** One line for the strip and the notification. */
  summary: string;
  /** A required stage failed on the base commit too: the repository was already red. */
  baseIsRed: boolean;
  /** A stage passed only on its re-run. */
  flaky: boolean;
  /** The signature of the first required failure, for escalation. */
  signature?: string;
  /** Strategy ids that failed, required ones first. */
  failed: string[];
}

/**
 * Add up a plan's results.
 *
 * Ordered by how much each outcome matters, because they are not comparable:
 * an `error` means we do not know and it is our fault, a `failed` means we know
 * and it is the agent's, and `unavailable` means nobody ever said. Mixing them
 * into "not passed" is what makes an unverified result look like a good one.
 */
export function summariseVerification(
  plan: VerificationPlan,
  results: readonly VerificationResult[],
): VerificationSummary {
  const required = new Set(plan.stages.filter((s) => s.required).map((s) => s.strategy));
  const finished = results.filter((r) => r.state === 'finished');
  const of = (kind: VerificationOutcomeKind, onlyRequired: boolean): VerificationResult[] =>
    finished.filter((r) => r.outcome === kind && (!onlyRequired || required.has(r.strategy)));

  const errors = of('error', true);
  const failures = of('failed', true);
  const inconclusive = of('inconclusive', true);
  const baseIsRed = finished.some((r) => r.preExisting);
  const flaky = finished.some((r) => r.flaky);
  const advisoryFailed = finished.filter((r) => !required.has(r.strategy) && (r.outcome === 'failed' || r.outcome === 'inconclusive'));

  if (errors.length > 0) {
    return {
      verdict: 'error',
      summary: `Verification could not run: ${errors[0].summary ?? errors[0].strategy}`,
      baseIsRed,
      flaky,
      failed: errors.map((r) => r.strategy),
    };
  }
  if (failures.length > 0) {
    const first = failures[0];
    return {
      verdict: 'failed',
      summary: first.summary ?? `${first.strategy} failed`,
      baseIsRed,
      flaky,
      signature: first.evidence?.signature,
      failed: failures.map((r) => r.strategy),
    };
  }
  if (inconclusive.length > 0) {
    const first = inconclusive[0];
    return {
      verdict: 'inconclusive',
      summary: first.preExisting
        ? `${first.strategy} fails on the base commit too — the repository was already red`
        : (first.summary ?? `${first.strategy} could not decide`),
      baseIsRed,
      flaky,
      signature: first.evidence?.signature,
      failed: inconclusive.map((r) => r.strategy),
    };
  }

  // Nothing failed. Whether that is a pass depends on whether anything that
  // could actually vouch for the result ran.
  //
  // `diff-sanity` deliberately does not count, however green it is: it proves
  // the agent edited some files and that they contain no conflict markers,
  // which is not evidence that the work is right. Counting it would turn every
  // task in a repository with no commands into a confident `passed` — the
  // "a completed process is a successful task" mistake, wearing a tick.
  const ranSomething = finished.some((r) => r.outcome === 'passed' && required.has(r.strategy) && verifies(r.strategy));
  if (!ranSomething) {
    return {
      verdict: 'unverified',
      summary:
        plan.stages.length === 0
          ? 'No checks are configured for this repository, so the result is unverified.'
          : 'Nothing could be verified, so the result is unverified.',
      baseIsRed,
      flaky,
      failed: [],
    };
  }

  const passed = of('passed', false).length;
  const notes: string[] = [];
  if (flaky) notes.push('one stage was flaky');
  if (advisoryFailed.length > 0) notes.push(`${advisoryFailed.length} advisory ${advisoryFailed.length === 1 ? 'check' : 'checks'} failed`);
  return {
    verdict: 'passed',
    summary: `${passed} ${passed === 1 ? 'check' : 'checks'} passed${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
    baseIsRed,
    flaky,
    failed: advisoryFailed.map((r) => r.strategy),
  };
}

// ---------------------------------------------------------------------------
// The badge (§18.2, drawn by #34's strip)
// ---------------------------------------------------------------------------

export interface VerificationBadge {
  verdict: VerificationVerdict;
  /** `✓`, `✗`, `~`, `?`, `!` — the glyph the row and the strip show. */
  glyph: string;
  text: string;
  title: string;
}

const GLYPH: Record<VerificationVerdict, string> = {
  passed: '✓',
  failed: '✗',
  inconclusive: '~',
  unverified: '?',
  error: '!',
};

const LABEL: Record<VerificationVerdict, string> = {
  passed: 'verified',
  failed: 'failed',
  inconclusive: 'inconclusive',
  unverified: 'unverified',
  error: 'check errored',
};

/** The badge for a summary. `~ flaky` rather than a bare tick when a stage needed a re-run. */
export function verificationBadge(s: VerificationSummary): VerificationBadge {
  const flakyPass = s.verdict === 'passed' && s.flaky;
  return {
    verdict: s.verdict,
    glyph: flakyPass ? '~' : GLYPH[s.verdict],
    text: flakyPass ? 'flaky' : LABEL[s.verdict],
    title: s.summary,
  };
}

/** One line per stage, for the strip's verification detail (§18.3). */
export function stageLine(r: VerificationResult): string {
  const parts = [r.strategy];
  if (r.state === 'running') parts.push('running');
  else if (r.skipped) parts.push('skipped');
  else parts.push(r.outcome ?? 'no result');
  if (r.review) {
    const n = reviewCounts(r.review);
    const bits = [n.met > 0 ? `${n.met} met` : '', n.unmet > 0 ? `${n.unmet} unmet` : '', n.unclear > 0 ? `${n.unclear} unclear` : ''].filter(Boolean);
    if (bits.length > 0) parts.push(bits.join(', '));
  }
  if (r.preExisting) parts.push('base is red');
  if (r.flaky) parts.push('flaky');
  if (r.durationMs !== undefined) parts.push(formatMs(r.durationMs));
  return parts.join(' · ');
}

function formatMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}
