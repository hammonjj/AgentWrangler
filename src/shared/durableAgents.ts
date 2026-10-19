/**
 * Durable agents (#179): a configured identity — a name, a role, a scope and
 * its own instructions — that the user comes back to over time, as opposed
 * to a session, which is one runtime conversation.
 *
 * An agent owns no process. It points at its current conversation (one
 * canonical conversation in v1) and remembers the ones before it; typing to
 * it resumes the current one or starts a new one from the agent's
 * configuration. Sessions started anywhere else stay unassigned.
 *
 * Agent Wrangler owns this record. Nothing here writes to Claude Code's or
 * Codex's files: the agent's instructions reach a session the same way the
 * delegation instructions do, appended to its system prompt at launch.
 *
 * Pure: no Node or DOM imports (`src/shared`).
 */

import { emptyMemory, MAX_MEMORY_CHARS, memoryChars, memoryPrompt, MEMORY_PROPOSAL_INSTRUCTIONS, parseStoredMemory, type AgentMemory, type AgentMemoryItem, type AgentMemoryProposal } from './agentMemory';
import type { SessionProvider } from './harness';
import type { SessionStatus } from './model';

export type DurableAgentScope = { kind: 'global' } | { kind: 'folder'; dir: string };

/** One conversation an agent has had, by the provider's own id. */
export interface AgentSessionRef {
  provider: SessionProvider;
  sessionId: string;
  /** ms epoch it was linked to the agent. */
  linkedAt: number;
}

