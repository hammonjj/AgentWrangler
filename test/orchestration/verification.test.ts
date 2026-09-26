/**
 * The pure rules behind verification (#35): what a plan contains, what a diff
 * is judged on, how a failure is named, and what a set of results adds up to.
 */
import { describe, expect, it } from 'vitest';
import {
  buildVerificationPlan,
  diffSanityFindings,
  failingNames,
  isTestPath,
  matchesGlob,
  normalizeSignature,
  outputTail,
  planCanVerify,
  stageLine,
  summariseVerification,
  verificationBadge,
} from '../../src/shared/orchestration/verification';
import { DEFAULT_REPO_POLICY, type RepoPolicy } from '../../src/shared/orchestration/repoPolicy';
import type { VerificationPlan, VerificationResult } from '../../src/shared/orchestration/types';

const policy = (commands: Record<string, string[]> = {}): RepoPolicy => ({
  ...DEFAULT_REPO_POLICY,
  verification: {
    commands: Object.fromEntries(Object.entries(commands).map(([k, run]) => [k, { run, timeoutSec: 600 }])),
    missionDefault: [],
  },
});

const finished = (o: Partial<VerificationResult> & { strategy: string }): VerificationResult => ({
  state: 'finished',
  startedAt: 0,
  ...o,
});

describe('buildVerificationPlan', () => {
  it('runs the cheap check first and the repository’s commands after it', () => {
    const plan = buildVerificationPlan({ kind: 'feature', policy: policy({ typecheck: ['npm', 'run', 'typecheck'], test: ['npm', 'test'] }) });
    expect(plan.stages.map((s) => s.strategy)).toEqual(['diff-sanity', 'command:typecheck', 'command:test']);
    expect(plan.stages.every((s) => s.required)).toBe(true);
  });

  it('requires a diff for kinds that change things and only warns for the others', () => {
    expect(buildVerificationPlan({ kind: 'feature', policy: policy() }).stages[0].required).toBe(true);
    expect(buildVerificationPlan({ kind: 'investigation', policy: policy() }).stages[0].required).toBe(false);
  });

  it('runs every command the policy defines when nothing narrowed it', () => {
    const plan = buildVerificationPlan({ kind: 'feature', policy: policy({ a: ['a'], b: ['b'] }) });
    expect(plan.stages.filter((s) => s.strategy.startsWith('command:'))).toHaveLength(2);
  });

  it('lets a suggestion narrow the commands but never add one', () => {
    const p = policy({ typecheck: ['tsc'], test: ['npm', 'test'] });
    const narrowed = buildVerificationPlan({ kind: 'feature', policy: p, suggested: ['typecheck'] });
    expect(narrowed.stages.map((s) => s.strategy)).toEqual(['diff-sanity', 'command:typecheck']);

    // The name of a command this repository does not define cannot become one.
    const invented = buildVerificationPlan({ kind: 'feature', policy: p, suggested: ['command:deploy'] });
    expect(invented.stages.map((s) => s.strategy)).toEqual(['diff-sanity']);
  });

  it('carries each command’s own timeout onto its stage', () => {
    const p = policy({ slow: ['npm', 'run', 'e2e'] });
    p.verification.commands.slow.timeoutSec = 1800;
    const plan = buildVerificationPlan({ kind: 'feature', policy: p });
    expect(plan.stages.find((s) => s.strategy === 'command:slow')?.timeoutSec).toBe(1800);
  });

  it('adds an advisory regression check for a bug fix, and only when there is something to run', () => {
    const withCommands = buildVerificationPlan({ kind: 'bugfix', policy: policy({ test: ['npm', 'test'] }) });
    expect(withCommands.stages.find((s) => s.strategy === 'regression-test')?.required).toBe(false);
    expect(buildVerificationPlan({ kind: 'bugfix', policy: policy() }).stages.map((s) => s.strategy)).not.toContain('regression-test');
  });

  it('adds a human stage only when asked, and it is required', () => {
    const plan = buildVerificationPlan({ kind: 'feature', policy: policy(), requireHuman: true });
    expect(plan.stages.at(-1)).toEqual({ strategy: 'human', required: true });
  });

  it('knows that diff-sanity alone cannot verify anything', () => {
    const none = buildVerificationPlan({ kind: 'feature', policy: policy() });
    expect(planCanVerify(none, policy())).toBe(false);
    const some = buildVerificationPlan({ kind: 'feature', policy: policy({ test: ['npm', 'test'] }) });
    expect(planCanVerify(some, policy({ test: ['npm', 'test'] }))).toBe(true);
  });
});

