import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionUsageIndex, addTurn } from '../src/core/telemetry/sessionUsageIndex';
import { monthFile } from '../src/core/telemetry/telemetryLog';
import { SessionStore } from '../src/core/sessionStore';
import type { TurnRecord } from '../src/shared/orchestration/telemetry';
import { formatTokens, formatUsd, usageCellText, usageHeaderText, usageTitle, type SessionUsage } from '../src/shared/sessionUsage';
import type { AgentSession } from '../src/shared/model';

const T = Date.UTC(2026, 8, 25, 12);

function turn(over: Partial<TurnRecord> & { id: string }): TurnRecord {
  return {
    v: 1,
    type: 'turn',
    at: T,
    sessionId: 'sess-1',
    harness: 'claude-code',
    source: 'anthropic',
    modelsUsed: { 'claude-opus-5': { in: 100, out: 50, cacheRead: 1000, cacheWrite: 10 } },
    effort: { requested: 'high', applied: 'high' },
    isError: false,
    costUsd: 0.5,
    costBasis: 'harness-estimate',
    ...over,
  };
}

function usageOf(records: TurnRecord[]): SessionUsage {
  let s: ReturnType<typeof addTurn> | undefined;
  for (const r of records) s = addTurn(s, r);
  return s!.usage;
}

describe('formatters', () => {
  it('formats tokens and dollars compactly', () => {
    expect([940, 1234, 12_300, 340_000, 3_100_000, 31_000_000].map(formatTokens)).toEqual(['940', '1.2k', '12k', '340k', '3.1M', '31M']);
    expect([0.004, 1.936, 24.19, 145.2].map(formatUsd)).toEqual(['<$0.01', '$1.94', '$24.2', '$145']);
  });

  it('always says the cost basis, and "not reported" rather than zero', () => {
    const claude = usageOf([turn({ id: 'a' })]);
    expect(usageCellText(claude)).toBe('1.2k tok · $0.50 est');
    const codex = usageOf([turn({ id: 'b', harness: 'codex', costUsd: undefined, costBasis: 'none', modelsUsed: { 'gpt-x': { in: 3000, out: 200, cacheRead: 2500 } } })]);
    expect(usageCellText(codex)).toBe('3.2k tok · cost not reported');
    expect(usageTitle(codex)).toMatch(/reports no cost/);
    const priced = usageOf([turn({ id: 'c', harness: 'codex', costUsd: 0.2, costBasis: 'price-table' })]);
    expect(usageCellText(priced)).toMatch(/\$0\.20 priced$/);
  });

  it('marks a partial cost as a lower bound', () => {
    const u = usageOf([turn({ id: 'a' }), turn({ id: 'b', costUsd: undefined, costBasis: 'none' })]);
    expect(u.uncostedTurns).toBe(1);
    expect(usageCellText(u)).toBe('2.3k tok · $0.50+ est');
    expect(usageTitle(u)).toMatch(/lower bound/);
  });

  it('a session whose every turn lacked usage says so', () => {
    const u = usageOf([turn({ id: 'a', modelsUsed: {}, usageUnknown: 'zeroed totals', costUsd: undefined, costBasis: 'none' })]);
    expect(usageCellText(u)).toBe('usage not reported');
  });

  it('the header names models and effort, with "unknown" where not reported', () => {
    const both = usageOf([turn({ id: 'a' })]);
    expect(usageHeaderText(both, (id) => (id === 'claude-opus-5' ? 'Opus 5' : id))).toBe('Opus 5 · effort high · 1.2k tok · $0.50 est');
    const downgraded = usageOf([turn({ id: 'a', effort: { requested: 'max', applied: 'high' } })]);
    expect(usageHeaderText(downgraded)).toContain('effort max → high');
    const unknown = usageOf([turn({ id: 'a', effort: { requested: 'high' } })]);
    expect(usageHeaderText(unknown)).toContain('effort high → unknown');
    const none = usageOf([turn({ id: 'a', effort: {} })]);
    expect(usageHeaderText(none)).toContain('effort unknown');
  });
});

describe('addTurn', () => {
  it('sums tokens once per convention: Claude adds cache, Codex already counts it in input', () => {
    expect(usageOf([turn({ id: 'a' })]).tokens.total).toBe(1160);
    expect(usageOf([turn({ id: 'a', harness: 'codex', modelsUsed: { m: { in: 3000, out: 200, cacheRead: 2500 } } })]).tokens.total).toBe(3200);
  });

  it('orders models by output, takes the latest effort, and counts a record once', () => {
    const u = usageOf([
      turn({ id: 'a', modelsUsed: { haiku: { in: 1, out: 5 } }, effort: { requested: 'low' } }),
      turn({ id: 'b', at: T + 1, modelsUsed: { opus: { in: 1, out: 50 } } }),
      turn({ id: 'b', at: T + 1, modelsUsed: { opus: { in: 1, out: 50 } } }),
    ]);
    expect(u.turns).toBe(2);
    expect(u.models).toEqual(['opus', 'haiku']);
    expect(u.effort).toEqual({ requested: 'high', applied: 'high' });
  });

  it('mixed bases say so, and a gap-covering record is remembered', () => {
    const u = usageOf([turn({ id: 'a', coversGap: true }), turn({ id: 'b', costBasis: 'price-table' })]);
    expect(u.costBasis).toBe('mixed');
    expect(u.coversGap).toBe(true);
    expect(u.costUsd).toBe(1);
  });
});

describe('SessionUsageIndex', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('loads this month and last month, skips torn lines, and does not double count live records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'));
    dirs.push(dir);
    const last = Date.UTC(2026, 7, 20);
    fs.writeFileSync(monthFile(dir, last), `${JSON.stringify(turn({ id: 'old', at: last }))}\n`);
    fs.writeFileSync(monthFile(dir, T), `${JSON.stringify(turn({ id: 'a' }))}\n{"torn":`);
    const index = new SessionUsageIndex();
    let fired = 0;
    index.onDidChange(() => fired++);
    await index.load(dir, T);
    expect(index.get('SESS-1')?.turns).toBe(2);
    expect(fired).toBe(1);
    index.add(turn({ id: 'a' }));
    expect(index.get('sess-1')?.turns).toBe(2);
    expect(fired).toBe(1);
    index.add(turn({ id: 'c' }));
    expect(index.get('sess-1')?.turns).toBe(3);
    expect(index.get('other')).toBeUndefined();
  });
});

describe('SessionStore usage decoration', () => {
  function session(id: string): AgentSession {
    return { provider: 'claude', sessionId: id, key: `claude:${id}`, title: 't', cwd: '/Users/test/proj', status: 'done', lastActivityAt: 1 } as AgentSession;
  }

  it('puts usage on sessions that have records, nothing on those that do not, and fires on change', async () => {
    const store = new SessionStore();
    const index = new SessionUsageIndex();
    store.useUsage((id) => index.get(id));
    await store.register({
      id: 'claude',
      displayName: 'Claude',
      scan: async () => [session('sess-1'), session('sess-2')],
      start: async () => undefined,
      refresh: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    } as never);
    expect(store.get('claude:sess-1')?.usage).toBeUndefined();
    const upserts: string[][] = [];
    store.onDidUpdate((u) => upserts.push(u.upserted.map((s) => s.key)));
    index.add(turn({ id: 'a' }));
    store.usageApplied();
    expect(store.get('claude:sess-1')?.usage?.turns).toBe(1);
    expect(store.get('claude:sess-2')?.usage).toBeUndefined();
    expect(upserts).toEqual([['claude:sess-1']]);
    store.usageApplied();
    expect(upserts).toHaveLength(1);
  });
});
