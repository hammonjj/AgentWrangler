/**
 * Automatic routing's gate and the shadow comparison report (§27.3, #42), as
 * pure functions over telemetry fixtures; the mode in force; and the
 * Preferences rule that `auto` over an unmet gate needs an override with the
 * numbers shown.
 */
import { describe, expect, it } from 'vitest';
import {
  comparisonReport,
  effectiveMode,
  evaluateGate,
  gateLines,
  type CorpusStatus,
  type EvidenceRecord,
  type GateInput,
} from '../../src/shared/orchestration/autoRouting';
import { parseRoutingSettings, routingSettingsValue } from '../../src/shared/orchestration/executionPolicy';
import { routingPolicyUpdate } from '../../src/shared/preferences';
import type { AttemptRecord, RoutingRecord } from '../../src/shared/orchestration/telemetry';
import type { EffortLevel, ExecutionTarget, OutcomeCategory, RouteAgreement, RouteDimension, RoutingMode } from '../../src/shared/orchestration/types';
import { catalog } from './routingFixtures';

const TIERS = ['basic', 'standard', 'expert', 'frontier'];
const MODEL: Record<string, string> = { basic: 'haiku', standard: 'sonnet', expert: 'opus' };
const CORPUS: CorpusStatus = { routerVersion: 'rtr-1', assessorVersion: 'asm-2', cards: 31, failing: 0, egregious: 0 };

function target(tier: string, effort: EffortLevel = 'medium'): ExecutionTarget {
  return { harness: 'claude-code', source: 'anthropic', model: MODEL[tier] ?? tier, tier, effortNative: effort, location: 'hosted' };
}

interface Fixture {
  task: string;
  mode?: RoutingMode;
  kind?: string;
  /** What the router picked. */
  rec: [string, EffortLevel];
  /** What ran. Default: the recommendation. */
  ran?: [string, EffortLevel];
  agreement?: RouteAgreement;
  changed?: RouteDimension[];
  outcome?: AttemptRecord['outcome'];
  category?: OutcomeCategory;
  n?: number;
  escalationStep?: number;
  verdict?: RoutingRecord['verdict'];
  /** No attempt record yet: the attempt is still running. */
  running?: boolean;
}

let clock = 1_000;

/** A routing record and (unless running) its attempt record: what the runner writes for one decision. */
function decision(f: Fixture): EvidenceRecord[] {
  const n = f.n ?? 1;
  const mode = f.mode ?? 'manual';
  const [rt, re] = f.rec;
  const [ut, ue] = f.ran ?? f.rec;
  const changed = f.changed ?? [...(rt !== ut ? (['model', 'tier'] as const) : []), ...(re !== ue ? (['effort'] as const) : [])];
  const agreement = f.agreement ?? (changed.includes('tier') ? 'changed-tier' : changed.length > 0 ? 'changed-effort' : mode === 'assisted' ? 'accepted' : 'matched');
  const at = clock++;
  const routing: RoutingRecord = {
    v: 1,
    type: 'routing',
    at,
    id: `routing:${f.task}-${n}`,
    missionId: `m-${f.task}`,
    taskId: `t-${f.task}`,
    decisionId: `d-${f.task}-${n}`,
    attemptN: n,
    mode,
    decidedBy: mode === 'manual' || changed.length > 0 ? 'user' : 'router',
    routerVersion: 'rtr-1',
    catalogVersion: 'c1',
    requirement: { minTier: rt, maxTier: 'expert', effort: re, gates: [] },
    ruleIds: ['tier.band'],
    verdict: f.verdict ?? 'route',
    recommended: target(rt, re),
    ran: target(ut, ue),
    ranEffort: ue,
    ...(f.escalationStep !== undefined ? { escalationStep: f.escalationStep } : {}),
    agreement,
    changed,
    candidates: { chosen: 1, fallback: 0, rejected: 1 },
  };
  if (f.running) return [routing];
  const attempt: AttemptRecord = {
    v: 1,
    type: 'attempt',
    at: at + 1,
    id: `attempt:${f.task}-${n}`,
    missionId: routing.missionId,
    taskId: routing.taskId,
    attemptId: `a-${f.task}-${n}`,
    n,
    mode,
    assessment: { dimensions: { kind: { value: f.kind ?? 'feature', confidence: 'high' } }, assessorVersion: 'asm-2' },
    target: { ...target(ut, ue), effortRequested: ue },
    shadow: { tier: rt, effort: re, target: target(rt, re), verdict: routing.verdict },
    agreement,
    ...(changed.length > 0 ? { changed } : {}),
    usage: {},
    cost: { basis: 'none' },
    turns: 1,
    outcome: f.outcome ?? 'succeeded',
    ...(f.category ? { category: f.category } : {}),
    ...(f.escalationStep !== undefined ? { escalationStep: f.escalationStep } : {}),
    verification: [],
    flags: {},
  };
  return [routing, attempt];
}

