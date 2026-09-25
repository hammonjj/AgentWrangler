import { describe, expect, it } from 'vitest';
import { claudeTurnUsage, codexTurnUsage, priceCost, type SegmentState } from '../../src/core/telemetry/turnUsage';

const T = 1_790_000_000_000;

/** A Claude `result` with cumulative totals, as the SDK sends them. */
function result(uuid: string, cost: number, models: Record<string, [number, number, number?, number?]>) {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    total_cost_usd: cost,
    modelUsage: Object.fromEntries(
      Object.entries(models).map(([m, [i, o, cr = 0, cw = 0]]) => [
        m,
        { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, costUSD: cost, webSearchRequests: 0, contextWindow: 200000, maxOutputTokens: 32000 },
      ]),
    ),
  };
}

function run(results: unknown[], opts: { resetBefore?: number; start?: SegmentState } = {}) {
  let state = opts.start;
  return results.map((r, i) => {
    if (i === opts.resetBefore && state) state = { ...state, resetPending: true };
    const u = claudeTurnUsage(state, r, T + i);
    if (u.kind !== 'duplicate') state = u.next;
    return u;
  });
}

describe('claudeTurnUsage', () => {
  it('differences cumulative totals, per model', () => {
    const [a, b] = run([
      result('r1', 0.1, { opus: [100, 10, 1000] }),
      result('r2', 0.25, { opus: [150, 30, 1500], haiku: [20, 5] }),
    ]);
    expect(a).toMatchObject({ kind: 'usage', costUsd: 0.1, modelsUsed: { opus: { in: 100, out: 10, cacheRead: 1000 } } });
    expect(b).toMatchObject({ kind: 'usage', costUsd: 0.15, modelsUsed: { opus: { in: 50, out: 20, cacheRead: 500 }, haiku: { in: 20, out: 5 } } });
  });

  it('a result seen again (a reattach replays it) records nothing', () => {
    const r = result('r1', 0.1, { opus: [100, 10] });
    const first = claudeTurnUsage(undefined, r, T);
    if (first.kind !== 'usage') throw new Error('expected usage');
    expect(claudeTurnUsage(first.next, r, T + 1)).toEqual({ kind: 'duplicate' });
  });

  it('zeroed totals are no data, and the baseline survives them', () => {
    const [, zero, after] = run([
      result('r1', 0.1, { opus: [100, 10] }),
      result('r2', 0, { opus: [0, 0] }),
      result('r3', 0.2, { opus: [200, 20] }),
    ]);
    expect(zero).toMatchObject({ kind: 'no-data', why: 'zeroed totals' });
    expect(after).toMatchObject({ kind: 'usage', costUsd: 0.1, modelsUsed: { opus: { in: 100, out: 10 } } });
  });

  it('totals that go down without a reset are no data, never subtracted, and re-baseline', () => {
    const [, down, after] = run([
      result('r1', 0.5, { opus: [500, 50] }),
      result('r2', 0.1, { opus: [100, 10] }),
      result('r3', 0.15, { opus: [150, 15] }),
    ]);
    expect(down).toMatchObject({ kind: 'no-data', why: 'totals went down without a reset' });
    expect(after).toMatchObject({ kind: 'usage', costUsd: 0.05, modelsUsed: { opus: { in: 50, out: 5 } } });
  });

  it('after /clear the drop is expected: the turn counts from zero', () => {
    const [, cleared] = run([result('r1', 0.5, { opus: [500, 50] }), result('r2', 0.1, { opus: [100, 10] })], { resetBefore: 1 });
    expect(cleared).toMatchObject({ kind: 'usage', costUsd: 0.1, modelsUsed: { opus: { in: 100, out: 10 } } });
  });

  it('a /clear that did not actually reset the totals is differenced normally', () => {
    const [, same] = run([result('r1', 0.5, { opus: [500, 50] }), result('r2', 0.6, { opus: [600, 60] })], { resetBefore: 1 });
    expect(same).toMatchObject({ kind: 'usage', costUsd: 0.1, modelsUsed: { opus: { in: 100, out: 10 } } });
  });

  it('a new execution (resume, migration) starts from zero', () => {
    // The caller keys state by execution, so a new one has no state.
    expect(claudeTurnUsage(undefined, result('r9', 0.02, { sonnet: [30, 3] }), T)).toMatchObject({
      kind: 'usage',
      costUsd: 0.02,
      coversGap: false,
      modelsUsed: { sonnet: { in: 30, out: 3 } },
    });
  });

  it('the first turn after a restart, against a baseline from disk, may cover a gap', () => {
    const start: SegmentState = { totals: { models: { opus: { in: 100, out: 10 } }, costUsd: 0.1 }, lastId: 'r1', fromDisk: true, updatedAt: T };
    const [replayed, next, later] = run(
      [result('r1', 0.1, { opus: [100, 10] }), result('r5', 0.4, { opus: [400, 40] }), result('r6', 0.5, { opus: [500, 50] })],
      { start },
    );
    expect(replayed).toEqual({ kind: 'duplicate' });
    expect(next).toMatchObject({ kind: 'usage', coversGap: true, costUsd: 0.3 });
    expect(later).toMatchObject({ kind: 'usage', coversGap: false, costUsd: 0.1 });
  });

  it('a result with no usage is no data', () => {
    expect(claudeTurnUsage(undefined, { type: 'result', uuid: 'x' }, T)).toMatchObject({ kind: 'no-data' });
  });

  it('never produces floating-point noise', () => {
    const [, b] = run([result('r1', 0.1, { opus: [1, 1] }), result('r2', 0.3, { opus: [2, 2] })]);
    expect(b).toMatchObject({ costUsd: 0.2 });
  });
});

