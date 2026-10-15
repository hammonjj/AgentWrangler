import { describe, expect, it } from 'vitest';
import {
  agentDraftKey,
  agentIdOfDraftKey,
  agentIdOfOrigin,
  agentInstructions,
  agentOrigin,
  agentView,
  createAgent,
  editAgent,
  linkSession,
  MAX_AGENT_HISTORY,
  orderAgents,
  parseStoredAgents,
  planAgentOpen,
  sanitizeAgentInput,
  startFresh,
  type DurableAgent,
  type DurableAgentInput,
} from '../src/shared/durableAgents';
import { DurableAgentStore } from '../src/core/durableAgentStore';

const INPUT: DurableAgentInput = { name: 'PO', role: 'Owns the backlog', scope: { kind: 'folder', dir: '/Users/test/proj' }, provider: 'claude' };

function memoryStorage(initial: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = { ...initial };
  return {
    doc,
    get<T>(key: string, def: T): T {
      return (doc[key] as T) ?? def;
    },
    update(key: string, value: unknown) {
      if (value === undefined) delete doc[key];
      else doc[key] = JSON.parse(JSON.stringify(value));
      return undefined;
    },
  };
}

describe('checking what the form sent', () => {
  it('accepts a tidy agent and trims it', () => {
    const r = sanitizeAgentInput({ name: '  PO ', role: ' Owns the backlog ', scope: { kind: 'folder', dir: '/Users/test/proj/' }, provider: 'codex', model: ' gpt-5 ', effort: 'high', instructions: ' Be brief. ' });
    expect(r).toEqual({ value: { name: 'PO', role: 'Owns the backlog', scope: { kind: 'folder', dir: '/Users/test/proj' }, provider: 'codex', model: 'gpt-5', effort: 'high', instructions: 'Be brief.' } });
  });

  it.each([
    [{ ...INPUT, name: '' }, 'name'],
    [{ ...INPUT, role: ' ' }, 'what the agent is for'],
    [{ ...INPUT, scope: { kind: 'folder', dir: 'relative/path' } }, 'Global or a project'],
    [{ ...INPUT, provider: 'gemini' }, 'Claude or Codex'],
    [{ ...INPUT, effort: 'ludicrous' }, 'effort'],
    [{ ...INPUT, model: 'two words' }, 'model'],
    [{ ...INPUT, name: 'x'.repeat(61) }, '60 characters'],
  ])('refuses %j', (input, message) => {
    const r = sanitizeAgentInput(input);
    expect('error' in r && r.error).toContain(message);
  });

  it('treats a missing scope as Global', () => {
    const r = sanitizeAgentInput({ name: 'a', role: 'b' });
    expect('value' in r && r.value.scope).toEqual({ kind: 'global' });
  });
});

describe('an agent and its conversations', () => {
  const base = createAgent('a1', INPUT, 1);
  const ref = (sessionId: string, provider: 'claude' | 'codex' = 'claude') => ({ provider, sessionId, linkedAt: 2 });

  it('links a first conversation as current, and moves the old one to history on the next', () => {
    const one = linkSession(base, ref('s1'), 2);
    expect(one.current?.sessionId).toBe('s1');
    const two = linkSession(one, ref('s2'), 3);
    expect(two.current?.sessionId).toBe('s2');
    expect(two.history.map((h) => h.sessionId)).toEqual(['s1']);
  });

  it('a new id for the same conversation (resume, compaction) is a continuation, not history', () => {
    const one = linkSession(base, ref('s1'), 2);
    const continued = linkSession(one, ref('s1b'), 3, 's1');
    expect(continued.current?.sessionId).toBe('s1b');
    expect(continued.history).toEqual([]);
  });

  it('linking the current conversation again changes nothing', () => {
    const one = linkSession(base, ref('s1'), 2);
    expect(linkSession(one, ref('s1'), 9)).toBe(one);
  });

  it('starting afresh keeps the old conversation in history', () => {
    const fresh = startFresh(linkSession(base, ref('s1'), 2), 3);
    expect(fresh.current).toBeUndefined();
    expect(fresh.history.map((h) => h.sessionId)).toEqual(['s1']);
  });

  it('caps history', () => {
    let a = base;
    for (let i = 0; i < MAX_AGENT_HISTORY + 5; i++) a = linkSession(a, ref(`s${i}`), i);
    expect(a.history).toHaveLength(MAX_AGENT_HISTORY);
    expect(a.history[0].sessionId).toBe(`s${MAX_AGENT_HISTORY + 3}`);
  });

  it('an edit keeps the conversation unless the harness or the folder changes', () => {
    const linked = linkSession(base, ref('s1'), 2);
    expect(editAgent(linked, { ...INPUT, role: 'Reviews PRs', instructions: 'x' }, 3).current?.sessionId).toBe('s1');
    const moved = editAgent(linked, { ...INPUT, scope: { kind: 'global' } }, 3);
    expect(moved.current).toBeUndefined();
    expect(moved.history.map((h) => h.sessionId)).toEqual(['s1']);
    const codex = editAgent(linked, { ...INPUT, provider: 'codex' }, 3);
    expect(codex.current).toBeUndefined();
    expect(codex.createdAt).toBe(1);
    expect(codex.id).toBe('a1');
  });
});

