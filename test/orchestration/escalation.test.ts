/**
 * The escalation policy (#41, plan §15.2–15.3) as tables: a classified failure
 * and a task's history → the step taken, with every step skipped and why —
 * pins, caps, limits, nothing to move to. Then a seeded simulation that walks
 * the ladder under hundreds of random failure sequences and checks, on every
 * step, that no task passes an attempt, tier, effort or cost limit, that pins
 * never move, and that every sequence ends.
 */
import { describe, expect, it } from 'vitest';
import {
  decideEscalation,
  DEFAULT_LIMITS,
  limitsFor,
  type AttemptHistoryItem,
  type EscalationInput,
  type EscalationRoute,
  type ProbeRequest,
} from '../../src/orchestration/policy/escalation';
import type { Classification } from '../../src/orchestration/policy/outcome';
import { DEFAULT_TIERS, tierRank } from '../../src/shared/orchestration/catalog';
import { EFFORT_LEVELS, LAUNCHING_ACTIONS, type EscalationDecision, type ExecutionTarget, type OutcomeCategory, type RouteCaps, type RouteDimension } from '../../src/shared/orchestration/types';

const T0 = 1_800_000_000_000;

/** A model at each tier on each harness, the way a resolver snapshot would offer them. */
const MODELS: Record<string, Record<string, string>> = {
  'claude-code': { basic: 'haiku', standard: 'sonnet', expert: 'opus', frontier: 'fable' },
  codex: { basic: 'gpt-6-luna', standard: 'gpt-6-sol', expert: 'gpt-6-astra' },
};

function target(harness: string, tier: string): ExecutionTarget {
  return { harness, source: harness === 'codex' ? 'openai' : 'anthropic', model: MODELS[harness][tier], tier, effortNative: 'medium', location: 'hosted' };
}

/** The probe a test answers from `MODELS`; `none` lists tiers with nothing available. */
function probeFrom(opts: { none?: string[]; largest?: number } = {}) {
  const calls: ProbeRequest[] = [];
  const probe = (req: ProbeRequest) => {
    calls.push(req);
    if (opts.none?.includes(req.tier)) return { ok: false as const, reason: `nothing at ${req.tier}` };
    if (req.largerContextThan !== undefined && (opts.largest ?? 0) <= req.largerContextThan) return { ok: false as const, reason: 'no larger window' };
    const harnesses = Object.keys(MODELS).filter((h) => (req.harness ? h === req.harness : true) && h !== req.notHarness && MODELS[h][req.tier]);
    if (harnesses.length === 0) return { ok: false as const, reason: `no harness has ${req.tier}` };
    return { ok: true as const, target: target(harnesses[0], req.tier) };
  };
  return { probe, calls };
}

const ROUTE: EscalationRoute = { harness: 'claude-code', model: 'sonnet', tier: 'standard', effort: 'medium', contextWindow: 200_000 };

function cls(category: OutcomeCategory, signature = `sig-${category}`, over: Partial<Classification> = {}): Classification {
  return { category, signature, detail: `synthetic ${category}`, ...over };
}

function hist(...items: [OutcomeCategory, string?][]): AttemptHistoryItem[] {
  return items.map(([category, signature], i) => ({ id: `a${i + 1}`, n: i + 1, status: 'failed', category, signature: signature ?? `sig-${category}` }));
}

let seq = 0;
function input(over: Partial<EscalationInput> = {}): EscalationInput {
  const history = over.history ?? hist(['quality-new']);
  return {
    taskId: 't1',
    afterAttemptId: history.at(-1)?.id ?? 'a1',
    classification: cls('quality-new'),
    history,
    decisions: [],
    route: ROUTE,
    mode: 'auto',
    pinned: [],
    caps: {},
    frontierAllowed: false,
    autoRecover: false,
    tiers: DEFAULT_TIERS,
    sessionContinuable: true,
    effortMidSession: true,
    limits: limitsFor('auto'),
    probe: probeFrom().probe,
    now: T0,
    newId: () => `d${++seq}`,
    ...over,
  };
}

