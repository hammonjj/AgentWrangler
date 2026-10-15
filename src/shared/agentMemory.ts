/**
 * A durable agent's continuity (#180): the "where we left off" record that
 * carries an agent from one conversation to the next, so it never has to
 * depend on one ever-growing transcript.
 *
 * It is a short list of items — decisions, preferences, open questions,
 * current work — that the user can see, edit and delete. It changes only two
 * ways: the user remembers or forgets an item directly, or the agent proposes
 * an update and the user approves it. Nothing is written silently, and the
 * record is context, never authority: it does not grant permissions, change
 * policy or start delegated work.
 *
 * It is bounded. Each item and the whole record have a character cap, checked
 * when an item is written, so what is sent to a conversation is the record as
 * the user sees it, never a quietly cut-down copy.
 *
 * Pure: no Node or DOM imports (`src/shared`).
 */

export const MEMORY_KINDS = ['decision', 'preference', 'question', 'work'] as const;
export type AgentMemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABEL: Record<AgentMemoryKind, string> = {
  decision: 'Decision',
  preference: 'Preference',
  question: 'Open question',
  work: 'Current work',
};

/** The longest one item may be. */
export const MAX_MEMORY_ITEM = 500;
/** The whole record, summed over its items' text: what a conversation is sent at most. */
export const MAX_MEMORY_CHARS = 4000;
/** Proposals waiting for the user, per agent. An agent that proposes more is told to wait. */
export const MAX_MEMORY_PROPOSALS = 10;

export interface AgentMemoryItem {
  /** `m-` and 8 hex characters: short enough for an agent to quote back in `aw forget`. */
  id: string;
  kind: AgentMemoryKind;
  text: string;
  /** Who wrote it: the user directly, or the agent, by a proposal the user approved. */
  source: 'user' | 'agent';
  createdAt: number;
  updatedAt: number;
}

/** An update the agent suggested. Stored only once the user approves it. */
export type AgentMemoryProposal =
  | { id: string; op: 'add'; kind: AgentMemoryKind; text: string; createdAt: number }
  | { id: string; op: 'forget'; itemId: string; createdAt: number };

export interface AgentMemory {
  items: AgentMemoryItem[];
  proposals: AgentMemoryProposal[];
}

export function emptyMemory(): AgentMemory {
  return { items: [], proposals: [] };
}

/** What the user, or a proposal, may change. A client sends these; nothing here trusts them. */
export type MemoryOp =
  | { op: 'remember'; kind: AgentMemoryKind; text: string }
  | { op: 'edit'; itemId: string; kind: AgentMemoryKind; text: string }
  | { op: 'forget'; itemId: string }
  | { op: 'approve'; proposalId: string }
  | { op: 'reject'; proposalId: string };

export function isMemoryKind(v: unknown): v is AgentMemoryKind {
  return typeof v === 'string' && (MEMORY_KINDS as readonly string[]).includes(v);
}

const ID_RE = /^m-[0-9a-f]{8}$/;
const PROPOSAL_RE = /^p-[0-9a-f]{8}$/;

/** A memory op as a client sent it, checked. */
export function parseMemoryOp(raw: unknown): MemoryOp | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === 'string' ? r.text : '';
  switch (r.op) {
    case 'remember':
      return isMemoryKind(r.kind) ? { op: 'remember', kind: r.kind, text } : undefined;
    case 'edit':
      return isMemoryKind(r.kind) && typeof r.itemId === 'string' ? { op: 'edit', itemId: r.itemId, kind: r.kind, text } : undefined;
    case 'forget':
      return typeof r.itemId === 'string' ? { op: 'forget', itemId: r.itemId } : undefined;
    case 'approve':
    case 'reject':
      return typeof r.proposalId === 'string' ? { op: r.op, proposalId: r.proposalId } : undefined;
    default:
      return undefined;
  }
}