describe('diffSanityFindings', () => {
  const file = (f: string, insertions = 1, deletions = 0) => ({ file: f, insertions, deletions });

  it('fails an empty diff for a kind that was supposed to change something', () => {
    const out = diffSanityFindings({ diff: '', changedFiles: [], kind: 'feature' });
    expect(out).toEqual([{ code: 'no-diff', fatal: true, message: expect.any(String) }]);
  });

  it('accepts an empty diff from an investigation, which may rightly conclude nothing', () => {
    expect(diffSanityFindings({ diff: '', changedFiles: [], kind: 'investigation' })).toEqual([]);
  });

  it('fails a diff that commits conflict markers', () => {
    const diff = ['+++ b/src/a.ts', '+<<<<<<< HEAD', '+const a = 1;', '+=======', '+const a = 2;', '+>>>>>>> other'].join('\n');
    const out = diffSanityFindings({ diff, changedFiles: [file('src/a.ts')], kind: 'feature' });
    expect(out).toEqual([expect.objectContaining({ code: 'conflict-markers', fatal: true, files: ['src/a.ts'] })]);
  });

  it('fails a diff that adds something shaped like a credential', () => {
    const diff = ['+++ b/src/config.ts', '+const key = "AKIAIOSFODNN7EXAMPLE";'].join('\n');
    const out = diffSanityFindings({ diff, changedFiles: [file('src/config.ts')], kind: 'feature' });
    expect(out[0]).toMatchObject({ code: 'secret', fatal: true });
  });

  it('does not mistake ordinary code for a secret', () => {
    const diff = ['+++ b/src/a.ts', '+const apiKey = process.env.API_KEY;', '+// token: see the README'].join('\n');
    expect(diffSanityFindings({ diff, changedFiles: [file('src/a.ts')], kind: 'feature' })).toEqual([]);
  });

  it('warns, but does not fail, when only tests were deleted', () => {
    const out = diffSanityFindings({
      diff: '+++ b/src/a.ts\n+const a = 1;',
      changedFiles: [file('src/a.ts'), file('test/a.test.ts', 0, 40)],
      kind: 'feature',
    });
    expect(out).toEqual([expect.objectContaining({ code: 'deleted-tests', fatal: false, files: ['test/a.test.ts'] })]);
  });

  it('says nothing about moved tests in a refactor, which is what a refactor does', () => {
    const out = diffSanityFindings({
      diff: '+++ b/src/a.ts\n+const a = 1;',
      changedFiles: [file('src/a.ts'), file('test/a.test.ts', 0, 40)],
      kind: 'refactor',
    });
    expect(out).toEqual([]);
  });

  it('warns about newly skipped tests', () => {
    const diff = ['+++ b/test/a.test.ts', "+  it.skip('does the thing', () => {", '+  xit("other", () => {'].join('\n');
    const out = diffSanityFindings({ diff, changedFiles: [file('test/a.test.ts')], kind: 'feature' });
    expect(out).toEqual([expect.objectContaining({ code: 'skipped-tests', fatal: false })]);
  });

  it('warns about changes outside the task’s predicted scope', () => {
    const out = diffSanityFindings({
      diff: '+++ b/src/other/x.ts\n+x',
      changedFiles: [file('src/ui/a.ts'), file('src/other/x.ts')],
      kind: 'feature',
      scope: ['src/ui/**'],
    });
    expect(out).toEqual([expect.objectContaining({ code: 'outside-scope', fatal: false, files: ['src/other/x.ts'] })]);
  });

  it('recognises the usual test paths', () => {
    expect(isTestPath('test/a.test.ts')).toBe(true);
    expect(isTestPath('src/__tests__/a.ts')).toBe(true);
    expect(isTestPath('pkg/foo_test.go')).toBe(true);
    expect(isTestPath('src/index.ts')).toBe(false);
  });
});