describe('opening an agent', () => {
  const agent: DurableAgent = { ...createAgent('a1', INPUT, 1), current: { provider: 'claude', sessionId: 'ABC', linkedAt: 1 } };

  it('shows the current conversation when it is known or live', () => {
    expect(planAgentOpen(agent, (k) => (k === 'claude:abc' ? { status: 'ended' } : undefined), () => false)).toEqual({ kind: 'show', key: 'claude:abc' });
    expect(planAgentOpen(agent, () => undefined, (k) => k === 'claude:abc')).toEqual({ kind: 'show', key: 'claude:abc' });
  });

  it('an agent with no conversation shows its empty one', () => {
    expect(planAgentOpen(createAgent('a2', INPUT, 1), () => undefined, () => false)).toEqual({ kind: 'draft' });
  });

  it('a lost conversation is said, never swapped for another', () => {
    const plan = planAgentOpen(agent, () => undefined, () => false);
    expect(plan.kind).toBe('draft');
    expect(plan.kind === 'draft' && plan.notice).toContain('could not be found');
  });
});

describe('keys and origins', () => {
  it('round-trips the draft key and refuses other keys', () => {
    expect(agentIdOfDraftKey(agentDraftKey('a1'))).toBe('a1');
    expect(agentIdOfDraftKey('claude:abc')).toBeUndefined();
    expect(agentIdOfDraftKey('agent:')).toBeUndefined();
  });

  it('reads an agent origin and nothing else', () => {
    expect(agentIdOfOrigin(agentOrigin('a1'))).toBe('a1');
    expect(agentIdOfOrigin({ kind: 'orchestration', missionId: 'm' })).toBeUndefined();
    expect(agentIdOfOrigin(undefined)).toBeUndefined();
  });
});

describe('instructions', () => {
  it('names the role, defers to the repository and grants nothing', () => {
    const text = agentInstructions({ name: 'PO', role: 'Owns the backlog', instructions: 'Write acceptance criteria.' });
    expect(text).toContain('"PO"');
    expect(text).toContain('Owns the backlog');
    expect(text).toMatch(/repository instructions .* authoritative/i);
    expect(text).toMatch(/do not grant permissions/i);
    expect(text).toContain('Write acceptance criteria.');
  });
});

describe('what the Agents view draws', () => {
  it('describes where the agent left off, and orders most recently used first', () => {
    const a = linkSession(createAgent('a1', { ...INPUT, name: 'B' }, 1), { provider: 'claude', sessionId: 's1', linkedAt: 5 }, 5);
    const b = createAgent('a2', { ...INPUT, name: 'A', scope: { kind: 'global' } }, 1);
    const views = orderAgents([
      agentView(b, () => undefined),
      agentView(a, (k) => (k === 'claude:s1' ? { status: 'waiting', title: 'Backlog review', lastActivityAt: 50 } : undefined)),
    ]);
    expect(views.map((v) => v.name)).toEqual(['B', 'A']);
    expect(views[0]).toMatchObject({ currentKey: 'claude:s1', currentStatus: 'waiting', currentTitle: 'Backlog review', lastActivityAt: 50, scopeLabel: 'proj' });
    expect(views[1]).toMatchObject({ scopeLabel: 'Global', historyCount: 0 });
    expect(views[1].currentKey).toBeUndefined();
  });
});

describe('the store', () => {
  it('creates, edits, links and removes, and persists each change', () => {
    const storage = memoryStorage();
    let n = 0;
    const store = new DurableAgentStore(storage, () => 100, () => `id${++n}`);
    let fired = 0;
    store.onDidChange(() => fired++);
    const a = store.create(INPUT);
    expect(a.id).toBe('id1');
    store.link(a.id, { provider: 'claude', sessionId: 'S1' });
    expect(store.ownerOf('claude', 's1')?.id).toBe('id1');
    store.update(a.id, { ...INPUT, role: 'Reviews PRs' });
    expect(new DurableAgentStore(storage).get('id1')).toMatchObject({ role: 'Reviews PRs', current: { sessionId: 'S1' } });
    store.startFresh(a.id);
    expect(store.ownerOf('claude', 's1')).toBeUndefined();
    expect(store.remove(a.id)).toBe(true);
    expect(new DurableAgentStore(storage).list).toEqual([]);
    expect(fired).toBe(5);
  });

  it('drops a stored record that does not parse rather than failing', () => {
    const good = createAgent('ok', INPUT, 1);
    const parsed = parseStoredAgents([good, { id: 'bad' }, 'junk', { ...good }]);
    expect(parsed.map((a) => a.id)).toEqual(['ok']);
    expect(parseStoredAgents({ not: 'a list' })).toEqual([]);
  });
});
