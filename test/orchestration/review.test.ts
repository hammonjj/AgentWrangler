/**
 * The review-agent verifier (#36): its verdict schema, how a verdict is
 * repaired and read, when the stage runs, and what it does to a task's
 * verification — with simulated reviewer output (valid, invalid, all unclear).
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { validateJson } from '../../src/orchestration/completion/jsonSchema';
import { READ_ONLY_TOOLS, workspaceToolDecision } from '../../src/orchestration/completion/structuredCompletion';
import { reviewViewOf } from '../../src/orchestration/view/taskViews';
import { REVIEW_SCHEMA, Reviewer, MAX_DIFF_CHARS, reviewInput } from '../../src/orchestration/verify/reviewer';
import { Verifier } from '../../src/orchestration/verify/verifier';
import { DEFAULT_REPO_POLICY, resolveRepoPolicy, validateRepoPolicyFile, type RepoPolicy } from '../../src/shared/orchestration/repoPolicy';
import { reviewHeadText } from '../../src/shared/orchestration/taskView';
import type { ReviewVerdict, VerificationPlan, WorktreeAssignment } from '../../src/shared/orchestration/types';
import {
  buildVerificationPlan,
  normaliseReview,
  reviewOutcome,
  stageApplies,
  stageLine,
  summariseVerification,
} from '../../src/shared/orchestration/verification';
import { task } from './fixtures';

const CRITERIA = ['the button is labelled Save', 'the setting is documented in the README', 'no new dependency'];

function verdictOf(...vs: ('met' | 'unmet' | 'unclear')[]): ReviewVerdict {
  return { criteria: vs.map((v, i) => ({ id: `c${i + 1}`, verdict: v, why: `why ${i + 1}` })), concerns: [], model: 'claude-sonnet-4-5' };
}

function answer(...vs: ('met' | 'unmet' | 'unclear')[]) {
  return { criteria: vs.map((v, i) => ({ id: `c${i + 1}`, verdict: v, why: `why ${i + 1}` })), concerns: [] as string[] };
}

function policy(review: Partial<RepoPolicy['review']> = {}, commands: RepoPolicy['verification']['commands'] = { test: { run: ['npm', 'test'], timeoutSec: 60 } }): RepoPolicy {
  return {
    ...DEFAULT_REPO_POLICY,
    verification: { commands, missionDefault: [] },
    review: { ...DEFAULT_REPO_POLICY.review, ...review },
  };
}

describe('the verdict schema', () => {
  it('accepts a verdict per criterion with concerns', () => {
    expect(validateJson(REVIEW_SCHEMA, { ...answer('met', 'unclear'), concerns: ['a bug'] })).toEqual([]);
  });

  it.each([
    ['an unknown verdict', { criteria: [{ id: 'c1', verdict: 'maybe', why: 'x' }], concerns: [] }],
    ['a criterion with no reason', { criteria: [{ id: 'c1', verdict: 'met' }], concerns: [] }],
    ['no concerns field', { criteria: [] }],
    ['an extra field', { ...answer('met'), score: 3 }],
    ['concerns that are not strings', { criteria: [], concerns: [1] }],
  ])('rejects %s', (_label, value) => {
    expect(validateJson(REVIEW_SCHEMA, value).length).toBeGreaterThan(0);
  });
});

describe('normaliseReview', () => {
  it('keeps a complete, well-formed answer as it is, in the task’s order', () => {
    const n = normaliseReview(3, { criteria: [answer('met', 'unmet', 'unclear').criteria[2], ...answer('met', 'unmet').criteria], concerns: [] });
    expect(n.criteria.map((c) => [c.id, c.verdict])).toEqual([
      ['c1', 'met'],
      ['c2', 'unmet'],
      ['c3', 'unclear'],
    ]);
    expect(n.repaired).toBe(0);
  });

  it('reads a criterion the reviewer skipped as unclear, and counts the repair', () => {
    const n = normaliseReview(3, answer('met'));
    expect(n.criteria.map((c) => c.verdict)).toEqual(['met', 'unclear', 'unclear']);
    expect(n.criteria[1].why).toMatch(/no verdict/);
    expect(n.repaired).toBe(2);
  });

  it('keeps the first of two answers for one criterion, and drops ids that name none', () => {
    const n = normaliseReview(1, {
      criteria: [
        { id: 'C1', verdict: 'met', why: 'first' },
        { id: 'c1', verdict: 'unmet', why: 'second' },
        { id: 'c9', verdict: 'unmet', why: 'nothing' },
      ],
      concerns: [],
    });
    expect(n.criteria).toEqual([{ id: 'c1', verdict: 'met', why: 'first' }]);
    expect(n.repaired).toBe(2);
  });

  it('trims and caps concerns, and drops empty ones', () => {
    const n = normaliseReview(0, { criteria: [], concerns: ['  a  ', '', ...Array.from({ length: 20 }, (_, i) => `c${i}`)] });
    expect(n.concerns[0]).toBe('a');
    expect(n.concerns).toHaveLength(10);
  });
});

describe('reviewOutcome', () => {
  it('passes only when every criterion is met', () => {
    expect(reviewOutcome(verdictOf('met', 'met')).outcome).toBe('passed');
  });

  it('fails on any unmet criterion, naming it', () => {
    const o = reviewOutcome(verdictOf('met', 'unmet', 'unclear'));
    expect(o.outcome).toBe('failed');
    expect(o.summary).toContain('c2');
  });

  it('is inconclusive when nothing is unmet but something is unclear — including all of it', () => {
    expect(reviewOutcome(verdictOf('met', 'unclear')).outcome).toBe('inconclusive');
    expect(reviewOutcome(verdictOf('unclear', 'unclear', 'unclear'))).toMatchObject({ outcome: 'inconclusive', summary: expect.stringContaining('3 of 3') });
  });
});

describe('the review stage in a plan', () => {
  it('is advisory and gated on the assessment by default', () => {
    const plan = buildVerificationPlan({ kind: 'feature', policy: policy(), criteria: 2 });
    expect(plan.stages.at(-1)).toEqual({ strategy: 'review', required: false, timeoutSec: 600, onlyIf: 'risky-or-weakly-verified' });
  });

  it('is left out of a task with no acceptance criteria, and when the policy says never', () => {
    expect(buildVerificationPlan({ kind: 'feature', policy: policy(), criteria: 0 }).stages.some((s) => s.strategy === 'review')).toBe(false);
    expect(buildVerificationPlan({ kind: 'feature', policy: policy({ when: 'never' }), criteria: 2 }).stages.some((s) => s.strategy === 'review')).toBe(false);
  });

  it('runs on every task under always', () => {
    const plan = buildVerificationPlan({ kind: 'feature', policy: policy({ when: 'always' }), criteria: 2 });
    expect(plan.stages.at(-1)).toEqual({ strategy: 'review', required: false, timeoutSec: 600 });
  });

  it('is required, and ungated, for a kind the policy lists — even under never', () => {
    const plan = buildVerificationPlan({ kind: 'migration', policy: policy({ when: 'never', requiredFor: ['migration'] }), criteria: 1 });
    expect(plan.stages.at(-1)).toEqual({ strategy: 'review', required: true, timeoutSec: 600 });
  });

  it('comes after the commands and before a human approval', () => {
    const plan = buildVerificationPlan({ kind: 'bugfix', policy: policy(), criteria: 1, requireHuman: true });
    expect(plan.stages.map((s) => s.strategy)).toEqual(['diff-sanity', 'command:test', 'regression-test', 'review', 'human']);
  });
});

describe('stageApplies', () => {
  const gated = { strategy: 'review', required: false, onlyIf: 'risky-or-weakly-verified' as const };

  it.each([
    ['low', 'strong', false],
    ['low', 'partial', false],
    ['low', 'weak', true],
    ['low', 'none', true],
    ['moderate', 'strong', true],
    ['critical', 'partial', true],
  ] as const)('risk %s, verifiability %s → %s', (risk, verifiability, runs) => {
    expect(stageApplies(gated, { risk, verifiability })).toBe(runs);
  });

  it('runs an unassessed task, and any stage with no condition', () => {
    expect(stageApplies(gated, undefined)).toBe(true);
    expect(stageApplies({ strategy: 'review', required: false }, { risk: 'low', verifiability: 'strong' })).toBe(true);
  });
});

describe('the review policy', () => {
  it('validates when and requiredFor', () => {
    expect(validateRepoPolicyFile({ review: { when: 'always', requiredFor: ['migration'] } }).ok).toBe(true);
    const bad = validateRepoPolicyFile({ review: { when: 'sometimes', requiredFor: ['nonsense'], extra: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.path).sort()).toEqual(['review.extra', 'review.requiredFor[0]', 'review.when']);
  });

  it('defaults to auto and advisory, and layers field by field', () => {
    expect(DEFAULT_REPO_POLICY.review).toEqual({ when: 'auto', requiredFor: [] });
    const r = resolveRepoPolicy([{ review: { requiredFor: ['migration', 'migration'] } }, { review: { when: 'always' } }]);
    expect(r.ok && r.policy.review).toEqual({ when: 'always', requiredFor: ['migration'] });
  });
});

describe('Reviewer', () => {
  const req = { task: task('t1', { acceptanceCriteria: CRITERIA, kindHint: 'feature' }), diff: '+const a = 1;\n', cwd: '/Users/test/proj-wt' };

  it('returns a normalised verdict with the model and its cost from a valid answer', async () => {
    const completion = new SimulatedCompletion([{ output: { ...answer('met', 'unmet', 'unclear'), concerns: ['no test'] }, costUsd: 0.03 }]);
    const r = await new Reviewer({ completion }).review(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.criteria.map((c) => c.verdict)).toEqual(['met', 'unmet', 'unclear']);
    expect(r.verdict.concerns).toEqual(['no test']);
    expect(r.verdict.usage?.costUsd).toBe(0.03);
    expect(r.verdict.model).toBe('sonnet');
    // Read-only, in the worktree, in plan mode.
    const o = completion.calls[0].options;
    expect(o).toMatchObject({ cwd: '/Users/test/proj-wt', tools: [...READ_ONLY_TOOLS], permissionMode: 'plan' });
    expect(o.maxTurns).toBeGreaterThan(1);
  });

  it('reports invalid output, after the retry, as a failure to answer', async () => {
    const r = await new Reviewer({ completion: new SimulatedCompletion([{ raw: 'looks fine to me' }, { output: { criteria: 'all good' } }]) }).review(req);
    expect(r).toMatchObject({ ok: false, reason: 'invalid-output' });
  });

  it('reads an all-unclear answer as it is', async () => {
    const r = await new Reviewer({ completion: new SimulatedCompletion([{ output: answer('unclear', 'unclear', 'unclear') }]) }).review(req);
    expect(r.ok && reviewOutcome(r.verdict).outcome).toBe('inconclusive');
  });

  it('says so when there is no completion to ask', async () => {
    expect(await new Reviewer({}).review(req)).toMatchObject({ ok: false, reason: 'no-completion' });
  });

  it('frames the task as data, numbers the criteria, and cuts a huge diff', () => {
    const input = reviewInput({ task: req.task, diff: 'x'.repeat(MAX_DIFF_CHARS + 10) });
    expect(input).toContain('c2: the setting is documented in the README');
    expect(input).toContain('<diff>');
    expect(input).toContain('diff cut at');
    expect(input.length).toBeLessThan(MAX_DIFF_CHARS + 1000);
  });
});

describe('workspace tools', () => {
  const root = '/Users/test/proj-wt';

  it('allows reads inside the worktree, and a search with no path', () => {
    expect(workspaceToolDecision(root, 'Read', { file_path: path.join(root, 'src/a.ts') }).behavior).toBe('allow');
    expect(workspaceToolDecision(root, 'Grep', { pattern: 'x' }).behavior).toBe('allow');
    expect(workspaceToolDecision(root, 'Glob', { pattern: '**/*.ts', path: 'src' }).behavior).toBe('allow');
  });

  it('refuses anything outside it, and any tool that is not read-only', () => {
    expect(workspaceToolDecision(root, 'Read', { file_path: '/Users/test/.ssh/id_rsa' }).behavior).toBe('deny');
    expect(workspaceToolDecision(root, 'Read', { file_path: '../proj/secret' }).behavior).toBe('deny');
    expect(workspaceToolDecision(root, 'Read', { file_path: `${root}-other/a.ts` }).behavior).toBe('deny');
    expect(workspaceToolDecision(root, 'Bash', { command: 'ls' }).behavior).toBe('deny');
    expect(workspaceToolDecision(root, 'Edit', { file_path: path.join(root, 'a.ts') }).behavior).toBe('deny');
  });
});

