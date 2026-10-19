import { describe, expect, it } from 'vitest';
import { attentionNotice, shouldPreventAppSuspension, type MenuBarSession } from '../src/core/menuBar';

const s = (over: Partial<MenuBarSession> & Pick<MenuBarSession, 'key' | 'status'>): MenuBarSession => ({
  title: over.key,
  owned: false,
  ...over,
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