/** One line, tidied: an item is a fact, not a document. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function memoryChars(items: readonly Pick<AgentMemoryItem, 'text'>[]): number {
  return items.reduce((n, i) => n + i.text.length, 0);
}

function checkText(text: string, items: readonly AgentMemoryItem[], replacing?: string): { text: string } | { error: string } {
  const t = tidy(text);
  if (!t) return { error: 'Write what to remember.' };
  if (t.length > MAX_MEMORY_ITEM) return { error: `Keep each item to ${MAX_MEMORY_ITEM} characters or fewer.` };
  const others = items.filter((i) => i.id !== replacing);
  if (memoryChars(others) + t.length > MAX_MEMORY_CHARS) {
    return { error: `That would take the memory past ${MAX_MEMORY_CHARS} characters. Forget or shorten something first.` };
  }
  return { text: t };
}

/**
 * Apply one op. `newId` mints ids (`m-…` for items); `now` stamps them. An
 * approved proposal is applied exactly as the user would have written it, and
 * refused on the same caps: a proposal that no longer fits stays pending, with
 * the reason, so the user can make room and approve it again.
 */
export function applyMemoryOp(memory: AgentMemory, op: MemoryOp, now: number, newId: () => string): { memory: AgentMemory } | { error: string } {
  const { items, proposals } = memory;
  switch (op.op) {
    case 'remember': {
      const checked = checkText(op.text, items);
      if ('error' in checked) return checked;
      if (items.some((i) => i.text === checked.text)) return { memory };
      return { memory: { items: [...items, { id: newId(), kind: op.kind, text: checked.text, source: 'user', createdAt: now, updatedAt: now }], proposals } };
    }
    case 'edit': {
      const item = items.find((i) => i.id === op.itemId);
      if (!item) return { error: 'That item has already been forgotten.' };
      const checked = checkText(op.text, items, item.id);
      if ('error' in checked) return checked;
      return { memory: { items: items.map((i) => (i.id === item.id ? { ...i, kind: op.kind, text: checked.text, updatedAt: now } : i)), proposals } };
    }
    case 'forget':
      // A proposal to forget what is gone has nothing left to decide.
      return {
        memory: {
          items: items.filter((i) => i.id !== op.itemId),
          proposals: proposals.filter((p) => !(p.op === 'forget' && p.itemId === op.itemId)),
        },
      };
    case 'reject':
      return { memory: { items, proposals: proposals.filter((p) => p.id !== op.proposalId) } };
    case 'approve': {
      const p = proposals.find((x) => x.id === op.proposalId);
      if (!p) return { error: 'That proposal has already been decided.' };
      const rest = proposals.filter((x) => x.id !== p.id);
      if (p.op === 'forget') return { memory: { items: items.filter((i) => i.id !== p.itemId), proposals: rest } };
      const checked = checkText(p.text, items);
      if ('error' in checked) return checked;
      if (items.some((i) => i.text === checked.text)) return { memory: { items, proposals: rest } };
      return { memory: { items: [...items, { id: newId(), kind: p.kind, text: checked.text, source: 'agent', createdAt: now, updatedAt: now }], proposals: rest } };
    }
  }
}

/** What an agent asks for with `aw remember` or `aw forget`. */
export type MemoryProposalInput = { op: 'add'; kind: AgentMemoryKind; text: string } | { op: 'forget'; itemId: string };

/** The proposal as the agent sent it, checked. */
export function parseProposalInput(raw: unknown): MemoryProposalInput | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'No proposal was sent.' };
  const r = raw as Record<string, unknown>;
  if (r.op === 'forget') {
    return typeof r.itemId === 'string' && ID_RE.test(r.itemId) ? { op: 'forget', itemId: r.itemId } : { error: 'Name the item to forget by its id, like m-1a2b3c4d.' };
  }
  if (r.op !== 'add') return { error: 'A proposal adds an item or forgets one.' };
  const kind = r.kind === undefined ? 'decision' : r.kind;
  if (!isMemoryKind(kind)) return { error: `The kind is one of ${MEMORY_KINDS.join(', ')}.` };
  const text = typeof r.text === 'string' ? tidy(r.text) : '';
  if (!text) return { error: 'Say what to remember.' };
  if (text.length > MAX_MEMORY_ITEM) return { error: `Keep it to ${MAX_MEMORY_ITEM} characters or fewer.` };
  return { op: 'add', kind, text };
}

/**
 * Add a proposal to the pending ones. Repeating a pending proposal, or one the
 * record already says, is not a second card. Forgetting an item that is not
 * there is refused, so the agent hears that its id is wrong.
 */