export interface DurableAgent {
  id: string;
  name: string;
  /** One line: what this agent is for ("Product owner for the web app"). */
  role: string;
  scope: DurableAgentScope;
  /** The agent's own standing instructions. Repository instructions still apply and win. */
  instructions?: string;
  /**
   * A file in the agent's project folder whose text is added to its
   * instructions (#182), relative to the folder. Read afresh at every launch
   * and resume, so an edit to it reaches the next conversation; a missing file
   * is reported, never skipped. Folder agents only.
   */
  instructionsFile?: string;
  provider: SessionProvider;
  /** Empty means the launcher's current default. */
  model?: string;
  effort?: string;
  /** The conversation typing to the agent continues. */
  current?: AgentSessionRef;
  /** Earlier conversations, newest first. */
  history: AgentSessionRef[];
  /**
   * Sessions the user took off this agent by hand (#181), lower-cased ids.
   * Such a session still carries the agent as its origin, so without this a
   * resume of it would be mistaken for the agent's conversation continuing.
   */
  detached: string[];
  /** Continuity: the "where we left off" record and the agent's pending proposals (#180). */
  memory: AgentMemory;
  /** Listed first (#182). */
  pinned?: boolean;
  /** Hidden from the directory until "Show archived" (#182). Still opens from a link. */
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What the create/edit form sends. Everything else is the host's. */
export interface DurableAgentInput {
  name: string;
  role: string;
  scope: DurableAgentScope;
  instructions?: string;
  instructionsFile?: string;
  provider: SessionProvider;
  model?: string;
  effort?: string;
}

export const MAX_AGENT_NAME = 60;
export const MAX_AGENT_ROLE = 200;
export const MAX_AGENT_INSTRUCTIONS = 8000;
/** The most of an instructions file a conversation is sent; a longer file is refused, not cut. */
export const MAX_AGENT_INSTRUCTIONS_FILE = 16_000;
export const MAX_AGENT_INSTRUCTIONS_PATH = 300;
/** Past conversations kept per agent. Older ones are still sessions; they only lose the link. */
export const MAX_AGENT_HISTORY = 50;
export const AGENT_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'] as const;

/**
 * An instructions file's path as typed, checked: relative to the agent's
 * folder and inside it. Whether it exists, and where a symlink in it leads,
 * is the host's to check.
 */
export function checkInstructionsPath(raw: string): { path: string } | { error: string } {
  const p = raw.trim().replace(/^\.\/+/, '');
  if (p.length > MAX_AGENT_INSTRUCTIONS_PATH) return { error: 'That instructions file path is too long.' };
  if (p.startsWith('/') || p.startsWith('~')) return { error: 'Give the instructions file relative to the project folder, like docs/agents/po.md.' };
  if (p.split('/').some((seg) => seg === '..')) return { error: 'The instructions file must be inside the project folder.' };
  if (/[\0\n\r]/.test(p)) return { error: 'That is not a file path.' };
  return { path: p };
}

/**
 * Check and tidy what a form sent. A browser is a client, so nothing here is
 * trusted: a folder must be an absolute path (whether it exists, and whether
 * the client may name it, is the host's call).
 */
export function sanitizeAgentInput(raw: unknown): { value: DurableAgentInput } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'No agent was sent.' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(r.name);
  if (!name) return { error: 'Give the agent a name.' };
  if (name.length > MAX_AGENT_NAME) return { error: `Keep the name to ${MAX_AGENT_NAME} characters or fewer.` };
  const role = str(r.role);
  if (!role) return { error: 'Say what the agent is for.' };
  if (role.length > MAX_AGENT_ROLE) return { error: `Keep the role to ${MAX_AGENT_ROLE} characters or fewer.` };
  const instructions = str(r.instructions);
  if (instructions.length > MAX_AGENT_INSTRUCTIONS) return { error: `Keep the instructions to ${MAX_AGENT_INSTRUCTIONS} characters or fewer.` };
  const provider = r.provider === 'codex' ? 'codex' : r.provider === 'claude' || r.provider === undefined ? 'claude' : undefined;
  if (!provider) return { error: 'Choose Claude or Codex.' };
  const scopeRaw = r.scope as Record<string, unknown> | undefined;
  let scope: DurableAgentScope;
  if (!scopeRaw || scopeRaw.kind === 'global') scope = { kind: 'global' };
  else if (scopeRaw.kind === 'folder' && typeof scopeRaw.dir === 'string' && scopeRaw.dir.startsWith('/')) scope = { kind: 'folder', dir: scopeRaw.dir.replace(/\/+$/, '') || '/' };
  else return { error: 'Choose Global or a project folder.' };
  const model = str(r.model);
  if (model.length > 100 || /\s/.test(model)) return { error: 'That is not a model name.' };
  const effort = str(r.effort);
  if (!(AGENT_EFFORTS as readonly string[]).includes(effort)) return { error: 'Choose an effort from the list.' };
  let instructionsFile: string | undefined;
  const fileRaw = str(r.instructionsFile);
  if (fileRaw) {
    if (scope.kind !== 'folder') return { error: 'An instructions file needs a project folder; a Global agent has only its own instructions.' };
    const checked = checkInstructionsPath(fileRaw);
    if ('error' in checked) return checked;
    instructionsFile = checked.path || undefined;
  }
  return {
    value: {
      name,
      role,
      scope,
      provider,
      ...(instructions ? { instructions } : {}),
      ...(instructionsFile ? { instructionsFile } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  };
}

/** A new agent from a checked form. */
export function createAgent(id: string, input: DurableAgentInput, now: number): DurableAgent {
  return { id, ...input, history: [], detached: [], memory: emptyMemory(), createdAt: now, updatedAt: now };
}

/** Whether saving this edit ends the current conversation (#182 Q5): the form warns first. */
export function editStartsFresh(agent: Pick<DurableAgent, 'provider' | 'scope' | 'current'>, input: Pick<DurableAgentInput, 'provider' | 'scope'>): boolean {
  return agent.current !== undefined && !(agent.provider === input.provider && sameScope(agent.scope, input.scope));
}

/**
 * An edit. Identity, conversations, memory and creation time are kept. A
 * change of provider or scope cannot continue the current conversation (a
 * Codex thread is not a Claude session; a session belongs to its folder), so
 * it is moved to history and the next message starts a new one. Everything
 * else applies from the next launch or resume.
 */
export function editAgent(agent: DurableAgent, input: DurableAgentInput, now: number): DurableAgent {
  const next: DurableAgent = {
    id: agent.id,
    ...input,
    history: agent.history,
    detached: agent.detached,
    memory: agent.memory,
    ...(agent.pinned ? { pinned: true } : {}),
    ...(agent.archived ? { archived: true } : {}),
    createdAt: agent.createdAt,
    updatedAt: now,
  };
  if (agent.current) {
    if (!editStartsFresh(agent, input)) next.current = agent.current;
    else next.history = pushHistory(agent.history, agent.current);
  }
  return next;
}

/** Pin or archive (#182). Archiving unpins: an archived agent is out of the way, not first. */
export function setAgentFlag(agent: DurableAgent, flag: 'pinned' | 'archived', on: boolean, now: number): DurableAgent {
  const next: DurableAgent = { ...agent, updatedAt: now };
  delete next[flag];
  if (on) next[flag] = true;
  if (flag === 'archived' && on) delete next.pinned;
  if (flag === 'pinned' && on) delete next.archived;
  return next;
}

export function sameScope(a: DurableAgentScope, b: DurableAgentScope): boolean {
  return a.kind === b.kind && (a.kind === 'global' || a.dir === (b as { dir: string }).dir);
}

function pushHistory(history: AgentSessionRef[], ref: AgentSessionRef): AgentSessionRef[] {
  return [ref, ...history.filter((h) => !(h.provider === ref.provider && h.sessionId === ref.sessionId))].slice(0, MAX_AGENT_HISTORY);
}

/**
 * Make `ref` the agent's current conversation. The one it replaces goes to
 * history, unless it is the same conversation under a new id: Claude Code
 * issues a new session id on resume and after a compaction, and that is a
 * continuation, not a new conversation (`previousId`).
 */
export function linkSession(agent: DurableAgent, ref: AgentSessionRef, now: number, previousId?: string): DurableAgent {
  const cur = agent.current;
  if (cur && sameRef(cur, ref)) return agent;
  const continued = cur !== undefined && previousId !== undefined && cur.sessionId.toLowerCase() === previousId.toLowerCase();
  const history = cur && !continued ? pushHistory(agent.history, cur) : agent.history;
  const id = ref.sessionId.toLowerCase();
  return {
    ...agent,
    current: ref,
    history: history.filter((h) => !sameRef(h, ref)),
    detached: agent.detached.filter((d) => d !== id),
    updatedAt: now,
  };
}

/** "New conversation": the next message starts afresh; the old one stays in history. */
export function startFresh(agent: DurableAgent, now: number): DurableAgent {
  if (!agent.current) return agent;
  return { ...agent, current: undefined, history: pushHistory(agent.history, agent.current), updatedAt: now };
}

function sameRef(a: Pick<AgentSessionRef, 'provider' | 'sessionId'>, b: Pick<AgentSessionRef, 'provider' | 'sessionId'>): boolean {
  return a.provider === b.provider && a.sessionId.toLowerCase() === b.sessionId.toLowerCase();
}

/** Whether this conversation is the agent's, current or earlier. */
export function hasSession(agent: Pick<DurableAgent, 'current' | 'history'>, ref: Pick<AgentSessionRef, 'provider' | 'sessionId'>): boolean {
  return (agent.current !== undefined && sameRef(agent.current, ref)) || agent.history.some((h) => sameRef(h, ref));
}

/**
 * Take a conversation off the agent by hand (#181). It stays a session,
 * unassigned. Taking the current one off leaves the agent with none, so its
 * next message starts a new conversation; the earlier ones are untouched.
 */
export function unassignSession(agent: DurableAgent, ref: Pick<AgentSessionRef, 'provider' | 'sessionId'>, now: number): DurableAgent {
  if (!hasSession(agent, ref)) return agent;
  const id = ref.sessionId.toLowerCase();
  const next: DurableAgent = {
    ...agent,
    history: agent.history.filter((h) => !sameRef(h, ref)),
    detached: [id, ...agent.detached.filter((d) => d !== id)].slice(0, MAX_AGENT_HISTORY),
    updatedAt: now,
  };
  if (agent.current && sameRef(agent.current, ref)) delete next.current;
  return next;
}

/** Whether the user took this conversation off the agent by hand. */
export function isDetached(agent: Pick<DurableAgent, 'detached'>, sessionId: string): boolean {
  return agent.detached.includes(sessionId.toLowerCase());
}

export function sessionKeyOf(ref: Pick<AgentSessionRef, 'provider' | 'sessionId'>): string {
  return `${ref.provider}:${ref.sessionId.toLowerCase()}`;
}

/** A session key back into a ref, for a key a client sent. */
export function refOfKey(key: string): Pick<AgentSessionRef, 'provider' | 'sessionId'> | undefined {
  const at = key.indexOf(':');
  const provider = key.slice(0, at);
  const sessionId = key.slice(at + 1);
  if ((provider !== 'claude' && provider !== 'codex') || !sessionId) return undefined;
  return { provider, sessionId };
}

/**
 * Whether a session can become this agent's (#181): the same harness, and the
 * agent's folder (a session belongs to the folder it runs in). A Global agent
 * works in its own scratch folder, so it takes a session from anywhere: Global
 * means "not tied to a project", and a conversation the user chooses to give
 * it is theirs to give.
 */
export function canAssign(agent: Pick<DurableAgent, 'provider' | 'scope'>, session: { provider: string; cwd?: string }): boolean {
  if (agent.provider !== session.provider) return false;
  if (agent.scope.kind === 'global') return true;
  const cwd = session.cwd?.replace(/\/+$/, '');
  return cwd !== undefined && (cwd === agent.scope.dir || cwd.startsWith(`${agent.scope.dir}/`));
}

/**
 * Agents as stored, read tolerantly: a record that does not parse is dropped
 * rather than taking the daemon down over one bad entry.
 */
export function parseStoredAgents(raw: unknown): DurableAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: DurableAgent[] = [];
  const seen = new Set<string>();
  const ref = (v: unknown): AgentSessionRef | undefined => {
    const r = v as Partial<AgentSessionRef> | null;
    if (!r || typeof r !== 'object' || (r.provider !== 'claude' && r.provider !== 'codex') || typeof r.sessionId !== 'string' || !r.sessionId) return undefined;
    return { provider: r.provider, sessionId: r.sessionId, linkedAt: typeof r.linkedAt === 'number' ? r.linkedAt : 0 };
  };
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id || seen.has(a.id)) continue;
    const input = sanitizeAgentInput(a);
    if ('error' in input) continue;
    seen.add(a.id);
    const current = ref(a.current);
    const history = Array.isArray(a.history) ? a.history.map(ref).filter((h): h is AgentSessionRef => h !== undefined).slice(0, MAX_AGENT_HISTORY) : [];
    const detached = Array.isArray(a.detached) ? a.detached.filter((d): d is string => typeof d === 'string' && d.length > 0).map((d) => d.toLowerCase()).slice(0, MAX_AGENT_HISTORY) : [];
    out.push({
      id: a.id,
      ...input.value,
      ...(current ? { current } : {}),
      history,
      detached,
      memory: parseStoredMemory(a.memory),
      ...(a.pinned === true ? { pinned: true } : {}),
      ...(a.archived === true ? { archived: true } : {}),
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
      updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0,
    });
  }
  return out;
}

