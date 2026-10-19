/**
 * Whole-mission simulation (#48, plan §26.3): hundreds of generated missions
 * (random dependency graphs × random injected failures) and named scenarios
 * run to the end on a fake clock, with the invariants checked at every step.
 * See `missionSim.ts`. A failure names its seed: `AW_SIM_SEED=<n>` reruns that
 * mission alone, and `generateSpec(<n>)` rebuilds it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSimScenario } from '../../src/shared/orchestration/simulation';
import { generateSpec, runMissionSim, type MissionSimSpec } from './missionSim';

const MISSIONS = 1000;
const DIR = join(__dirname, 'fixtures', 'mission-sims');

const named = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as MissionSimSpec);

describe('named mission scenarios', () => {
  for (const spec of named) {
    it(spec.name, () => {
      parseSimScenario(spec.scenario);
      runMissionSim(spec);
    });
  }
});

describe('generated missions', () => {
  const only = process.env.AW_SIM_SEED ? Number(process.env.AW_SIM_SEED) : undefined;

  it(`${MISSIONS} missions hold every invariant, in well under a minute`, () => {
    const started = Date.now();
    const seeds = only !== undefined ? [only] : Array.from({ length: MISSIONS }, (_, i) => i + 1);
    const outcomes = { completed: 0, stuck: 0, cancelled: 0 };
    let escalations = 0;
    let parallel = 0;
    for (const seed of seeds) {
      const spec = generateSpec(seed);
      const result = runMissionSim(spec);
      const states = Object.values(result.tasks);
      if (spec.cancelAtSec !== undefined && states.includes('cancelled')) outcomes.cancelled++;
      else if (states.every((s) => s === 'done')) outcomes.completed++;
      else outcomes.stuck++;
      escalations += result.records.filter((r) => r.type === 'escalation').length;
      parallel = Math.max(parallel, result.maxParallel);
    }
    if (only === undefined) {
      // The generator really does exercise failures, escalation and parallelism.
      expect(outcomes.completed).toBeGreaterThan(MISSIONS / 5);
      expect(outcomes.stuck).toBeGreaterThan(MISSIONS / 20);
      expect(escalations).toBeGreaterThan(MISSIONS);
      expect(parallel).toBeGreaterThan(1);
      expect(Date.now() - started).toBeLessThan(60_000);
    }
  }, 120_000);

  it('a seed reproduces: the same mission, the same trace, the same records', () => {
    for (const seed of [3, 41, 187, 402]) {
      expect(generateSpec(seed)).toEqual(generateSpec(seed));
      const a = runMissionSim(generateSpec(seed));
      const b = runMissionSim(generateSpec(seed));
      expect(b.trace).toEqual(a.trace);
      expect(b.records).toEqual(a.records);
    }
  });

  it('a broken invariant names the seed that broke it', () => {
    const spec = generateSpec(7);
    // A scheduler limit the spec cannot honour: a mission needing two at once under a global cap of one.
    const broken: MissionSimSpec = { ...spec, seed: 7, expect: { tasks: { t0: 'cancelled' }, mission: 'cancelled' } };
    expect(() => runMissionSim(broken)).toThrow(/^seed 7 \(generateSpec\(7\)\): /);
  });
});