function many(count: number, f: Omit<Fixture, 'task'>, prefix: string): EvidenceRecord[] {
  return Array.from({ length: count }, (_, i) => decision({ ...f, task: `${prefix}${i}` })).flat();
}

function gate(records: EvidenceRecord[], over: Partial<GateInput> = {}) {
  return evaluateGate({ records, tiers: TIERS, corpus: CORPUS, routerVersion: 'rtr-1', assessorVersion: 'asm-2', ...over });
}

/** A record that meets every criterion: 20 manual shadows that agreed, 12 assisted proposals, 10 taken as offered. */
function healthy(): EvidenceRecord[] {
  return [
    ...many(20, { rec: ['standard', 'medium'] }, 'manual'),
    ...many(10, { mode: 'assisted', rec: ['standard', 'medium'] }, 'accepted'),
    ...many(2, { mode: 'assisted', rec: ['standard', 'medium'], ran: ['expert', 'medium'] }, 'raised'),
  ];
}

describe('evaluateGate (§27.3)', () => {
  it('is met when every criterion is, and shows the numbers', () => {
    const g = gate(healthy());
    expect(g.met).toBe(true);
    expect(g.numbers).toMatchObject({ decisions: 32, assisted: 12, assistedKeptTier: 10, underRoutedKinds: [] });
    expect(gateLines(g)).toEqual([
      '✓ Routing corpus green, zero egregious misroutes: 31/31 cards · 0 egregious',
      '✓ At least 30 shadow or assisted decisions: 32 of 30',
      '✓ At least 70% of assisted proposals run without a tier change: 83% (10 of 12)',
      '✓ No task kind the router under-routes: none',
    ]);
  });

  it('an empty log meets nothing but the corpus', () => {
    const g = gate([]);
    expect(g.met).toBe(false);
    expect(g.checks.map((c) => [c.id, c.met])).toEqual([
      ['corpus', true],
      ['decisions', false],
      ['acceptance', false],
      ['under-routing', true],
    ]);
    expect(g.checks[1]).toMatchObject({ value: '0 of 30', detail: '30 more needed.' });
    expect(g.checks[2]).toMatchObject({ value: 'no assisted proposals yet' });
  });

  it('the corpus check fails without a result, with a failing card, or for another router', () => {
    expect(gate(healthy(), { corpus: undefined }).checks[0]).toMatchObject({ met: false, value: 'not run' });
    expect(gate(healthy(), { corpus: { ...CORPUS, egregious: 1 } }).checks[0]).toMatchObject({ met: false, detail: '0 card(s) outside expectations, 1 egregious.' });
    expect(gate(healthy(), { corpus: { ...CORPUS, failing: 2 } }).met).toBe(false);
    expect(gate(healthy(), { routerVersion: 'rtr-2' }).checks[0]).toMatchObject({
      met: false,
      detail: 'The corpus result is for rtr-1/asm-2; this build routes with rtr-2/asm-2.',
    });
  });

  it('counts one decision per task: retries, resumes and escalation steps are not new evidence', () => {
    const records = [
      ...decision({ task: 'a', rec: ['standard', 'medium'], outcome: 'failed', category: 'quality-new' }),
      ...decision({ task: 'a', n: 2, rec: ['expert', 'medium'], escalationStep: 1 }),
      ...decision({ task: 'a', n: 3, rec: ['standard', 'medium'] }),
      ...decision({ task: 'b', rec: ['standard', 'medium'] }),
    ];
    expect(gate(records).numbers.decisions).toBe(2);
    expect(comparisonReport({ records, tiers: TIERS }).rows.map((r) => [r.taskId, r.attemptN])).toEqual([
      ['t-a', 1],
      ['t-b', 1],
    ]);
  });

  it('does not count auto decisions, or recommendations that were not a route', () => {
    const records = [
      ...many(5, { mode: 'auto', rec: ['standard', 'medium'] }, 'auto'),
      ...many(5, { rec: ['expert', 'high'], verdict: 'needs-human' }, 'nh'),
      ...many(3, { rec: ['standard', 'medium'] }, 'ok'),
    ];
    expect(gate(records).numbers.decisions).toBe(3);
  });

  it('acceptance: a tier change is a rejection; an effort or model change within the tier is not', () => {
    const records = [
      ...healthy().filter((r) => !r.id.includes('accepted')),
      ...many(5, { mode: 'assisted', rec: ['standard', 'medium'] }, 'took'),
      ...many(3, { mode: 'assisted', rec: ['standard', 'medium'], ran: ['standard', 'high'] }, 'effort'),
      ...many(3, { mode: 'assisted', rec: ['standard', 'medium'], ran: ['basic', 'medium'] }, 'lower'),
    ];
    const g = gate(records);
    // 5 taken + 3 effort changes kept the tier; 2 + 3 changed it: 8 of 13.
    expect(g.checks[2]).toMatchObject({ met: false, value: '62% (8 of 13)', detail: '5 of 13 had their tier changed.' });
  });

  it('acceptance needs enough assisted proposals to judge, whatever the rate', () => {
    const records = [...many(30, { rec: ['standard', 'medium'] }, 'manual'), ...many(3, { mode: 'assisted', rec: ['standard', 'medium'] }, 'took')];
    const g = gate(records);
    expect(g.checks[2]).toMatchObject({ met: false, value: '100% (3 of 3)', detail: 'Needs at least 10 assisted proposals to judge; 3 so far.' });
    expect(gate(records, { criteria: { minAssistedDecisions: 3 } }).met).toBe(true);
  });

  it('under-routing: the router wanted cheaper, the dearer route ran, and it still needed escalation', () => {
    const records = [
      ...healthy(),
      ...decision({ task: 'mig', kind: 'migration', rec: ['standard', 'medium'], ran: ['expert', 'medium'], outcome: 'failed', category: 'quality-repeat' }),
      // Same pattern, but the failure says nothing about the route (the server went away).
      ...decision({ task: 'infra', kind: 'docs', rec: ['basic', 'low'], ran: ['standard', 'low'], outcome: 'failed', category: 'infra' }),
      // The router wanted more, the cheaper route failed: the router was right, not under-routing.
      ...decision({ task: 'right', kind: 'bugfix', rec: ['expert', 'high'], ran: ['standard', 'high'], outcome: 'failed', category: 'quality-new' }),
      // Same tier, less effort from the router; the higher effort still failed.
      ...decision({ task: 'eff', kind: 'refactor', rec: ['standard', 'low'], ran: ['standard', 'high'], outcome: 'failed', category: 'stuck' }),
    ];
    const g = gate(records);
    expect(g.met).toBe(false);
    expect(g.numbers.underRoutedKinds).toEqual(['migration', 'refactor']);
    expect(g.checks[3]).toMatchObject({ met: false, value: 'migration, refactor' });
  });
});

