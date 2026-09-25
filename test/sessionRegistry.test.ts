import { describe, expect, it } from 'vitest';
import {
  AUTO_RESUME_WINDOW_MS,
  INTERRUPTED_SHOWN_MS,
  MAX_RECORDS,
  RECORD_MAX_AGE_MS,
  autoResumeCandidate,
  HOST_LOST,
  classifyOnStartup,
  outcomesFromDeadHosts,
  recordFromManifest,
  showsInterrupted,
} from '../src/core/session/recovery';
import { LEGACY_KEY, SessionRegistry, type SessionRecord } from '../src/core/session/sessionRegistry';
import type { HostManifest } from '../src/shared/sessionProtocol';

function deadManifest(sessionId: string, startedAt: number): HostManifest {
  return {
    v: 1,
    hostId: 'aaaaaaaa',
    provider: 'claude',
    sessionId,
    cwd: '/Users/test/proj',
    hostPid: 1,
    socketPath: '/tmp/x.sock',
    protocol: 1,
    hostBuild: 'test',
    sdkVersion: '0',
    startedAt,
  };
}

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
    const stale = rec({ sessionId: 'stale', state: 'ended', lastShownAt: now - RECORD_MAX_AGE_MS - 1 });
    const { records, interrupted } = classifyOnStartup([...many, stale], now);
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records.map((r) => r.sessionId)).toEqual(many.slice(0, MAX_RECORDS).map((r) => r.sessionId));
    expect(interrupted).toEqual([]);
  });

  describe('never drops a live record (#72)', () => {
    const history = Array.from({ length: MAX_RECORDS + 20 }, (_, i) => rec({ sessionId: `h${i}`, state: 'ended', lastShownAt: now - i }));

    it.each(['claude', 'codex'] as const)('%s: an old live record survives the cap and is interrupted', (provider) => {
      const old = rec({ sessionId: 'old', provider, state: 'live', lastShownAt: now - 20 * 24 * HOUR });
      const { records, interrupted } = classifyOnStartup([...history, old], now);
      expect(records.find((r) => r.sessionId === 'old')).toMatchObject({ provider, state: 'interrupted', endedReason: 'app-restart' });
      expect(interrupted.map((r) => r.sessionId)).toEqual(['old']);
      expect(records).toHaveLength(MAX_RECORDS);
    });

    it.each(['claude', 'codex'] as const)('%s: a live record past the age rule survives it', (provider) => {
      const ancient = rec({ sessionId: 'ancient', provider, state: 'live', lastShownAt: now - RECORD_MAX_AGE_MS - HOUR });
      const { records, interrupted } = classifyOnStartup([...history, ancient], now);
      expect(records.some((r) => r.sessionId === 'ancient')).toBe(true);
      expect(interrupted.map((r) => r.sessionId)).toEqual(['ancient']);
    });

    it('a session still running in a host survives the age rule and the cap, and stays live', () => {
      const hosted = rec({ sessionId: 'Hosted', state: 'live', lastShownAt: now - RECORD_MAX_AGE_MS - HOUR });
      const { records, interrupted } = classifyOnStartup([...history, hosted], now, new Set(['hosted']));
      expect(records.find((r) => r.sessionId === 'Hosted')).toMatchObject({ state: 'live' });
      expect(interrupted).toEqual([]);
    });

    it('keeps every live record even when they alone pass the cap', () => {
      const live = Array.from({ length: MAX_RECORDS + 3 }, (_, i) =>
        rec({ sessionId: `l${i}`, provider: i % 2 ? 'codex' : 'claude', state: 'live', lastShownAt: now - 40 * 24 * HOUR - i }),
      );
      const { records, interrupted } = classifyOnStartup([...history, ...live], now);
      expect(records).toHaveLength(MAX_RECORDS + 3);
      expect(records.every((r) => r.sessionId.startsWith('l'))).toBe(true);
      expect(interrupted).toHaveLength(MAX_RECORDS + 3);
    });

    it('the next start treats an old interrupted record as history again', () => {
      const old = rec({ sessionId: 'old', state: 'live', lastShownAt: now - RECORD_MAX_AGE_MS - HOUR });
      const first = classifyOnStartup([old], now);
      expect(classifyOnStartup(first.records, now + HOUR).records).toEqual([]);
    });
  });
});

describe('recordFromManifest (#72)', () => {
  it('rebuilds the launch options and origin a host wrote down', () => {
    const origin = { kind: 'orchestration', missionId: 'm1' };
    expect(
      recordFromManifest({
        sessionId: 's1',
        cwd: '/Users/test/proj',
        launch: { resume: true, model: 'opus', permissionMode: 'plan', effort: 'high', binary: '/usr/local/bin/claude' },
        origin,
      }),
    ).toEqual({
      sessionId: 's1',
      provider: 'claude',
      cwd: '/Users/test/proj',
      launch: { model: 'opus', permissionMode: 'plan', effort: 'high', binary: '/usr/local/bin/claude' },
      origin,
    });
  });

  it('copes with a manifest from before launch or origin were written', () => {
    expect(recordFromManifest({ sessionId: 's1', cwd: '/Users/test/proj' })).toEqual({
      sessionId: 's1',
      provider: 'claude',
      cwd: '/Users/test/proj',
      launch: {},
      origin: undefined,
    });
    expect(recordFromManifest({ cwd: '/Users/test/proj' })).toBeUndefined();
  });

  it('a rebuilt record starts when its host did, so a later host crash is still read as one', () => {
    const t0 = 50 * 24 * HOUR;
    let now = t0 + 2 * 24 * HOUR;
    const registry = new SessionRegistry(memento(), { now: () => now });
    registry.live(recordFromManifest({ sessionId: 's1', cwd: '/Users/test/proj', startedAt: t0 })!);
    expect(registry.get('s1')?.liveSince).toBe(t0);
    // The app quits, the host dies with no exit record, the app starts again.
    now += HOUR;
    const { records, interrupted } = registry.startup(new Set(), outcomesFromDeadHosts([deadManifest('s1', t0)]));
    expect(records[0]).toMatchObject({ state: 'interrupted', endedReason: HOST_LOST });
    expect(autoResumeCandidate(interrupted, now)).toBeUndefined();
  });

  it('never dates a run in the future', () => {
    const registry = new SessionRegistry(memento(), { now: () => 1000 });
    expect(registry.live({ sessionId: 's', provider: 'claude', cwd: '/Users/test/proj', liveSince: 5000 }).liveSince).toBe(1000);
  });

  it('what it rebuilds is what adopt reads back from the registry', () => {
    const registry = new SessionRegistry(memento());
    const input = recordFromManifest({ sessionId: 's1', cwd: '/Users/test/proj', launch: { model: 'sonnet', effort: 'low' }, origin: { kind: 'x' } });
    registry.live(input!);
    expect(registry.get('s1')).toMatchObject({ state: 'live', launch: { model: 'sonnet', effort: 'low' }, origin: { kind: 'x' } });
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
