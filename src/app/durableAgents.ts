/**
 * Durable agents (#179) as the application runs them: the directory the
 * table pane lists, and the launch that turns an agent's first message into a
 * session.
 *
 * Lifecycle: an agent runs nothing. Opening it shows its current
 * conversation, or an empty one when it has none; typing to a current Claude
 * session resumes it the way typing to any idle session does (`adoptAndSend`),
 * and the first message of an empty one launches a session from the agent's
 * configuration. The session carries `{kind: 'agent', agentId}` as its origin,
 * which the registry keeps across resumes, so a conversation that changes id
 * (a resume, a compaction) stays the agent's.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { DurableAgentStore } from '../core/durableAgentStore';
import type { Disposable } from '../core/events';
import type { LaunchDefaults } from '../core/launchDefaults';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import type { SessionHandle } from '../core/session/sessionHandle';
import type { SessionStore } from '../core/sessionStore';
import type { HostDialogs, WorkbenchSurface } from '../host/hostServices';
import { withConversationDelegation } from '../shared/conversationDelegation';
import {
  agentDraftKey,
  agentIdOfOrigin,
  agentInstructions,
  agentOrigin,
  agentView,
  orderAgents,
  planAgentOpen,
  sanitizeAgentInput,
  sessionKeyOf,
  type DurableAgent,
} from '../shared/durableAgents';
import { displayTitle, GLOBAL_PROJECT_DIR, type AgentSession } from '../shared/model';
import type { AgentConversations, AgentDirectory } from '../ui/agentDirectory';
import type { ProjectSource } from '../ui/dashboardHost';

export interface DurableAgentDeps {
  agents: DurableAgentStore;
  store: SessionStore;
  sessions: SessionExecutors;
  launchDefaults: LaunchDefaults;
  projects: ProjectSource;
  dialogs: HostDialogs;
  surface: () => WorkbenchSurface | undefined;
  /** The scratch folder a Global agent works in, created on demand. */
  globalDir: () => string;
  log: (line: string) => void;
}

export interface DurableAgents {
  directory: AgentDirectory;
  conversations: AgentConversations;
  dispose(): void;
}

