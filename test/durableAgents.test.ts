import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentFile } from '../src/app/durableAgents';
import {
  assignableAgents,
  canAssign,
  checkInstructionsPath,
  editStartsFresh,
  isDetached,
  MAX_AGENT_INSTRUCTIONS_FILE,
  refOfKey,
  unassignSession,
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

describe('history and assignment (#181)', () => {
  const a = linkSession(linkSession(createAgent('a1', INPUT, 1), { provider: 'claude', sessionId: 's1', linkedAt: 2 }, 2), { provider: 'claude', sessionId: 's2', linkedAt: 3 }, 3);

  it('lists earlier conversations with what the store knows of them', () => {
    const v = agentView(a, (k) => (k === 'claude:s1' ? { status: 'ended', title: 'Roadmap', lastActivityAt: 9 } : undefined));
    expect(v.history).toEqual([{ key: 'claude:s1', provider: 'claude', linkedAt: 2, title: 'Roadmap', status: 'ended', lastActivityAt: 9 }]);
  });

  it('unassigning the current conversation leaves none; an earlier one just leaves history', () => {
    const off = unassignSession(a, { provider: 'claude', sessionId: 'S2' }, 4);
    expect(off.current).toBeUndefined();
    expect(off.history.map((h) => h.sessionId)).toEqual(['s1']);
    const earlier = unassignSession(a, { provider: 'claude', sessionId: 's1' }, 4);
    expect(earlier.current?.sessionId).toBe('s2');
    expect(earlier.history).toEqual([]);
    expect(unassignSession(a, { provider: 'codex', sessionId: 's1' }, 4)).toBe(a);
  });

  it('a session can go to an agent of its harness and folder; a Global agent takes any folder', () => {
    expect(canAssign(INPUT, { provider: 'claude', cwd: '/Users/test/proj' })).toBe(true);
    expect(canAssign(INPUT, { provider: 'claude', cwd: '/Users/test/proj/sub' })).toBe(true);
    expect(canAssign(INPUT, { provider: 'claude', cwd: '/Users/test/project' })).toBe(false);
    expect(canAssign(INPUT, { provider: 'codex', cwd: '/Users/test/proj' })).toBe(false);
    expect(canAssign({ ...INPUT, scope: { kind: 'global' } }, { provider: 'claude', cwd: '/elsewhere' })).toBe(true);
    const views = [agentView(createAgent('a1', INPUT, 1), () => undefined), agentView({ ...createAgent('a2', INPUT, 1), archived: true }, () => undefined), agentView(createAgent('a3', { ...INPUT, provider: 'codex' }, 1), () => undefined)];
    expect(assignableAgents(views, { provider: 'claude', cwd: '/Users/test/proj' }).map((v) => v.id)).toEqual(['a1']);
    expect(assignableAgents(views, { provider: 'claude', cwd: '/Users/test/proj' }, 'a1')).toEqual([]);
  });

  it('reads a session key back', () => {
    expect(refOfKey('codex:T1')).toEqual({ provider: 'codex', sessionId: 'T1' });
    expect(refOfKey('agent:a1')).toBeUndefined();
    expect(refOfKey('claude:')).toBeUndefined();
  });
});

describe('configuring (#182)', () => {
  it('takes an instructions file inside a project folder only', () => {
    expect(sanitizeAgentInput({ ...INPUT, instructionsFile: './docs/agents/po.md' })).toMatchObject({ value: { instructionsFile: 'docs/agents/po.md' } });
    expect(sanitizeAgentInput({ ...INPUT, scope: { kind: 'global' }, instructionsFile: 'po.md' })).toHaveProperty('error');
    expect(sanitizeAgentInput({ ...INPUT, instructionsFile: '../other/po.md' })).toHaveProperty('error');
    expect(sanitizeAgentInput({ ...INPUT, instructionsFile: '/etc/passwd' })).toHaveProperty('error');
    expect(checkInstructionsPath('docs/a..b.md')).toEqual({ path: 'docs/a..b.md' });
  });

  it('every field stays editable; only a harness or folder change ends the current conversation', () => {
    const linked = linkSession(createAgent('a1', INPUT, 1), { provider: 'claude', sessionId: 's1', linkedAt: 2 }, 2);
    expect(editStartsFresh(linked, { ...INPUT })).toBe(false);
    expect(editStartsFresh(linked, { ...INPUT, provider: 'codex' })).toBe(true);
    expect(editStartsFresh(linked, { ...INPUT, scope: { kind: 'global' } })).toBe(true);
    expect(editStartsFresh(createAgent('a2', INPUT, 1), { ...INPUT, provider: 'codex' })).toBe(false);
  });

  it('orders pinned first and archived last, most recent first within each', () => {
    const v = (id: string, name: string, at: number, extra: object = {}) => ({ ...agentView(createAgent(id, { ...INPUT, name }, 1), () => undefined), lastActivityAt: at, ...extra });
    const ordered = orderAgents([v('1', 'old', 1), v('2', 'archived', 99, { archived: true }), v('3', 'pinned', 0, { pinned: true }), v('4', 'new', 50)]);
    expect(ordered.map((x) => x.name)).toEqual(['pinned', 'new', 'old', 'archived']);
  });

  it("adds the file's text to the instructions, naming the file", () => {
    const text = agentInstructions({ name: 'PO', role: 'r', instructionsFile: 'docs/po.md' }, 'Write acceptance criteria first.');
    expect(text).toContain('from docs/po.md');
    expect(text).toContain('Write acceptance criteria first.');
  });
});

describe('reading an instructions file (#182)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-agent-')));
    fs.mkdirSync(path.join(dir, 'proj', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'proj', 'docs', 'po.md'), 'Be brief.');
    fs.writeFileSync(path.join(dir, 'outside.md'), 'secret');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a file in the folder, and says what is wrong otherwise', () => {
    const proj = path.join(dir, 'proj');
    expect(readAgentFile(proj, 'docs/po.md', 'PO')).toEqual({ text: 'Be brief.' });
    expect(readAgentFile(proj, 'docs/missing.md', 'PO')).toMatchObject({ error: expect.stringContaining('was not found') });
    expect(readAgentFile(proj, 'docs', 'PO')).toMatchObject({ error: expect.stringContaining('is not a file') });
    fs.symlinkSync(path.join(dir, 'outside.md'), path.join(proj, 'docs', 'link.md'));
    expect(readAgentFile(proj, 'docs/link.md', 'PO')).toMatchObject({ error: expect.stringContaining('leads outside') });
    fs.writeFileSync(path.join(proj, 'docs', 'long.md'), 'x'.repeat(MAX_AGENT_INSTRUCTIONS_FILE + 1));
    expect(readAgentFile(proj, 'docs/long.md', 'PO')).toMatchObject({ error: expect.stringContaining('longer than') });
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

  it('assigns a session to one agent at most, and unassigns it so a resume does not claim it back (#181)', () => {
    const storage = memoryStorage();
    let n = 0;
    const store = new DurableAgentStore(storage, () => 100, () => `id${++n}`);
    const a = store.create(INPUT);
    const b = store.create(INPUT);
    store.link(a.id, { provider: 'claude', sessionId: 's1' });
    store.assign(b.id, { provider: 'claude', sessionId: 'S1' });
    expect(store.get(a.id)?.current).toBeUndefined();
    expect(store.holderOf('claude', 's1')).toMatchObject({ agent: { id: b.id }, current: true });
    store.link(b.id, { provider: 'claude', sessionId: 's2' });
    expect(store.holderOf('claude', 's1')).toMatchObject({ agent: { id: b.id }, current: false });
    expect(store.unassign({ provider: 'claude', sessionId: 's1' })).toBe(true);
    expect(store.holderOf('claude', 's1')).toBeUndefined();
    expect(isDetached(store.get(b.id)!, 'S1')).toBe(true);
    expect(store.unassign({ provider: 'claude', sessionId: 'nobody' })).toBe(false);
    // Assigning it again undoes the detachment.
    store.assign(b.id, { provider: 'claude', sessionId: 's1' });
    expect(isDetached(store.get(b.id)!, 's1')).toBe(false);
  });

  it('keeps memory and proposals, which approve through the store (#180)', () => {
    const storage = memoryStorage();
    let h = 0;
    const store = new DurableAgentStore(storage, () => 100, () => 'a1', () => (++h).toString(16).padStart(8, '0'));
    store.create(INPUT);
    expect(store.memory('a1', { op: 'remember', kind: 'decision', text: 'Postgres' })).toHaveProperty('agent');
    const proposed = store.propose('a1', { op: 'add', kind: 'preference', text: 'Prefers tables' });
    expect(proposed).toEqual({ proposalId: 'p-00000002' });
    expect(store.get('a1')?.memory.items.map((i) => i.text)).toEqual(['Postgres']);
    store.memory('a1', { op: 'approve', proposalId: 'p-00000002' });
    expect(new DurableAgentStore(storage).get('a1')?.memory.items.map((i) => [i.text, i.source])).toEqual([['Postgres', 'user'], ['Prefers tables', 'agent']]);
    // An edit to the agent keeps its memory.
    store.update('a1', { ...INPUT, role: 'Reviews PRs' });
    expect(store.get('a1')?.memory.items).toHaveLength(2);
    expect(store.memory('gone', { op: 'forget', itemId: 'm-00000001' })).toEqual({ error: 'That agent no longer exists.' });
  });

  it('pins and archives (#182)', () => {
    const store = new DurableAgentStore(memoryStorage(), () => 100, () => 'a1');
    store.create(INPUT);
    expect(store.setFlag('a1', 'pinned', true)).toMatchObject({ pinned: true });
    const archived = store.setFlag('a1', 'archived', true);
    expect(archived).toMatchObject({ archived: true });
    expect(archived?.pinned).toBeUndefined();
    expect(store.setFlag('a1', 'archived', false)?.archived).toBeUndefined();
  });

  it('drops a stored record that does not parse rather than failing', () => {
    const good = createAgent('ok', INPUT, 1);
    const parsed = parseStoredAgents([good, { id: 'bad' }, 'junk', { ...good }]);
    expect(parsed.map((a) => a.id)).toEqual(['ok']);
    expect(parseStoredAgents({ not: 'a list' })).toEqual([]);
  });
});
