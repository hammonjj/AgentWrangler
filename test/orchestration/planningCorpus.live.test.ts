/**
 * The live planner evaluation (#44 acceptance, plan §29 P8): every planning
 * corpus card through the real planner — the expert model, reading the card's
 * repository written to a temporary directory — and scored: a "should not
 * split" objective must come back as **one task**, and an "allowed" one within
 * its limit, with no plan the validator refuses.
 *
 * Opt-in (`AW_LIVE_PLANNER=1`): it spends an expert-model call (or two, with
 * the repair round) per card. What is printed is ids and counts only.
 *
 *   AW_LIVE_PLANNER=1 npx vitest run test/orchestration/planningCorpus.live.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { resolveClaudeBinary } from '../../src/claude/binary';
import { ClaudeStructuredCompletion, type CompletionQueryFn } from '../../src/orchestration/completion/structuredCompletion';
import { Planner } from '../../src/orchestration/policy/planner';
import { loadPlanningCorpus, materialise, planMisses } from './planningCorpus';

const live = process.env.AW_LIVE_PLANNER === '1';
/** Calls at once. Small: this is a subscription, not a batch API. */
const PARALLEL = 2;

describe.skipIf(!live)('planning corpus: live planner evaluation', () => {
  it('proposes one task for every should-not-split objective', async () => {
    const corpus = loadPlanningCorpus();
    const planner = new Planner({
      completion: new ClaudeStructuredCompletion({ query: sdkQuery as CompletionQueryFn, binary: () => resolveClaudeBinary('') }),
    });
    const lines: string[] = [];
    const misses: string[] = [];
    let cost = 0;
    const queue = [...corpus];
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aw-plan-${c.id}-`)));
          try {
            materialise(c, dir);
            const r = await planner.plan({ objective: c.objective, cwd: dir, strategies: c.repo.verification, cap: 8 });
            cost += r.rounds.reduce((s, x) => s + (x.costUsd ?? 0), 0);
            if (!r.ok) {
              misses.push(`${c.id}: planning failed`);
              lines.push(`${c.id}: failed after ${r.rounds.length} round(s)`);
              continue;
            }
            misses.push(...planMisses(c, r.plan));
            lines.push(`${c.id}: ${r.plan.tasks.length} task(s), ${r.rounds.length} round(s), ${r.warnings.length} warning(s) [expect ${c.expect.split}]`);
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      }),
    );
    console.log([`planner ${planner.model}/${planner.effort}`, ...lines.sort(), `cost: $${cost.toFixed(2)}`].join('\n'));
    expect(misses).toEqual([]);
  }, 1_800_000);
});
