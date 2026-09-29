import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/sessionStore';
import type { AgentSession } from '../src/shared/model';

describe('Subagent fingerprinting', () => {
  it('changes fingerprint when subagent status changes', async () => {
    let scanResult: AgentSession[] = [];
    const mockProvider = {
      id: 'claude',
      displayName: 'Claude',
      start: async () => {},
      refresh: async () => {},
      scan: async () => scanResult,
      onDidChange: () => ({ dispose() {} }),
      onTranscriptAppended: () => ({ dispose() {} }),
      dispose: () => {},
    };

    const store = new SessionStore();
    await store.register(mockProvider as any);

    let session: AgentSession = {
      provider: 'claude',
      sessionId: 'test-1',
      key: 'claude:test-1',
      title: 'Test Session',
      status: 'busy',
      lastActivityAt: 1000,
      subagentList: [
        { id: 'a', label: 'Agent A', status: 'working' },
        { id: 'b', label: 'Agent B', status: 'done' },
      ],
    };

    scanResult = [session];

    const updates: any[] = [];
    store.onDidUpdate((update) => updates.push(update));

    await store.refresh();
    expect(store.get('claude:test-1')).toBeDefined();

    // Change a subagent's status
    session = {
      ...session,
      subagentList: [
        { id: 'a', label: 'Agent A', status: 'done' },
        { id: 'b', label: 'Agent B', status: 'done' },
      ],
    };
    scanResult = [session];
    await store.refresh();

    // Should detect a change due to status change
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].upserted).toEqual([expect.objectContaining({
      subagentList: expect.arrayContaining([
        expect.objectContaining({ id: 'a', status: 'done' }),
      ]),
    })]);

    store.dispose();
  });

  it('does not change fingerprint when only lastActivityAt changes', async () => {
    let scanResult: AgentSession[] = [];
    const mockProvider = {
      id: 'codex',
      displayName: 'Codex',
      start: async () => {},
      refresh: async () => {},
      scan: async () => scanResult,
      onDidChange: () => ({ dispose() {} }),
      onTranscriptAppended: () => ({ dispose() {} }),
      dispose: () => {},
    };

    const store = new SessionStore();
    await store.register(mockProvider as any);

    let session: AgentSession = {
      provider: 'codex',
      sessionId: 'test-2',
      key: 'codex:test-2',
      title: 'Codex Session',
      status: 'busy',
      lastActivityAt: 1000,
      subagentList: [
        { id: 'x', label: 'Subagent X', status: 'working', lastActivityAt: 100 },
      ],
    };

    scanResult = [session];

    const updates: any[] = [];
    store.onDidUpdate((update) => updates.push(update));

    await store.refresh();
    const firstUpdateCount = updates.length;

    // Update only the lastActivityAt in the subagent (should NOT trigger a change)
    session = {
      ...session,
      subagentList: [
        { id: 'x', label: 'Subagent X', status: 'working', lastActivityAt: 200 },
      ],
    };
    scanResult = [session];
    await store.refresh();

    // Should NOT detect a material change since only lastActivityAt changed
    expect(updates.length).toBe(firstUpdateCount);

    store.dispose();
  });

  it('detects when subagent list gains or loses items', async () => {
    let scanResult: AgentSession[] = [];
    const mockProvider = {
      id: 'claude',
      displayName: 'Claude',
      start: async () => {},
      refresh: async () => {},
      scan: async () => scanResult,
      onDidChange: () => ({ dispose() {} }),
      onTranscriptAppended: () => ({ dispose() {} }),
      dispose: () => {},
    };

    const store = new SessionStore();
    await store.register(mockProvider as any);

    let session: AgentSession = {
      provider: 'claude',
      sessionId: 'test-3',
      key: 'claude:test-3',
      title: 'Test',
      status: 'busy',
      lastActivityAt: 1000,
      subagentList: [
        { id: 'a', label: 'Agent A', status: 'working' },
      ],
    };

    scanResult = [session];

    const updates: any[] = [];
    store.onDidUpdate((update) => updates.push(update));

    await store.refresh();
    expect(updates.length).toBeGreaterThan(0);

    // Add a new subagent
    session = {
      ...session,
      subagentList: [
        { id: 'a', label: 'Agent A', status: 'working' },
        { id: 'b', label: 'Agent B', status: 'working' },
      ],
    };
    scanResult = [session];
    await store.refresh();

    // Should detect the change
    expect(updates.at(-1)?.upserted).toEqual([expect.objectContaining({
      subagentList: expect.arrayContaining([
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'b' }),
      ]),
    })]);

    store.dispose();
  });
});
