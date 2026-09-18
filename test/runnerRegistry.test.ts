import { describe, expect, it } from 'vitest';
import { RESUME_WINDOW_MS, RunnerRegistry, type MementoLike } from '../src/claude/runner/runnerRegistry';

function memento(initial: Record<string, unknown> = {}): MementoLike {
  const store = new Map(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue: T): T {
      return store.has(key) ? (store.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

describe('RunnerRegistry', () => {
  it('remembers a session and returns it as the one to resume', () => {
    const reg = new RunnerRegistry(memento());
    reg.remember('abc', '/Users/test/proj', 1000);
    expect(reg.resumable(2000)).toMatchObject({ sessionId: 'abc', cwd: '/Users/test/proj' });
  });

  it('offers the one most recently on screen, not the one started first', () => {
    const reg = new RunnerRegistry(memento());
    reg.remember('first', '/Users/test/a', 1000);
    reg.remember('second', '/Users/test/b', 2000);
    reg.remember('first', '/Users/test/a', 3000); // looked at again
    expect(reg.resumable(3500)?.sessionId).toBe('first');
    expect(reg.all().map((r) => r.sessionId)).toEqual(['first', 'second']);
  });

  it('does not resurrect old history on an ordinary VSCode start', () => {
    // The point is recovering an interrupted session, not reopening whatever
    // was running last week.
    const reg = new RunnerRegistry(memento());
    const then = 1_000_000;
    reg.remember('stale', '/Users/test/proj', then);
    expect(reg.resumable(then + RESUME_WINDOW_MS - 1)).toBeDefined();
    expect(reg.resumable(then + RESUME_WINDOW_MS + 1)).toBeUndefined();
  });

  it('forgets a session that was deliberately ended', () => {
    const reg = new RunnerRegistry(memento());
    reg.remember('abc', '/Users/test/proj', 1000);
    reg.forget('abc');
    expect(reg.all()).toEqual([]);
    expect(reg.resumable(1001)).toBeUndefined();
  });

  it('records a session once however many times it is touched', () => {
    const reg = new RunnerRegistry(memento());
    for (let i = 0; i < 5; i++) reg.remember('abc', '/Users/test/proj', 1000 + i);
    expect(reg.all()).toHaveLength(1);
  });

  it('ignores junk in storage rather than throwing on startup', () => {
    // This runs during activation; a bad value must not take the extension down.
    const reg = new RunnerRegistry(
      memento({ 'agentWrangler.runnerSessions': [null, 'nope', { sessionId: 'ok', cwd: '/Users/test/p', lastShownAt: 5 }] }),
    );
    expect(reg.all()).toHaveLength(1);
    expect(new RunnerRegistry(memento({ 'agentWrangler.runnerSessions': 'not an array' })).all()).toEqual([]);
  });
});

it('marks every recent interrupted session, not just the newest, and forgets deliberate ends', () => {
  const reg = new RunnerRegistry(memento());
  reg.remember('first', '/Users/test/a', 1000);
  reg.remember('second', '/Users/test/b', 2000);
  expect(reg.wasRunning('first', 3000)).toBe(true);
  expect(reg.wasRunning('second', 3000)).toBe(true);
  expect(reg.wasRunning('first', RESUME_WINDOW_MS + 1001)).toBe(false);
  reg.forget('second'); expect(reg.wasRunning('second', 3000)).toBe(false);
});
