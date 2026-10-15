import { describe, expect, it } from 'vitest';
import {
  addProposal,
  applyMemoryOp,
  emptyMemory,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_ITEM,
  MAX_MEMORY_PROPOSALS,
  memoryPrompt,
  parseMemoryOp,
  parseProposalInput,
  parseStoredMemory,
  type AgentMemory,
} from '../src/shared/agentMemory';
import { agentInstructions } from '../src/shared/durableAgents';

let n = 0;
const ids = () => `m-${(++n).toString(16).padStart(8, '0')}`;

function apply(memory: AgentMemory, op: Parameters<typeof applyMemoryOp>[1]): AgentMemory {
  const r = applyMemoryOp(memory, op, 1, ids);
  if ('error' in r) throw new Error(r.error);
  return r.memory;
}

describe('remembering and forgetting (#180)', () => {
  it('remembers, edits and forgets an item, tidying its text', () => {
    let m = apply(emptyMemory(), { op: 'remember', kind: 'decision', text: '  Ship v2\n in March ' });
    expect(m.items).toMatchObject([{ kind: 'decision', text: 'Ship v2 in March', source: 'user' }]);
    const id = m.items[0].id;
    m = apply(m, { op: 'edit', itemId: id, kind: 'work', text: 'Shipping v2' });
    expect(m.items).toMatchObject([{ id, kind: 'work', text: 'Shipping v2' }]);
    m = apply(m, { op: 'forget', itemId: id });
    expect(m.items).toEqual([]);
  });

  it('remembering the same thing twice keeps one item', () => {
    const once = apply(emptyMemory(), { op: 'remember', kind: 'decision', text: 'A' });
    expect(apply(once, { op: 'remember', kind: 'decision', text: 'A' }).items).toHaveLength(1);
  });

  it('refuses an empty item, a long one, and one that takes the record past the cap', () => {
    expect(applyMemoryOp(emptyMemory(), { op: 'remember', kind: 'decision', text: '  ' }, 1, ids)).toEqual({ error: 'Write what to remember.' });
    expect(applyMemoryOp(emptyMemory(), { op: 'remember', kind: 'decision', text: 'x'.repeat(MAX_MEMORY_ITEM + 1) }, 1, ids)).toHaveProperty('error');
    let m = emptyMemory();
    for (let i = 0; i < MAX_MEMORY_CHARS / MAX_MEMORY_ITEM; i++) m = apply(m, { op: 'remember', kind: 'work', text: `${i}`.padEnd(MAX_MEMORY_ITEM, 'x') });
    const over = applyMemoryOp(m, { op: 'remember', kind: 'work', text: 'one more' }, 1, ids);
    expect('error' in over && over.error).toContain(`${MAX_MEMORY_CHARS} characters`);
    // An edit is measured without the item it replaces.
    expect(applyMemoryOp(m, { op: 'edit', itemId: m.items[0].id, kind: 'work', text: 'short' }, 1, ids)).not.toHaveProperty('error');
  });

  it('editing an item already forgotten says so', () => {
    expect(applyMemoryOp(emptyMemory(), { op: 'edit', itemId: 'm-00000000', kind: 'work', text: 'x' }, 1, ids)).toEqual({ error: 'That item has already been forgotten.' });
  });
});

