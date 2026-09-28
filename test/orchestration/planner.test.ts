/**
 * The planner (#44, plan §11): the validator's tables, and simulated planner
 * outputs through the real structured completion — valid, cyclic,
 * over-decomposed, over-sized and invalid JSON — with the one repair round.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { validateJson } from '../../src/orchestration/completion/jsonSchema';
import {
  PLAN_SCHEMA,
  Planner,
  checkPlan,
  checkPlannerAnswer,
  normalisePlan,
  plannerInput,
  repairInput,
  type PlanCheckContext,
  type PlannedTask,
  type PlannerOutput,
} from '../../src/orchestration/policy/planner';

const CTX: PlanCheckContext = { cap: 8, strategies: ['typecheck', 'test'] };

function task(key: string, over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    key,
    title: `Task ${key}`,
    objective: `Synthetic objective for ${key}.`,
    acceptanceCriteria: [`${key} works`],
    scope: { paths: [`src/${key}/**`], subsystems: [key] },
    dependsOn: [],
    verification: ['test'],
    assessmentHints: { kind: 'feature', complexity: 'involved', risk: 'low' },
    whySeparate: `${key} is its own subsystem, checked by its own tests`,
    ...over,
  };
}

function plan(tasks: PlannedTask[], over: Partial<PlannerOutput> = {}): PlannerOutput {
  return { decomposition: tasks.length > 1 ? 'multiple' : 'single', risks: [], tasks, ...over };
}

const single = plan([task('t1', { whySeparate: '' })]);

describe('checkPlan: hard problems (§11.2)', () => {
  const cases: [string, PlannerOutput, PlanCheckContext, RegExp][] = [
    ['more tasks than the cap', plan(['t1', 't2', 't3'].map((k) => task(k))), { ...CTX, cap: 2 }, /3 tasks, more than the cap of 2/],
    ['a cycle, shown as its path', plan([task('t1', { dependsOn: [{ key: 't2', kind: 'code' }] }), task('t2', { dependsOn: [{ key: 't1', kind: 'code' }] })]), CTX, /dependency cycle: t1 → t2 → t1/],
    ['a self edge', plan([task('t1', { dependsOn: [{ key: 't1', kind: 'order' }] }), task('t2')]), CTX, /t1 depends on itself/],
    ['a dangling edge', plan([task('t1'), task('t2', { dependsOn: [{ key: 't9', kind: 'code' }] })]), CTX, /t2 depends on t9, which is not in the plan/],
    ['a duplicate edge', plan([task('t1'), task('t2', { dependsOn: [{ key: 't1', kind: 'code' }, { key: 't1', kind: 'order' }] })]), CTX, /t2 depends on t1 twice/],
    ['a key used twice', plan([task('t1'), task('t1', { scope: { paths: ['lib/**'], subsystems: [] } })]), CTX, /task key t1 is used twice/],
    ['no acceptance criteria', plan([task('t1', { acceptanceCriteria: ['  '], whySeparate: '' })]), CTX, /t1 has no acceptance criteria/],
    ['an unknown verification strategy', plan([task('t1', { verification: ['lint'], whySeparate: '' })]), CTX, /t1 names verification "lint", which the repository's policy does not define \(it has: typecheck, test\)/],
    ['a strategy when the policy has none', plan([task('t1', { verification: ['test'], whySeparate: '' })]), { ...CTX, strategies: [] }, /it defines none/],
    ['an absolute path', plan([task('t1', { scope: { paths: ['/etc/passwd'], subsystems: [] }, whySeparate: '' })]), CTX, /scope path \/etc\/passwd is not inside the repository/],
    ['a path climbing out', plan([task('t1', { scope: { paths: ['../other/**'], subsystems: [] }, whySeparate: '' })]), CTX, /scope path \.\.\/other\/\*\* is not inside/],
    ['a home path', plan([task('t1', { scope: { paths: ['~/x'], subsystems: [] }, whySeparate: '' })]), CTX, /not inside the repository/],
    ['a split with no reason', plan([task('t1'), task('t2', { whySeparate: ' ' })]), CTX, /t2 does not say why it is a separate task/],
    ['"single" with several tasks', plan([task('t1'), task('t2')], { decomposition: 'single' }), CTX, /decomposition is "single" but the plan has 2 tasks/],
    ['no tasks', plan([]), CTX, /the plan has no tasks/],
  ];
  it.each(cases)('%s', (_name, p, ctx, want) => {
    const c = checkPlan(p, ctx);
    expect(c.problems.join('\n')).toMatch(want);
  });

  it('a valid single-task plan has no problems and no advice', () => {
    expect(checkPlan(single, CTX)).toEqual({ problems: [], advice: [] });
  });

  it('a valid split: disjoint scopes, each checkable, each with a reason', () => {
    const p = plan([task('t1'), task('t2', { dependsOn: [{ key: 't1', kind: 'code' }], scope: { paths: ['lib/**'], subsystems: ['lib'] } })]);
    expect(checkPlan(p, CTX)).toEqual({ problems: [], advice: [] });
  });

  it('`command:<name>` and `<name>` both name a policy command', () => {
    expect(checkPlan(plan([task('t1', { verification: ['command:typecheck', 'test'], whySeparate: '' })]), CTX).problems).toEqual([]);
  });
});

describe('checkPlan: when not to split (§11.3) is advice', () => {
  it('overlapping scopes with no order between them', () => {
    const p = plan([task('t1', { scope: { paths: ['src/**'], subsystems: [] } }), task('t2', { scope: { paths: ['src/a.ts'], subsystems: [] } })]);
    const c = checkPlan(p, CTX);
    expect(c.problems).toEqual([]);
    expect(c.advice.join('\n')).toMatch(/t1 and t2 may touch the same files \(src\/\*\*\) with no order between them/);
  });

  it('a strict chain over the same files is one task', () => {
    const shared = { paths: ['src/parser/**'], subsystems: ['parser'] };
    const p = plan([
      task('t1', { scope: shared }),
      task('t2', { scope: shared, dependsOn: [{ key: 't1', kind: 'code' }] }),
      task('t3', { scope: shared, dependsOn: [{ key: 't2', kind: 'code' }] }),
    ]);
    const c = checkPlan(p, CTX);
    expect(c.problems).toEqual([]);
    expect(c.advice.join('\n')).toMatch(/t1 → t2 → t3 is a strictly sequential chain over the same files: make it one task/);
  });

  it('a trivial task and a docs follow-up fold into their neighbours', () => {
    const p = plan([
      task('t1'),
      task('t2', { scope: { paths: ['lib/**'], subsystems: [] }, assessmentHints: { kind: 'chore', complexity: 'trivial', risk: 'low' } }),
      task('t3', { scope: { paths: ['docs/**'], subsystems: [] }, dependsOn: [{ key: 't1', kind: 'order' }], assessmentHints: { kind: 'docs', complexity: 'routine', risk: 'low' } }),
    ]);
    const advice = checkPlan(p, CTX).advice.join('\n');
    expect(advice).toMatch(/t2 is trivial, not worth an agent's start-up/);
    expect(advice).toMatch(/t3 is a docs follow-up of t1: mechanical follow-ups belong to the task that makes them necessary/);
  });

  it('a single task is never advised against', () => {
    expect(checkPlan(plan([task('t1', { whySeparate: '', assessmentHints: { kind: 'docs', complexity: 'trivial', risk: 'low' } })]), CTX).advice).toEqual([]);
  });
});

describe('checkPlan: a replan (§11.4)', () => {
  const kept: PlanCheckContext['kept'] = [
    { key: 't1', state: 'done' },
    { key: 't2', state: 'skipped' },
  ];
  it('may depend on a done task that stays', () => {
    const p = plan([task('n1', { dependsOn: [{ key: 't1', kind: 'code' }], whySeparate: '' })]);
    expect(checkPlan(p, { ...CTX, kept }).problems).toEqual([]);
  });
  it('may not depend on a task it sets aside, nor reuse a key that stays', () => {
    const p = plan([task('t1', { whySeparate: '' }), task('n2', { dependsOn: [{ key: 't2', kind: 'code' }] })]);
    const problems = checkPlan(p, { ...CTX, kept }).problems.join('\n');
    expect(problems).toMatch(/task key t1 is already taken by a task that stays/);
    expect(problems).toMatch(/n2 depends on t2, which the replan sets aside/);
  });
});

describe('the schema', () => {
  it('accepts a well-formed plan and refuses anything that could carry a command or a model', () => {
    expect(validateJson(PLAN_SCHEMA, single)).toEqual([]);
    const smuggled = { ...single, tasks: [{ ...single.tasks[0], command: 'rm -rf /', model: 'opus' }] };
    expect(validateJson(PLAN_SCHEMA, smuggled).join('\n')).toMatch(/command|model/);
    expect(validateJson(PLAN_SCHEMA, { ...single, permissionMode: 'bypassPermissions' }).length).toBeGreaterThan(0);
    expect(checkPlannerAnswer({ tasks: 'none' }, CTX).problems[0]).toMatch(/does not match the schema/);
  });

  it('normalises: trimmed, blanks dropped, `command:` stripped, decomposition from the count', () => {
    const n = normalisePlan(plan([task(' t1 ', { acceptanceCriteria: [' a ', ''], verification: ['command:test', 'test'], whySeparate: '' })], { decomposition: 'multiple' }));
    expect(n.decomposition).toBe('single');
    expect(n.tasks[0]).toMatchObject({ key: 't1', acceptanceCriteria: ['a'], verification: ['test'] });
  });
});

describe('the input', () => {
  it('says what can verify, the cap, and for a replan what is done, replaced and dropped', () => {
    const text = plannerInput({
      objective: 'Synthetic objective.',
      strategies: ['test'],
      cap: 3,
      note: 'Synthetic note.',
      replan: {
        done: [{ key: 't1', title: 'Done one', objective: 'Did it.', scopePaths: ['src/a/**'] }],
        replaced: [{ key: 't2', title: 'Failed one', objective: 'Tried it.', state: 'needs-human', evidence: ['attempt 1: succeeded; command:test failed: 1 failing'] }],
        notStarted: [{ key: 't3', title: 'Never ran' }],
      },
    });
    expect(text).toContain('<objective>\nSynthetic objective.\n</objective>');
    expect(text).toContain('Verification commands this repository defines (name them, never a command line): test.');
    expect(text).toContain('At most 3 tasks.');
    expect(text).toMatch(/<done_tasks>\nt1: Done one/);
    expect(text).toMatch(/<replaced_tasks>\nt2: Failed one \(needs-human\)[\s\S]*command:test failed/);
    expect(text).toMatch(/<dropped_tasks>\nt3: Never ran/);
    expect(text).toContain('<user_note>\nSynthetic note.\n</user_note>');
  });

  it('a delegation’s criteria are the user’s, for the whole objective (#82)', () => {
    const text = plannerInput({ objective: 'Synthetic objective.', acceptanceCriteria: ['Synthetic check passes', ' '], strategies: [], cap: 8 });
    expect(text).toContain('each one must be among some task’s criteria');
    expect(text).toContain('<acceptance_criteria>\n- Synthetic check passes\n</acceptance_criteria>');
    expect(plannerInput({ objective: 'Synthetic objective.', strategies: [], cap: 8 })).not.toContain('acceptance_criteria');
  });

  it('the repair input carries the previous plan and every problem', () => {
    const text = repairInput('FIRST', single, { problems: ['dependency cycle: t1 → t2 → t1'], advice: ['t3 is trivial'] });
    expect(text.startsWith('FIRST')).toBe(true);
    expect(text).toContain('<previous_plan>');
    expect(text).toContain('- dependency cycle: t1 → t2 → t1');
    expect(text).toContain('- (advice) t3 is trivial');
  });
});

describe('Planner over simulated outputs', () => {
  const req = { objective: 'Synthetic objective.', cwd: '/Users/test/proj', strategies: ['typecheck', 'test'], cap: 8 };
  const cyclic = plan([task('t1', { dependsOn: [{ key: 't2', kind: 'code' }] }), task('t2', { dependsOn: [{ key: 't1', kind: 'code' }] })]);
  const overSplit = plan([
    task('t1', { scope: { paths: ['src/**'], subsystems: [] } }),
    task('t2', { scope: { paths: ['src/x.ts'], subsystems: [] } }),
  ]);

  it('a valid plan is accepted in one round, read-only, in the checkout, on the expert model', async () => {
    const completion = new SimulatedCompletion([{ output: single, usage: { in: 900, out: 120 }, costUsd: 0.2 }]);
    const r = await new Planner({ completion }).plan(req);
    expect(r).toMatchObject({ ok: true, warnings: [], plan: { decomposition: 'single', tasks: [{ key: 't1' }] } });
    expect(r.rounds).toEqual([expect.objectContaining({ n: 1, ok: true, problems: [], costUsd: 0.2, inputTokens: 900, outputTokens: 120 })]);
    const opts = completion.calls[0].options;
    expect(opts).toMatchObject({ cwd: '/Users/test/proj', model: 'opus', effort: 'high', permissionMode: 'plan', tools: ['Read', 'Grep', 'Glob'], persistSession: false, settingSources: [] });
    expect(opts.maxTurns).toBeGreaterThan(16);
  });

  it('a cyclic plan gets one repair round with the cycle named, and a fixed answer is accepted', async () => {
    const completion = new SimulatedCompletion([{ output: cyclic }, { output: plan([task('t1'), task('t2', { dependsOn: [{ key: 't1', kind: 'code' }], scope: { paths: ['lib/**'], subsystems: [] } })]) }]);
    const r = await new Planner({ completion }).plan(req);
    expect(r.ok).toBe(true);
    expect(r.rounds.map((x) => [x.n, x.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(completion.calls[1].prompt).toContain('- dependency cycle: t1 → t2 → t1');
  });

  it('a cyclic plan twice is planning-failed, with the reason', async () => {
    const completion = new SimulatedCompletion([{ output: cyclic }, { output: cyclic }]);
    const r = await new Planner({ completion }).plan(req);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^the plan was still not valid after one repair: dependency cycle: t1 → t2 → t1/);
    expect(r.rounds).toHaveLength(2);
    expect(completion.calls).toHaveLength(2);
  });

  it('an over-sized plan is repaired or refused', async () => {
    const big = plan(['t1', 't2', 't3'].map((k, i) => task(k, { scope: { paths: [`p${i}/**`], subsystems: [] } })));
    const refused = await new Planner({ completion: new SimulatedCompletion([{ output: big }, { output: big }]) }).plan({ ...req, cap: 2 });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/3 tasks, more than the cap of 2/) });
    const fixed = await new Planner({ completion: new SimulatedCompletion([{ output: big }, { output: single }]) }).plan({ ...req, cap: 2 });
    expect(fixed).toMatchObject({ ok: true, plan: { tasks: [{ key: 't1' }] } });
  });

  it('an over-decomposed plan gets the repair round; merged, it is accepted clean', async () => {
    const completion = new SimulatedCompletion([{ output: overSplit }, { output: single }]);
    const r = await new Planner({ completion }).plan(req);
    expect(r).toMatchObject({ ok: true, warnings: [], plan: { decomposition: 'single' } });
    expect(completion.calls[1].prompt).toMatch(/\(advice\) t1 and t2 may touch the same files/);
  });

  it('an over-decomposed plan still over-decomposed after repair is kept, with warnings for review', async () => {
    const r = await new Planner({ completion: new SimulatedCompletion([{ output: overSplit }, { output: overSplit }]) }).plan(req);
    expect(r).toMatchObject({ ok: true, plan: { tasks: [{ key: 't1' }, { key: 't2' }] } });
    if (r.ok) expect(r.warnings.join('\n')).toMatch(/may touch the same files/);
  });

  it('advice-only first answer stands when the repair breaks something hard', async () => {
    const r = await new Planner({ completion: new SimulatedCompletion([{ output: overSplit }, { output: cyclic }]) }).plan(req);
    expect(r).toMatchObject({ ok: true, plan: { tasks: [{ key: 't1' }, { key: 't2' }] } });
    if (r.ok) expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('invalid JSON: the completion’s own retry is the repair round, then planning-failed', async () => {
    const completion = new SimulatedCompletion([{ raw: 'not json at all' }, { raw: 'still not json' }]);
    const r = await new Planner({ completion }).plan(req);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/the planner could not answer: its answer was not a valid plan, twice/) });
    expect(completion.calls).toHaveLength(2);
  });

  it('an API error fails at once; no completion fails saying so; neither throws', async () => {
    const r = await new Planner({ completion: new SimulatedCompletion([{ error: 'overloaded' }]) }).plan(req);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^the planner could not answer: API Error: 529/) });
    expect(await new Planner({}).plan(req)).toMatchObject({ ok: false, reason: 'no way to reach a planner model is configured' });
  });

  it('an abort ends it as aborted', async () => {
    const abort = new AbortController();
    const p = new Planner({ completion: new SimulatedCompletion([{ hang: true }]) }).plan({ ...req, signal: abort.signal });
    abort.abort();
    expect(await p).toMatchObject({ ok: false, aborted: true });
  });
});