describe('matchesGlob', () => {
  it('matches within and across path segments', () => {
    expect(matchesGlob('src/ui/a.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/ui/a.ts', 'src/*')).toBe(false);
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/ui/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('other/a.ts', 'src/**')).toBe(false);
  });

  it('treats a dot as a character and not as a wildcard', () => {
    expect(matchesGlob('srcXa.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('a.ts', 'a?ts')).toBe(true);
  });
});

describe('failingNames', () => {
  it('reads vitest and jest failures', () => {
    const out = failingNames(['RUN v3', ' FAIL  test/a.test.ts > thing > works', ' ✓ test/b.test.ts'].join('\n'));
    expect(out).toEqual(['test/a.test.ts > thing > works']);
  });

  it('reads pytest, go and tsc', () => {
    expect(failingNames('FAILED tests/test_x.py::test_y - AssertionError: nope')).toEqual(['tests/test_x.py::test_y']);
    expect(failingNames('--- FAIL: TestThing (0.00s)')).toEqual(['TestThing']);
    expect(failingNames('src/a.ts(12,3): error TS2345: no')).toEqual(['src/a.ts TS2345']);
  });

  it('returns nothing rather than guessing at output it does not recognise', () => {
    expect(failingNames('something went wrong\nplease try again')).toEqual([]);
  });

  it('ignores colour codes', () => {
    expect(failingNames('\u001B[31m FAIL  test/a.test.ts\u001B[0m')).toEqual(['test/a.test.ts']);
  });
});

describe('normalizeSignature', () => {
  it('is the same for two runs of the same failure in different trees', () => {
    const a = normalizeSignature({ strategy: 'test', text: 'Error at /tmp/x-a1/src/a.ts:12:3 took 1.2s', root: '/tmp/x-a1' });
    const b = normalizeSignature({ strategy: 'test', text: 'Error at /tmp/x-a2/src/a.ts:88:1 took 9.9s', root: '/tmp/x-a2' });
    expect(a).toBe(b);
  });

  it('prefers the failing test names, and does not care what order they arrived in', () => {
    const a = normalizeSignature({ strategy: 'test', failing: ['b', 'a'] });
    expect(a).toBe(normalizeSignature({ strategy: 'test', failing: ['a', 'b'] }));
    expect(a).toBe('test:a,b');
  });

  it('caps a suite that broke everywhere', () => {
    const sig = normalizeSignature({ strategy: 'test', failing: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(sig).toBe('test:a,b,c,d,e+2');
  });

  it('skips the noise runners print and names the failure after the first real line', () => {
    const sig = normalizeSignature({ strategy: 'test', text: '\n> npm test\nnpm ERR! code 1\n    at foo\nTypeError: x is not a function' });
    expect(sig).toBe('test:TypeError: x is not a function');
  });

  it('has no signature when there was nothing to read', () => {
    expect(normalizeSignature({ strategy: 'test' })).toBeUndefined();
    expect(normalizeSignature({ strategy: 'test', text: '   \n\n' })).toBeUndefined();
  });

  it('distinguishes two different failures', () => {
    const a = normalizeSignature({ strategy: 'test', failing: ['test/a.test.ts'] });
    const b = normalizeSignature({ strategy: 'test', failing: ['test/b.test.ts'] });
    expect(a).not.toBe(b);
  });
});

describe('outputTail', () => {
  it('keeps the end, which is where a runner puts its summary', () => {
    expect(outputTail('abcdef', 3)).toBe('…def');
    expect(outputTail('abc', 10)).toBe('abc');
  });
});

describe('summariseVerification', () => {
  const plan = (...stages: [string, boolean][]): VerificationPlan => ({
    stages: stages.map(([strategy, required]) => ({ strategy, required })),
  });

  it('passes when every required stage passed', () => {
    const s = summariseVerification(plan(['command:test', true]), [finished({ strategy: 'command:test', outcome: 'passed' })]);
    expect(s.verdict).toBe('passed');
    expect(s.summary).toBe('1 check passed');
  });

  it('fails on a required failure and carries its signature', () => {
    const s = summariseVerification(
      plan(['command:test', true]),
      [finished({ strategy: 'command:test', outcome: 'failed', summary: 'test failed: a', evidence: { signature: 'test:a' } })],
    );
    expect(s).toMatchObject({ verdict: 'failed', signature: 'test:a', summary: 'test failed: a', failed: ['command:test'] });
  });

  it('is unverified when a repository has no checks at all', () => {
    const s = summariseVerification({ stages: [] }, []);
    expect(s.verdict).toBe('unverified');
    expect(s.summary).toContain('No checks are configured');
  });

  it('is unverified when the only required stage could not run', () => {
    const s = summariseVerification(plan(['command:test', true]), [finished({ strategy: 'command:test', outcome: 'unavailable' })]);
    expect(s.verdict).toBe('unverified');
  });

  it('is unverified when a human has yet to accept it, whatever else passed', () => {
    const s = summariseVerification(plan(['human', true]), [finished({ strategy: 'human', outcome: 'unavailable' })]);
    expect(s.verdict).toBe('unverified');
  });

  it('does not blame the attempt for a failure the base commit has too', () => {
    const s = summariseVerification(
      plan(['command:test', true]),
      [finished({ strategy: 'command:test', outcome: 'inconclusive', preExisting: true })],
    );
    expect(s.verdict).toBe('inconclusive');
    expect(s.baseIsRed).toBe(true);
    expect(s.summary).toContain('base commit');
  });

  it('calls a crashed verifier an error, and says so before any failure', () => {
    const s = summariseVerification(
      plan(['command:a', true], ['command:b', true]),
      [
        finished({ strategy: 'command:a', outcome: 'failed' }),
        finished({ strategy: 'command:b', outcome: 'error', summary: 'b timed out after 600s' }),
      ],
    );
    expect(s.verdict).toBe('error');
    expect(s.summary).toContain('timed out');
  });

  it('passes with a note when a stage was flaky', () => {
    const s = summariseVerification(plan(['command:test', true]), [finished({ strategy: 'command:test', outcome: 'passed', flaky: true })]);
    expect(s.verdict).toBe('passed');
    expect(s.flaky).toBe(true);
    expect(s.summary).toContain('flaky');
  });

  it('passes with a warning when only an advisory stage failed', () => {
    const s = summariseVerification(
      plan(['command:test', true], ['regression-test', false]),
      [
        finished({ strategy: 'command:test', outcome: 'passed' }),
        finished({ strategy: 'regression-test', outcome: 'failed' }),
      ],
    );
    expect(s.verdict).toBe('passed');
    expect(s.summary).toContain('1 advisory check failed');
  });

  it('ignores a stage that is still running', () => {
    const s = summariseVerification(plan(['command:test', true]), [{ strategy: 'command:test', state: 'running', startedAt: 0 }]);
    expect(s.verdict).toBe('unverified');
  });
});

describe('verificationBadge', () => {
  const badgeFor = (results: VerificationResult[], stages: VerificationPlan['stages']) =>
    verificationBadge(summariseVerification({ stages }, results));

  it('ticks a pass, crosses a failure and marks a flake', () => {
    const required = [{ strategy: 'command:test', required: true }];
    expect(badgeFor([finished({ strategy: 'command:test', outcome: 'passed' })], required)).toMatchObject({ glyph: '✓', text: 'verified' });
    expect(badgeFor([finished({ strategy: 'command:test', outcome: 'failed' })], required)).toMatchObject({ glyph: '✗', text: 'failed' });
    expect(badgeFor([finished({ strategy: 'command:test', outcome: 'passed', flaky: true })], required)).toMatchObject({ glyph: '~', text: 'flaky' });
    expect(badgeFor([], [])).toMatchObject({ glyph: '?', text: 'unverified' });
  });
});

describe('stageLine', () => {
  it('says what happened, and why it is not being blamed when it is not', () => {
    expect(stageLine(finished({ strategy: 'command:test', outcome: 'inconclusive', preExisting: true, durationMs: 90_000 })))
      .toBe('command:test · inconclusive · base is red · 1m');
    expect(stageLine({ strategy: 'command:test', state: 'running', startedAt: 0 })).toBe('command:test · running');
  });
});
