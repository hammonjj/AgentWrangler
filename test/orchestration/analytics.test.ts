/**
 * The routing analytics layer (#49, plan §17): filters and group-by, each
 * metric with its numerator, denominator and record ids, the hosted/local
 * split, the calibration report with its evidence, and "not reported by
 * <harness>" for fields a harness never sends. Synthetic fixtures only.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDataset,
  calibrationReport,
  computeMetric,
  filterTasks,
  formatReported,
  groupBy,
  hostedLocalSplit,
  isNotReported,
  metricByGroup,
  notReportedText,
  taskGroupKey,
  type AnalyticsFilter,
  type AnalyticsRecord,
} from '../../src/shared/orchestration/analytics';
import { AnalyticsIndex } from '../../src/core/telemetry/telemetryIndex';
import { RoutingEvidenceIndex } from '../../src/core/telemetry/routingEvidenceIndex';
import { conflict, DAY, localCall, override, repoOf, T0, tasks, TIERS } from './analyticsFixtures';

/**
 * a: a clean first pass. b: needed a tier step. c: Codex, no cost reported.
 * d: expert on routine work, small diff. e: failed, then needed a person (other repo).
 * f: the router wanted cheaper; the dearer route passed. g: still running, interrupted.
 */
function fleet(): AnalyticsRecord[] {
  return [
    ...tasks(
      { task: 'a', kind: 'feature', attempts: [{ tier: 'standard', costUsd: 1, tokens: 1000, git: { files: 2, lines: 40 }, verification: 'passed', activeMs: 60_000, queueMs: 1_000, permissionAsks: 2, scopeAccuracy: 1 }] },
      {
        task: 'b',
        kind: 'bugfix',
        attempts: [
          { tier: 'standard', outcome: 'failed', category: 'quality-new', costUsd: 1, tokens: 500, verification: 'failed', activeMs: 30_000 },
          { tier: 'expert', escalation: 'raise-tier', costUsd: 3, tokens: 1500, verification: 'passed', activeMs: 40_000, scopeAccuracy: 0.5 },
        ],
      },
      { task: 'c', kind: 'docs', harness: 'codex', attempts: [{ tier: 'standard', model: 'gpt-5' }] },
      { task: 'd', kind: 'docs', complexity: 'routine', assessorVersion: 'asm-1', attempts: [{ tier: 'expert', costUsd: 2, tokens: 800, git: { files: 1, lines: 10 } }] },
      { task: 'other-e', kind: 'feature', attempts: [{ tier: 'standard', outcome: 'failed', category: 'quality-new', costUsd: 1, flags: { userIntervened: true } }], needsHuman: true },
      { task: 'f', kind: 'test', day: 40, router: { tier: 'standard', effort: 'medium', changed: ['tier', 'model'] }, attempts: [{ tier: 'expert', costUsd: 5, tokens: 2000 }] },
      { task: 'g', kind: 'feature', final: false, attempts: [{ tier: 'standard', outcome: 'interrupted' }] },
    ),
    conflict('a', 'merged'),
    conflict('b', 'conflict'),
    override('a'),
    override('b', 'mission'),
  ];
}

const ds = (records = fleet()) => buildDataset({ records, tiers: TIERS, repoOf });
const m = (id: Parameters<typeof computeMetric>[2], f: AnalyticsFilter = {}, records?: AnalyticsRecord[]) => computeMetric(ds(records), f, id);

