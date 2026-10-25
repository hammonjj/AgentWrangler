/**
 * Child conversations (#198): a durable agent's conversation starts an
 * ordinary Claude or Codex conversation in its own git worktree and branch,
 * drives it, merges its branch itself, and cleans it up. No mission ceremony.
 *
 * The link to the parent rides in the registry `origin` as `{kind: 'child'}`,
 * never `{kind: 'agent'}`: an agent origin would let `follow()` adopt the
 * child as the agent's own conversation. It names the agent by its stable id,
 * so the parent link survives the parent's (and the child's) Claude id
 * changing on resume or compaction: the parent row is whatever conversation
 * the agent continues now. One level only: a child is never an agent's
 * conversation, so it can never spawn.
 *
 * Pure: no Node or DOM imports (`src/shared`).
 */
import type { SessionProvider } from './harness';
import type { SessionStatus } from './model';

export interface ChildOrigin {
  kind: 'child';
  /** The durable agent whose conversation started it. Its stable id, not a session id. */
  agentId: string;
  /** Stable for the child's whole life, whatever its session id becomes: the worktree's slug. */
  childId: string;
  /** The conversation that spawned it, at spawn time. Informational: the agent id decides. */
  parent: { provider: SessionProvider; sessionId: string };
  worktree: string;
  branch: string;
  repo: string;
}

export function childOrigin(o: Omit<ChildOrigin, 'kind'>): ChildOrigin {
  return { kind: 'child', ...o };
}

/** A child origin, read tolerantly: anything else (another kind, a torn record) is not one. */
export function parseChildOrigin(origin: unknown): ChildOrigin | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const o = origin as Record<string, unknown>;
  if (o.kind !== 'child') return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const p = o.parent as Record<string, unknown> | undefined;
  const agentId = str(o.agentId);
  const childId = str(o.childId);
  const worktree = str(o.worktree);
  const branch = str(o.branch);
  const repo = str(o.repo);
  if (!agentId || !childId || !worktree || !branch || !repo) return undefined;
  const parent = p && (p.provider === 'claude' || p.provider === 'codex') && str(p.sessionId) ? { provider: p.provider as SessionProvider, sessionId: p.sessionId as string } : undefined;
  if (!parent) return undefined;
  return { kind: 'child', agentId, childId, parent, worktree, branch, repo };
}

/**
 * Who is asking, for a child action: the durable agent whose conversation the
 * caller is, or why not. `holderAgentId`: the agent holding the caller's
 * session (`DurableAgentStore.holderOf`). A child is never held by an agent,
 * and its own origin says so: one level of nesting only.
 */
export function childCallerDecision(holderAgentId: string | undefined, callerOrigin: unknown): { agentId: string } | { refused: 'child' | 'not-an-agent'; message: string } {
  if (parseChildOrigin(callerOrigin)) {
    return { refused: 'child', message: 'This is a child conversation, and a child cannot start or drive conversations of its own (one level only). Report back to the agent that started you instead.' };
  }
  if (!holderAgentId) {
    return { refused: 'not-an-agent', message: "This conversation is not a durable agent's, so it has no children. Only a durable agent's conversation can use aw child." };
  }
  return { agentId: holderAgentId };
}

// ---- what the table nests ----

/** What a session row carries about the child it is (host decorates). */
export interface ChildRowInfo {
  agentId: string;
  agentName: string;
  childId: string;
  /** The agent's current conversation's key: the row this one nests under. Absent: it has none. */
  parentKey?: string;
}

export interface NestableRow {
  key: string;
  childOf?: { parentKey?: string };
}

/**
 * Children under their parent: `top` keeps every row that is not nested (in
 * the order given), `children` the nested ones by parent key. A child whose
 * parent is not among `rows` stays top level, so nothing is ever unreachable,
 * and a child never nests under another child.
 */
export function nestChildren<T extends NestableRow>(rows: readonly T[]): { top: T[]; children: Map<string, T[]> } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const children = new Map<string, T[]>();
  const top: T[] = [];
  for (const r of rows) {
    const parentKey = r.childOf?.parentKey;
    const parent = parentKey !== undefined && parentKey !== r.key ? byKey.get(parentKey) : undefined;
    if (parent && !parent.childOf) {
      const list = children.get(parentKey!);
      if (list) list.push(r);
      else children.set(parentKey!, [r]);
    } else top.push(r);
  }
  return { top, children };
}

/** Whether a child is waiting on the user: a permission prompt, a question or a plan. */
export function childNeedsYou(rows: readonly { status: SessionStatus; pendingQuestion?: unknown; pendingPlan?: unknown }[]): boolean {
  return rows.some((r) => r.status === 'blocked' || r.pendingQuestion !== undefined || r.pendingPlan !== undefined);
}

/** One child as the Agents view and `aw child list` show it. */
export interface AgentChildView {
  childId: string;
  key: string;
  provider: SessionProvider;
  branch: string;
  worktree: string;
  /** Absent when the store has no row for it yet. */
  title?: string;
  status?: SessionStatus;
  needsYou?: boolean;
  lastActivityAt?: number;
}

// ---- what the conversations are told ----

/** Appended to a durable agent's instructions instead of the `aw delegate` guidance (#198). */
export const CHILD_CONVERSATION_GUIDANCE = [
  'Child conversations: to hand off a piece of work, start a child conversation instead of delegating.',
  '- `aw child spawn [--claude|--codex] [--name <short-name>] "<self-contained prompt>"` starts a Claude or Codex conversation in a new git worktree on a new branch (child/<name>), cut from the HEAD of this conversation\'s repository (`--folder <dir>` for another one). It prints the child\'s id, worktree and branch.',
  '- `aw child list` shows your children and their status; `aw child read <id> [--last N]` shows a child\'s recent messages; `aw child send <id> "<text>"` messages it; `aw child stop <id>` stops it.',
  '- When a child has finished, review its branch, merge it to main yourself as the repository\'s instructions say, then run `aw child done <id>`: it removes the worktree and archives the child, and refuses while the branch is unmerged or the tree is dirty (`--discard` throws that work away).',
  'You can act only on your own children, and a child cannot start children of its own. The user sees each child nested under this conversation and can talk to it directly.',
].join('\n');

/** Add the child guidance once. */
export function withChildGuidance(existing: string): string {
  return existing.includes(CHILD_CONVERSATION_GUIDANCE) ? existing : `${existing}\n\n${CHILD_CONVERSATION_GUIDANCE}`;
}

/** What a child is told at launch and on every resume. */
export function childInstructions(o: Pick<ChildOrigin, 'worktree' | 'branch'>, agentName: string | undefined): string {
  return [
    `You are a child conversation started by ${agentName ? `the durable agent "${agentName}"` : 'a durable agent'} in Agent Wrangler, working in your own git worktree (${o.worktree}) on the branch ${o.branch}.`,
    'Commit your work on this branch. Do not merge it into main and do not push: the agent that started you reviews and merges it. When you are done, say so plainly in your last reply, with what you changed and how you checked it.',
    'You cannot start child conversations of your own, and aw delegate is not for you: ask the agent that started you instead. Project and repository instructions (CLAUDE.md, AGENTS.md) still apply.',
  ].join('\n');
}
