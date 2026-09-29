/**
 * Warm-session assignment (#54, plan §22.1) as tables, then simulated chains:
 * which session a task's first attempt runs in, given its route requirement
 * and the warm sessions earlier tasks left. Plus the telemetry it leaves: the
 * assignment mode and the context at start on each attempt record.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseAssignment,
  contextCeilingFor,
  DEFAULT_CONTEXT_CEILING,
  tierWithin,
  type AssignmentInput,
  type WarmCandidate,
} from '../../src/orchestration/engine/assignment';
import { addTurnContext, assignmentModeOf, attemptRecord } from '../../src/orchestration/engine/attemptRecord';
import { attemptPrompt } from '../../src/orchestration/engine/attemptPolicy';
import { migrateMission } from '../../src/orchestration/store/migrations';
import { claudeRequestTokens, codexRequestTokens, foldRequest, requestContextOf, REQUEST_CONTEXT_KEY } from '../../src/core/telemetry/requestContext';
import { DEFAULT_TIERS } from '../../src/shared/orchestration/catalog';
import type { ExecutionAttempt, Mission, RoutingDecision, TierName } from '../../src/shared/orchestration/types';
import { attempt, mission, T0 } from './fixtures';

const TREE = 'wt-mission';

function warm(id: string, over: Partial<WarmCandidate> = {}): WarmCandidate {
  return {
    attemptId: `a-${id}`,
    taskId: id,
    taskKey: id,
    sessionId: `s-${id}`,
    harness: 'claude-code',
    source: 'anthropic',
    model: 'sonnet',
    tier: 'standard',
    treeId: TREE,
    idle: false,
    contextTokens: 40_000,
    endedAt: T0,
    ...over,
  };
}

function input(candidates: WarmCandidate[], over: Partial<AssignmentInput> = {}): AssignmentInput {
  return {
    requirement: { harness: 'claude-code', source: 'anthropic', model: 'sonnet', minTier: 'standard', maxTier: 'standard' },
    tiers: DEFAULT_TIERS,
    capabilities: { resume: true, fork: true },
    treeId: TREE,
    upstream: [],
    candidates,
    ...over,
  };
}

describe('chooseAssignment: tables', () => {
  it.each<[string, AssignmentInput, { mode: string; sessionId?: string; reason?: RegExp }]>([
    ['no candidates: cold', input([]), { mode: 'cold', reason: /no warm session/ }],
    ['a satisfying session on the same tree: reuse', input([warm('t1')]), { mode: 'reuse', sessionId: 's-t1', reason: /carries on t1's session in the same worktree/ }],
    [
      'a tier below the requirement: cold',
      input([warm('t1', { tier: 'basic' })]),
      { mode: 'cold', reason: /t1's session is basic; the route needs standard/ },
    ],
    [
      'a tier above the requirement: cold (reuse never overrides the route)',
      input([warm('t1', { tier: 'expert' })]),
      { mode: 'cold', reason: /is expert; the route needs standard/ },
    ],
    [
      'a tier inside [minTier, maxTier]: reuse',
      input([warm('t1', { tier: 'expert' })], { requirement: { harness: 'claude-code', source: 'anthropic', model: 'sonnet', minTier: 'standard', maxTier: 'expert' } }),
      { mode: 'reuse', sessionId: 's-t1' },
    ],
    [
      'a tier outside [minTier, maxTier]: cold',
      input([warm('t1', { tier: 'frontier' })], { requirement: { harness: 'claude-code', source: 'anthropic', model: 'sonnet', minTier: 'standard', maxTier: 'expert' } }),
      { mode: 'cold', reason: /the route needs standard–expert/ },
    ],
    ['another harness: cold', input([warm('t1', { harness: 'codex', source: 'openai' })]), { mode: 'cold', reason: /runs on codex; the route is claude-code/ }],
    ['another source: cold', input([warm('t1', { source: 'local:box' })]), { mode: 'cold', reason: /runs on local:box/ }],
    ['another model on the same tier: cold', input([warm('t1', { model: 'haiku' })]), { mode: 'cold', reason: /runs haiku; the route is sonnet/ }],
    ['a pin the session does not match: cold', input([warm('t1')], { pins: { model: 'opus' } }), { mode: 'cold' }],
    [
      'another lineage (a parallel tree), not upstream: cold',
      input([warm('t1', { treeId: 'wt-other' })]),
      { mode: 'cold', reason: /another worktree and is not upstream/ },
    ],
    [
      'another tree, upstream, fork allowed: fork',
      input([warm('t1', { treeId: 'wt-other' })], { upstream: ['t1'] }),
      { mode: 'fork', sessionId: 's-t1', reason: /forks t1's conversation into this task's worktree/ },
    ],
    [
      'another tree, upstream, harness cannot fork: cold',
      input([warm('t1', { treeId: 'wt-other' })], { upstream: ['t1'], capabilities: { resume: true, fork: false } }),
      { mode: 'cold', reason: /cannot fork into a new one/ },
    ],
    [
      'a new tree (none yet) and fork off: cold, never reuse across trees',
      input([warm('t1')], { treeId: undefined, upstream: ['t1'], capabilities: { resume: true, fork: false } }),
      { mode: 'cold' },
    ],
    [
      'above the context ceiling: cold',
      input([warm('t1', { contextTokens: DEFAULT_CONTEXT_CEILING + 1 })]),
      { mode: 'cold', reason: /above the ceiling/ },
    ],
    [
      'above half its window, though under the ceiling: cold',
      input([warm('t1', { contextTokens: 60_000, contextWindow: 100_000 })]),
      { mode: 'cold', reason: /above the ceiling of 50000/ },
    ],
    ['a lower ceiling given: cold', input([warm('t1', { contextTokens: 40_000 })], { contextCeiling: 30_000 }), { mode: 'cold' }],
    ['context not reported: reuse, and the reason says so', input([warm('t1', { contextTokens: undefined })]), { mode: 'reuse', reason: /context not reported/ }],
    [
      'not live and the harness cannot resume: cold',
      input([warm('t1', { idle: false })], { capabilities: { resume: false, fork: false } }),
      { mode: 'cold', reason: /cannot resume it/ },
    ],
    ['live and idle, though the harness cannot resume: reuse', input([warm('t1', { idle: true })], { capabilities: { resume: false, fork: false } }), { mode: 'reuse' }],
    [
      'an unordered tier matches only a requirement of exactly it',
      input([warm('t1', { tier: 'unassigned' })], { requirement: { harness: 'claude-code', source: 'anthropic', model: 'sonnet', minTier: 'unassigned', maxTier: 'unassigned' } }),
      { mode: 'reuse' },
    ],
  ])('%s', (_name, i, expected) => {
    const got = chooseAssignment(i);
    expect(got.mode).toBe(expected.mode);
    if (expected.sessionId) expect(got).toMatchObject({ sessionId: expected.sessionId });
    if (expected.reason) expect(got.reason).toMatch(expected.reason);
  });

  it('ranks reuse over fork, live over resumed, then the newest; a taken session is skipped', () => {
    const cands = [
      warm('t1', { treeId: 'wt-other', endedAt: T0 + 9 }),
      warm('t2', { endedAt: T0 + 1 }),
      warm('t3', { endedAt: T0 + 5 }),
      warm('t4', { endedAt: T0 + 2, idle: true }),
    ];
    const i = input(cands, { upstream: ['t1'] });
    expect(chooseAssignment(i)).toMatchObject({ mode: 'reuse', sessionId: 's-t4', fromAttemptId: 'a-t4' });
    expect(chooseAssignment(input(cands.slice(0, 3), { upstream: ['t1'] }))).toMatchObject({ mode: 'reuse', sessionId: 's-t3' });
    expect(chooseAssignment(i, new Set(['s-t4', 's-t3', 's-t2']))).toMatchObject({ mode: 'fork', sessionId: 's-t1' });
    expect(chooseAssignment(i, new Set(['s-t4', 's-t3', 's-t2', 's-t1']))).toMatchObject({ mode: 'cold', reason: /taken by another start/ });
  });

  it('one session, several attempts: the newest speaks for it', () => {
    // A → B reused A's session; for C the candidate is B's attempt, not A's.
    const got = chooseAssignment(input([warm('A', { sessionId: 's', endedAt: T0 }), warm('B', { sessionId: 's', endedAt: T0 + 10 })]));
    expect(got).toMatchObject({ mode: 'reuse', sessionId: 's', fromAttemptId: 'a-B' });
  });

  it('is deterministic: the order of the candidates does not matter', () => {
    const cands = [warm('t1', { endedAt: T0 + 3 }), warm('t2', { endedAt: T0 + 3 }), warm('t3', { endedAt: T0 + 3, contextTokens: 10_000 })];
    const a = chooseAssignment(input(cands));
    const b = chooseAssignment(input([...cands].reverse()));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ sessionId: 's-t3' });
  });

  it('never returns fork for a harness whose adapter cannot fork', () => {
    // Every shape of candidate, on a harness with fork off: reuse or cold, never fork.
    const trees = [TREE, 'wt-other', 'wt-third'];
    for (const treeId of [TREE, undefined, 'wt-new']) {
      for (const upstream of [[], ['t0', 't1', 't2']]) {
        const cands = trees.map((t, n) => warm(`t${n}`, { treeId: t, idle: n % 2 === 0 }));
        const got = chooseAssignment(input(cands, { treeId, upstream, capabilities: { resume: true, fork: false } }));
        expect(got.mode).not.toBe('fork');
      }
    }
  });

  it('tier and ceiling helpers', () => {
    expect(tierWithin(DEFAULT_TIERS, 'standard', 'basic', 'expert')).toBe(true);
    expect(tierWithin(DEFAULT_TIERS, 'frontier', 'basic', 'expert')).toBe(false);
    expect(tierWithin(DEFAULT_TIERS, 'mystery', 'basic', 'expert')).toBe(false);
    expect(contextCeilingFor({})).toBe(DEFAULT_CONTEXT_CEILING);
    expect(contextCeilingFor({ contextWindow: 1_000_000 })).toBe(DEFAULT_CONTEXT_CEILING);
    expect(contextCeilingFor({ contextWindow: 64_000 })).toBe(32_000);
  });
});

/**
 * A chain of tasks on one planned-mission tree, played through the
 * assignment the way the runner does it: each task's first attempt takes the
 * choice, and its session and context become the next task's candidate.
 */
