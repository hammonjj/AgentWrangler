/**
 * The relay benchmark's report (#194): `npm run bench:relay` writes the matrix to
 * `docs/relay-benchmark-results.md`. Skipped in an ordinary test run; the gates in
 * `relayBenchmark.test.ts` are what CI holds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILES, runScenario, type Scenario, type ScenarioResult } from './bench/relaySim';
import { measureCodec } from './bench/measureCodec';
import { matrix, renderReport } from './bench/relayReport';

const out = process.env.RELAY_BENCH_REPORT;

describe.skipIf(!out)('relay benchmark report', () => {
  it('runs the matrix and writes the report', async () => {
    const results: ScenarioResult[] = [];
    for (const scenario of matrix()) results.push(await runScenario(scenario));
    const codec = await measureCodec();
    const text = renderReport(results, codec);
    const file = path.resolve(out === '1' ? 'docs/relay-benchmark-results.md' : out!);
    fs.writeFileSync(file, text);
    expect(results.length).toBeGreaterThan(0);
    void PROFILES;
    void ({} as Scenario);
  }, 120_000);
});
