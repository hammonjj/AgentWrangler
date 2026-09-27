/**
 * The planning corpus (#44, plan §27, §29 P8): synthetic, public-safe
 * objectives over made-up repositories, each saying whether a split is ever
 * right for it. Most are **"should not split"**: the planner's default is one
 * task, and these are the cases where anything else is over-decomposition.
 *
 * Unlike the routing corpus, a card's repository is file *contents*: the live
 * evaluation writes them to a temporary directory for the planner to read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PlanCheckContext, PlannerOutput } from '../../src/orchestration/policy/planner';
import { checkPlan } from '../../src/orchestration/policy/planner';

export const PLANNING_CORPUS_DIR = path.join(__dirname, '..', 'fixtures', 'planning-corpus');

export interface PlanningCard {
  id: string;
  case: string;
  objective: string;
  repo: {
    /** Repository-relative path → contents. */
    files: Record<string, string>;
    /** Verification command names the repository's policy defines. */
    verification: string[];
  };
  /** `never`: one task is the only right answer. `allowed`: a split may pay, up to `maxTasks`. */
  expect: { split: 'never' | 'allowed'; maxTasks?: number };
}

export function planningCardProblems(c: PlanningCard, file: string): string[] {
  const out: string[] = [];
  if (`${c.id}.json` !== path.basename(file)) out.push(`id: ${c.id} does not match the file name`);
  if (!c.case?.trim()) out.push('case: missing');
  if (!c.objective?.trim()) out.push('objective: missing');
  const files = Object.keys(c.repo?.files ?? {});
  if (files.length === 0) out.push('repo.files: empty');
  for (const f of files) {
    if (f.startsWith('/') || f.split('/').includes('..')) out.push(`repo.files: ${f} is not a relative path inside the repository`);
  }
  if (!['never', 'allowed'].includes(c.expect?.split)) out.push('expect.split: must be never or allowed');
  if (c.expect?.split === 'allowed' && !(Number(c.expect.maxTasks) >= 2)) out.push('expect.maxTasks: an allowed split needs a limit of at least 2');
  return out;
}

export function loadPlanningCorpus(dir = PLANNING_CORPUS_DIR): PlanningCard[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PlanningCard);
}

/** Write the card's repository into `root`. */
export function materialise(c: PlanningCard, root: string): void {
  for (const [rel, text] of Object.entries(c.repo.files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

export function cardContext(c: PlanningCard, cap = 8): PlanCheckContext {
  return { cap, strategies: c.repo.verification };
}

/** Why a plan is wrong for the card: too many tasks, or a plan the validator refuses. Empty when it is right. */
export function planMisses(c: PlanningCard, plan: PlannerOutput): string[] {
  const out: string[] = [];
  const n = plan.tasks.length;
  if (c.expect.split === 'never' && n !== 1) out.push(`${c.id}: ${n} tasks for a should-not-split objective`);
  if (c.expect.split === 'allowed' && n > (c.expect.maxTasks ?? 1)) out.push(`${c.id}: ${n} tasks, more than ${c.expect.maxTasks}`);
  out.push(...checkPlan(plan, cardContext(c)).problems.map((p) => `${c.id}: ${p}`));
  return out;
}