// ---- the conversation pane's key for an agent with nothing to resume ----

const DRAFT_PREFIX = 'agent:';

/** The key the conversation pane shows an agent by before it has a session. */
export function agentDraftKey(agentId: string): string {
  return `${DRAFT_PREFIX}${agentId}`;
}

export function agentIdOfDraftKey(key: string): string | undefined {
  return key.startsWith(DRAFT_PREFIX) && key.length > DRAFT_PREFIX.length ? key.slice(DRAFT_PREFIX.length) : undefined;
}

// ---- the session's origin: how a session says which agent it works for ----

export interface AgentOrigin {
  kind: 'agent';
  agentId: string;
}

export function agentOrigin(agentId: string): AgentOrigin {
  return { kind: 'agent', agentId };
}

export function agentIdOfOrigin(origin: unknown): string | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const o = origin as Partial<AgentOrigin>;
  return o.kind === 'agent' && typeof o.agentId === 'string' && o.agentId ? o.agentId : undefined;
}

// ---- opening an agent ----

export type AgentOpenPlan =
  /** Show this session; typing to it continues it. */
  | { kind: 'show'; key: string }
  /** Nothing to continue: show the agent's empty conversation; the first message starts one. */
  | { kind: 'draft'; notice?: string };

/**
 * What selecting an agent shows. Deterministic, and never quietly a different
 * conversation: if the current one cannot be found, the user is told that the
 * next message starts a new one rather than being dropped into another
 * session's context.
 */