/** The decided steps as `action` or `action✗blockedBy`, in order. */
function steps(i: EscalationInput): string[] {
  return decideEscalation(i).decisions.map((d) => (d.blockedBy ? `${d.action}✗${d.blockedBy}` : d.action));
}

describe('the ladder, category by category (§15.2)', () => {
  it('quality-new: the failure goes back to the same session', () => {
    const out = decideEscalation(input());
    expect(out.final).toMatchObject({ action: 'continue-with-feedback', mode: 'continue', step: 1 });
    expect(decideEscalation(input({ sessionContinuable: false })).final.mode).toBe('fresh');
  });

  it('quality-repeat: raises effort first, in the session when the harness can', () => {
    const i = input({ classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's']) });
    expect(decideEscalation(i).final).toMatchObject({ action: 'raise-effort', delta: { effort: 'high' }, mode: 'continue' });
    expect(decideEscalation({ ...i, effortMidSession: false }).final.mode).toBe('fresh');
  });

  it('quality-repeat: a pinned effort is skipped, and the tier goes up instead', () => {
    const i = input({ classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's']), pinned: ['effort'], pinnedBy: { effort: 'the mission' } });
    const out = decideEscalation(i);
    expect(out.decisions[0]).toMatchObject({ action: 'raise-effort', blockedBy: 'pin', reason: 'Effort is pinned by the mission, so it is not raised.' });
    expect(out.final).toMatchObject({ action: 'raise-tier', delta: { tier: 'expert' }, mode: 'cold', target: { model: 'opus', tier: 'expert' } });
  });

  it('a mission capped at standard never goes to expert, and says which cap stopped it', () => {
    const i = input({
      classification: cls('quality-repeat', 's'),
      history: hist(['quality-new', 's'], ['quality-repeat', 's']),
      caps: { maxTier: 'standard', maxEffort: 'medium' },
      cappedBy: { maxTier: 'the mission', maxEffort: 'the mission' },
      pinned: ['harness'],
      pinnedBy: { harness: 'this task' },
    });
    const out = decideEscalation(i);
    expect(out.decisions.map((d) => [d.action, d.blockedBy, d.reason])).toEqual([
      ['raise-effort', 'cap', 'Would raise effort to high; the mission caps effort at medium.'],
      ['raise-tier', 'cap', 'Would raise tier to expert; the mission is capped at standard.'],
      ['switch-harness', 'pin', 'The harness is pinned by this task.'],
      ['needs-human', undefined, expect.stringContaining('the mission is capped at standard')],
    ]);
    expect(out.decisions.some((d) => d.target?.tier === 'expert')).toBe(false);
  });

  it('frontier only when the mission allows it', () => {
    const atExpert = { ...ROUTE, model: 'opus', tier: 'expert', effort: 'max' as const };
    const base = { classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's']), route: atExpert, pinned: ['harness'] as RouteDimension[] };
    const off = decideEscalation(input(base));
    expect(off.decisions.find((d) => d.action === 'raise-tier')).toMatchObject({ blockedBy: 'cap', reason: 'Would raise to frontier; not allowed for this mission.' });
    const { probe, calls } = probeFrom();
    const on = decideEscalation(input({ ...base, frontierAllowed: true, probe }));
    expect(on.final).toMatchObject({ action: 'raise-tier', target: { model: 'fable', tier: 'frontier' } });
    expect(calls.at(-1)).toMatchObject({ tier: 'frontier', escalationTier: true, harness: 'claude-code' });
  });

  it('switches harness at the same tier when effort and tier cannot move (auto)', () => {
    const i = input({ classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's']), route: { ...ROUTE, effort: 'max' }, caps: { maxTier: 'standard' } });
    expect(steps(i)).toEqual(['raise-effort✗unavailable', 'raise-tier✗cap', 'switch-harness']);
    expect(decideEscalation(i).final).toMatchObject({ delta: { harness: 'codex' }, target: { model: 'gpt-6-sol', tier: 'standard' } });
  });

  it('a route picked by hand does not change tier or harness on its own (manual)', () => {
    const i = input({ mode: 'manual', limits: limitsFor('manual'), classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's']), route: { ...ROUTE, effort: undefined } });
    const out = decideEscalation(i);
    expect(steps(i)).toEqual(['raise-effort✗unavailable', 'raise-tier✗limit', 'switch-harness✗limit', 'needs-human']);
    expect(out.decisions[1].reason).toBe('Would raise tier to expert; a route picked by hand does not change tier on its own.');
  });

  it('a pinned model fixes the tier and the harness', () => {
    const i = input({ classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's']), route: { ...ROUTE, effort: 'max' }, pinned: ['model', 'tier'], pinnedBy: { model: 'this task', tier: 'this task' } });
    expect(steps(i)).toEqual(['raise-effort✗unavailable', 'raise-tier✗pin', 'switch-harness✗pin', 'needs-human']);
  });

  it('the same failure three times in a row goes to a person, whatever is left', () => {
    const i = input({ classification: cls('quality-repeat', 's'), history: hist(['quality-new', 's'], ['quality-repeat', 's'], ['quality-repeat', 's']) });
    expect(decideEscalation(i).final).toMatchObject({ action: 'needs-human', evidence: { repeats: 3 } });
  });

  it('a step already used is not used again', () => {
    const used: EscalationDecision = { id: 'x', taskId: 't1', afterAttemptId: 'a2', evidence: { category: 'quality-repeat', repeats: 2 }, action: 'raise-effort', delta: { effort: 'high' }, reason: '', decidedAt: T0, step: 2 };
    const i = input({ classification: cls('quality-repeat', 't'), history: hist(['quality-new', 's'], ['quality-new', 't'], ['quality-repeat', 't']), route: { ...ROUTE, effort: 'high' }, decisions: [used], limits: { ...limitsFor('auto'), qualityAttempts: 5 } });
    expect(steps(i)).toEqual(['raise-effort✗limit', 'raise-tier']);
    expect(decideEscalation(i).final.step).toBe(2);
  });

  it('a rate limit waits and never raises the tier', () => {
    const i = input({ classification: cls('capacity', 'api-429'), history: hist(['capacity', 'api-429']), capacityBackAt: T0 + 90_000 });
    const out = decideEscalation(i);
    expect(out.decisions).toHaveLength(1);
    expect(out.final).toMatchObject({ action: 'wait', notBefore: T0 + 90_000, mode: 'continue' });
    expect(decideEscalation({ ...i, capacityBackAt: undefined }).final.notBefore).toBe(T0 + DEFAULT_LIMITS.capacityWaitMs);
    // Four in a row: waiting has not helped.
    const tired = input({ classification: cls('capacity', 'api-429'), history: hist(['capacity', 'api-429'], ['capacity', 'api-429'], ['capacity', 'api-429'], ['capacity', 'api-429']) });
    expect(steps(tired)).toEqual(['needs-human']);
  });

  it('infra: two retries of the same route with backoff, then another harness, then a person', () => {
    const one = decideEscalation(input({ classification: cls('infra', 'api-500'), history: hist(['infra', 'api-500']) }));
    expect(one.final).toMatchObject({ action: 'retry-same', notBefore: T0 + 15_000 });
    const two = decideEscalation(input({ classification: cls('infra', 'api-500'), history: hist(['infra', 'api-500'], ['infra', 'api-500']) }));
    expect(two.final).toMatchObject({ action: 'retry-same', notBefore: T0 + 60_000 });
    const three = input({ classification: cls('infra', 'api-500'), history: hist(['infra', 'api-500'], ['infra', 'api-500'], ['infra', 'api-500']) });
    expect(steps(three)).toEqual(['retry-same✗limit', 'switch-harness']);
    expect(steps({ ...three, pinned: ['harness'] })).toEqual(['retry-same✗limit', 'switch-harness✗pin', 'needs-human']);
    // A refused login is not retried as is.
    expect(steps(input({ classification: cls('infra', 'api-401', { retryable: false }), history: hist(['infra', 'api-401']) }))).toEqual(['needs-human']);
  });

  it('infra retries are not attempts at the work', () => {
    const i = input({ classification: cls('infra', 'api-500'), history: hist(['quality-new', 'a'], ['quality-new', 'b'], ['quality-new', 'c'], ['infra', 'api-500']) });
    expect(decideEscalation(i).final.action).toBe('retry-same');
  });

  it('lost: one automatic Resume under autoRecover, never after a host crash', () => {
    const lost = (auto: boolean, autoResumable: boolean, history = hist(['lost', 'app-restart'])) =>
      decideEscalation(input({ classification: cls('lost', 'app-restart'), history, autoRecover: auto, lost: { resumable: true, autoResumable } })).final;
    expect(lost(true, true)).toMatchObject({ action: 'retry-same', mode: 'continue' });
    expect(lost(false, true).action).toBe('needs-human');
    expect(lost(true, false)).toMatchObject({ action: 'needs-human', reason: expect.stringContaining('never resumed on its own after a host crash') });
    const again = [{ ...hist(['lost', 'app-restart'])[0], autoResumed: true }];
    expect(lost(true, true, again).action).toBe('needs-human');
  });

  it('context: a larger window at the same tier, else a split', () => {
    const bigger = decideEscalation(input({ classification: cls('context'), history: hist(['context']), probe: probeFrom({ largest: 1_000_000 }).probe }));
    expect(bigger.final).toMatchObject({ action: 'switch-model', mode: 'cold' });
    expect(steps(input({ classification: cls('context'), history: hist(['context']) }))).toEqual(['switch-model✗unavailable', 'split-task']);
    expect(steps(input({ classification: cls('context'), history: hist(['context']), route: { ...ROUTE, contextWindow: undefined } }))).toEqual(['switch-model✗unavailable', 'split-task']);
    expect(steps(input({ classification: cls('context'), history: hist(['context']), pinned: ['model', 'tier'] }))).toEqual(['switch-model✗pin', 'split-task']);
  });

  it('empty: one explicit retry, then a person', () => {
    expect(decideEscalation(input({ classification: cls('empty', 'no-diff'), history: hist(['empty', 'no-diff']) })).final).toMatchObject({ action: 'continue-with-feedback' });
    expect(steps(input({ classification: cls('empty', 'no-diff'), history: hist(['empty', 'no-diff'], ['empty', 'no-diff']) }))).toEqual(['needs-human']);
  });

  it('stuck: one fresh try, then a person', () => {
    expect(decideEscalation(input({ classification: cls('stuck', 'wall-clock'), history: hist(['stuck', 'wall-clock']) })).final).toMatchObject({ action: 'retry-same', mode: 'cold' });
    expect(steps(input({ classification: cls('stuck', 'wall-clock'), history: hist(['stuck', 'wall-clock'], ['stuck', 'wall-clock']) }))).toEqual(['needs-human']);
  });

  it('ambiguity and policy go to a person; budget stops', () => {
    expect(steps(input({ classification: cls('ambiguity'), history: hist(['ambiguity']) }))).toEqual(['needs-human']);
    expect(decideEscalation(input({ classification: cls('policy'), history: hist(['policy']) })).final.reason).toMatch(/never changes permissions/);
    expect(steps(input({ classification: cls('budget', 'max-turns'), history: hist(['budget', 'max-turns']) }))).toEqual(['stop']);
  });
});