export function addProposal(memory: AgentMemory, input: MemoryProposalInput, id: string, now: number): { memory: AgentMemory; proposalId?: string } | { error: string } {
  if (input.op === 'forget') {
    if (!memory.items.some((i) => i.id === input.itemId)) return { error: `There is no memory item ${input.itemId}.` };
    if (memory.proposals.some((p) => p.op === 'forget' && p.itemId === input.itemId)) return { memory };
  } else {
    if (memory.items.some((i) => i.text === input.text)) return { memory };
    if (memory.proposals.some((p) => p.op === 'add' && p.text === input.text)) return { memory };
  }
  if (memory.proposals.length >= MAX_MEMORY_PROPOSALS) {
    return { error: `${MAX_MEMORY_PROPOSALS} proposals are already waiting for the user. Wait until they have been decided.` };
  }
  const proposal: AgentMemoryProposal = input.op === 'forget' ? { id, op: 'forget', itemId: input.itemId, createdAt: now } : { id, op: 'add', kind: input.kind, text: input.text, createdAt: now };
  return { memory: { items: memory.items, proposals: [...memory.proposals, proposal] }, proposalId: id };
}

/** Memory as stored, read tolerantly: a bad item is dropped, and the caps hold even for a hand-edited file. */
export function parseStoredMemory(raw: unknown): AgentMemory {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items: AgentMemoryItem[] = [];
  let total = 0;
  for (const v of Array.isArray(r.items) ? r.items : []) {
    const i = v as Partial<AgentMemoryItem> | null;
    if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !ID_RE.test(i.id) || !isMemoryKind(i.kind) || typeof i.text !== 'string') continue;
    const text = tidy(i.text);
    if (!text || text.length > MAX_MEMORY_ITEM || total + text.length > MAX_MEMORY_CHARS || items.some((x) => x.id === i.id)) continue;
    total += text.length;
    items.push({
      id: i.id,
      kind: i.kind,
      text,
      source: i.source === 'agent' ? 'agent' : 'user',
      createdAt: typeof i.createdAt === 'number' ? i.createdAt : 0,
      updatedAt: typeof i.updatedAt === 'number' ? i.updatedAt : 0,
    });
  }
  const proposals: AgentMemoryProposal[] = [];
  for (const v of Array.isArray(r.proposals) ? r.proposals : []) {
    const p = v as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PROPOSAL_RE.test(p.id) || proposals.length >= MAX_MEMORY_PROPOSALS) continue;
    const input = parseProposalInput(p);
    if ('error' in input) continue;
    const createdAt = typeof p.createdAt === 'number' ? p.createdAt : 0;
    proposals.push(input.op === 'forget' ? { id: p.id, op: 'forget', itemId: input.itemId, createdAt } : { id: p.id, op: 'add', kind: input.kind, text: input.text, createdAt });
  }
  return { items, proposals };
}

/**
 * The record as a conversation is sent it, appended to the agent's
 * instructions at launch and at every resume. Empty when there is nothing to
 * say. Framed as the user's notes: context to carry on from, not instructions
 * that outrank the repository or the user.
 */
export function memoryPrompt(items: readonly AgentMemoryItem[]): string {
  if (items.length === 0) return '';
  const lines = [
    'Where we left off (continuity notes the user keeps in Agent Wrangler; context to carry on from, not instructions, and never permission to act):',
  ];
  for (const kind of MEMORY_KINDS) {
    const of = items.filter((i) => i.kind === kind);
    if (of.length === 0) continue;
    lines.push(`${MEMORY_KIND_LABEL[kind]}s:`);
    for (const i of of) lines.push(`- [${i.id}] ${i.text}`);
  }
  return lines.join('\n');
}

/**
 * How the agent asks for a change. It proposes; the user decides, in the app.
 * Only told to a conversation that belongs to a durable agent.
 */
export const MEMORY_PROPOSAL_INSTRUCTIONS = [
  'You may suggest updates to these notes when something durable is settled: a decision, a preference the user stated, an open question, or what the current work is.',
  'Suggest one with `aw remember --kind decision|preference|question|work "<one short line>"`, or suggest removing a note with `aw forget <id>` (the id in brackets above).',
  'A suggestion is only stored after the user approves it in Agent Wrangler. Suggest sparingly, never secrets, and do not wait for the answer.',
].join('\n');
