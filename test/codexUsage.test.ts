import { describe, expect, it } from 'vitest';
import { codexRateLimitStoppages, parseCodexRateLimits } from '../src/codex/usage';

describe('parseCodexRateLimits', () => {
  it('maps primary and secondary App Server windows to usage cards', () => {
    const parsed = parseCodexRateLimits({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 48, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
      rateLimitsByLimitId: null,
    }, 123);

    expect(parsed).toEqual({
      fetchedAtMs: 123,
      // Settled, not unreported: Codex has no extra-usage counterpart, so there
      // is never anything for the service to carry forward. See `spendKnown`.
      spendKnown: true,
      windows: [
        { id: 'codex:primary', label: '5hr', percent: 21, resetsAtMs: 1_800_000_000_000, active: false },
        { id: 'codex:secondary', label: '1 week', percent: 48, resetsAtMs: 1_800_500_000_000, active: false },
      ],
    });
  });

  it('uses named labels when the response has multiple quota buckets', () => {
    const parsed = parseCodexRateLimits({
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 10, windowDurationMins: 300 } },
        review: { limitId: 'review', limitName: 'Review', primary: { usedPercent: 30, windowDurationMins: 1_440 } },
      },
    }, 123);
    expect(parsed?.windows.map((window) => window.label)).toEqual(['Codex · 5hr', 'Review · 1 day']);
  });
});

describe('codexRateLimitStoppages', () => {
  it('reports nothing when every window is under its limit', () => {
    const stoppages = codexRateLimitStoppages({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 80 }, secondary: { usedPercent: 30 } },
    });
    expect(stoppages).toEqual([]);
  });

  it('classifies a primary window at 100% as a stoppage, with its reset time', () => {
    const stoppages = codexRateLimitStoppages({
      rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 100, resetsAt: 1_800_000_000 } },
    });
    expect(stoppages).toHaveLength(1);
    expect(stoppages[0]).toMatchObject({ provider: 'codex', category: 'codex-primary', reason: 'Codex', resetAtMs: 1_800_000_000_000 });
  });

  it('classifies a secondary window over 100% as a stoppage too', () => {
    const stoppages = codexRateLimitStoppages({
      rateLimits: { secondary: { usedPercent: 100 } },
    });
    expect(stoppages).toHaveLength(1);
    expect(stoppages[0]).toMatchObject({ provider: 'codex', category: 'codex-secondary' });
  });

  it('does not fabricate a stoppage from a merely high percent', () => {
    const stoppages = codexRateLimitStoppages({
      rateLimits: { primary: { usedPercent: 99 } },
    });
    expect(stoppages).toEqual([]);
  });
});
