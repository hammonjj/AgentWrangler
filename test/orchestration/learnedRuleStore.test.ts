/**
 * What a person decided on routing proposals, and what the Analytics view
 * shows of it (#52): accept, reject and revoke survive a restart; a refused or
 * damaged rule is never applied; the view always says why there is nothing to
 * propose.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyticsDetail, analyticsView } from '../../src/shared/orchestration/analyticsView';
import { generateProposals, ruleFromProposal } from '../../src/shared/orchestration/routingProposals';
import { buildDataset } from '../../src/shared/orchestration/analytics';
import { LearnedRuleStore } from '../../src/orchestration/policy/learnedRuleStore';
import { proposalVeto } from '../../src/orchestration/policy/learnedVeto';
import { DAY, repoOf, T0, taskRecords, TIERS, type TaskSpec } from './analyticsFixtures';

const NOW = T0 + 200 * DAY;
const specs: TaskSpec[] = Array.from({ length: 20 }, (_, i) => ({
  task: `p${i}`,
  kind: 'test',
  complexity: 'routine',
  verifiability: 'strong',
  risk: 'low',
  attempts: [{ tier: 'basic' }],
  router: { tier: 'standard', effort: 'medium', changed: ['tier' as const] },
  day: i,
}));
const records = specs.flatMap(taskRecords);
const proposal = generateProposals(buildDataset({ records, tiers: TIERS, repoOf }), { now: NOW, tiers: ['basic', 'standard', 'expert'] })[0];

function tmp(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-learned-')), 'orchestration', 'learned-rules.json');
}

describe('LearnedRuleStore', () => {
  it('keeps an accepted rule with its evidence across a restart, and revoking removes it', () => {
    const file = tmp();
    const a = new LearnedRuleStore(file);
    const r = a.accept(proposal, NOW);
    expect(r.ok).toBe(true);
    const b = new LearnedRuleStore(file);
    expect(b.rules()).toHaveLength(1);
    expect(b.rules()[0].evidence.observations).toBe(20);
    expect(b.revoke(proposal.id)).toBe(true);
    expect(new LearnedRuleStore(file).rules()).toEqual([]);
    expect(b.revoke(proposal.id)).toBe(false);
  });

  it('remembers a rejection, and accepting later clears it', () => {
    const file = tmp();
    const s = new LearnedRuleStore(file);
    s.reject(proposal.id, NOW);
    expect(new LearnedRuleStore(file).rejected()).toEqual([{ id: proposal.id, rejectedAt: NOW }]);
    s.accept(proposal, NOW + 1);
    expect(s.rejected()).toEqual([]);
  });

  it('refuses a proposal the veto refuses, and writes nothing', () => {
    const file = tmp();
    const s = new LearnedRuleStore(file);
    const bad = { ...proposal, cohort: { ...proposal.cohort, verifiability: 'none-weak' as const } };
    const r = s.accept(bad, NOW);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores a damaged file whole, and a hand-edited rule the veto refuses', () => {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(new LearnedRuleStore(file).rules()).toEqual([]);
    const bad = ruleFromProposal({ ...proposal, cohort: { ...proposal.cohort, verifiability: 'none-weak' } }, NOW);
    expect(proposalVeto(bad).length).toBeGreaterThan(0);
    fs.writeFileSync(file, JSON.stringify({ version: 1, rules: [bad, ruleFromProposal(proposal, NOW)], rejected: [] }));
    const logged: string[] = [];
    expect(new LearnedRuleStore(file, undefined, (l) => logged.push(l)).rules().map((r) => r.id)).toEqual([proposal.id]);
    expect(logged.join('\n')).toMatch(/ignoring downgrade:/);
  });

  it('notifies listeners on every decision', () => {
    const s = new LearnedRuleStore(tmp());
    let n = 0;
    s.onDidChange(() => n++);
    s.reject('x', NOW);
    s.accept(proposal, NOW);
    s.revoke(proposal.id);
    expect(n).toBe(3);
  });
});

describe('the Analytics view of proposals', () => {
  const input = { records, tiers: TIERS, repoOf, selection: {}, now: NOW, proposals: { rules: [], rejected: [], tiers: ['basic', 'standard', 'expert'], veto: proposalVeto } };

  it('shows a pending proposal with cohort, counts, interval and window, and its evidence in the detail', () => {
    const v = analyticsView(input).proposals;
    expect(v.pending).toHaveLength(1);
    expect(v.pending[0]).toMatchObject({ direction: 'downgrade', counts: '20 of 20 passed first time on basic' });
    expect(v.pending[0].interval).toMatch(/^\d+%–\d+% \(90% interval\)$/);
    expect(v.pending[0].window).toMatch(/^\d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/);
    expect(v.pending[0].refused).toBeUndefined();
    const d = analyticsDetail(input, v.pending[0].ref);
    expect(d?.facts.map((f) => f.label)).toEqual(expect.arrayContaining(['Cohort', 'Passed first time', 'Success rate', 'Data window']));
    expect(d?.evidenceTotal).toBeGreaterThan(0);
  });

  it('moves an accepted proposal to the rules, with its evidence, and stops proposing it', () => {
    const rule = ruleFromProposal(proposal, NOW);
    const v = analyticsView({ ...input, proposals: { ...input.proposals, rules: [rule] } }).proposals;
    expect(v.pending).toEqual([]);
    expect(v.rules).toHaveLength(1);
    expect(v.rules[0].evidence).toMatch(/20 of 20 passed first time on basic/);
    expect(analyticsDetail({ ...input, proposals: { ...input.proposals, rules: [rule] } }, v.rules[0].ref)?.title).toBe('Accepted routing rule');
  });

  it('says why there is nothing to propose when the history is thin', () => {
    const v = analyticsView({ ...input, records: records.slice(0, 20) }).proposals;
    expect(v.pending).toEqual([]);
    expect(v.note).toMatch(/Nothing to propose yet: .*at least 20 observations/);
  });
});