function playChain(tasks: { key: string; tier: TierName; model?: string; addsContext: number }[], opts: { ceiling?: number } = {}) {
  const ran: { key: string; mode: string; sessionId: string; from?: string; contextAtStart?: number; reason: string }[] = [];
  let fresh = 0;
  for (const t of tasks) {
    const candidates: WarmCandidate[] = ran.map((r, n) => ({
      attemptId: `a-${r.key}`,
      taskId: r.key,
      taskKey: r.key,
      sessionId: r.sessionId,
      harness: 'claude-code',
      source: 'anthropic',
      model: tasks[n].model ?? 'sonnet',
      tier: tasks[n].tier,
      treeId: TREE,
      idle: false,
      contextTokens: (r.contextAtStart ?? 0) + tasks[n].addsContext,
      endedAt: T0 + n,
    }));
    const choice = chooseAssignment({
      requirement: { harness: 'claude-code', source: 'anthropic', model: t.model ?? 'sonnet', minTier: t.tier, maxTier: t.tier },
      tiers: DEFAULT_TIERS,
      capabilities: { resume: true, fork: true },
      treeId: TREE,
      upstream: ran.length ? [ran[ran.length - 1].key] : [],
      candidates,
      contextCeiling: opts.ceiling,
    });
    if (choice.mode === 'cold') {
      ran.push({ key: t.key, mode: 'cold', sessionId: `s-new-${++fresh}`, contextAtStart: 20_000, reason: choice.reason });
    } else {
      const from = candidates.find((c) => c.attemptId === choice.fromAttemptId)!;
      ran.push({ key: t.key, mode: choice.mode, sessionId: choice.sessionId, from: from.taskKey, contextAtStart: from.contextTokens, reason: choice.reason });
    }
  }
  return ran;
}

