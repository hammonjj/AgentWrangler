import { describe, expect, it } from 'vitest';
import {
  parseUsage,
  resetsInText,
  spendText,
  usageErrorText,
  usageSeverity,
  usageSummaryLine,
} from '../src/shared/usage';

const NOW = Date.parse('2026-09-11T04:00:00.000Z');

/** Trimmed from a real GET /api/oauth/usage response (Claude Code 2.1.x, a Max 5x account). */
const LIVE_BODY = {
  five_hour: { utilization: 54.0, resets_at: '2026-09-11T08:20:00.976906+00:00', locked_reason: null },
  seven_day: { utilization: 49.0, resets_at: '2026-09-11T16:00:00.976928+00:00', locked_reason: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 0.0 },
  limits: [
    { kind: 'session', group: 'session', percent: 54, severity: 'normal', resets_at: '2026-09-11T08:20:00.976906+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 49, severity: 'normal', resets_at: '2026-09-11T16:00:00.976928+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 55,
      severity: 'normal',
      resets_at: '2026-09-11T16:00:00.977194+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 100000, currency: 'USD', exponent: 2 },
    percent: 0,
    severity: 'normal',
    enabled: true,
  },
};

describe('parseUsage', () => {
  it('reads the three windows off `limits` with the labels Claude Code itself uses', () => {
    const snap = parseUsage(LIVE_BODY, NOW)!;
    expect(snap.fetchedAtMs).toBe(NOW);
    expect(snap.windows.map((w) => [w.id, w.label, w.percent, w.active])).toEqual([
      ['session', 'Session (5hr)', 54, false],
      ['weekly_all', 'Weekly (7 day)', 49, false],
      ['weekly_scoped:Fable', 'Weekly Fable', 55, true],
    ]);
    expect(snap.windows[0].resetsAtMs).toBe(Date.parse('2026-09-11T08:20:00.976906+00:00'));
  });

  it('carries the extra-usage credits when the account has them enabled', () => {
    const snap = parseUsage(LIVE_BODY, NOW)!;
    expect(snap.spend).toEqual({ usedMinor: 0, limitMinor: 100000, exponent: 2, currency: 'USD', percent: 0 });
  });

  it('leaves spend out when credits are disabled', () => {
    const body = { ...LIVE_BODY, spend: { ...LIVE_BODY.spend, enabled: false } };
    expect(parseUsage(body, NOW)!.spend).toBeUndefined();
  });

  it('falls back to the top-level windows when `limits` is absent (older API shape)', () => {
    const { limits: _drop, ...older } = LIVE_BODY;
    const body = { ...older, seven_day_opus: { utilization: 12, resets_at: '2026-09-11T16:00:00Z' } };
    const snap = parseUsage(body, NOW)!;
    expect(snap.windows.map((w) => [w.id, w.label, w.percent])).toEqual([
      ['session', 'Session (5hr)', 54],
      ['weekly_all', 'Weekly (7 day)', 49],
      ['weekly_scoped:Opus', 'Weekly Opus', 12],
    ]);
  });

  it('clamps nonsense percents and tolerates a missing reset time', () => {
    const body = { limits: [{ kind: 'session', percent: 140, resets_at: null }, { kind: 'weekly_all', percent: -3 }] };
    const snap = parseUsage(body, NOW)!;
    expect(snap.windows.map((w) => w.percent)).toEqual([100, 0]);
    expect(snap.windows[0].resetsAtMs).toBeUndefined();
  });

  it('returns undefined for a body with nothing usable, so the caller reports bad-response', () => {
    expect(parseUsage(null, NOW)).toBeUndefined();
    expect(parseUsage('nope', NOW)).toBeUndefined();
    expect(parseUsage({}, NOW)).toBeUndefined();
    expect(parseUsage({ limits: [] }, NOW)).toBeUndefined();
  });
});

describe('usageSeverity', () => {
  it('is blue to 69, yellow to 89, orange from 90', () => {
    expect(usageSeverity(0)).toBe('normal');
    expect(usageSeverity(69.9)).toBe('normal');
    expect(usageSeverity(70)).toBe('warning');
    expect(usageSeverity(89)).toBe('warning');
    expect(usageSeverity(90)).toBe('critical');
    expect(usageSeverity(100)).toBe('critical');
  });
});

describe('resetsInText', () => {
  const H = 3_600_000;
  it('matches the granularity of Claude Code’s own panel', () => {
    expect(resetsInText(NOW, NOW + 4 * H + 20 * 60_000)).toBe('Resets in 4h');
    expect(resetsInText(NOW, NOW + 35 * 60_000)).toBe('Resets in 35m');
    expect(resetsInText(NOW, NOW + 30_000)).toBe('Resets in 1m');
    expect(resetsInText(NOW, NOW + 2 * 24 * H + 3 * H)).toBe('Resets in 2d 3h');
    expect(resetsInText(NOW, NOW + 3 * 24 * H)).toBe('Resets in 3d');
  });
  it('says so when the reset has passed, and nothing when there is none', () => {
    expect(resetsInText(NOW, NOW - 1)).toBe('Resets now');
    expect(resetsInText(NOW, undefined)).toBe('');
  });
});

describe('spendText', () => {
  it('formats minor units as currency', () => {
    expect(spendText({ usedMinor: 350, limitMinor: 100000, exponent: 2, currency: 'USD', percent: 0 })).toBe(
      '$3.50 of $1,000',
    );
  });
});

describe('usageSummaryLine', () => {
  it('is one short line per window, for tooltips', () => {
    expect(usageSummaryLine(parseUsage(LIVE_BODY, NOW)!)).toBe('Session 54% · Week 49% · Fable 55%');
  });
});

describe('usageErrorText', () => {
  it('explains each failure in terms of what to do about it', () => {
    expect(usageErrorText({ kind: 'no-credentials', atMs: NOW })).toMatch(/No Claude Code login/);
    expect(usageErrorText({ kind: 'unauthorized', atMs: NOW })).toMatch(/refreshes the next time/);
    expect(usageErrorText({ kind: 'rate-limited', atMs: NOW })).toMatch(/rate-limiting/);
    expect(usageErrorText({ kind: 'network', detail: 'ENOTFOUND', atMs: NOW })).toContain('ENOTFOUND');
    expect(usageErrorText({ kind: 'bad-response', detail: 'HTTP 500', atMs: NOW })).toContain('HTTP 500');
  });
});