describe('comparisonReport (§27.3)', () => {
  const records = [
    ...decision({ task: 'same', kind: 'feature', rec: ['standard', 'medium'] }),
    ...decision({ task: 'over', kind: 'docs', rec: ['basic', 'low'], ran: ['expert', 'high'] }),
    ...decision({ task: 'under', kind: 'bugfix', rec: ['expert', 'high'], ran: ['standard', 'high'], outcome: 'failed', category: 'quality-new' }),
    ...decision({ task: 'under2', kind: 'bugfix', rec: ['expert', 'medium'], ran: ['basic', 'medium'], outcome: 'failed', category: 'empty' }),
    ...decision({ task: 'side', kind: 'feature', rec: ['standard', 'medium'], ran: ['standard', 'medium'], changed: ['harness', 'model'], agreement: 'changed-harness' }),
    ...decision({ task: 'live', rec: ['standard', 'medium'], ran: ['expert', 'medium'], running: true }),
  ];
  const report = comparisonReport({ records, tiers: TIERS });

  it('lists predicted vs ran vs outcome for every task', () => {
    expect(report.rows.map((r) => [r.taskId, r.direction, r.outcome])).toEqual([
      ['t-same', 'agreed', 'passed-first'],
      ['t-over', 'router-cheaper', 'passed-first'],
      ['t-under', 'router-dearer', 'needed-escalation'],
      ['t-under2', 'router-dearer', 'needed-escalation'],
      ['t-side', 'sideways', 'passed-first'],
      ['t-live', 'router-cheaper', 'running'],
    ]);
    expect(report.rows[1]).toMatchObject({ predicted: { tier: 'basic', effort: 'low', model: 'haiku' }, ran: { tier: 'expert', effort: 'high', model: 'opus' } });
    // A running attempt has no assessment on record yet.
    expect(report.rows[5].kind).toBeUndefined();
  });

  it('names both patterns with their outcomes', () => {
    expect(report.patterns).toEqual([
      expect.objectContaining({ direction: 'router-cheaper', count: 2, passedFirst: 1, neededEscalation: 0, other: 1, reading: 'Mixed outcomes.' }),
      expect.objectContaining({ direction: 'router-dearer', count: 2, passedFirst: 0, neededEscalation: 2, reading: '2 needed escalation on the cheaper route: the router was right.' }),
    ]);
  });

  it('counts disagreements by kind and by dimension, most first', () => {
    expect(report.byKind.map((k) => [k.kind, k.decisions, k.disagreements])).toEqual([
      ['bugfix', 2, 2],
      // Ties on disagreements: more decisions first, then by name.
      ['feature', 2, 1],
      ['docs', 1, 1],
      ['not yet assessed', 1, 1],
    ]);
    expect(report.byKind[0]).toMatchObject({ routerDearer: 2, neededEscalation: 2, passedFirst: 0 });
    expect(report.byDimension).toEqual([
      { dimension: 'model', count: 5, passedFirst: 2, neededEscalation: 2 },
      { dimension: 'tier', count: 4, passedFirst: 1, neededEscalation: 2 },
      { dimension: 'effort', count: 1, passedFirst: 1, neededEscalation: 0 },
      { dimension: 'harness', count: 1, passedFirst: 1, neededEscalation: 0 },
    ]);
    expect(report.total).toMatchObject({ decisions: 6, disagreements: 5, routerCheaper: 2, routerDearer: 2, sideways: 1 });
  });

  it('carries no text a person wrote: ids, tiers, models and enums only', () => {
    expect(JSON.stringify(report)).not.toMatch(/objective|prompt/i);
  });
});