describe('simulated chains', () => {
  it('A → B → C on one tree: B and C carry A’s session on', () => {
    const ran = playChain([
      { key: 'A', tier: 'standard', addsContext: 10_000 },
      { key: 'B', tier: 'standard', addsContext: 10_000 },
      { key: 'C', tier: 'standard', addsContext: 10_000 },
    ]);
    expect(ran.map((r) => [r.key, r.mode, r.sessionId, r.from ?? null])).toEqual([
      ['A', 'cold', 's-new-1', null],
      ['B', 'reuse', 's-new-1', 'A'],
      ['C', 'reuse', 's-new-1', 'B'],
    ]);
    // Each start carries the context the session last held.
    expect(ran.map((r) => r.contextAtStart)).toEqual([20_000, 30_000, 40_000]);
  });

  it('a mid-chain tier change forces cold, and the next task at that tier reuses the new session', () => {
    const ran = playChain([
      { key: 'A', tier: 'standard', addsContext: 5_000 },
      // Same model name, another tier (a local model the catalog places higher, say): the tier alone decides.
      { key: 'B', tier: 'expert', addsContext: 5_000 },
      { key: 'C', tier: 'expert', addsContext: 5_000 },
      { key: 'D', tier: 'standard', addsContext: 5_000 },
    ]);
    expect(ran.map((r) => [r.key, r.mode, r.sessionId])).toEqual([
      ['A', 'cold', 's-new-1'],
      ['B', 'cold', 's-new-2'],
      ['C', 'reuse', 's-new-2'],
      // Back on standard: A's session satisfies it again, and is still warm.
      ['D', 'reuse', 's-new-1'],
    ]);
    expect(ran[1].reason).toMatch(/is standard; the route needs expert/);
  });

  it('a chain that outgrows the ceiling starts over cold, then reuses the new session', () => {
    const ran = playChain(
      [
        { key: 'A', tier: 'standard', addsContext: 30_000 },
        { key: 'B', tier: 'standard', addsContext: 30_000 },
        { key: 'C', tier: 'standard', addsContext: 30_000 },
        { key: 'D', tier: 'standard', addsContext: 30_000 },
      ],
      // A starts at 20k; B at 50k; C would start at 80k.
      { ceiling: 70_000 },
    );
    expect(ran.map((r) => [r.key, r.mode, r.sessionId])).toEqual([
      ['A', 'cold', 's-new-1'],
      ['B', 'reuse', 's-new-1'],
      ['C', 'cold', 's-new-2'],
      ['D', 'reuse', 's-new-2'],
    ]);
  });
});