describe('limits and caps on another attempt (§15.3)', () => {
  it('the attempts cap stops it, naming the scope', () => {
    const out = decideEscalation(input({ history: hist(['quality-new', 'a'], ['quality-new', 'b']), classification: cls('quality-new', 'b'), caps: { maxAttempts: 2 }, cappedBy: { maxAttempts: 'the mission' } }));
    expect(out.decisions.map((d) => [d.action, d.blockedBy])).toEqual([
      ['continue-with-feedback', 'cap'],
      ['stop', undefined],
    ]);
    expect(out.final.reason).toBe("Attempt 3 would pass the mission's cap of 2 attempts.");
  });

  it('the spend cap stops it', () => {
    const out = decideEscalation(input({ caps: { maxEstimatedCostUsd: 1 }, spentUsd: 1.25 }));
    expect(out.final).toMatchObject({ action: 'stop', reason: expect.stringContaining('$1.25') });
  });

  it('three attempts at the work is the limit', () => {
    const i = input({ classification: cls('quality-new', 'c'), history: hist(['quality-new', 'a'], ['quality-new', 'b'], ['quality-new', 'c']) });
    expect(steps(i)).toEqual(['continue-with-feedback✗limit', 'needs-human']);
  });

  it('no task gets more than the hard ceiling, of any kind', () => {
    const many = hist(...Array.from({ length: 8 }, () => ['capacity', 'api-429'] as [OutcomeCategory, string]));
    const i = input({ classification: cls('infra', 'api-500'), history: [...many, ...hist(['infra', 'api-500']).map((h) => ({ ...h, id: 'a9', n: 9 }))] });
    expect(decideEscalation(i).final.action).toBe('needs-human');
  });
});

