import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { cleanNickname, MAX_NICKNAME_LENGTH, NicknameService } from '../src/core/nicknameService';
import { displayTitle } from '../src/shared/model';

function storage(): KeyValueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string, dflt: T): T => (data.has(key) ? (data.get(key) as T) : dflt),
    update: (key: string, value: unknown) => data.set(key, value),
  };
}

describe('cleanNickname', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanNickname('  the   backend    fix ')).toBe('the backend fix');
  });

  // The natural way to get a newline in is a paste, and refusing a paste
  // teaches nothing; a name is one line by nature, so make it one.
  it('flattens a pasted multi-line string instead of rejecting it', () => {
    expect(cleanNickname('first line\nsecond line')).toBe('first line second line');
  });

  it('treats blank as no nickname', () => {
    expect(cleanNickname('')).toBeUndefined();
    expect(cleanNickname('   ')).toBeUndefined();
    expect(cleanNickname('\n\t')).toBeUndefined();
    expect(cleanNickname(undefined)).toBeUndefined();
  });

  it('caps the length, so one nickname cannot wreck a 300px row', () => {
    expect(cleanNickname('x'.repeat(500))).toHaveLength(MAX_NICKNAME_LENGTH);
  });
});

describe('NicknameService', () => {
  let store: ReturnType<typeof storage>;
  let svc: NicknameService;

  beforeEach(() => {
    store = storage();
    svc = new NicknameService(store);
  });

  it('sets and reads a nickname', () => {
    svc.set('claude:a', 'The flaky test hunt');
    expect(svc.get('claude:a')).toBe('The flaky test hunt');
  });

  /**
   * The original title is never touched, so clearing the nickname is a real
   * undo rather than a second rename back to a remembered string.
   */
  it('clears with a blank name, and the original title comes back', () => {
    const session = { title: 'fix-the-thing' };
    svc.set('claude:a', 'My name for it');
    expect(displayTitle({ ...session, nickname: svc.get('claude:a') })).toBe('My name for it');
    svc.set('claude:a', '   ');
    expect(svc.get('claude:a')).toBeUndefined();
    expect(displayTitle({ ...session, nickname: svc.get('claude:a') })).toBe('fix-the-thing');
  });

  it('fires only on a real change', () => {
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.set('claude:a', 'one');
    svc.set('claude:a', 'one');
    expect(fired).toBe(1);
    // Clearing something that was never set is not a change either.
    svc.set('claude:b', '');
    expect(fired).toBe(1);
  });

  it('stores the cleaned form, not the raw input', () => {
    svc.set('claude:a', '  spaced   out  ');
    expect(svc.get('claude:a')).toBe('spaced out');
  });

  it('survives a reload', () => {
    svc.set('claude:a', 'kept');
    expect(new NicknameService(store).get('claude:a')).toBe('kept');
  });

  it('ignores junk in storage rather than throwing on startup', () => {
    store.data.set('agentWrangler.nicknames', { 'claude:a': '   ', 'claude:b': 'fine' });
    const revived = new NicknameService(store);
    expect(revived.get('claude:a')).toBeUndefined();
    expect(revived.get('claude:b')).toBe('fine');
  });
});

describe('displayTitle', () => {
  it('prefers the nickname and falls back to the title', () => {
    expect(displayTitle({ title: 'original', nickname: 'mine' })).toBe('mine');
    expect(displayTitle({ title: 'original', nickname: undefined })).toBe('original');
  });
});