export function planAgentOpen(agent: DurableAgent, lookup: (key: string) => { status: SessionStatus } | undefined, live: (key: string) => boolean): AgentOpenPlan {
  const cur = agent.current;
  if (!cur) return { kind: 'draft' };
  const key = sessionKeyOf(cur);
  if (live(key) || lookup(key)) return { kind: 'show', key };
  return {
    kind: 'draft',
    notice: `${agent.name}'s last conversation could not be found (it may have been deleted). Sending starts a new conversation.`,
  };
}

/**
 * What is appended to the session's system prompt. Stated as working style,
 * not authority: the agent's record never grants permissions or turns a
 * discussion into delegated work, and the repository's own instructions win.
 */
export function agentInstructions(
  agent: Pick<DurableAgent, 'name' | 'role' | 'instructions' | 'instructionsFile'> & { memory?: Pick<AgentMemory, 'items'> },
  /** The instructions file's text, read by the host. */
  fileText?: string,
): string {
  const lines = [
    `You are "${agent.name}", a durable agent configured in Agent Wrangler. Your role: ${agent.role}`,
    'Project and repository instructions (CLAUDE.md, AGENTS.md and the documents they name) are authoritative; where these agent instructions conflict with them, follow the repository.',
    'These instructions describe your role and working style only. They do not grant permissions, change approval policy, or authorise you to start implementation the user has not asked for.',
  ];
  if (agent.instructions) lines.push('', 'Agent instructions:', agent.instructions);
  if (fileText?.trim()) lines.push('', `Agent instructions from ${agent.instructionsFile ?? 'a file'} in the project:`, fileText.trim());
  const notes = memoryPrompt(agent.memory?.items ?? []);
  if (notes) lines.push('', notes);
  if (agent.memory) lines.push('', MEMORY_PROPOSAL_INSTRUCTIONS);
  return lines.join('\n');
}

