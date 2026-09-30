import { describe, expect, it } from 'vitest';
import { stoppedCodexSession } from '../src/codex/stoppedStatus';
import { SessionStore } from '../src/core/sessionStore';
import type { SessionRecord } from '../src/core/session/sessionRegistry';
import type { AgentSession } from '../src/shared/model';

const discovered: AgentSession = {
  provider: 'codex', sessionId: 'thread', key: 'codex:thread', title: 'Test',
  status: 'stuck', statusIsEstimated: true, lastActivityAt: 100,
  progress: { startedAtMs: 90, blockedMs: 0, toolCalls: 0 },
};
const stopped: SessionRecord = {
  v: 1, sessionId: 'thread', provider: 'codex', cwd: '/Users/test/proj',
  launch: {}, state: 'stopped', createdAt: 1, lastShownAt: 1, updatedAt: 200,
};

describe('stopped Codex status', () => {
  it('keeps a stopped run ended across stale stuck and done rollout snapshots', async () => {
    let row = discovered;
    const store = new SessionStore();
    store.useLiveSessions((session) => stoppedCodexSession(session, stopped));
    await store.register({
      id: 'codex', displayName: 'Codex', start: async () => {}, refresh: async () => {},
      scan: async () => [row], onDidChange: () => ({ dispose() {} }), dispose() {},
    });
    const statuses: string[] = [];
    store.onDidUpdate((update) => statuses.push(...update.upserted.map((s) => s.status)));
    expect(store.get(discovered.key)).toMatchObject({ status: 'ended', statusIsEstimated: false, progress: undefined });
    row = { ...row, status: 'done' };
    await store.refresh();
    expect(store.get(discovered.key)?.status).toBe('ended');
    expect(statuses).toEqual([]);
    store.dispose();
  });

  it('defers to a later external turn and to an open-elsewhere owner', () => {
    expect(stoppedCodexSession({ ...discovered, lastActivityAt: 201 }, stopped)).toBeUndefined();
    expect(stoppedCodexSession({ ...discovered, lastActivityAt: 301 },
      { ...stopped, stateChangedAt: 200, updatedAt: 400 })).toBeUndefined();
    expect(stoppedCodexSession(discovered, { ...stopped, endedReason: 'open-elsewhere' })).toBeUndefined();
    expect(stoppedCodexSession(discovered, { ...stopped, state: 'live' })).toBeUndefined();
  });
});
