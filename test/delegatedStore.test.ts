/**
 * The store applies the derived orchestration state (#101) to every row, and
 * its change events and toast edges follow the derivation: a mission moving
 * re-derives the origin without a provider scan, a parent waiting on children
 * never toasts an early Done, and an approval the mission announced is not
 * toasted again by the row.
 */
import { describe, expect, it } from 'vitest';
import { SessionStore, type StoreUpdate } from '../src/core/sessionStore';
import type { AgentSession } from '../src/shared/model';
import type { Mission, RouteRecommendation } from '../src/shared/orchestration/types';
import { turnStartFor } from '../src/claude/status';
import { reduceHookEvent, type HookEvent } from '../src/claude/hookEvents';
import { attempt, mission, T0, task } from './orchestration/fixtures';

const SID = 'thread-0001';
const KEY = `codex:${SID}`;
const REC = { verdict: 'route' } as unknown as RouteRecommendation;

function proposal(id: string, at: number): Mission {
  return mission({
    id,
    origin: { provider: 'codex', sessionId: SID, turnStartedAt: T0 },
    state: 'draft',
    tasks: [task('t1', { state: 'routed', recommendation: REC })],
    createdAt: at,
    updatedAt: at,
  });
}

function running(m: Mission, at: number): Mission {
  return {
    ...m,
    state: 'running',
    startApproval: { at, by: 'user' },
    tasks: [{ ...m.tasks[0], state: 'running', attemptIds: ['a1'] }],
    attempts: [attempt('a1', 't1', { state: 'running' })],
    updatedAt: at,
  };
}

async function harness(initial: AgentSession) {
  let row = initial;
  let missions: Mission[] = [];
  const store = new SessionStore();
  store.useLinkedWork((key) => missions.filter((m) => m.origin && `${m.origin.provider}:${m.origin.sessionId}` === key));
  await store.register({ id: 'codex', displayName: 'Codex', start: async () => {}, refresh: async () => {}, scan: async () => [row], onDidChange: () => ({ dispose() {} }), dispose() {} });
  const updates: StoreUpdate[] = [];
  store.onDidUpdate((u) => updates.push(u));
  return {
    store,
    updates,
    edges: () => updates.map((u) => u.becameWaiting.map((s) => s.status)),
    setRow: async (next: Partial<AgentSession>) => {
      row = { ...row, ...next };
      await store.refresh();
    },
    setMissions: (next: Mission[]) => {
      missions = next;
      store.linkedWorkApplied();
    },
  };
}

const base: AgentSession = { provider: 'codex', sessionId: SID, key: KEY, title: 'Origin', status: 'busy', lastActivityAt: T0, turnStartedAt: T0, runnerOwned: true };

describe('store: derived orchestration state (#101)', () => {
  it('an approval resolves the origin\'s Waiting with no provider change, and every surface sees it', async () => {
    const h = await harness(base);
    h.setMissions([proposal('mA', T0 + 1)]);
    await h.setRow({ status: 'waiting', lastActivityAt: T0 + 2 });
    expect(h.store.get(KEY)).toMatchObject({ status: 'waiting', wait: { reason: 'awaiting-approval', ref: { missionId: 'mA' } } });
    // A3: the mission's own notice announced the approval; the row does not toast it again.
    expect(h.edges().at(-1)).toEqual([]);

    h.setMissions([running(proposal('mA', T0 + 1), T0 + 3)]);
    const row = h.store.get(KEY)!;
    expect(row.status).toBe('done');
    expect(row.wait).toMatchObject({ reason: 'awaiting-children', ref: { missionId: 'mA' } });
    expect(row.linked?.map((w) => w.phase)).toEqual(['running']);
    expect(h.updates.at(-1)?.upserted.map((s) => s.key)).toEqual([KEY]);
    expect(h.store.waitingCount).toBe(0);
  });

  it('a parent waiting on children never toasts an early Done; a plain finished turn still does', async () => {
    const h = await harness(base);
    h.setMissions([running(proposal('mA', T0 + 1), T0 + 2)]);
    await h.setRow({ status: 'done', lastActivityAt: T0 + 3 });
    expect(h.store.get(KEY)?.status).toBe('done');
    expect(h.edges().at(-1)).toEqual([]);

    const plain = await harness({ ...base, key: 'codex:thread-0002', sessionId: 'thread-0002' });
    await plain.setRow({ status: 'done', lastActivityAt: T0 + 3 });
    expect(plain.edges().at(-1)).toEqual(['done']);
  });

  it('re-applying the same missions (a duplicate event) fires nothing', async () => {
    const h = await harness({ ...base, status: 'waiting' });
    const ms = [running(proposal('mA', T0 + 1), T0 + 2)];
    h.setMissions(ms);
    const n = h.updates.length;
    h.setMissions([...ms]);
    h.setMissions([...ms, ...ms]);
    expect(h.updates.length).toBe(n);
  });

  it('usage and renames re-derive from the provider\'s reading, never from the derived row', async () => {
    const h = await harness({ ...base, status: 'waiting' });
    h.setMissions([running(proposal('mA', T0 + 1), T0 + 2)]);
    expect(h.store.get(KEY)?.status).toBe('done');
    // The mission fails: the raw prose Waiting stands again, now pointing at it.
    // (The store derives against the real clock, and a terminal mission is listed for a day.)
    h.setMissions([{ ...running(proposal('mA', T0 + 1), T0 + 2), state: 'failed', updatedAt: Date.now() }]);
    h.store.renameApplied();
    h.store.usageApplied();
    expect(h.store.get(KEY)).toMatchObject({ status: 'waiting', wait: { reason: 'user-reply', ref: { missionId: 'mA' } } });
  });
});

describe('Claude status path: the turn stamp that ties a turn to its missions (K2)', () => {
  const ev = (over: Partial<HookEvent>): HookEvent => ({ hookEventName: 'UserPromptSubmit', sessionId: 's1', receivedAtMs: T0, ...over }) as HookEvent;

  it('is kept after the turn ends, unlike the live turn clock', () => {
    let s = reduceHookEvent(undefined, ev({ receivedAtMs: T0 + 1 }));
    s = reduceHookEvent(s, ev({ hookEventName: 'Stop', receivedAtMs: T0 + 9 }));
    expect(s.turnStartedAtMs).toBeUndefined();
    expect(turnStartFor(s)).toBe(T0 + 1);
  });

  it('is unknown when it came from a backlog replay, or when there are no hooks', () => {
    expect(turnStartFor({ lastPromptAtMs: T0, lastPromptUncertain: true })).toBeUndefined();
    expect(turnStartFor(undefined)).toBeUndefined();
  });
});