describe('attempt telemetry (#54)', () => {
  const decision: RoutingDecision = {
    id: 'd1',
    taskId: 't1',
    attemptN: 1,
    mode: 'manual',
    policyVersion: 'manual',
    requirement: { minTier: 'standard', maxTier: 'standard', effort: 'low', needs: [], gates: [] },
    reasons: [],
    overrides: [],
    resolution: { target: { harness: 'claude-code', source: 'anthropic', model: 'sonnet', tier: 'standard', effortNative: 'low', location: 'hosted' }, candidates: [], catalogVersion: 'manual' },
    decidedBy: 'user',
    decidedAt: T0,
  };
  const ended = (over: Partial<ExecutionAttempt>) =>
    attempt('a2', 't1', { routingDecisionId: 'd1', state: 'succeeded', launchedAt: T0 + 1000, endedAt: T0 + 5000, outcome: { status: 'succeeded' }, ...over });
  const m = (): Mission => mission({ decisions: [decision] });

  it.each<[string, Partial<ExecutionAttempt>, Record<string, unknown>]>([
    ['fresh reports as cold, with its first request as context at start', { context: { atStart: 18_000, last: 30_000 } }, { assignmentMode: 'cold', contextTokensAtStart: 18_000 }],
    [
      'reuse names the attempt it carried on and the context it carried',
      { assignment: { mode: 'reuse', sessionIds: ['s1'], harness: 'claude-code', fromAttemptId: 'a1', fromSessionId: 's1' }, context: { atStart: 42_000 } },
      { assignmentMode: 'reuse', assignedFrom: 'a1', contextTokensAtStart: 42_000 },
    ],
    [
      'fork names its source',
      { assignment: { mode: 'fork', sessionIds: ['s2'], harness: 'claude-code', fromAttemptId: 'a1', fromSessionId: 's1' }, context: { atStart: 42_000 } },
      { assignmentMode: 'fork', assignedFrom: 'a1' },
    ],
    ['continue stays distinct', { assignment: { mode: 'continue', sessionIds: ['s1'], harness: 'claude-code' } }, { assignmentMode: 'continue' }],
  ])('%s', (_name, over, expected) => {
    expect(attemptRecord(m(), ended(over), T0 + 6000)).toMatchObject(expected);
  });

  it('unknown context is absent, never 0', () => {
    for (const context of [undefined, {}, { atStart: 0 }, { atStart: Number.NaN }]) {
      const rec = attemptRecord(m(), ended({ context }), T0 + 6000)!;
      expect(rec.assignmentMode).toBe('cold');
      expect('contextTokensAtStart' in rec).toBe(false);
    }
    expect('assignedFrom' in attemptRecord(m(), ended({}), T0 + 6000)!).toBe(false);
  });

  it('an attempt saved before #54 still loads and reports cold with no context', () => {
    const old = migrateMission(
      JSON.parse(
        JSON.stringify({
          ...m(),
          v: 1,
          attempts: [{ id: 'a2', taskId: 't1', n: 1, routingDecisionId: 'd1', assignment: { mode: 'fresh', sessionIds: ['s1'], harness: 'claude-code' }, state: 'succeeded', verification: [], flags: {}, outcome: { status: 'succeeded' }, createdAt: T0 }],
        }),
      ),
    );
    const rec = attemptRecord(old, old.attempts[0], T0 + 1)!;
    expect(rec).toMatchObject({ assignmentMode: 'cold' });
    expect(rec.contextTokensAtStart).toBeUndefined();
    expect(assignmentModeOf(old.attempts[0])).toBe('cold');
  });

  it('addTurnContext: a cold attempt takes its first turn’s first request; every turn moves `last`', () => {
    const cold = attempt('a', 't1');
    const c1 = addTurnContext(cold, { first: 18_000, last: 25_000 }, true);
    expect(c1).toEqual({ atStart: 18_000, last: 25_000 });
    // A later turn: `last` moves, `atStart` stays.
    expect(addTurnContext({ ...cold, context: c1 }, { first: 26_000, last: 31_000 }, false)).toEqual({ atStart: 18_000, last: 31_000 });
    // A first turn seen late (after a restart) sets no `atStart`.
    expect(addTurnContext(cold, { first: 18_000, last: 25_000 }, false)).toEqual({ last: 25_000 });
    // Nothing reported: unchanged.
    expect(addTurnContext(cold, undefined, true)).toBeUndefined();
    expect(addTurnContext(cold, { first: 0 }, true)).toBeUndefined();
    // A carried session keeps the `atStart` launch gave it.
    const reused = attempt('b', 't2', { assignment: { mode: 'reuse', sessionIds: ['s'], harness: 'claude-code', fromAttemptId: 'a' }, context: { atStart: 40_000 } });
    expect(addTurnContext(reused, { first: 41_000, last: 50_000 }, true)).toEqual({ atStart: 40_000, last: 50_000 });
  });
});