/** A Codex turn end as `CodexRunner` emits it. */
function codex(turnId: string, total: [number, number], last?: [number, number], usageTurnId = turnId) {
  const b = ([i, o]: [number, number]) => ({ totalTokens: i + o, inputTokens: i, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: o, reasoningOutputTokens: 0 });
  return {
    threadId: 'th-1',
    turn: { id: turnId, status: 'completed', error: null, durationMs: 1200 },
    model: 'gpt-x',
    usageUpdate: { turnId: usageTurnId, tokenUsage: { total: b(total), last: last ? b(last) : undefined, modelContextWindow: 200000 } },
  };
}

describe('codexTurnUsage', () => {
  it('uses the per-turn figure when there is no baseline, then differences the total', () => {
    const a = codexTurnUsage(undefined, codex('t1', [100, 10], [100, 10]), T);
    expect(a).toMatchObject({ kind: 'usage', coversGap: false, modelsUsed: { 'gpt-x': { in: 100, out: 10 } } });
    if (a.kind !== 'usage') throw new Error('expected usage');
    const b = codexTurnUsage(a.next, codex('t2', [180, 25], [80, 15]), T + 1);
    expect(b).toMatchObject({ kind: 'usage', coversGap: false, modelsUsed: { 'gpt-x': { in: 80, out: 15 } } });
  });

  it('a total that grew by more than the last turn covers turns nobody saw', () => {
    const a = codexTurnUsage(undefined, codex('t1', [100, 10], [100, 10]), T);
    if (a.kind !== 'usage') throw new Error('expected usage');
    const b = codexTurnUsage(a.next, codex('t4', [400, 40], [50, 5]), T + 1);
    expect(b).toMatchObject({ kind: 'usage', coversGap: true, modelsUsed: { 'gpt-x': { in: 300, out: 30 } } });
  });

  it('no usage reported, or usage for another turn and no baseline, is no data', () => {
    expect(codexTurnUsage(undefined, { threadId: 'th-1', turn: { id: 't1' } }, T)).toMatchObject({ kind: 'no-data', why: 'no token usage reported' });
    expect(codexTurnUsage(undefined, codex('t2', [100, 10], [100, 10], 't1'), T)).toMatchObject({ kind: 'no-data' });
  });

  it('the same turn twice records once', () => {
    const a = codexTurnUsage(undefined, codex('t1', [100, 10], [100, 10]), T);
    if (a.kind !== 'usage') throw new Error('expected usage');
    expect(codexTurnUsage(a.next, codex('t1', [100, 10], [100, 10]), T + 1)).toEqual({ kind: 'duplicate' });
  });
});

describe('priceCost', () => {
  it('prices known models and refuses to guess for unknown ones', () => {
    const prices = { 'gpt-x': { inPerMTok: 2, outPerMTok: 8, cacheReadPerMTok: 0.5 } };
    expect(priceCost(prices, { 'gpt-x': { in: 1_000_000, out: 500_000, cacheRead: 400_000 } })).toBe(0.6 * 2 + 0.4 * 0.5 + 0.5 * 8);
    expect(priceCost(prices, { other: { in: 1 } })).toBeUndefined();
    expect(priceCost(undefined, { 'gpt-x': { in: 1 } })).toBeUndefined();
  });
});
