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
  provider: SessionProvider;
  /** Empty means the launcher's current default. */
  model?: string;
  effort?: string;
  /** The conversation typing to the agent continues. */
  current?: AgentSessionRef;
  /** Earlier conversations, newest first. */
  history: AgentSessionRef[];
  createdAt: number;
  updatedAt: number;
}

/** What the create/edit form sends. Everything else is the host's. */
export interface DurableAgentInput {
  name: string;
  role: string;
  scope: DurableAgentScope;
  instructions?: string;
  provider: SessionProvider;
  model?: string;
  effort?: string;
}

export const MAX_AGENT_NAME = 60;
export const MAX_AGENT_ROLE = 200;
export const MAX_AGENT_INSTRUCTIONS = 8000;
/** Past conversations kept per agent. Older ones are still sessions; they only lose the link. */
export const MAX_AGENT_HISTORY = 50;
export const AGENT_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'] as const;

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
  return {
    value: {
      name,
      role,
      scope,
      provider,
      ...(instructions ? { instructions } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  };
}

/** A new agent from a checked form. */
export function createAgent(id: string, input: DurableAgentInput, now: number): DurableAgent {
  return { id, ...input, history: [], createdAt: now, updatedAt: now };
}

/**
 * An edit. Identity, conversations and creation time are kept. A change of
 * provider or scope cannot continue the current conversation (a Codex thread
 * is not a Claude session; a session belongs to its folder), so it is moved
 * to history and the next message starts a new one.
 */
export function editAgent(agent: DurableAgent, input: DurableAgentInput, now: number): DurableAgent {
  const next: DurableAgent = { id: agent.id, ...input, history: agent.history, createdAt: agent.createdAt, updatedAt: now };
  if (agent.current) {
    const keeps = agent.provider === input.provider && sameScope(agent.scope, input.scope);
    if (keeps) next.current = agent.current;
    else next.history = pushHistory(agent.history, agent.current);
  }
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
  if (cur && cur.provider === ref.provider && cur.sessionId === ref.sessionId) return agent;
  const continued = cur !== undefined && previousId !== undefined && cur.sessionId === previousId;
  const history = cur && !continued ? pushHistory(agent.history, cur) : agent.history;
  return { ...agent, current: ref, history: history.filter((h) => !(h.provider === ref.provider && h.sessionId === ref.sessionId)), updatedAt: now };
}

/** "New conversation": the next message starts afresh; the old one stays in history. */
export function startFresh(agent: DurableAgent, now: number): DurableAgent {
  if (!agent.current) return agent;
  return { ...agent, current: undefined, history: pushHistory(agent.history, agent.current), updatedAt: now };
}

export function sessionKeyOf(ref: Pick<AgentSessionRef, 'provider' | 'sessionId'>): string {
  return `${ref.provider}:${ref.sessionId.toLowerCase()}`;
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
    out.push({
      id: a.id,
      ...input.value,
      ...(current ? { current } : {}),
      history,
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
export function agentInstructions(agent: Pick<DurableAgent, 'name' | 'role' | 'instructions'>): string {
  const lines = [
    `You are "${agent.name}", a durable agent configured in Agent Wrangler. Your role: ${agent.role}`,
    'Project and repository instructions (CLAUDE.md, AGENTS.md and the documents they name) are authoritative; where these agent instructions conflict with them, follow the repository.',
    'These instructions describe your role and working style only. They do not grant permissions, change approval policy, or authorise you to start implementation the user has not asked for.',
  ];
  if (agent.instructions) lines.push('', 'Agent instructions:', agent.instructions);
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
    ...(currentKey ? { currentKey } : {}),
    ...(cur ? { currentStatus: cur.status, currentTitle: cur.title, ...(cur.subtitle ? { currentSubtitle: cur.subtitle } : {}) } : {}),
    lastActivityAt: cur?.lastActivityAt ?? agent.current?.linkedAt ?? undefined,
    historyCount: agent.history.length,
  };
}

/** Most recently used first, then by name: the agent you were just talking to is at the top. */
export function orderAgents(views: DurableAgentView[]): DurableAgentView[] {
  return [...views].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
}