describe('request context from the runners (#54)', () => {
  it('Claude: the input side of a main-thread assistant message', () => {
    const msg = (usage: Record<string, number>, parent?: string) => ({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { usage } });
    expect(claudeRequestTokens(msg({ input_tokens: 10, cache_read_input_tokens: 17_000, cache_creation_input_tokens: 500, output_tokens: 50 }))).toBe(17_510);
    expect(claudeRequestTokens(msg({ input_tokens: 10 }, 'toolu_1'))).toBeUndefined();
    expect(claudeRequestTokens(msg({ input_tokens: 0 }))).toBeUndefined();
    expect(claudeRequestTokens({ type: 'result', usage: { input_tokens: 5 } })).toBeUndefined();
  });

  it('Codex: `last.inputTokens`, which includes the cached part', () => {
    expect(codexRequestTokens({ total: { inputTokens: 99 }, last: { inputTokens: 17_816, cachedInputTokens: 11_264 } })).toBe(17_816);
    expect(codexRequestTokens({ total: { inputTokens: 99 } })).toBeUndefined();
  });

  it('folds requests into first and last, and reads them back off a turn end', () => {
    let ctx = foldRequest({}, undefined);
    expect(ctx).toEqual({});
    ctx = foldRequest(foldRequest(foldRequest(ctx, 100), undefined), 250);
    expect(ctx).toEqual({ first: 100, last: 250 });
    expect(requestContextOf({ subtype: 'success', [REQUEST_CONTEXT_KEY]: ctx })).toEqual({ first: 100, last: 250 });
    expect(requestContextOf({ subtype: 'success' })).toBeUndefined();
    expect(requestContextOf({ [REQUEST_CONTEXT_KEY]: { first: -1, last: 'x' } })).toBeUndefined();
  });
});

describe('the prompt of a carried session', () => {
  const task = { title: 'Use the constant', objective: 'Synthetic: use a.', acceptanceCriteria: ['b.ts uses a'] };
  it('says the old task is done and this one is separate; a fork is told it moved', () => {
    const cold = attemptPrompt(task, { harness: 'claude-code', branch: 'aw/m/mission' });
    const reuse = attemptPrompt(task, { harness: 'claude-code', branch: 'aw/m/mission', carried: 'reuse' });
    const fork = attemptPrompt(task, { harness: 'claude-code', branch: 'aw/m/t2', carried: 'fork' });
    expect(cold.startsWith('# Task: Use the constant')).toBe(true);
    expect(reuse).toMatch(/^Your previous task is finished/);
    expect(reuse.endsWith(cold)).toBe(true);
    expect(fork).toMatch(/^This conversation was copied from an earlier task.*different worktree/);
  });
});