describe("the agent's proposals (#180)", () => {
  it('stores nothing until approved, then stores it as the agent\'s', () => {
    const added = addProposal(emptyMemory(), { op: 'add', kind: 'preference', text: 'Prefers tables' }, 'p-00000001', 5);
    if ('error' in added) throw new Error(added.error);
    expect(added.memory.items).toEqual([]);
    expect(added.memory.proposals).toEqual([{ id: 'p-00000001', op: 'add', kind: 'preference', text: 'Prefers tables', createdAt: 5 }]);
    const approved = apply(added.memory, { op: 'approve', proposalId: 'p-00000001' });
    expect(approved.items).toMatchObject([{ kind: 'preference', text: 'Prefers tables', source: 'agent' }]);
    expect(approved.proposals).toEqual([]);
  });

  it('a rejected proposal leaves the record as it was', () => {
    const added = addProposal(emptyMemory(), { op: 'add', kind: 'decision', text: 'x' }, 'p-00000001', 5);
    if ('error' in added) throw new Error(added.error);
    expect(apply(added.memory, { op: 'reject', proposalId: 'p-00000001' })).toEqual(emptyMemory());
  });

  it('a proposal to forget removes the item only on approval', () => {
    const m = apply(emptyMemory(), { op: 'remember', kind: 'question', text: 'Which DB?' });
    const id = m.items[0].id;
    const added = addProposal(m, { op: 'forget', itemId: id }, 'p-00000002', 5);
    if ('error' in added) throw new Error(added.error);
    expect(added.memory.items).toHaveLength(1);
    expect(apply(added.memory, { op: 'approve', proposalId: 'p-00000002' }).items).toEqual([]);
    expect(addProposal(m, { op: 'forget', itemId: 'm-ffffffff' }, 'p-3', 5)).toEqual({ error: 'There is no memory item m-ffffffff.' });
  });

  it('forgetting an item by hand drops a pending proposal to forget it', () => {
    const m = apply(emptyMemory(), { op: 'remember', kind: 'question', text: 'Which DB?' });
    const added = addProposal(m, { op: 'forget', itemId: m.items[0].id }, 'p-00000002', 5);
    if ('error' in added) throw new Error(added.error);
    expect(apply(added.memory, { op: 'forget', itemId: m.items[0].id }).proposals).toEqual([]);
  });

  it('an approval that no longer fits is refused and the proposal stays', () => {
    let m = emptyMemory();
    for (let i = 0; i < MAX_MEMORY_CHARS / MAX_MEMORY_ITEM; i++) m = apply(m, { op: 'remember', kind: 'work', text: `${i}`.padEnd(MAX_MEMORY_ITEM, 'x') });
    const added = addProposal(m, { op: 'add', kind: 'decision', text: 'late' }, 'p-00000001', 5);
    if ('error' in added) throw new Error(added.error);
    expect(applyMemoryOp(added.memory, { op: 'approve', proposalId: 'p-00000001' }, 1, ids)).toHaveProperty('error');
    expect(added.memory.proposals).toHaveLength(1);
  });

  it('repeats are not a second card, and there is a limit to what can wait', () => {
    const a = addProposal(emptyMemory(), { op: 'add', kind: 'decision', text: 'x' }, 'p-1', 5);
    if ('error' in a) throw new Error(a.error);
    const again = addProposal(a.memory, { op: 'add', kind: 'decision', text: 'x' }, 'p-2', 6);
    expect('memory' in again && again.memory).toBe(a.memory);
    expect('proposalId' in again && again.proposalId).toBeFalsy();
    let m = emptyMemory();
    for (let i = 0; i < MAX_MEMORY_PROPOSALS; i++) {
      const r = addProposal(m, { op: 'add', kind: 'decision', text: `p${i}` }, `p-${i}`, 1);
      if ('error' in r) throw new Error(r.error);
      m = r.memory;
    }
    expect(addProposal(m, { op: 'add', kind: 'decision', text: 'one too many' }, 'p-x', 1)).toHaveProperty('error');
  });

  it('checks what the agent sent', () => {
    expect(parseProposalInput({ op: 'add', text: ' Prefers  tables ' })).toEqual({ op: 'add', kind: 'decision', text: 'Prefers tables' });
    expect(parseProposalInput({ op: 'add', kind: 'secret', text: 'x' })).toHaveProperty('error');
    expect(parseProposalInput({ op: 'add', text: '' })).toHaveProperty('error');
    expect(parseProposalInput({ op: 'forget', itemId: '../x' })).toHaveProperty('error');
    expect(parseProposalInput({ op: 'grant', text: 'x' })).toHaveProperty('error');
  });

  it('reads a client op strictly', () => {
    expect(parseMemoryOp({ op: 'remember', kind: 'work', text: 'x' })).toEqual({ op: 'remember', kind: 'work', text: 'x' });
    expect(parseMemoryOp({ op: 'remember', kind: 'nope', text: 'x' })).toBeUndefined();
    expect(parseMemoryOp({ op: 'approve' })).toBeUndefined();
    expect(parseMemoryOp('forget')).toBeUndefined();
  });
});

describe('what a conversation is sent (#180)', () => {
  it('is empty with no items, and grouped by kind with ids otherwise', () => {
    expect(memoryPrompt([])).toBe('');
    const m = apply(apply(emptyMemory(), { op: 'remember', kind: 'question', text: 'Which DB?' }), { op: 'remember', kind: 'decision', text: 'Postgres for now' });
    const text = memoryPrompt(m.items);
    expect(text).toMatch(/not instructions, and never permission/);
    expect(text.indexOf('Decisions:')).toBeLessThan(text.indexOf('Open questions:'));
    expect(text).toContain(`- [${m.items[1].id}] Postgres for now`);
  });

  it("is part of an agent's instructions, within the cap, with how to propose", () => {
    let m = emptyMemory();
    for (let i = 0; i < MAX_MEMORY_CHARS / MAX_MEMORY_ITEM; i++) m = apply(m, { op: 'remember', kind: 'work', text: `${i}`.padEnd(MAX_MEMORY_ITEM, 'x') });
    const text = agentInstructions({ name: 'PO', role: 'Owns the backlog', memory: m });
    for (const i of m.items) expect(text).toContain(i.text);
    expect(text.length).toBeLessThan(MAX_MEMORY_CHARS + 3000);
    expect(text).toContain('aw remember');
    expect(text).toMatch(/only stored after the user approves/);
  });
});

describe('memory as stored', () => {
  it('drops bad items and holds the caps even for a hand-edited file', () => {
    const big = 'x'.repeat(MAX_MEMORY_ITEM);
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `m-${i.toString(16).padStart(8, '0')}`, kind: 'work', text: big }));
    const parsed = parseStoredMemory({ items: [...items, { id: 'bad', kind: 'work', text: 'x' }, { id: 'm-abcdabcd', kind: 'nope', text: 'x' }], proposals: [{ id: 'p-00000001', op: 'add', text: 'y' }, { id: 'p-00000002', op: 'grant' }] });
    expect(parsed.items).toHaveLength(MAX_MEMORY_CHARS / MAX_MEMORY_ITEM);
    expect(parsed.proposals).toEqual([{ id: 'p-00000001', op: 'add', kind: 'decision', text: 'y', createdAt: 0 }]);
    expect(parseStoredMemory(undefined)).toEqual(emptyMemory());
  });
});
