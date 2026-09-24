import { describe, expect, it } from 'vitest';
import {
  AUTO_RESUME_WINDOW_MS,
  INTERRUPTED_SHOWN_MS,
  MAX_RECORDS,
  RECORD_MAX_AGE_MS,
  autoResumeCandidate,
  classifyOnStartup,
  showsInterrupted,
} from '../src/core/session/recovery';
import { LEGACY_KEY, SessionRegistry, type SessionRecord } from '../src/core/session/sessionRegistry';

function memento(initial: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = { ...initial };
  return {
    doc,
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

function rec(over: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    v: 1,
    provider: 'claude',
    cwd: '/Users/test/proj',
    launch: {},
    state: 'live',
    createdAt: 0,
    lastShownAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const HOUR = 60 * 60 * 1000;

describe('classifyOnStartup (the recovery table)', () => {
  const now = 100 * 24 * HOUR;

  it.each([
    ['live', 'interrupted'],
    ['stopped', 'stopped'],
    ['ended', 'ended'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
  ] as const)('%s → %s', (before, after) => {
    const { records } = classifyOnStartup([rec({ sessionId: 's', state: before, lastShownAt: now - HOUR })], now);
    expect(records[0].state).toBe(after);
  });

  it('reports only the sessions this restart interrupted, newest first', () => {
    const { interrupted } = classifyOnStartup(
      [
        rec({ sessionId: 'old', state: 'live', lastShownAt: now - 3 * HOUR }),
        rec({ sessionId: 'new', state: 'live', lastShownAt: now - HOUR }),
        rec({ sessionId: 'before', state: 'interrupted', lastShownAt: now - 2 * HOUR }),
        rec({ sessionId: 'done', state: 'stopped', lastShownAt: now }),
      ],
      now,
    );
    expect(interrupted.map((r) => r.sessionId)).toEqual(['new', 'old']);
    expect(interrupted.every((r) => r.endedReason === 'app-restart')).toBe(true);
  });

  it('drops records too old to matter, and caps the list', () => {
    const many = Array.from({ length: MAX_RECORDS + 5 }, (_, i) => rec({ sessionId: `s${i}`, state: 'ended', lastShownAt: now - i }));
    const stale = rec({ sessionId: 'stale', state: 'live', lastShownAt: now - RECORD_MAX_AGE_MS - 1 });
    const { records, interrupted } = classifyOnStartup([...many, stale], now);
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records.some((r) => r.sessionId === 'stale')).toBe(false);
    expect(interrupted).toEqual([]);
  });
});

describe('interrupted display and auto-resume', () => {
  const now = 10 * 24 * HOUR;

  it('shows interrupted for a week, then it is just ended', () => {
    expect(showsInterrupted(rec({ sessionId: 's', state: 'interrupted', lastShownAt: now - HOUR }), now)).toBe(true);
    expect(showsInterrupted(rec({ sessionId: 's', state: 'interrupted', lastShownAt: now - INTERRUPTED_SHOWN_MS - 1 }), now)).toBe(false);
    expect(showsInterrupted(rec({ sessionId: 's', state: 'stopped', lastShownAt: now }), now)).toBe(false);
    expect(showsInterrupted(undefined, now)).toBe(false);
  });

  it('auto-resumes only the newest recent Claude session, never an orchestrated one', () => {
    const list = [
      rec({ sessionId: 'orch', lastShownAt: now - 1, origin: { kind: 'orchestration', missionId: 'm' } }),
      rec({ sessionId: 'codex', provider: 'codex', lastShownAt: now - 2 }),
      rec({ sessionId: 'mine', lastShownAt: now - 3 }),
      rec({ sessionId: 'older', lastShownAt: now - 4 }),
    ];
    expect(autoResumeCandidate(list, now)?.sessionId).toBe('mine');
    expect(autoResumeCandidate([rec({ sessionId: 'x', lastShownAt: now - AUTO_RESUME_WINDOW_MS - 1 })], now)).toBeUndefined();
    expect(autoResumeCandidate([], now)).toBeUndefined();
  });
});

describe('SessionRegistry', () => {
  let t = 1_000_000;
  const clock = () => t;

  it('records, touches and changes state without losing launch details', () => {
    const reg = new SessionRegistry(memento(), { now: clock });
    reg.live({ sessionId: 'S1', provider: 'claude', cwd: '/Users/test/proj', launch: { model: 'opus', effort: 'high' }, repoRoot: '/Users/test/proj' });
    t += 10;
    reg.touch('s1');
    reg.noteApplied('s1', { effort: 'medium' });
    reg.setState('s1', 'stopped');
    expect(reg.get('s1')).toMatchObject({
      sessionId: 'S1',
      state: 'stopped',
      lastShownAt: t,
      repoRoot: '/Users/test/proj',
      launch: { model: 'opus', effort: 'high', applied: { effort: 'medium' } },
    });
  });

  it('brings a record back to live on resume, keeping when it was first created and how it was launched', () => {
    const reg = new SessionRegistry(memento(), { now: clock });
    reg.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj', launch: { model: 'opus' } });
    const created = reg.get('s1')!.createdAt;
    reg.setState('s1', 'interrupted');
    t += 1000;
    reg.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj' });
    expect(reg.all()).toHaveLength(1);
    expect(reg.get('s1')).toMatchObject({ state: 'live', createdAt: created, launch: { model: 'opus' } });
  });

  it('turns every live session into an interrupted one at startup, and persists it', () => {
    const store = memento();
    const first = new SessionRegistry(store, { now: clock });
    first.live({ sessionId: 'a', provider: 'claude', cwd: '/Users/test/a' });
    first.live({ sessionId: 'b', provider: 'codex', cwd: '/Users/test/b' });
    first.live({ sessionId: 'c', provider: 'claude', cwd: '/Users/test/c' });
    first.setState('c', 'stopped');

    const second = new SessionRegistry(store, { now: clock });
    const { interrupted } = second.startup();
    expect(interrupted.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
    expect(new SessionRegistry(store, { now: clock }).get('a')?.state).toBe('interrupted');
    expect(second.isInterrupted('b')).toBe(true);
    expect(second.isInterrupted('c')).toBe(false);
  });

  it('imports the old runner registry once, recent entries only, and leaves the old key alone', () => {
    const now = 50 * HOUR;
    const legacy = memento({
      [LEGACY_KEY]: [
        { sessionId: 'recent', cwd: '/Users/test/p', lastShownAt: now - HOUR },
        { sessionId: 'ancient', cwd: '/Users/test/p', lastShownAt: now - 20 * HOUR },
        null,
        { sessionId: 'broken' },
      ],
    });
    const store = memento();
    const reg = new SessionRegistry(store, { legacy, now: () => now });
    expect(reg.all().map((r) => r.sessionId)).toEqual(['recent']);
    expect(reg.startup().interrupted.map((r) => r.sessionId)).toEqual(['recent']);
    expect(legacy.doc[LEGACY_KEY]).toHaveLength(4);

    // A second start does not import again, even if the old key changed.
    legacy.doc[LEGACY_KEY] = [{ sessionId: 'later', cwd: '/Users/test/p', lastShownAt: now }];
    expect(new SessionRegistry(store, { legacy, now: () => now }).get('later')).toBeUndefined();
  });

  it('ignores malformed records rather than failing', () => {
    const reg = new SessionRegistry(memento({ 'agentWrangler.sessions': [null, 'x', { sessionId: 'no-provider' }, rec({ sessionId: 'ok' })] }));
    expect(reg.all().map((r) => r.sessionId)).toEqual(['ok']);
    expect(new SessionRegistry(memento({ 'agentWrangler.sessions': 'nope' })).all()).toEqual([]);
  });

  it('forgets a session outright', () => {
    const reg = new SessionRegistry(memento(), { now: clock });
    reg.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj' });
    reg.forget('S1');
    expect(reg.get('s1')).toBeUndefined();
  });
});
