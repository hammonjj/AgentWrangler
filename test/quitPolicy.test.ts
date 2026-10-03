import { describe, expect, it } from 'vitest';
import { QUIT_INTENT_MAX_AGE_MS, QUIT_STOP_BOUND_MS, agentCount, quitIntentSource, quitPolicy } from '../src/core/session/quitPolicy';

describe('quitPolicy', () => {
  it('leaves hosted sessions running on every stop but --all', () => {
    expect(quitPolicy({ source: 'signal', local: 1, hosted: 2 }).stopHosted).toBe(false);
    expect(quitPolicy({ source: 'stopAll', local: 0, hosted: 2 }).stopHosted).toBe(true);
  });

  it('bounds the graceful stop at 10 s', () => {
    expect(QUIT_STOP_BOUND_MS).toBe(10_000);
    expect(quitPolicy({ source: 'signal', local: 1, hosted: 0 }).stopWithinMs).toBe(QUIT_STOP_BOUND_MS);
  });
});

describe('quitIntentSource', () => {
  it('recognises a fresh announcement', () => {
    expect(quitIntentSource('stop\n', 500)).toBe('signal');
    expect(quitIntentSource('stop-all', 500)).toBe('stopAll');
  });

  it('ignores a stale, unknown, unreadable or future-dated marker', () => {
    expect(quitIntentSource('stop-all', QUIT_INTENT_MAX_AGE_MS + 1)).toBeUndefined();
    expect(quitIntentSource('install', 10)).toBeUndefined();
    expect(quitIntentSource(undefined, 10)).toBeUndefined();
    expect(quitIntentSource('stop-all', -5)).toBeUndefined();
  });
});

describe('agentCount', () => {
  it('pluralises', () => {
    expect(agentCount(1)).toBe('1 agent');
    expect(agentCount(3)).toBe('3 agents');
  });
});
