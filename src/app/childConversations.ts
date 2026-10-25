/**
 * Child conversations (#198) as the application runs them: a durable agent's
 * conversation spawns an ordinary conversation in its own worktree, drives it,
 * and finishes it once its branch is merged. `docs/plans/child-conversations.md`.
 *
 * Who may act on which child is not decided here: the control backend asks
 * `authorize` as the calling agent's principal, with the target's child owner
 * on the resource (`core/access.ts`). This module resolves the caller and the
 * target, and does the work once that has passed.
 *
 * A child is found by its origin (`{kind: 'child'}`), on the live handle or in
 * the registry, which carries it across resumes and id changes. Its `childId`
 * is stable, so a Claude child that took a new id is still the same child.
 */
import { randomUUID } from 'node:crypto';
import { createChildWorktree, inspectChildWorktree, nodeGit, removeChildWorktree, repoRootOf, doneDecision, type GitExec } from '../core/childWorktree';
import type { DurableAgentStore } from '../core/durableAgentStore';
import type { LaunchDefaults } from '../core/launchDefaults';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import type { SessionHandle } from '../core/session/sessionHandle';
import type { SessionRegistry } from '../core/session/sessionRegistry';
import type { SessionStore } from '../core/sessionStore';
import type { StopOutcome } from '../core/control/protocol';
import { resolveSessionRef } from '../core/control/protocol';
import { childCallerDecision, childInstructions, childOrigin, parseChildOrigin, type AgentChildView, type ChildOrigin, type ChildRowInfo } from '../shared/childConversations';
import { sessionKeyOf, type DurableAgent } from '../shared/durableAgents';
import { displayTitle, type AgentSession } from '../shared/model';

export interface ChildConversationDeps {
  agents: Pick<DurableAgentStore, 'get' | 'holderOf'>;
  store: Pick<SessionStore, 'sessions' | 'get'>;
  sessions: Pick<SessionExecutors, 'list' | 'get' | 'launch'>;
  registry: Pick<SessionRegistry, 'all' | 'get'>;
  launchDefaults: Pick<LaunchDefaults, 'request'>;
  archive: { isArchived(key: string): boolean; set(key: string, archived: boolean): void };
  stopSession(key: string, opts: { force?: boolean }): Promise<StopOutcome | 'gone'>;
  /** Resume an idle child and send it `text`, as typing to it in the pane does. Throws with the reason. */
  resumeAndSend(key: string, text: string): Promise<void>;
  git?: GitExec;
  log: (line: string) => void;
}

/** One child: its origin, and the session that is it now. */
export interface ChildEntry {
  origin: ChildOrigin;
  provider: 'claude' | 'codex';
  sessionId: string;
  key: string;
  live?: SessionHandle;
}

export type ChildResolution = { key: string; entry?: ChildEntry } | { error: 'notFound' } | { error: 'ambiguous'; matches: { key: string; sessionId: string; title: string }[] };

export interface ChildConversations {
  /** The durable agent a conversation is, for a child action, or why it may not act. */
  callerOf(origin: { provider: string; sessionId: string }): { agent: DurableAgent } | { refused: string; message: string };
  /** What a session row says about the child it is (host decorates); undefined for any other. */
  rowInfo(provider: string, sessionId: string): ChildRowInfo | undefined;
  isChild(provider: string, sessionId: string): boolean;
  /** The resume instructions of a child, or undefined for any other session. */
  resumeInstructions(origin: unknown): string | undefined;
  /** An agent's children that are not archived, newest first. */
  list(agentId: string): AgentChildView[];
  view(entry: ChildEntry): AgentChildView;
  /** A child by its id, a session id or prefix, or a key. A non-child session resolves without `entry`. */
  resolve(ref: string): ChildResolution;
  spawn(agent: DurableAgent, caller: { provider: 'claude' | 'codex'; sessionId: string }, params: { prompt: string; provider?: 'claude' | 'codex'; folder?: string; name?: string }): Promise<{ child: AgentChildView; repo: string; note?: string }>;
  send(entry: ChildEntry, text: string): Promise<{ outcome: 'applied' | 'stale' | 'gone' | 'unsupported'; reason?: string }>;
  stop(entry: ChildEntry, force: boolean): Promise<StopOutcome | 'gone'>;
  done(entry: ChildEntry, discard: boolean): Promise<{ outcome: 'done' | 'refused'; message: string }>;
}