describe('metrics (§17): numerator, denominator and the records behind them', () => {
  it('first-attempt success counts finished tasks accepted by verification on attempt 1', () => {
    const r = m('first-attempt-success');
    expect([r.numerator, r.denominator]).toEqual([4, 6]);
    expect(r.value).toBeCloseTo(4 / 6);
    expect(r.numeratorIds.sort()).toEqual(['task-final:a', 'task-final:c', 'task-final:d', 'task-final:f']);
    // The running task is not finished.
    expect(r.ids).not.toContain('task-final:g');
  });

  it('eventual success is done over finished', () => {
    const r = m('eventual-success');
    expect([r.numerator, r.denominator]).toEqual([5, 6]);
    expect(r.numeratorIds).not.toContain('task-final:other-e');
  });

  it('escalation rate counts tasks with a launched tier or effort step, and names the steps', () => {
    const r = m('escalation-rate');
    expect([r.numerator, r.denominator]).toEqual([1, 7]);
    expect(r.numeratorIds).toEqual(['escalation:b-2']);
  });

  it('cost per successful task averages what was reported, and lists what was not', () => {
    const r = m('cost-per-success');
    // a 1, b 4, d 2, f 5 over four; c (Codex) reported nothing.
    expect([r.numerator, r.denominator]).toEqual([12, 4]);
    expect(r.value).toBe(3);
    expect(r.missing).toEqual({ ids: ['task-final:c'], harnesses: ['codex'] });
    expect(r.buckets?.map((b) => [b.key, b.count])).toEqual([
      ['harness-estimate', 4],
      ['none', 1],
    ]);
  });

  it('a cost no record reported is not-reported, never 0', () => {
    const r = m('cost-per-success', { harness: 'codex' });
    expect(isNotReported(r.value)).toBe(true);
    expect(formatReported(r.value, (v: number) => `$${v}`)).toBe('not reported by Codex');
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(0);
  });

  it('tokens per successful task', () => {
    const r = m('tokens-per-success');
    expect(r.value).toBe((1000 + 2000 + 800 + 2000) / 4);
    expect(r.missing?.harnesses).toEqual(['codex']);
  });

  it('model distribution buckets attempts by model, with ids', () => {
    const r = m('model-distribution');
    expect(r.buckets?.map((b) => [b.key, b.count])).toEqual([
      ['sonnet', 4],
      ['opus', 3],
      ['gpt-5', 1],
    ]);
    expect(r.buckets?.find((b) => b.key === 'gpt-5')?.ids).toEqual(['attempt:c-1']);
    expect(r.denominator).toBe(8);
  });

  it('effort distribution', () => {
    expect(m('effort-distribution').buckets?.map((b) => b.key)).toEqual(['medium']);
  });

  it('verification rejection is failed over verified attempts', () => {
    const r = m('verification-rejection');
    expect([r.numerator, r.denominator]).toEqual([1, 3]);
    expect(r.numeratorIds).toEqual(['attempt:b-1']);
  });

  it('escalation cost is the cost of attempts after the first, of the total', () => {
    const r = m('escalation-cost');
    expect(r.value).toBe(3);
    expect(r.denominator).toBe(1 + 1 + 3 + 2 + 1 + 5);
    expect(r.numeratorIds).toEqual(['attempt:b-2']);
    expect(r.missing?.harnesses).toContain('codex');
  });

  it('active, queue and waiting time sum what was recorded', () => {
    expect(m('active-time').value).toBe(130_000);
    expect(m('queue-time').value).toBe(1_000);
    // Written only when there was a wait: attempts with an active time waited 0.
    const w = m('waiting-on-human');
    expect(w.value).toBe(0);
    expect(w.denominator).toBe(3);
  });

  it('retries, crashes and merge conflicts', () => {
    expect([m('retry-rate').numerator, m('retry-rate').denominator]).toEqual([1, 7]);
    const c = m('crashes');
    expect(c.numeratorIds).toEqual(['attempt:g-1']);
    const mc = m('merge-conflicts');
    expect([mc.numerator, mc.denominator]).toEqual([1, 2]);
    expect(mc.numeratorIds).toEqual(['integration:b-conflict']);
  });

  it('overrides, permission interruptions and human rescue', () => {
    const o = m('overrides');
    expect(o.numeratorIds.sort()).toEqual(['override:a-task', 'override:b-mission']);
    const p = m('permission-interruptions');
    expect(p.value).toBe(2);
    expect(p.missing?.harnesses).toEqual(['claude-code', 'codex']);
    const h = m('human-rescue');
    expect([h.numerator, h.denominator]).toEqual([1, 6]);
    expect(h.numeratorIds.sort()).toEqual(['attempt:other-e-1', 'escalation:other-e-end']);
  });

  it('a metric with nothing to measure has no value, not 0', () => {
    const r = m('eventual-success', { kind: 'nothing-like-this' });
    expect(r.value).toBeUndefined();
    expect(r.denominator).toBe(0);
  });
});