// ---- what the Agents view draws ----

export interface DurableAgentView {
  id: string;
  name: string;
  role: string;
  scope: DurableAgentScope;
  /** "Global" or the folder's last segment. */
  scopeLabel: string;
  provider: SessionProvider;
  model?: string;
  effort?: string;
  instructions?: string;
  instructionsFile?: string;
  /** The current conversation's session key, when there is one. */
  currentKey?: string;
  /** Its status when the session is known; absent when it is not. */
  currentStatus?: SessionStatus;
  /** Its title, for "where we left off". */
  currentTitle?: string;
  /** The last prompt sent, as the store previews it. */
  currentSubtitle?: string;
  /** ms epoch of the last activity in any of its conversations it can see. */
  lastActivityAt?: number;
  /** How many earlier conversations it remembers. */
  historyCount: number;
  /** Its earlier conversations, newest first (#181). */
  history: AgentHistoryView[];
  /** The continuity record and what the agent proposes for it (#180). */
  memory: AgentMemoryItem[];
  proposals: AgentMemoryProposal[];
  /** Characters the record uses, against `memoryCap`. */
  memoryChars: number;
  memoryCap: number;
  pinned?: boolean;
  archived?: boolean;
}

/**
 * What the conversation pane shows of the agent a conversation belongs to
 * (#180): its memory, to read and correct beside the conversation, and the
 * agent's pending proposals as cards.
 */