export function createChildConversations(deps: ChildConversationDeps): ChildConversations {
  const git = deps.git ?? nodeGit;

  const originOfSession = (sessionId: string): unknown => deps.sessions.get(sessionId)?.origin ?? deps.registry.get(sessionId)?.origin;

  /** Every child, by child id: the live handle when there is one, else its newest record. */
  const entries = (): Map<string, ChildEntry> => {
    const out = new Map<string, ChildEntry>();
    for (const h of deps.sessions.list()) {
      const o = parseChildOrigin(h.origin);
      if (!o || !h.sessionId || out.has(o.childId)) continue;
      out.set(o.childId, { origin: o, provider: h.provider, sessionId: h.sessionId, key: sessionKeyOf({ provider: h.provider, sessionId: h.sessionId }), live: h });
    }
    const newest = new Map<string, { at: number; entry: ChildEntry }>();
    for (const r of deps.registry.all()) {
      const o = parseChildOrigin(r.origin);
      if (!o || out.has(o.childId)) continue;
      const seen = newest.get(o.childId);
      if (seen && seen.at >= r.updatedAt) continue;
      newest.set(o.childId, { at: r.updatedAt, entry: { origin: o, provider: r.provider, sessionId: r.sessionId, key: sessionKeyOf({ provider: r.provider, sessionId: r.sessionId }) } });
    }
    for (const [id, { entry }] of newest) out.set(id, entry);
    return out;
  };

  const rowOf = (entry: ChildEntry): AgentSession | undefined => deps.store.get(entry.key) ?? entry.live?.liveSession;

  const view = (entry: ChildEntry): AgentChildView => {
    const row = rowOf(entry);
    const needsYou = row?.status === 'blocked' || entry.live?.pendingQuestion !== undefined || entry.live?.pendingPlan !== undefined;
    return {
      childId: entry.origin.childId,
      key: entry.key,
      provider: entry.provider,
      branch: entry.origin.branch,
      worktree: entry.origin.worktree,
      ...(row ? { title: displayTitle(row), status: row.status, lastActivityAt: row.lastActivityAt } : {}),
      ...(needsYou ? { needsYou: true } : {}),
    };
  };

  const keysOf = (childId: string): string[] => {
    const keys = new Set<string>();
    for (const r of deps.registry.all()) if (parseChildOrigin(r.origin)?.childId === childId) keys.add(sessionKeyOf(r));
    for (const h of deps.sessions.list()) if (h.sessionId && parseChildOrigin(h.origin)?.childId === childId) keys.add(sessionKeyOf({ provider: h.provider, sessionId: h.sessionId }));
    return [...keys];
  };

  return {
    callerOf(origin) {
      const held = deps.agents.holderOf(origin.provider, origin.sessionId);
      const decision = childCallerDecision(held?.agent.id, originOfSession(origin.sessionId));
      if ('refused' in decision) return decision;
      return { agent: held!.agent };
    },

    rowInfo(_provider, sessionId) {
      const o = parseChildOrigin(originOfSession(sessionId));
      if (!o) return undefined;
      const agent = deps.agents.get(o.agentId);
      return {
        agentId: o.agentId,
        agentName: agent?.name ?? 'a deleted agent',
        childId: o.childId,
        ...(agent?.current ? { parentKey: sessionKeyOf(agent.current) } : {}),
      };
    },

    isChild: (_provider, sessionId) => parseChildOrigin(originOfSession(sessionId)) !== undefined,

    resumeInstructions(origin) {
      const o = parseChildOrigin(origin);
      return o ? childInstructions(o, deps.agents.get(o.agentId)?.name) : undefined;
    },

    list(agentId) {
      return [...entries().values()]
        .filter((e) => e.origin.agentId === agentId && !deps.archive.isArchived(e.key))
        .map(view)
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    },

    view,

    resolve(ref) {
      const wanted = ref.trim().toLowerCase();
      const all = entries();
      const byId = [...all.values()].filter((e) => e.origin.childId.toLowerCase() === wanted);
      if (byId.length === 1) return { key: byId[0].key, entry: byId[0] };
      const live = deps.sessions.list().flatMap((h) => (h.liveSession && !deps.store.get(h.liveSession.key) ? [h.liveSession] : []));
      const found = resolveSessionRef([...deps.store.sessions, ...live], ref);
      if ('error' in found) {
        if (found.error === 'ambiguous') return { error: 'ambiguous', matches: found.matches.map((s) => ({ key: s.key, sessionId: s.sessionId, title: displayTitle(s) })) };
        return { error: 'notFound' };
      }
      const s = found.match;
      const o = parseChildOrigin(originOfSession(s.sessionId));
      // The child as it is now (it may have taken a new id since this row).
      const entry = o ? all.get(o.childId) : undefined;
      return entry ? { key: entry.key, entry } : { key: s.key };
    },

    async spawn(agent, caller, params) {
      const provider = params.provider ?? agent.provider;
      const callerKey = sessionKeyOf(caller);
      const folder = params.folder ?? deps.store.get(callerKey)?.cwd ?? deps.sessions.get(caller.sessionId)?.cwd;
      if (!folder) throw new Error('Could not tell which folder this conversation is in; pass --folder <dir>.');
      const root = await repoRootOf(folder, git);
      if ('error' in root) throw new Error(root.error);
      const wt = await createChildWorktree(root.root, params.name ?? params.prompt, { reserved: new Set(entries().keys()), git });
      const origin = childOrigin({ agentId: agent.id, childId: wt.slug, parent: { provider: caller.provider, sessionId: caller.sessionId }, worktree: wt.path, branch: wt.branch, repo: root.root });
      const instructions = childInstructions(origin, agent.name);
      let handle: SessionHandle;
      try {
        handle = await deps.sessions.launch(
          deps.launchDefaults.request(provider, wt.path, {
            ...(provider === 'claude'
              ? { sessionId: randomUUID(), policy: { claude: { conversationInstructions: instructions } } }
              : { policy: { codex: { developerInstructions: instructions } } }),
            origin,
          }),
        );
      } catch (error) {
        // Nothing ran in it: take the fresh worktree and branch away again.
        await removeChildWorktree(wt, { registered: true, clean: false, deleteBranch: true }, git).catch(() => undefined);
        throw error;
      }
      deps.log(`durable agent ${agent.id} started a ${provider} child conversation ${wt.slug}`);
      const outcome = await handle.send(params.prompt).catch(() => 'unsupported' as const);
      const sessionId = handle.sessionId;
      const entry: ChildEntry = sessionId
        ? { origin, provider, sessionId, key: sessionKeyOf({ provider, sessionId }), live: handle }
        : { origin, provider, sessionId: wt.slug, key: `${provider}:${wt.slug}`, live: handle };
      return {
        child: view(entry),
        repo: root.root,
        ...(outcome !== 'applied' ? { note: 'The child started but did not take the prompt; send it again with aw child send.' } : {}),
      };
    },

    async send(entry, text) {
      const h = entry.live;
      if (h && h.lifecycle !== 'ended' && h.lifecycle !== 'error') {
        if (!h.canSend) return h.readOnlyReason ? { outcome: 'unsupported', reason: h.readOnlyReason } : { outcome: 'stale' };
        return { outcome: await h.send(text) };
      }
      try {
        await deps.resumeAndSend(entry.key, text);
        return { outcome: 'applied' };
      } catch (error) {
        return { outcome: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
      }
    },

    stop: (entry, force) => deps.stopSession(entry.key, { force }),

    async done(entry, discard) {
      const o = entry.origin;
      const c = { repoRoot: o.repo, path: o.worktree, branch: o.branch };
      const facts = await inspectChildWorktree(c, git);
      const row = rowOf(entry);
      const working = row?.status === 'busy' || row?.status === 'stuck' || row?.status === 'blocked';
      const decision = doneDecision({ ...facts, working, discard, branch: o.branch });
      if (!decision.ok) return { outcome: 'refused', message: `Not done: ${decision.reasons.join('; ')}.` };
      if (row && row.status !== 'ended') {
        const stopped = await deps.stopSession(entry.key, { force: discard });
        if (stopped === 'working') return { outcome: 'refused', message: 'Not done: it is still working; pass --discard to stop it anyway.' };
        if (stopped === 'refused' || stopped === 'hostRefused') return { outcome: 'refused', message: 'Not done: its process could not be stopped, so its worktree was left alone. See the app log.' };
      }
      const removed = await removeChildWorktree(c, { registered: facts.registered, clean: decision.clean, deleteBranch: decision.deleteBranch }, git);
      for (const key of keysOf(o.childId)) deps.archive.set(key, true);
      deps.log(`child conversation ${o.childId} finished${discard ? ' (discarded)' : ''}`);
      const branchText = removed.branchKept ? `kept ${o.branch}${facts.merged === false ? ' (unmerged)' : ''}` : `deleted ${o.branch}`;
      return { outcome: 'done', message: `Removed the worktree ${o.worktree}, ${branchText}, and archived the child.` };
    },
  };
}
