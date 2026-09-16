import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { PinService } from '../src/core/pinService';

function storage(): KeyValueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string, dflt: T): T => (data.has(key) ? (data.get(key) as T) : dflt),
    update: (key: string, value: unknown) => data.set(key, value),
  };
}

describe('PinService', () => {
  let store: ReturnType<typeof storage>;
  let svc: PinService;

  beforeEach(() => {
    store = storage();
    svc = new PinService(store);
  });

  it('pins and unpins', () => {
    expect(svc.isPinned('claude:a')).toBe(false);
    svc.toggle('claude:a');
    expect(svc.isPinned('claude:a')).toBe(true);
    expect(svc.count).toBe(1);
    svc.toggle('claude:a');
    expect(svc.isPinned('claude:a')).toBe(false);
  });

  it('is idempotent, so a repeated set is not a change', () => {
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.set('claude:a', true);
    svc.set('claude:a', true);
    expect(fired).toBe(1);
    svc.set('claude:b', false);
    expect(fired).toBe(1);
  });

  /**
   * The rest of the table sorts by recency, which is right when the question is
   * "what moved". A pinned section that reordered itself whenever an agent
   * wrote a line would defeat the point of pinning, which is knowing where to
   * look — so pins keep the order they were made in.
   */
  it('remembers the order pins were made in, oldest first', () => {
    svc.set('claude:a', true);
    svc.set('claude:b', true);
    const a = svc.pinnedAt('claude:a')!;
    const b = svc.pinnedAt('claude:b')!;
    expect(a).toBeLessThanOrEqual(b);
  });

  it('has no pin time for something that is not pinned', () => {
    expect(svc.pinnedAt('claude:a')).toBeUndefined();
  });

  it('keeps the other pins when one is removed', () => {
    svc.set('claude:a', true);
    svc.set('claude:b', true);
    svc.set('claude:a', false);
    expect(svc.isPinned('claude:a')).toBe(false);
    expect(svc.isPinned('claude:b')).toBe(true);
  });

  it('survives a reload', () => {
    svc.set('claude:a', true);
    const revived = new PinService(store);
    expect(revived.isPinned('claude:a')).toBe(true);
    expect(revived.pinnedAt('claude:a')).toBe(svc.pinnedAt('claude:a'));
  });

  it('ignores junk in storage rather than throwing on startup', () => {
    store.data.set('agentWrangler.pinnedKeys', [{ key: 'claude:a', atMs: 1 }, null, { key: 'no-time' }, 'nope']);
    const revived = new PinService(store);
    expect(revived.count).toBe(1);
    expect(revived.isPinned('claude:a')).toBe(true);
  });

  // This runs inside activate(); a throw here would take the extension down
  // over a preference, so a value that is not even a list has to be survivable.
  it.each([{}, 'nope', 42, null] as unknown[])('survives a stored value of %s', (junk) => {
    store.data.set('agentWrangler.pinnedKeys', junk);
    expect(() => new PinService(store)).not.toThrow();
    expect(new PinService(store).count).toBe(0);
  });

  /**
   * Two windows each hold a copy taken when they started. Writing that copy
   * back whole would drop whatever the other window has pinned since — the
   * failure that made a persisted paused-set the wrong design. Only the single
   * change is applied, to storage as it reads at that moment.
   */
  describe('two windows sharing one stored list', () => {
    it('does not drop a pin the other window made', () => {
      const other = new PinService(store);
      svc.set('claude:a', true);
      other.set('claude:b', true); // `other` never saw a
      const third = new PinService(store);
      expect(third.isPinned('claude:a')).toBe(true);
      expect(third.isPinned('claude:b')).toBe(true);
    });

    it('does not resurrect a pin the other window removed', () => {
      svc.set('claude:a', true);
      const other = new PinService(store);
      other.set('claude:a', false);
      // `svc` still has it in memory; its next write must not bring it back.
      svc.set('claude:b', true);
      const third = new PinService(store);
      expect(third.isPinned('claude:a')).toBe(false);
      expect(third.isPinned('claude:b')).toBe(true);
    });
  });
});
