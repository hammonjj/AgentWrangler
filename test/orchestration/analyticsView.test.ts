/**
 * The Analytics view-model (#49): what the table pane draws and what the
 * conversation pane's detail says, including "not reported by <harness>" for
 * fields a harness never sends and the heuristic label on over-routing.
 * Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import {
  analyticsDetail,
  analyticsView,
  candidateKey,
  evidenceSummary,
  parseRef,
  parseSelection,
  repositoryLabel,
  selectionFilter,
  type AnalyticsInput,
  type AnalyticsSelection,
} from '../../src/shared/orchestration/analyticsView';
import type { AnalyticsRecord } from '../../src/shared/orchestration/analytics';
import { DAY, repoOf, T0, tasks, TIERS } from './analyticsFixtures';

function fleet(): AnalyticsRecord[] {
  return tasks(
    { task: 'a', kind: 'feature', attempts: [{ tier: 'standard', costUsd: 1, tokens: 1000 }] },
    { task: 'b', kind: 'bugfix', attempts: [{ tier: 'standard', outcome: 'failed', costUsd: 1 }, { tier: 'expert', escalation: 'raise-tier', costUsd: 3 }] },
    { task: 'c', kind: 'docs', harness: 'codex', attempts: [{ tier: 'standard', model: 'gpt-5' }] },
    { task: 'd', kind: 'docs', complexity: 'routine', attempts: [{ tier: 'expert', costUsd: 2, git: { files: 1, lines: 10 } }] },
    { task: 'other-e', kind: 'feature', day: 40, attempts: [{ tier: 'basic', costUsd: 0.5 }] },
  );
}

const input = (selection: AnalyticsSelection = {}, records = fleet()): AnalyticsInput => ({ records, tiers: TIERS, repoOf, selection, now: T0 + 45 * DAY });

describe('the Analytics view', () => {
  it('puts the five headline metrics first', () => {
    const v = analyticsView(input());
    expect(v.headline.map((c) => c.label)).toEqual(['First-attempt success', 'Eventual success', 'Escalation rate', 'Cost per successful task', 'Model distribution']);
    expect(v.headline[0]).toMatchObject({ value: '80%', sub: '4 of 5 finished tasks' });
    expect(v.headline[2]).toMatchObject({ value: '20%', sub: '1 of 5 tasks' });
    expect(v.more.length).toBeGreaterThan(5);
    expect(v.counts).toBe('5 tasks · 6 attempts');
  });

  it('draws the model distribution as bars with counts and shares', () => {
    const bars = analyticsView(input()).headline[4].bars!;
    expect(bars.map((b) => [b.label, b.text])).toEqual([
      ['opus', '2 · 33%'],
      ['sonnet', '2 · 33%'],
      ['gpt-5', '1 · 17%'],
      ['haiku', '1 · 17%'],
    ]);
  });

  it('says which harness did not report a field, never 0', () => {
    const cost = analyticsView(input()).headline[3];
    // (1 + 4 + 2 + 0.5) / 4; Codex's task is left out, not counted as $0.
    expect(cost.value).toBe('$1.88');
    expect(cost.sub).toBe('over 4 successful tasks · 1 not reported by Codex');
    const codexOnly = analyticsView(input({ model: 'gpt-5' })).headline[3];
    expect(codexOnly.value).toBe('not reported by Codex');
    expect(codexOnly.notReported).toBe(true);
    expect(codexOnly.value).not.toMatch(/\$0/);
  });

  it('every headline metric moves with each filter', () => {
    const all = analyticsView(input()).headline.map((c) => c.value);
    for (const sel of [{ kind: 'bugfix' }, { tier: 'expert' }, { model: 'gpt-5' }, { repository: '/Users/test/other' }, { time: '7d' as const }]) {
      const v = analyticsView(input(sel));
      expect(v.headline.map((c) => c.value), JSON.stringify(sel)).not.toEqual(all);
    }
    // Effort: nothing in the fixtures is anything but medium.
    expect(analyticsView(input({ effort: 'high' })).headline[1].value).toBe('no data');
  });

  it('offers the values present, repositories by folder name, and time ranges', () => {
    const f = analyticsView(input({ kind: 'docs' })).filters;
    expect(f.map((c) => c.field)).toEqual(['kind', 'tier', 'effort', 'model', 'repository', 'time']);
    expect(f[0]).toMatchObject({ selected: 'docs' });
    expect(f[0].options.map((o) => o.value)).toEqual(['', 'bugfix', 'docs', 'feature']);
    expect(f[1].options.map((o) => o.value)).toEqual(['', 'basic', 'standard', 'expert']);
    expect(f[4].options.map((o) => o.label)).toEqual(['Any repository', 'other', 'proj']);
    expect(f[5].options[0]).toEqual({ value: '', label: 'All time' });
  });

  it('shows the hosted/local split, sensibly with nothing local', () => {
    const s = analyticsView(input()).split;
    expect(s.rows.map((r) => [r.label, r.attempts])).toEqual([
      ['Hosted', '6 attempts'],
      ['Local', '0 attempts'],
    ]);
    expect(s.rows[1]).toMatchObject({ success: '—', cost: '—' });
    expect(s.note).toBe('Nothing ran on a local model in this selection.');
  });

  it('local work is $0 API cost, with the hosted estimate labelled', () => {
    const records = [...fleet(), ...tasks({ task: 'h', attempts: [{ tier: 'basic', costUsd: 0, local: { apiEquivalentUsd: 0.4 } }] })];
    const s = analyticsView(input({}, records)).split;
    expect(s.rows[1]).toMatchObject({ attempts: '1 attempt', success: '100% succeeded', cost: '$0 API cost · ≈$0.40 hosted (estimate)' });
    expect(s.note).toBeUndefined();
  });

  it('lists calibration candidates, over-routing labelled heuristic', () => {
    const c = analyticsView(input()).calibration;
    expect(c.under.map((x) => [x.title, x.reason, x.heuristic])).toEqual([['bugfix · t-b', 'Needed a tier or effort step', false]]);
    expect(c.under[0].triggers).toContain('steps raise-tier→expert');
    expect(c.over).toHaveLength(1);
    expect(c.over[0]).toMatchObject({ heuristic: true, title: 'docs · t-d', evidence: '2 records' });
    expect(c.heuristicLabel).toBe('heuristic');
    expect(c.agreement.map((a) => a.label)).toContain('Scope accuracy');
    expect(c.agreement.find((a) => a.label === 'Scope accuracy')!.value).toBe('no data');
  });

  it('says so when nothing has been recorded', () => {
    const v = analyticsView(input({}, []));
    expect(v.empty).toMatch(/No orchestrated tasks/);
    expect(v.headline[0].value).toBe('no data');
    expect(v.calibration.under).toEqual([]);
  });
});

describe('the detail in the conversation pane', () => {
  it('a metric: its numbers, breakdowns and evidence', () => {
    const d = analyticsDetail(input(), { kind: 'metric', id: 'cost-per-success' })!;
    expect(d.title).toBe('Cost per successful task');
    expect(d.subtitle).toBe('Everything recorded');
    expect(d.facts).toContainEqual({ label: 'Left out', value: '1 record, not reported by Codex' });
    const byHarness = d.breakdowns.find((b) => b.title === 'By harness')!;
    expect(byHarness.rows).toContainEqual({ key: 'codex', value: 'not reported by Codex', sub: '1 record, none with this field' });
    expect(d.breakdowns.find((b) => b.title === 'By repository')!.rows.map((r) => r.key)).toEqual(['other', 'proj']);
    expect(d.evidence.map((e) => e.id)).toContain('task-final:c');
    expect(d.evidence[0].summary).toMatch(/^task done/);
  });

  it('an over-routing candidate carries the heuristic label and its triggering values', () => {
    const v = analyticsView(input());
    const ref = v.calibration.over[0].ref;
    const d = analyticsDetail(input(), ref)!;
    expect(d.heuristic).toBe('heuristic');
    expect(d.facts).toContainEqual({ label: 'complexity', value: 'routine' });
    expect(d.facts).toContainEqual({ label: 'filesChanged', value: '1' });
    expect(d.evidence.map((e) => e.id)).toEqual(['attempt:d-1', 'task-final:d']);
  });

  it('an under-routing candidate is not heuristic', () => {
    const d = analyticsDetail(input(), analyticsView(input()).calibration.under[0].ref)!;
    expect(d.heuristic).toBeUndefined();
    expect(d.evidence.map((e) => e.type)).toEqual(['attempt', 'escalation', 'task-final']);
  });

  it('the split and agreement rows have details too', () => {
    expect(analyticsDetail(input(), { kind: 'split' })!.facts).toContainEqual({ label: 'Note', value: 'Nothing ran on a local model in this selection.' });
    expect(analyticsDetail(input(), { kind: 'agreement', group: 'dimension', key: 'tier' })!.title).toBe("Router's tier kept");
  });

  it('a stale ref has no detail', () => {
    expect(analyticsDetail(input(), { kind: 'candidate', direction: 'over', key: 'nope' })).toBeUndefined();
  });

  it('evidence lines are metadata only', () => {
    const r = fleet().find((x) => x.type === 'escalation')!;
    expect(evidenceSummary(r)).toBe('after attempt 1 · raise-tier · quality-new');
  });
});

describe('wire parsing', () => {
  it('keeps known selection fields and refs only', () => {
    expect(parseSelection({ kind: 'docs', time: '30d', bogus: 1, tier: '' })).toEqual({ kind: 'docs', time: '30d' });
    expect(parseSelection({ time: 'forever' })).toEqual({});
    expect(parseRef({ kind: 'metric', id: 'eventual-success' })).toEqual({ kind: 'metric', id: 'eventual-success' });
    expect(parseRef({ kind: 'metric', id: 'made-up' })).toBeUndefined();
    expect(parseRef({ kind: 'candidate', direction: 'sideways', key: 'x' })).toBeUndefined();
  });

  it('turns a time range into a from', () => {
    expect(selectionFilter({ time: '7d', kind: 'docs' }, 10 * DAY)).toEqual({ kind: 'docs', from: 3 * DAY });
  });

  it('names repositories by folder', () => {
    expect(repositoryLabel('/Users/test/proj')).toBe('proj');
    expect(repositoryLabel('unknown')).toBe('unknown repository');
  });

  it('candidate keys are stable', () => {
    expect(candidateKey({ reason: 'rescue', taskKey: 'm|t' } as Parameters<typeof candidateKey>[0])).toBe('rescue|m|t');
  });
});