export function createDurableAgents(deps: DurableAgentDeps): DurableAgents {
  const { agents, store, sessions, launchDefaults, projects, dialogs } = deps;
  /** Agents whose first message is being launched: their link is made by the launch, not the watcher. */
  const starting = new Set<string>();
  /** The id each agent-owned handle was last seen with, to tell a continuation from a stranger. */
  const seen = new WeakMap<SessionHandle, string>();

  const liveFor = (key: string): SessionHandle | undefined =>
    sessions.list().find((h) => h.sessionId !== undefined && sessionKeyOf({ provider: h.provider, sessionId: h.sessionId }) === key);

  const dirOf = (agent: DurableAgent): string => (agent.scope.kind === 'global' ? deps.globalDir() : agent.scope.dir);

  /**
   * Follow agent sessions that change id. A handle whose previous id was the
   * agent's current conversation is that conversation, continued. A handle
   * first seen under an id the agent does not know, while the agent has a
   * current conversation and is not mid-launch, is a resume of it.
   */
  const follow = (): void => {
    for (const h of sessions.list()) {
      const agentId = agentIdOfOrigin(h.origin);
      const id = h.sessionId;
      if (!agentId || !id || starting.has(agentId)) continue;
      const before = seen.get(h);
      seen.set(h, id);
      if (before === id) continue;
      const agent = agents.get(agentId);
      const cur = agent?.current;
      if (!agent || !cur || cur.provider !== h.provider) continue;
      const curId = cur.sessionId.toLowerCase();
      if (curId === id.toLowerCase()) continue;
      const known = agent.history.some((r) => r.provider === h.provider && r.sessionId.toLowerCase() === id.toLowerCase());
      const continues = before !== undefined ? before.toLowerCase() === curId : !known;
      if (continues) agents.link(agentId, { provider: h.provider, sessionId: id }, cur.sessionId);
    }
  };
  const subs: Disposable[] = [sessions.onDidChange(follow)];

  const directory: AgentDirectory = {
    views() {
      return orderAgents(
        agents.list.map((a) =>
          agentView(a, (key) => {
            const s = store.get(key) ?? liveFor(key)?.liveSession;
            return s ? { status: s.status, title: displayTitle(s), ...(s.subtitle ? { subtitle: s.subtitle } : {}), lastActivityAt: s.lastActivityAt } : undefined;
          }),
        ),
      );
    },
    ownerOf(provider, sessionId) {
      const a = agents.ownerOf(provider, sessionId);
      return a ? { id: a.id, name: a.name } : undefined;
    },
    open(id) {
      const agent = agents.get(id);
      if (!agent) return;
      const plan = planAgentOpen(agent, (key) => store.get(key), (key) => liveFor(key) !== undefined);
      const surface = deps.surface();
      if (plan.kind === 'show') {
        const live = liveFor(plan.key);
        if (live) surface?.showSession(live);
        else surface?.show(plan.key);
        return;
      }
      surface?.show(agentDraftKey(id));
    },
    save(id, input) {
      const checked = sanitizeAgentInput(input);
      if ('error' in checked) return checked;
      const existing = id ? agents.get(id) : undefined;
      if (id && !existing) return { error: 'That agent no longer exists.' };
      const scope = checked.value.scope;
      if (scope.kind === 'folder') {
        // A browser names folders the launcher offered it, or the one the agent already had; nothing else.
        const offered = projects.value.some((p) => p.dir === scope.dir && p.dir !== GLOBAL_PROJECT_DIR);
        const kept = existing?.scope.kind === 'folder' && existing.scope.dir === scope.dir;
        if (!offered && !kept) return { error: 'Choose a project from the list.' };
        if (!isDirectory(scope.dir)) return { error: `${scope.dir} no longer exists.` };
      }
      const saved = existing ? agents.update(existing.id, checked.value) : agents.create(checked.value);
      return saved ? { id: saved.id } : { error: 'That agent no longer exists.' };
    },
    async remove(id) {
      const agent = agents.get(id);
      if (!agent) return;
      const choice = await dialogs.warn(
        `Delete the agent "${agent.name}"?`,
        { modal: true, detail: 'Its instructions are forgotten. Its conversations stay in Sessions, no longer linked to an agent.' },
        'Delete',
      );
      if (choice === 'Delete') agents.remove(id);
    },
    startFresh(id) {
      agents.startFresh(id);
    },
    onDidChange: (listener) => agents.onDidChange(listener),
  };

  const conversations: AgentConversations = {
    draft(id) {
      const agent = agents.get(id);
      if (!agent) return undefined;
      const plan = planAgentOpen(agent, (key) => store.get(key), (key) => liveFor(key) !== undefined);
      const key = agentDraftKey(id);
      const where = agent.scope.kind === 'global' ? 'with no project' : `in ${agent.scope.dir}`;
      const session: AgentSession = {
        provider: agent.provider,
        sessionId: key,
        key,
        title: agent.name,
        subtitle: `${agent.role}\n\nYour first message starts a new conversation with ${agent.name} ${where}, on ${agent.provider === 'codex' ? 'Codex' : 'Claude'}${agent.model ? ` (${agent.model})` : ''}. Nothing runs until you send it.`,
        status: 'done',
        lastActivityAt: agent.updatedAt,
        ...(agent.scope.kind === 'folder' ? { cwd: agent.scope.dir } : {}),
      };
      return { session, ...(plan.kind === 'draft' && plan.notice ? { notice: plan.notice } : {}) };
    },
    async start(id, text, images) {
      const agent = agents.get(id);
      if (!agent) throw new Error('This agent no longer exists; your draft was kept.');
      const cwd = dirOf(agent);
      if (agent.scope.kind === 'global') {
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (error) {
          throw new Error(`Could not create ${cwd}: ${(error as Error).message}`);
        }
      } else if (!isDirectory(cwd)) {
        throw new Error(`${cwd} no longer exists. Edit the agent to choose another folder; your draft was kept.`);
      }
      if (starting.has(id)) throw new Error(`${agent.name} is already starting; your draft was kept.`);
      starting.add(id);
      try {
        const instructions = withConversationDelegation(agentInstructions(agent));
        const handle = await sessions.launch(
          launchDefaults.request(agent.provider, cwd, {
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.effort ? { effort: agent.effort } : {}),
            ...(agent.provider === 'claude'
              ? { sessionId: randomUUID(), policy: { claude: { conversationInstructions: instructions } } }
              : { policy: { codex: { developerInstructions: instructions } } }),
            origin: agentOrigin(id),
          }),
        );
        if (handle.sessionId) {
          agents.link(id, { provider: handle.provider, sessionId: handle.sessionId });
          seen.set(handle, handle.sessionId);
        }
        if (agent.scope.kind === 'folder') projects.add(cwd);
        deps.surface()?.showSession(handle);
        deps.log(`started a ${agent.provider} conversation for durable agent ${id}`);
        const outcome = await handle.send(text, images);
        if (outcome !== 'applied') throw new Error('The conversation started but did not take the message; send it again.');
      } finally {
        starting.delete(id);
      }
    },
  };

  return {
    directory,
    conversations,
    dispose: () => subs.forEach((s) => s.dispose()),
  };
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