export interface AgentMemoryPaneView {
  agentId: string;
  agentName: string;
  items: AgentMemoryItem[];
  proposals: AgentMemoryProposal[];
  chars: number;
  cap: number;
}

export function memoryPaneView(agent: Pick<DurableAgent, 'id' | 'name' | 'memory'>): AgentMemoryPaneView {
  return { agentId: agent.id, agentName: agent.name, items: agent.memory.items, proposals: agent.memory.proposals, chars: memoryChars(agent.memory.items), cap: MAX_MEMORY_CHARS };
}

/** One earlier conversation, as the Agents view lists it. */
export interface AgentHistoryView {
  key: string;
  provider: SessionProvider;
  /** Absent when the store no longer has the session: listed, but there is nothing to open. */
  title?: string;
  status?: SessionStatus;
  lastActivityAt?: number;
  linkedAt: number;
}

export function scopeLabel(scope: DurableAgentScope): string {
  if (scope.kind === 'global') return 'Global';
  const parts = scope.dir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? scope.dir;
}

export interface AgentSessionFacts {
  status: SessionStatus;
  title: string;
  subtitle?: string;
  lastActivityAt: number;
}

export function agentView(agent: DurableAgent, lookup: (key: string) => AgentSessionFacts | undefined): DurableAgentView {
  const currentKey = agent.current ? sessionKeyOf(agent.current) : undefined;
  const cur = currentKey ? lookup(currentKey) : undefined;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    scope: agent.scope,
    scopeLabel: scopeLabel(agent.scope),
    provider: agent.provider,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    ...(agent.instructionsFile ? { instructionsFile: agent.instructionsFile } : {}),
    ...(currentKey ? { currentKey } : {}),
    ...(cur ? { currentStatus: cur.status, currentTitle: cur.title, ...(cur.subtitle ? { currentSubtitle: cur.subtitle } : {}) } : {}),
    lastActivityAt: cur?.lastActivityAt ?? agent.current?.linkedAt ?? undefined,
    historyCount: agent.history.length,
    history: agent.history.map((h) => {
      const key = sessionKeyOf(h);
      const s = lookup(key);
      return { key, provider: h.provider, linkedAt: h.linkedAt, ...(s ? { title: s.title, status: s.status, lastActivityAt: s.lastActivityAt } : {}) };
    }),
    memory: agent.memory.items,
    proposals: agent.memory.proposals,
    memoryChars: memoryChars(agent.memory.items),
    memoryCap: MAX_MEMORY_CHARS,
    ...(agent.pinned ? { pinned: true } : {}),
    ...(agent.archived ? { archived: true } : {}),
  };
}

/**
 * Pinned first, archived last, and most recently used first within each,
 * then by name: the agent you were just talking to is at the top.
 */
export function orderAgents(views: DurableAgentView[]): DurableAgentView[] {
  const rank = (v: DurableAgentView) => (v.pinned ? 0 : v.archived ? 2 : 1);
  return [...views].sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
}

/** The agents a session row may be given to (#181): not archived, not its owner already, most recent first. */
export function assignableAgents(views: readonly DurableAgentView[], session: { provider: string; cwd?: string }, ownerId?: string): DurableAgentView[] {
  return orderAgents(views.filter((v) => !v.archived && v.id !== ownerId && canAssign(v, session)));
}
