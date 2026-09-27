/**
 * The planning corpus is well formed, and the scoring means what it says
 * (#44). The live run is `planningCorpus.live.test.ts`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlannedTask } from '../../src/orchestration/policy/planner';
import { PLANNING_CORPUS_DIR, loadPlanningCorpus, materialise, planMisses, planningCardProblems } from './planningCorpus';

const corpus = loadPlanningCorpus();

function t(key: string, paths: string[], deps: string[] = []): PlannedTask {
  return {
    key,
    title: key,
    objective: key,
    acceptanceCriteria: ['checked'],
    scope: { paths, subsystems: [] },
    dependsOn: deps.map((d) => ({ key: d, kind: 'code' })),
    verification: [],
    assessmentHints: { kind: 'feature', complexity: 'involved', risk: 'low' },
    whySeparate: paths.length ? 'disjoint files' : '',
  };
}

describe('planning corpus', () => {
  it('has cards, most of them "should not split"', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    expect(corpus.filter((c) => c.expect.split === 'never').length).toBeGreaterThan(corpus.length / 2);
  });

  it.each(corpus.map((c) => [c.id, c] as const))('%s is well formed', (id, c) => {
    expect(planningCardProblems(c, path.join(PLANNING_CORPUS_DIR, `${id}.json`))).toEqual([]);
  });

  it('writes a card’s repository to disk for the planner to read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-plancorpus-'));
    try {
      materialise(corpus[0], dir);
      for (const rel of Object.keys(corpus[0].repo.files)) expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scores one task as right for a should-not-split card, and two as a miss', () => {
    const c = corpus.find((x) => x.expect.split === 'never')!;
    expect(planMisses(c, { decomposition: 'single', risks: [], tasks: [t('t1', [])] })).toEqual([]);
    expect(planMisses(c, { decomposition: 'multiple', risks: [], tasks: [t('t1', ['a/**']), t('t2', ['b/**'], ['t1'])] })[0]).toMatch(/2 tasks for a should-not-split objective/);
  });
});