// ---------------------------------------------------------------------------
// Simulation: random failure sequences, invariants on every step
// ---------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAILURES: OutcomeCategory[] = ['infra', 'lost', 'capacity', 'context', 'quality-new', 'empty', 'ambiguity', 'policy', 'stuck', 'budget'];

interface Walk {
  steps: number;
  attempts: number;
  final: EscalationDecision;
  /** Launching steps taken, and steps blocked, over the whole walk. */
  taken: number;
  blocked: number;
}

function walk(seed: number): Walk {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const mode = pick(['manual', 'assisted', 'auto'] as const);
  const caps: RouteCaps = {};
  if (r() < 0.5) caps.maxTier = pick(['basic', 'standard', 'expert', 'frontier']);
  if (r() < 0.5) caps.maxEffort = pick(EFFORT_LEVELS);
  if (r() < 0.4) caps.maxAttempts = 1 + Math.floor(r() * 6);
  if (r() < 0.4) caps.maxEstimatedCostUsd = Math.round(r() * 300) / 100;
  const pinned: RouteDimension[] = [];
  if (r() < 0.3) pinned.push('harness');
  if (r() < 0.3) pinned.push('model', 'tier');
  if (r() < 0.3) pinned.push('effort');
  const frontierAllowed = r() < 0.3;
  const capRank = caps.maxTier ? tierRank(DEFAULT_TIERS, caps.maxTier) : DEFAULT_TIERS.length - 1;
  // Start within the caps, as a launch that passed admission would.
  const startTier = DEFAULT_TIERS[Math.min(Math.floor(r() * 3), capRank)].name;
  const startEffort = pick([undefined, ...EFFORT_LEVELS.slice(0, caps.maxEffort ? EFFORT_LEVELS.indexOf(caps.maxEffort) + 1 : 4)]);
  let route: EscalationRoute = { harness: pick(['claude-code', 'codex']), model: '', tier: startTier, effort: startEffort, contextWindow: r() < 0.5 ? 200_000 : undefined };
  route = { ...route, model: MODELS[route.harness][route.tier] ?? MODELS['claude-code'][route.tier] };
  const start = { ...route };
  const history: AttemptHistoryItem[] = [];
  const decisions: EscalationDecision[] = [];
  let spent = 0;
  let prevSig: string | undefined;
  let attempts = 0;
  const { probe } = probeFrom({ largest: r() < 0.5 ? 1_000_000 : 0 });
  const limits = limitsFor(mode);

  for (let n = 1; n <= 60; n++) {
    attempts = history.filter((h) => !h.resume).length + 1;
    spent += Math.round(r() * 50) / 100;
    let category = pick(FAILURES);
    const signature = `s${Math.floor(r() * 2)}`;
    if (category === 'quality-new' && prevSig === signature) category = 'quality-repeat';
    const last = decisions.filter((d) => !d.blockedBy).at(-1);
    const resumed = !!last && last.action === 'retry-same' && last.evidence.category === 'lost';
    history.push({ id: `a${n}`, n, status: 'failed', category, signature, resume: resumed, autoResumed: resumed });
    if (category !== 'lost') prevSig = signature;
    const out = decideEscalation({
      taskId: 't',
      afterAttemptId: `a${n}`,
      classification: { category, signature, detail: category, ...(r() < 0.1 ? { retryable: false } : {}) },
      history: [...history],
      decisions: [...decisions],
      route,
      mode,
      pinned,
      caps,
      frontierAllowed,
      autoRecover: r() < 0.5,
      lost: { resumable: r() < 0.8, autoResumable: r() < 0.5 },
      tiers: DEFAULT_TIERS,
      spentUsd: spent,
      sessionContinuable: r() < 0.7,
      effortMidSession: r() < 0.5,
      capacityBackAt: r() < 0.5 ? T0 + 1000 : undefined,
      limits,
      probe,
      now: T0,
      newId: () => `d${++seq}`,
    });
    decisions.push(...out.decisions);

    // Invariants on every step.
    expect(out.decisions.at(-1)).toBe(out.final);
    expect(out.final.blockedBy).toBeUndefined();
    for (const d of out.decisions.slice(0, -1)) expect(d.blockedBy).toBeDefined();
    const takes = LAUNCHING_ACTIONS.includes(out.final.action);
    if (!takes) return { steps: n, attempts, final: out.final, taken: decisions.filter((d) => !d.blockedBy && LAUNCHING_ACTIONS.includes(d.action)).length, blocked: decisions.filter((d) => d.blockedBy).length };
    const isResume = out.final.action === 'retry-same' && category === 'lost';
    if (!isResume) {
      // Another attempt: within every count cap and limit.
      if (caps.maxAttempts !== undefined) expect(attempts).toBeLessThan(caps.maxAttempts);
      if (caps.maxEstimatedCostUsd !== undefined) expect(spent).toBeLessThan(caps.maxEstimatedCostUsd);
      expect(attempts).toBeLessThan(limits.hardMaxAttempts);
    }
    // The route it moves to: within the tier and effort caps; pins unmoved.
    if (out.final.target) route = { ...route, harness: out.final.target.harness, model: out.final.target.model, tier: out.final.target.tier };
    if (out.final.delta?.effort) route = { ...route, effort: out.final.delta.effort };
    const rank = tierRank(DEFAULT_TIERS, route.tier);
    expect(rank).toBeLessThanOrEqual(capRank);
    if (route.tier === 'frontier') expect(frontierAllowed).toBe(true);
    if (caps.maxEffort && route.effort) expect(EFFORT_LEVELS.indexOf(route.effort)).toBeLessThanOrEqual(EFFORT_LEVELS.indexOf(caps.maxEffort));
    if (pinned.includes('harness')) expect(route.harness).toBe(start.harness);
    if (pinned.includes('model')) expect([route.model, route.tier]).toEqual([start.model, start.tier]);
    if (pinned.includes('effort')) expect(route.effort).toBe(start.effort);
    if (category === 'capacity') expect(out.final.action).toBe('wait');
    // Steps used, never past their limits.
    const used = (a: string) => decisions.filter((d) => d.action === a && !d.blockedBy).length;
    expect(used('raise-tier')).toBeLessThanOrEqual(limits.tierSteps);
    expect(used('raise-effort')).toBeLessThanOrEqual(limits.effortSteps);
    expect(used('switch-harness')).toBeLessThanOrEqual(limits.harnessSwitches);
    if (mode !== 'auto') expect(rank).toBe(tierRank(DEFAULT_TIERS, start.tier));
  }
  throw new Error(`seed ${seed}: the ladder did not end in 60 failures`);
}

describe('simulation: random failure sequences', () => {
  it('under 500 seeded sequences, every task ends within its limits', () => {
    let longest = 0;
    let taken = 0;
    let blocked = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const w = walk(seed);
      longest = Math.max(longest, w.steps);
      taken += w.taken;
      blocked += w.blocked;
      expect(['needs-human', 'stop', 'split-task']).toContain(w.final.action);
    }
    // The walks exercised the ladder, not only its first refusal.
    expect(taken).toBeGreaterThan(300);
    expect(blocked).toBeGreaterThan(100);
    // Resumes are free, but a resume is at most one per interruption: the ceiling holds with room to spare.
    expect(longest).toBeLessThanOrEqual(DEFAULT_LIMITS.hardMaxAttempts * 2);
  });
});