describe('filters and group-by', () => {
  const keys = (f: AnalyticsFilter) => filterTasks(ds(), f).map((t) => t.taskId).sort();

  it('filters by kind, tier (first route), effort, model, repository, harness and time', () => {
    expect(keys({ kind: 'docs' })).toEqual(['t-c', 't-d']);
    // b escalated to expert, but was routed standard.
    expect(keys({ tier: 'expert' })).toEqual(['t-d', 't-f']);
    expect(keys({ model: 'gpt-5' })).toEqual(['t-c']);
    expect(keys({ effort: 'medium' })).toHaveLength(7);
    expect(keys({ repository: '/Users/test/other' })).toEqual(['t-other-e']);
    expect(keys({ harness: 'codex' })).toEqual(['t-c']);
    expect(keys({ from: T0 + 30 * DAY })).toEqual(['t-f']);
    expect(keys({ to: T0 + 30 * DAY })).toHaveLength(6);
    expect(keys({ dimensions: { complexity: 'routine' } })).toEqual(['t-d']);
  });

  it('per-mission and per-task cohorts', () => {
    expect(keys({ missionId: 'm-b' })).toEqual(['t-b']);
    expect(keys({ taskKey: 'm-a|t-a' })).toEqual(['t-a']);
  });

  it('attempt metrics filter on the attempt\'s own route', () => {
    // b's second attempt ran on expert.
    expect(m('model-distribution', { tier: 'expert' }).ids.sort()).toEqual(['attempt:b-2', 'attempt:d-1', 'attempt:f-1']);
  });

  it('the headline metrics move with the filters', () => {
    expect(m('first-attempt-success', { kind: 'bugfix' }).value).toBe(0);
    expect(m('first-attempt-success', { kind: 'docs' }).value).toBe(1);
    expect(m('escalation-rate', { repository: '/Users/test/other' }).value).toBe(0);
  });

  it('a mission the store no longer has is in the unknown repository', () => {
    const d = buildDataset({ records: tasks({ task: 'x', mission: 'm-gone', attempts: [{ tier: 'basic' }] }), tiers: TIERS, repoOf });
    expect(taskGroupKey(d.tasks[0], 'repository')).toBe('unknown');
    expect(filterTasks(d, { repository: 'unknown' })).toHaveLength(1);
  });

  it('groups by any dimension, a metric per group', () => {
    const byKind = metricByGroup(ds(), {}, 'eventual-success', 'kind');
    expect(byKind.map((g) => [g.key, g.result.numerator, g.result.denominator])).toEqual([
      ['bugfix', 1, 1],
      ['docs', 2, 2],
      ['feature', 1, 2],
      ['test', 1, 1],
    ]);
    const byComplexity = groupBy(ds().tasks, (t) => taskGroupKey(t, 'dim:complexity'));
    expect(byComplexity.map((g) => g.key)).toEqual(['involved', 'routine']);
    const byTier = metricByGroup(ds(), {}, 'model-distribution', 'tier');
    expect(byTier.map((g) => g.key)).toEqual(['standard', 'expert']);
  });
});

describe('hosted vs local', () => {
  it('renders sensibly with no local records', () => {
    const s = hostedLocalSplit(ds(), {});
    expect(s.noLocal).toBe(true);
    expect(s.local.attempts).toBe(0);
    expect(s.local.successRate).toBeUndefined();
    expect(s.local.costUsd).toBeUndefined();
    expect(s.hosted.attempts).toBe(8);
    expect(s.hosted.succeeded).toBe(5);
  });

  it('splits attempts by where they ran, and counts direct local calls', () => {
    const records = [
      ...fleet(),
      ...tasks({ task: 'h', attempts: [{ tier: 'basic', costUsd: 0, local: { apiEquivalentUsd: 0.4 } }] }),
      localCall('1'),
      localCall('2', false),
    ];
    const s = hostedLocalSplit(ds(records), { location: 'hosted' });
    expect(s.noLocal).toBe(false);
    expect(s.local).toMatchObject({ attempts: 1, succeeded: 1, costUsd: 0, apiEquivalentUsd: 0.4, ids: ['attempt:h-1'] });
    expect(s.localCalls).toMatchObject({ total: 2, ok: 1 });
  });
});

