import { describe, expect, it } from 'vitest';
import {
  QUIT_INTENT_MAX_AGE_MS,
  QUIT_STOP_BOUND_MS,
  agentCount,
  quitIntentSource,
  quitPolicy,
  type QuitSource,
} from '../src/core/session/quitPolicy';
import { MAX_RELOADS, RELOAD_WINDOW_MS, shouldReloadRenderer } from '../src/electron/rendererRecovery';

describe('quitPolicy', () => {
  it.each<[QuitSource, number, boolean]>([
    ['menu', 3, true],
    ['menu', 0, false],
    ['signal', 3, false],
    ['install', 3, false],
    ['external', 3, false],
  ])('%s quit with %i live sessions: confirm = %s', (source, live, confirm) => {
    expect(quitPolicy({ source, liveSessions: live })).toEqual({ confirm, stopWithinMs: QUIT_STOP_BOUND_MS });
  });

  it('bounds the graceful stop at 10 s', () => {
    expect(QUIT_STOP_BOUND_MS).toBe(10_000);
  });
});

describe('quitIntentSource', () => {
  it('recognises a fresh install announcement', () => {
    expect(quitIntentSource('install\n', 500)).toBe('install');
  });

  it('ignores a stale, unknown, unreadable or future-dated marker', () => {
    expect(quitIntentSource('install', QUIT_INTENT_MAX_AGE_MS + 1)).toBeUndefined();
    expect(quitIntentSource('reboot', 10)).toBeUndefined();
    expect(quitIntentSource(undefined, 10)).toBeUndefined();
    expect(quitIntentSource('install', -5)).toBeUndefined();
  });
});

describe('agentCount', () => {
  it('pluralises', () => {
    expect(agentCount(1)).toBe('1 agent');
    expect(agentCount(3)).toBe('3 agents');
  });
});

describe('shouldReloadRenderer', () => {
  it('reloads after a crash, and records when', () => {
    expect(shouldReloadRenderer('crashed', [], 1000)).toEqual({ reload: true, history: [1000] });
  });

  it('leaves a clean exit alone', () => {
    expect(shouldReloadRenderer('clean-exit', [], 1000).reload).toBe(false);
  });

  it('stops after a few crashes in a short window, and forgives old ones', () => {
    const recent = Array.from({ length: MAX_RELOADS }, (_, i) => 10_000 + i);
    expect(shouldReloadRenderer('crashed', recent, 10_100).reload).toBe(false);
    expect(shouldReloadRenderer('crashed', recent, 10_000 + RELOAD_WINDOW_MS + 100).reload).toBe(true);
  });
});
