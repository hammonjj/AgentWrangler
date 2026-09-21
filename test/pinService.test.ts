import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { GENERAL_SECTION, PinService } from '../src/core/pinService';

function storage(): KeyValueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string, dflt: T): T => (data.has(key) ? (data.get(key) as T) : dflt),
    update: (key: string, value: unknown) => data.set(key, value),
  };
}

describe('conversation sections', () => {
  let store: ReturnType<typeof storage>;
  let svc: PinService;

  beforeEach(() => {
    store = storage();
    svc = new PinService(store);
  });

  it('always provides General and assigns new conversations there', () => {
    expect(svc.names).toEqual([GENERAL_SECTION]);
    expect(svc.sectionFor('claude:a')).toBe(GENERAL_SECTION);
  });

  it('creates a section, assigns a conversation, and survives reload', () => {
    expect(svc.create('Client work')).toBe(true);
    svc.assign('claude:a', 'Client work');
    expect(svc.sectionFor('claude:a')).toBe('Client work');
    expect(svc.assignedAt('claude:a')).toEqual(expect.any(Number));

    const revived = new PinService(store);
    expect(revived.names).toEqual([GENERAL_SECTION, 'Client work']);
    expect(revived.sectionFor('claude:a')).toBe('Client work');
  });

  it('returns a conversation to General without deleting other assignments', () => {
    svc.create('One');
    svc.create('Two');
    svc.assign('claude:a', 'One');
    svc.assign('claude:b', 'Two');
    svc.assign('claude:a', GENERAL_SECTION);
    expect(svc.sectionFor('claude:a')).toBe(GENERAL_SECTION);
    expect(svc.sectionFor('claude:b')).toBe('Two');
  });

  it('rejects blank and case-insensitive duplicate names', () => {
    expect(svc.create('  ')).toBe(false);
    expect(svc.create('Research')).toBe(true);
    expect(svc.create('research')).toBe(false);
    expect(svc.create('General')).toBe(false);
  });

  it('ignores unknown assignments and stored junk', () => {
    store.data.set('agentWrangler.conversationSections', ['Valid', '', 7]);
    store.data.set('agentWrangler.conversationSectionAssignments', [
      { key: 'claude:a', section: 'Valid', atMs: 1 },
      null,
      { key: 'broken' },
    ]);
    const revived = new PinService(store);
    expect(revived.names).toEqual([GENERAL_SECTION, 'Valid']);
    expect(revived.sectionFor('claude:a')).toBe('Valid');
    revived.assign('claude:a', 'Missing');
    expect(revived.sectionFor('claude:a')).toBe('Valid');
  });

  it('fires only for material changes', () => {
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.create('Work');
    svc.create('work');
    svc.assign('claude:a', 'Work');
    svc.assign('claude:a', 'Work');
    expect(fired).toBe(2);
  });

  it('applies assignment writes to fresh storage so another window is preserved', () => {
    svc.create('One');
    svc.create('Two');
    const other = new PinService(store);
    svc.assign('claude:a', 'One');
    other.assign('claude:b', 'Two');
    const revived = new PinService(store);
    expect(revived.sectionFor('claude:a')).toBe('One');
    expect(revived.sectionFor('claude:b')).toBe('Two');
  });

  it('sees another window’s new sections and can return its assignment to General', () => {
    const other = new PinService(store);
    svc.create('Shared');
    expect(other.names).toContain('Shared');
    svc.assign('claude:a', 'Shared');
    expect(other.sectionFor('claude:a')).toBe('Shared');
    other.assign('claude:a', GENERAL_SECTION);
    expect(svc.sectionFor('claude:a')).toBe(GENERAL_SECTION);
  });
});