describe('effectiveMode', () => {
  const unmet = gate([]);
  const met = gate(healthy());

  it('auto runs only while the gate is met or an override stands; otherwise assisted, saying why', () => {
    expect(effectiveMode('manual', unmet, undefined)).toEqual({ mode: 'manual' });
    expect(effectiveMode('assisted', unmet, undefined)).toEqual({ mode: 'assisted' });
    expect(effectiveMode('auto', met, undefined)).toEqual({ mode: 'auto' });
    expect(effectiveMode('auto', unmet, { at: 1, shown: gateLines(unmet) })).toEqual({ mode: 'auto' });
    const fallback = effectiveMode('auto', unmet, undefined);
    expect(fallback.mode).toBe('assisted');
    expect(fallback.note).toMatch(/gate is not met, so this task is assisted: At least 30 shadow or assisted decisions \(0 of 30\)/);
    expect(effectiveMode('auto', undefined, undefined).mode).toBe('assisted');
  });
});

describe('routing settings and Preferences: auto needs the gate or an override (#42)', () => {
  const cat = catalog({ openai: false });
  const msg = (mode: string, overrideGate?: boolean) => ({ type: 'routingPolicy', mode, policy: { caps: { maxTier: 'expert' } }, ...(overrideGate ? { overrideGate } : {}) });
  const unmet = gate([]);
  const met = gate(healthy());

  it('refuses auto over an unmet gate, showing the numbers', () => {
    const r = routingPolicyUpdate(msg('auto'), cat, { gate: unmet, stored: { mode: 'manual' } });
    expect(r).toEqual({ ok: false, needsOverride: true, errors: ['Automatic routing’s gate is not met:', ...gateLines(unmet)] });
  });

  it('accepts auto over an unmet gate with an override, storing when and what was shown', () => {
    const r = routingPolicyUpdate(msg('auto', true), cat, { gate: unmet, stored: { mode: 'manual' }, now: 42 });
    expect(r).toEqual({ ok: true, value: { mode: 'auto', autoOverride: { at: 42, shown: gateLines(unmet) }, caps: { maxTier: 'expert' } } });
    const back = parseRoutingSettings((r as { value: unknown }).value);
    expect(back).toMatchObject({ mode: 'auto', autoOverride: { at: 42 } });
  });

  it('accepts auto with the gate met, with no override', () => {
    expect(routingPolicyUpdate(msg('auto'), cat, { gate: met, stored: { mode: 'manual' } })).toEqual({ ok: true, value: { mode: 'auto', caps: { maxTier: 'expert' } } });
  });

  it('keeps a standing override when a cap is edited on auto; leaving auto drops it', () => {
    const standing = { at: 7, shown: ['✗ something'] };
    expect(routingPolicyUpdate(msg('auto'), cat, { gate: unmet, stored: { mode: 'auto', autoOverride: standing } })).toEqual({
      ok: true,
      value: { mode: 'auto', autoOverride: standing, caps: { maxTier: 'expert' } },
    });
    expect(routingPolicyUpdate(msg('assisted'), cat, { gate: unmet, stored: { mode: 'auto', autoOverride: standing } })).toEqual({
      ok: true,
      value: { mode: 'assisted', caps: { maxTier: 'expert' } },
    });
    expect(routingSettingsValue('manual', {}, standing)).toEqual({ mode: 'manual' });
  });

  it('treats a gate it cannot read as unmet', () => {
    expect(routingPolicyUpdate(msg('auto'), cat, {})).toMatchObject({ ok: false, needsOverride: true });
  });

  it('reads auto from settings.json, and an override only beside auto', () => {
    expect(parseRoutingSettings({ mode: 'auto' })).toEqual({ mode: 'auto', policy: {}, errors: [] });
    expect(parseRoutingSettings({ mode: 'assisted', autoOverride: { at: 1, shown: [] } })).toEqual({ mode: 'assisted', policy: {}, errors: [] });
    expect(parseRoutingSettings({ mode: 'auto', autoOverride: { at: 'soon', shown: [] } })).toEqual({ mode: 'auto', policy: {}, errors: [] });
    expect(parseRoutingSettings({ mode: 'bogus' }).mode).toBe('manual');
  });
});
