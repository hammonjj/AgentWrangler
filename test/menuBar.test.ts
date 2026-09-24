import { describe, expect, it } from 'vitest';
import {
  attentionNotice,
  menuBarAgents,
  menuBarBadge,
  menuBarCounts,
  menuBarSummary,
  shouldPreventAppSuspension,
  type MenuBarSession,
} from '../src/core/menuBar';

const s = (over: Partial<MenuBarSession> & Pick<MenuBarSession, 'key' | 'status'>): MenuBarSession => ({
  title: over.key,
  owned: false,
  ...over,
});

describe('menuBarCounts', () => {
  it('counts busy (with stuck), waiting and blocked, skipping ended and archived', () => {
    const counts = menuBarCounts([
      s({ key: 'a', status: 'busy' }),
      s({ key: 'b', status: 'stuck' }),
      s({ key: 'c', status: 'waiting' }),
      s({ key: 'd', status: 'blocked' }),
      s({ key: 'e', status: 'done' }),
      s({ key: 'f', status: 'ended' }),
      s({ key: 'g', status: 'blocked', archived: true }),
    ]);
    expect(counts).toEqual({ busy: 2, waiting: 1, blocked: 1 });
  });
});

describe('menuBarBadge', () => {
  it('is the number that need you, or empty', () => {
    expect(menuBarBadge({ busy: 3, waiting: 0, blocked: 0 })).toBe('');
    expect(menuBarBadge({ busy: 3, waiting: 1, blocked: 2 })).toBe('3');
  });
});

describe('menuBarSummary', () => {
  it('names only what is non-zero', () => {
    expect(menuBarSummary({ busy: 0, waiting: 0, blocked: 0 })).toBe('No agents running');
    expect(menuBarSummary({ busy: 2, waiting: 0, blocked: 1 })).toBe('2 busy · 1 needs permission');
    expect(menuBarSummary({ busy: 0, waiting: 1, blocked: 2 })).toBe('1 waiting · 2 need permission');
  });
});

describe('menuBarAgents', () => {
  it('lists needs-you first, keeps store order within a status, and drops ended and archived', () => {
    const { agents, more } = menuBarAgents([
      s({ key: 'busy1', status: 'busy', projectName: 'proj' }),
      s({ key: 'done1', status: 'done' }),
      s({ key: 'wait1', status: 'waiting' }),
      s({ key: 'block1', status: 'blocked', blockedReason: 'Bash', owned: true }),
      s({ key: 'busy2', status: 'stuck', pid: 42 }),
      s({ key: 'gone', status: 'ended' }),
      s({ key: 'hidden', status: 'busy', archived: true }),
    ]);
    expect(agents.map((a) => a.key)).toEqual(['block1', 'wait1', 'busy1', 'busy2', 'done1']);
    expect(more).toBe(0);
    expect(agents[0]).toMatchObject({ detail: 'Needs permission for Bash', stoppable: true });
    expect(agents[2]).toMatchObject({ detail: 'Busy · proj', stoppable: false });
    expect(agents[3]).toMatchObject({ detail: 'Possibly stuck', stoppable: true });
  });

  it('caps the list and says how many are left out', () => {
    const many = Array.from({ length: 5 }, (_, i) => s({ key: `k${i}`, status: 'busy' }));
    const { agents, more } = menuBarAgents(many, 3);
    expect(agents).toHaveLength(3);
    expect(more).toBe(2);
  });
});

describe('shouldPreventAppSuspension', () => {
  it('holds only for owned sessions that are working or asking', () => {
    expect(shouldPreventAppSuspension([s({ key: 'a', status: 'busy' })])).toBe(false);
    expect(shouldPreventAppSuspension([s({ key: 'a', status: 'waiting', owned: true })])).toBe(false);
    expect(shouldPreventAppSuspension([s({ key: 'a', status: 'done', owned: true })])).toBe(false);
    expect(shouldPreventAppSuspension([s({ key: 'a', status: 'busy', owned: true })])).toBe(true);
    expect(shouldPreventAppSuspension([s({ key: 'a', status: 'blocked', owned: true })])).toBe(true);
  });
});

describe('attentionNotice', () => {
  it('words each notable status and ignores the rest', () => {
    expect(attentionNotice({ status: 'blocked', title: 'Fix login', blockedReason: 'Bash', projectName: 'proj' })).toEqual({
      title: 'Needs your permission',
      body: 'Fix login wants to use Bash · proj',
    });
    expect(attentionNotice({ status: 'waiting', title: 'Fix login' })).toEqual({ title: 'Waiting on you', body: 'Fix login' });
    expect(attentionNotice({ status: 'done', title: 'Fix login' })?.title).toBe('Done');
    expect(attentionNotice({ status: 'busy', title: 'Fix login' })).toBeUndefined();
  });
});
