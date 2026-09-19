import { describe, expect, it } from 'vitest';
import { parseCodexRateLimits } from '../src/codex/usage';

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