describe('the review stage in the verifier', () => {
  const wt = { id: 'w1', path: '/Users/test/proj-wt', branch: 'aw/x', baseCommit: 'abc' } as WorktreeAssignment;

  function run(opts: {
    plan: VerificationPlan;
    responses?: ConstructorParameters<typeof SimulatedCompletion>[0];
    reviewer?: boolean;
    assessment?: { risk: 'low' | 'moderate'; verifiability: 'strong' | 'weak' };
    criteria?: string[];
  }) {
    const completion = new SimulatedCompletion(opts.responses ?? []);
    const v = new Verifier({
      exec: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
      logsDir: '/nonexistent/aw-logs',
      diffText: async () => '+++ b/src/a.ts\n+const a = 1;\n',
      changedFiles: async () => [{ file: 'src/a.ts', insertions: 1, deletions: 0 }],
      ...(opts.reviewer === false ? {} : { reviewer: new Reviewer({ completion }) }),
    });
    const t = task('t1', { acceptanceCriteria: opts.criteria ?? CRITERIA, kindHint: 'feature', verification: opts.plan });
    return {
      completion,
      results: v.run(opts.plan, { attemptId: 'a1', task: t, policy: policy(), worktree: wt, ...(opts.assessment ? { assessment: opts.assessment } : {}) }),
    };
  }

  const advisory: VerificationPlan = {
    stages: [
      { strategy: 'command:test', required: true },
      { strategy: 'review', required: false, onlyIf: 'risky-or-weakly-verified' },
    ],
  };
  const required: VerificationPlan = {
    stages: [
      { strategy: 'command:test', required: true },
      { strategy: 'review', required: true },
    ],
  };

  it('an advisory unmet verdict is recorded, and the task still passes with a warning', async () => {
    const { results } = run({ plan: advisory, responses: [{ output: answer('met', 'unmet', 'met') }] });
    const rs = await results;
    const review = rs.find((r) => r.strategy === 'review')!;
    expect(review).toMatchObject({ outcome: 'failed', evidence: { failing: ['c2'], signature: 'review:c2' } });
    expect(review.review?.criteria).toHaveLength(3);
    expect(stageLine(review)).toContain('2 met, 1 unmet');
    const s = summariseVerification(advisory, rs);
    expect(s.verdict).toBe('passed');
    expect(s.summary).toContain('advisory');
  });

  it('an unclear verdict on a required review is inconclusive, not passed', async () => {
    const { results } = run({ plan: required, responses: [{ output: answer('met', 'unclear', 'met') }] });
    const s = summariseVerification(required, await results);
    expect(s.verdict).toBe('inconclusive');
    expect(s.summary).toContain('c2');
  });

  it('an unmet verdict on a required review fails the task', async () => {
    const { results } = run({ plan: required, responses: [{ output: answer('unmet', 'met', 'met') }] });
    expect(summariseVerification(required, await results)).toMatchObject({ verdict: 'failed', signature: 'review:c1' });
  });

  it('a reviewer that cannot answer is an error, which only a required review lets matter', async () => {
    const bad = [{ raw: 'nope' }, { raw: 'still nope' }];
    const a = await run({ plan: advisory, responses: bad }).results;
    expect(a.find((r) => r.strategy === 'review')).toMatchObject({ outcome: 'error', evidence: { signature: 'review:invalid-output' } });
    expect(summariseVerification(advisory, a).verdict).toBe('passed');
    expect(summariseVerification(required, await run({ plan: required, responses: bad }).results).verdict).toBe('error');
  });

  it('is skipped, without asking anyone, for a low-risk, well-verified task', async () => {
    const { results, completion } = run({ plan: advisory, assessment: { risk: 'low', verifiability: 'strong' } });
    const review = (await results).find((r) => r.strategy === 'review')!;
    expect(review).toMatchObject({ outcome: 'unavailable', skipped: true });
    expect(stageLine(review)).toContain('skipped');
    expect(completion.calls).toHaveLength(0);
  });

  it('runs for a risky task', async () => {
    const { results, completion } = run({ plan: advisory, assessment: { risk: 'moderate', verifiability: 'strong' }, responses: [{ output: answer('met', 'met', 'met') }] });
    expect((await results).find((r) => r.strategy === 'review')?.outcome).toBe('passed');
    expect(completion.calls).toHaveLength(1);
  });

  it('with no reviewer, is unavailable when advisory and inconclusive when required', async () => {
    expect((await run({ plan: advisory, reviewer: false }).results).find((r) => r.strategy === 'review')?.outcome).toBe('unavailable');
    const req = await run({ plan: required, reviewer: false }).results;
    expect(summariseVerification(required, req).verdict).toBe('inconclusive');
  });

  it('never counts as verification by itself: every criterion met in a repo with no commands is still unverified', async () => {
    const plan: VerificationPlan = { stages: [{ strategy: 'review', required: true }] };
    const rs = await run({ plan, responses: [{ output: answer('met', 'met', 'met') }] }).results;
    expect(rs[0].outcome).toBe('passed');
    expect(summariseVerification(plan, rs).verdict).toBe('unverified');
  });
});

describe('the strip’s review view', () => {
  it('pairs each verdict with the criterion’s own text, and says whether it is required', () => {
    const t = task('t1', { acceptanceCriteria: CRITERIA, verification: { stages: [{ strategy: 'review', required: true }] } });
    const v = reviewViewOf(t, [
      { strategy: 'review', state: 'finished', outcome: 'failed', startedAt: 0, review: { ...verdictOf('met', 'unmet', 'unclear'), concerns: ['x'], usage: { costUsd: 0.12 } } },
    ])!;
    expect(v.required).toBe(true);
    expect(v.criteria.map((c) => [c.text, c.verdict])).toEqual([
      [CRITERIA[0], 'met'],
      [CRITERIA[1], 'unmet'],
      [CRITERIA[2], 'unclear'],
    ]);
    expect(v.concerns).toEqual(['x']);
    expect(reviewHeadText(v)).toMatch(/^Review \(required\) · .+ · \$0\.12$/);
  });

  it('is absent when no review reached a verdict', () => {
    expect(reviewViewOf(task('t1'), [{ strategy: 'review', state: 'finished', outcome: 'unavailable', startedAt: 0 }])).toBeUndefined();
  });
});