describe('the calibration report', () => {
  const report = () => calibrationReport(ds(), {});

  it('lists under-routing: tasks that needed a tier or effort step, or a person', () => {
    const under = report().under.sort((x, y) => x.taskId.localeCompare(y.taskId));
    expect(under.map((e) => [e.taskId, e.reason])).toEqual([
      ['t-b', 'escalation'],
      ['t-other-e', 'rescue'],
    ]);
    const b = under[0];
    expect(b.heuristic).toBe(false);
    expect(b.triggers).toMatchObject({ tier: 'standard', steps: 'raise-tier→expert', after: 'quality-new', outcome: 'done' });
    expect(b.evidence).toEqual(['attempt:b-1', 'escalation:b-2', 'task-final:b']);
    expect(under[1].triggers.rescue).toBe('you stepped in, needed you');
    expect(under[1].evidence).toContain('escalation:other-e-end');
  });

  it('a blocked step is not an escalation', () => {
    const r = calibrationReport(ds(tasks({ task: 'z', attempts: [{ tier: 'standard', outcome: 'failed' }], blockedStep: 'raise-tier' })), {});
    expect(r.under).toEqual([]);
  });

  it('lists over-routing candidates, labelled heuristic, with the values that triggered them', () => {
    const over = report().over;
    expect(over.map((e) => [e.taskId, e.reason, e.heuristic])).toEqual([
      ['t-d', 'expert-small-diff', true],
      ['t-f', 'shadow-wanted-cheaper', true],
    ]);
    expect(over[0].triggers).toEqual({ tier: 'expert', complexity: 'routine', filesChanged: 1, lines: 10, firstAttemptPass: true });
    expect(over[0].evidence).toEqual(['attempt:d-1', 'task-final:d']);
    expect(over[1].triggers).toMatchObject({ router: 'standard · medium', ran: 'expert · medium', changed: 'tier, model' });
    expect(over[1].evidence).toEqual(['routing:f-1', 'attempt:f-1']);
  });

  it('a big diff on expert is not a candidate', () => {
    const r = calibrationReport(ds(tasks({ task: 'y', complexity: 'trivial', attempts: [{ tier: 'expert', git: { files: 12, lines: 900 } }] })), {});
    expect(r.over).toEqual([]);
  });

  it('assessor agreement by changed dimension, scope accuracy and assessor version', () => {
    const a = report().agreement;
    const tier = a.byDimension.find((r) => r.key === 'tier')!;
    expect(tier).toMatchObject({ decisions: 7, agreed: 6, evidence: ['routing:f-1'] });
    expect(a.byDimension.find((r) => r.key === 'effort')).toMatchObject({ agreed: 7, evidence: [] });
    expect(a.scopeAccuracy).toEqual({ mean: 0.75, n: 2, evidence: ['attempt:a-1', 'attempt:b-2'] });
    expect(a.byAssessorVersion.map((r) => [r.key, r.decisions, r.agreed])).toEqual([
      ['asm-2', 6, 5],
      ['asm-1', 1, 1],
    ]);
    expect(a.byAssessorVersion[0].meanScopeAccuracy).toBe(0.75);
  });

  it('follows the filters', () => {
    expect(calibrationReport(ds(), { kind: 'docs' }).under).toEqual([]);
    expect(calibrationReport(ds(), { kind: 'docs' }).over.map((e) => e.taskId)).toEqual(['t-d']);
  });
});

describe('not reported', () => {
  it('names the harness, never 0 or blank', () => {
    expect(notReportedText(['codex'])).toBe('not reported by Codex');
    expect(notReportedText(['claude-code', 'codex'])).toBe('not reported by Claude Code or Codex');
    expect(formatReported(undefined, String)).toBe('no data');
    expect(formatReported(0, (v: number) => `$${v.toFixed(2)}`)).toBe('$0.00');
  });
});

describe('the read-only index', () => {
  it('loads the analytics records from the monthly JSONL files, skipping turns without an attempt and torn lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-analytics-'));
    try {
      const lines = fleet().map((r) => JSON.stringify(r));
      const turn = (attemptId?: string) =>
        JSON.stringify({ v: 1, type: 'turn', at: T0, id: `turn:${attemptId ?? 'none'}`, sessionId: 's', harness: 'claude-code', source: 'anthropic', modelsUsed: {}, effort: {}, isError: false, costBasis: 'none', ...(attemptId ? { attemptId } : {}) });
      fs.writeFileSync(path.join(dir, '2026-09.jsonl'), [...lines.slice(0, 10), turn(), turn('a-a-1'), '{"torn'].join('\n'));
      fs.writeFileSync(path.join(dir, '2026-10.jsonl'), lines.slice(10).join('\n') + '\n');
      fs.writeFileSync(path.join(dir, 'state.json'), '{}');
      const index = new AnalyticsIndex();
      let fired = 0;
      index.onDidChange(() => fired++);
      await index.load(dir);
      expect(index.size).toBe(lines.length + 1);
      expect(index.records().some((r) => r.id === 'turn:none')).toBe(false);
      index.add(localCall('late'));
      expect(index.size).toBe(lines.length + 2);
      expect(fired).toBe(2);

      const evidence = new RoutingEvidenceIndex();
      await evidence.load(dir);
      expect(evidence.records().every((r) => r.type === 'routing' || r.type === 'attempt')).toBe(true);
      expect(evidence.size).toBe(fleet().filter((r) => r.type === 'routing' || r.type === 'attempt').length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing directory is an empty log', async () => {
    const index = new AnalyticsIndex();
    await index.load(path.join(os.tmpdir(), 'aw-analytics-does-not-exist'));
    expect(index.records()).toEqual([]);
  });
});
