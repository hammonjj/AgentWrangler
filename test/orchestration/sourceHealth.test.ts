import { describe, expect, it } from 'vitest';
import { sourceStatus } from '../../src/shared/orchestration/sourceHealth';
import type { UsageSnapshot, UsageWindow } from '../../src/shared/usage';

const NOW = 1_790_000_000_000;

function snapshot(windows: Partial<UsageWindow>[], fetchedAtMs = NOW - 60_000): UsageSnapshot {
  return {
    fetchedAtMs,
    spendKnown: false,
    windows: windows.map((w, i) => ({ id: `w${i}`, label: `Window ${i}`, percent: 0, active: false, ...w })),
  };
}

describe('sourceStatus', () => {
  it('is unknown before anything was read', () => {
    expect(sourceStatus('anthropic', undefined, NOW).health.state).toBe('unknown');
    expect(sourceStatus('anthropic', {}, NOW).health).toEqual({ state: 'unknown', reason: 'Usage not read yet' });
    expect(sourceStatus('anthropic', {}, NOW).capacity).toEqual({ windowPercent: { unknown: true }, freeSlots: { unknown: true } });
  });

  it('is reachable with room in every window, and reports the fullest', () => {
    const s = sourceStatus('anthropic', { last: snapshot([{ label: 'Session', percent: 20 }, { label: 'Weekly', percent: 41, resetsAtMs: NOW + 5 }]) }, NOW);
    expect(s.health.state).toBe('reachable');
    expect(s.health.reason).toBe('Weekly at 41%');
    expect(s.capacity).toMatchObject({ windowPercent: { value: 41, from: 'reported' }, windowLabel: 'Weekly', resetsAtMs: NOW + 5 });
    expect(s.capacity.backoffUntil).toBeUndefined();
  });

  it('is degraded near a limit and down at one, until it resets', () => {
    expect(sourceStatus('openai', { last: snapshot([{ label: '5hr', percent: 93 }]) }, NOW).health).toMatchObject({
      state: 'degraded',
      reason: '5hr at 93%',
    });
    const full = sourceStatus('openai', { last: snapshot([{ label: '1 week', percent: 100, resetsAtMs: NOW + 3_600_000 }]) }, NOW);
    expect(full.health).toMatchObject({ state: 'down', reason: '1 week limit reached' });
    expect(full.capacity.backoffUntil).toBe(NOW + 3_600_000);
  });

  it('keeps the last good read through an error, and says how old it is', () => {
    const s = sourceStatus(
      'anthropic',
      { last: snapshot([{ label: 'Weekly', percent: 50 }], NOW - 20 * 60_000), error: { kind: 'network', atMs: NOW } },
      NOW,
    );
    expect(s.health).toMatchObject({ state: 'reachable', reason: 'Weekly at 50% (as of 20m ago)' });
  });

  it('calls an old read stale even without an error', () => {
    const s = sourceStatus('anthropic', { last: snapshot([{ label: 'Weekly', percent: 5 }], NOW - 2 * 3_600_000) }, NOW);
    expect(s.health.reason).toBe('Weekly at 5% (as of 2h ago)');
  });

  it('reads errors with no good read behind them', () => {
    expect(sourceStatus('anthropic', { error: { kind: 'no-credentials', atMs: NOW } }, NOW).health.state).toBe('down');
    expect(sourceStatus('anthropic', { error: { kind: 'unauthorized', atMs: NOW } }, NOW).health.state).toBe('degraded');
    expect(sourceStatus('anthropic', { error: { kind: 'network', atMs: NOW } }, NOW).health).toMatchObject({
      state: 'unknown',
      reason: 'Could not read usage (network)',
    });
  });
});
