import { describe, expect, it } from 'vitest';
import type { SessionDTO } from '../src/shared/model';
import { canDismissAhead, MAX_AGE_MS, PendingDismissals } from '../src/shared/pendingDismissals';

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-1',
    key: 'claude:sess-1',
    title: 'proj',
    status: 'waiting',
    lastActivityAt: 1_000,
    cwd: '/Users/test/proj',
    pid: 4242,
    ...over,
  };
}

describe('canDismissAhead', () => {
  it('moves an idle row at once, and waits on one that is working', () => {
    expect(canDismissAhead(session({ status: 'waiting' }))).toBe(true);
    for (const status of ['busy', 'stuck', 'blocked'] as const) {
      expect(canDismissAhead(session({ status }))).toBe(false);
    }
  });
});

describe('PendingDismissals', () => {
  it('draws a dismissed row as ended, and a hidden one as archived, before the host says so', () => {
    const d = new PendingDismissals();
    const a = session({ key: 'a' });
    const b = session({ key: 'b' });
    const c = session({ key: 'c' });
    d.begin('a', 'dismiss', 0);
    d.begin('b', 'dismissHide', 0);
    const [ra, rb, rc] = d.apply([a, b, c]);
    expect(ra.status).toBe('ended');
    expect(rb.archived).toBe(true);
    expect(rc).toBe(c);
  });

  it('puts the row back when the host says the close failed', () => {
    const d = new PendingDismissals();
    const a = session({ key: 'a' });
    d.begin('a', 'dismiss', 0);
    expect(d.fail('a')).toBe(true);
    expect(d.apply([a])[0]).toBe(a);
    expect(d.fail('a')).toBe(false);
  });

  it('ends once the snapshot shows the outcome', () => {
    const d = new PendingDismissals();
    d.begin('a', 'dismiss', 0);
    d.begin('b', 'dismissHide', 0);
    d.settle([session({ key: 'a', status: 'waiting' }), session({ key: 'b', status: 'ended' })], 10);
    // `b` ended but is not archived yet: the Project tab would show it again.
    expect(d.size).toBe(2);
    d.settle([session({ key: 'a', status: 'ended' }), session({ key: 'b', archived: true })], 20);
    expect(d.size).toBe(0);
  });

  it('forgets a row that left the snapshot, and one the host never answered for', () => {
    const d = new PendingDismissals();
    d.begin('gone', 'dismiss', 0);
    d.begin('slow', 'dismiss', 0);
    d.settle([session({ key: 'slow' })], MAX_AGE_MS);
    expect(d.size).toBe(1);
    d.settle([session({ key: 'slow' })], MAX_AGE_MS + 1);
    expect(d.size).toBe(0);
  });
});
