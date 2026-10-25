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
import * as path from 'node:path';
import { parseMemoryOp, parseProposalInput } from '../shared/agentMemory';
import type { DurableAgentStore } from '../core/durableAgentStore';
import type { Disposable } from '../core/events';
import type { LaunchDefaults } from '../core/launchDefaults';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import type { SessionHandle } from '../core/session/sessionHandle';
import type { SessionStore } from '../core/sessionStore';
import type { HostDialogs, WorkbenchSurface } from '../host/hostServices';
import { CONVERSATION_DELEGATION_INSTRUCTIONS } from '../shared/conversationDelegation';
import { withChildGuidance } from '../shared/childConversations';
import type { ChildConversations } from './childConversations';
import {
  agentDraftKey,
  agentIdOfDraftKey,
  agentIdOfOrigin,
  agentInstructions,
  agentOrigin,
  agentView,
  canAssign,
  editStartsFresh,
  isDetached,
  MAX_AGENT_INSTRUCTIONS_FILE,
  memoryPaneView,
  orderAgents,
  planAgentOpen,
  refOfKey,
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
  /** Child conversations (#198): listed under their agent, never assignable to one. */
  children?: Pick<ChildConversations, 'list' | 'isChild' | 'resumeInstructions' | 'rowInfo'>;
  log: (line: string) => void;
}

export interface DurableAgents {
  directory: AgentDirectory;
  conversations: AgentConversations;
  /**
   * The instructions a resumed conversation is sent (#180, #182): those of
   * the agent that holds it now, with its memory and its instructions file
   * read afresh, rather than the copy frozen into the session at launch. A
   * session launched by an agent that no longer holds it gets the plain
   * conversation guidance. Undefined for anything else (keep what it has).
   * Throws when the instructions file cannot be read: that is reported, never
   * skipped.
   */
  resumeInstructions(ref: { provider: string; sessionId: string }, origin: unknown): string | undefined;
  /** An agent's proposal from `aw remember` / `aw forget`, by the conversation it came from (#180). */
  propose(origin: { provider: string; sessionId: string }, input: unknown): { agentName: string; proposalId?: string };
  /** Link a conversation that took a new id when it was resumed (a Codex fork). */
  continued(agentId: string, ref: { provider: 'claude' | 'codex'; sessionId: string }, previousId: string): void;
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

  /** The agent's instructions file, read now (#182). An error says what is wrong in words the user can act on. */
  const readInstructionsFile = (agent: DurableAgent): { text?: string } | { error: string } => {
    if (!agent.instructionsFile || agent.scope.kind !== 'folder') return {};
    return readAgentFile(agent.scope.dir, agent.instructionsFile, agent.name);
  };

  /** Everything a conversation of this agent is told, as of now. Throws when the instructions file cannot be read. */
  const instructionsFor = (agent: DurableAgent): string => {
    const file = readInstructionsFile(agent);
    if ('error' in file) throw new Error(file.error);
    // Durable agents hand work off through child conversations (#198), not `aw delegate`.
    return withChildGuidance(agentInstructions(agent, file.text));
  };

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
      // Taken off the agent by hand: its origin still names the agent, but it is not the agent's any more.
      if (isDetached(agent, id) || (before !== undefined && isDetached(agent, before))) continue;
      // Another agent holds it (assigned there by hand): a session belongs to one agent at most.
      const elsewhere = (sid: string) => {
        const holder = agents.holderOf(h.provider, sid);
        return holder !== undefined && holder.agent.id !== agentId;
      };
      if (elsewhere(id) || (before !== undefined && elsewhere(before))) continue;
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
          }, deps.children?.list(a.id) ?? []),
        ),
      );
    },
    ownerOf(provider, sessionId) {
      const held = agents.holderOf(provider, sessionId);
      return held ? { id: held.agent.id, name: held.agent.name, current: held.current } : undefined;
    },
    childOf: (provider, sessionId) => deps.children?.rowInfo(provider, sessionId),
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
    async save(id, input) {
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
        // Checked now so a typo is caught at the form, and again at every launch, since the file can go.
        if (checked.value.instructionsFile) {
          const file = readAgentFile(scope.dir, checked.value.instructionsFile, checked.value.name);
          if ('error' in file) return file;
        }
      }
      // #182 Q5: every field stays editable, but an edit that ends the current conversation says so first.
      if (existing && editStartsFresh(existing, checked.value)) {
        const choice = await dialogs.warn(
          `Start a new conversation for "${existing.name}"?`,
          {
            modal: true,
            detail: 'A conversation cannot move to another harness or folder. The current one is kept in the agent\'s history, and your next message starts a new conversation. Memory carries over.',
          },
          'Save',
        );
        if (choice !== 'Save') return { cancelled: true };
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
    setFlag(id, flag, on) {
      agents.setFlag(id, flag, on);
    },
    memory: (id, op) => applyMemory(id, op),
    makeCurrent(id, sessionKey) {
      const agent = agents.get(id);
      if (!agent) return { error: 'That agent no longer exists.' };
      const ref = refOfKey(sessionKey);
      const earlier = ref ? agent.history.find((h) => sessionKeyOf(h) === sessionKeyOf(ref)) : undefined;
      if (!earlier) return { error: 'That conversation is no longer in the agent\'s history.' };
      // A conversation left behind by a change of harness or folder (#182) cannot come back as current.
      const s = store.get(sessionKeyOf(earlier));
      if (!canAssign(agent, { provider: earlier.provider, cwd: s?.cwd })) {
        return { error: `That conversation ran on ${earlier.provider === 'codex' ? 'Codex' : 'Claude'}${s?.cwd ? ` in ${s.cwd}` : ''}, so ${agent.name} cannot carry it on as it is configured now.` };
      }
      agents.link(id, { provider: earlier.provider, sessionId: earlier.sessionId });
      return {};
    },
    assign(sessionKey, agentId) {
      const ref = refOfKey(sessionKey);
      if (!ref) return { error: 'That is not a session.' };
      const s = store.get(sessionKey) ?? liveFor(sessionKey)?.liveSession;
      // The store's own spelling of the id, so the link matches the row.
      const sessionId = s?.sessionId ?? ref.sessionId;
      if (agentId === undefined) {
        agents.unassign({ provider: ref.provider, sessionId });
        deps.log(`unassigned a ${ref.provider} session from its durable agent`);
        return {};
      }
      const agent = agents.get(agentId);
      if (!agent) return { error: 'That agent no longer exists.' };
      if (!s) return { error: 'That session is no longer in the table.' };
      // A child works for its agent; it never becomes the agent itself (#198).
      if (deps.children?.isChild(ref.provider, sessionId)) return { error: 'That is a child conversation of a durable agent, so it cannot become an agent\'s own conversation.' };
      if (!canAssign(agent, { provider: s.provider, cwd: s.cwd })) {
        return { error: agent.provider !== s.provider ? `${agent.name} runs on ${agent.provider === 'codex' ? 'Codex' : 'Claude'}.` : `${agent.name} works in ${agent.scope.kind === 'folder' ? agent.scope.dir : 'another folder'}.` };
      }
      agents.assign(agentId, { provider: s.provider, sessionId });
      deps.log(`assigned a ${s.provider} session to durable agent ${agentId}`);
      return {};
    },
    onDidChange: (listener) => agents.onDidChange(listener),
  };

  function applyMemory(id: string, raw: unknown): { error?: string } {
    const op = parseMemoryOp(raw);
    if (!op) return { error: 'That memory change was not understood.' };
    const r = agents.memory(id, op);
    return 'error' in r ? { error: r.error } : {};
  }

  /** The agent a conversation belongs to, by its session key or its draft key; not one the user detached. */
  const agentOfKey = (key: string): DurableAgent | undefined => {
    const draftOf = agentIdOfDraftKey(key);
    if (draftOf !== undefined) return agents.get(draftOf);
    const s = store.get(key) ?? liveFor(key)?.liveSession;
    const ref = s ? { provider: s.provider, sessionId: s.sessionId } : refOfKey(key);
    return ref ? agents.holderOf(ref.provider, ref.sessionId)?.agent : undefined;
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
        subtitle: `${agent.role}\n\nYour first message starts a new conversation with ${agent.name} ${where}, on ${agent.provider === 'codex' ? 'Codex' : 'Claude'}${agent.model ? ` (${agent.model})` : ''}${agent.memory.items.length ? `, carrying ${agent.memory.items.length} memory note${agent.memory.items.length === 1 ? '' : 's'}` : ''}. Nothing runs until you send it.`,
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
      const file = readInstructionsFile(agent);
      if ('error' in file) throw new Error(`${file.error} Your draft was kept.`);
      starting.add(id);
      try {
        const instructions = withChildGuidance(agentInstructions(agent, file.text));
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
    memoryFor(key) {
      const agent = agentOfKey(key);
      return agent ? memoryPaneView(agent) : undefined;
    },
    memory: (id, op) => applyMemory(id, op),
    resumesOnType(provider, sessionId) {
      return provider === 'codex' && (agents.ownerOf(provider, sessionId) !== undefined || deps.children?.isChild(provider, sessionId) === true);
    },
    onDidChange: (listener) => agents.onDidChange(listener),
  };

  return {
    directory,
    conversations,
    resumeInstructions(ref, origin) {
      // Who holds the conversation decides, not who launched it: an assigned
      // session speaks as its new agent, an unassigned one as nobody's (#181).
      const held = agents.holderOf(ref.provider, ref.sessionId);
      if (held) return instructionsFor(held.agent);
      // A child conversation (#198) is told it is one, every time, and never gets the delegation guidance.
      const child = deps.children?.resumeInstructions(origin);
      if (child !== undefined) return child;
      // Launched by an agent it no longer belongs to: drop that agent's role and memory.
      return agentIdOfOrigin(origin) !== undefined ? CONVERSATION_DELEGATION_INSTRUCTIONS : undefined;
    },
    propose(origin, input) {
      const checked = parseProposalInput(input);
      if ('error' in checked) throw new Error(checked.error);
      const held = agents.holderOf(origin.provider, origin.sessionId);
      if (!held) throw new Error('This conversation does not belong to a durable agent, so it has no memory to update.');
      const r = agents.propose(held.agent.id, checked);
      if ('error' in r) throw new Error(r.error);
      if (r.proposalId) deps.log(`durable agent ${held.agent.id}: a memory proposal is waiting for approval`);
      return { agentName: held.agent.name, ...(r.proposalId ? { proposalId: r.proposalId } : {}) };
    },
    continued(agentId, ref, previousId) {
      const agent = agents.get(agentId);
      if (agent?.current && agent.current.sessionId.toLowerCase() === previousId.toLowerCase()) agents.link(agentId, ref, previousId);
    },
    dispose: () => subs.forEach((s) => s.dispose()),
  };
}

/**
 * An agent's instructions file (#182): inside its folder, a regular file, not
 * too long. The folder's real path is compared with the file's, so a symlink
 * cannot lead the agent's instructions out of its project.
 */
export function readAgentFile(dir: string, rel: string, agentName: string): { text: string } | { error: string } {
  const full = path.resolve(dir, rel);
  let real: string;
  let root: string;
  try {
    root = fs.realpathSync(dir);
    real = fs.realpathSync(full);
  } catch {
    return { error: `${agentName}'s instructions file ${rel} was not found in ${dir}. Restore it, or edit the agent.` };
  }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) return { error: `${agentName}'s instructions file ${rel} leads outside ${dir}.` };
  let text: string;
  try {
    if (!fs.statSync(real).isFile()) return { error: `${agentName}'s instructions file ${rel} is not a file.` };
    text = fs.readFileSync(real, 'utf8');
  } catch (error) {
    return { error: `Could not read ${agentName}'s instructions file ${rel}: ${(error as Error).message}` };
  }
  if (text.length > MAX_AGENT_INSTRUCTIONS_FILE) {
    return { error: `${agentName}'s instructions file ${rel} is longer than ${MAX_AGENT_INSTRUCTIONS_FILE.toLocaleString('en-US')} characters. Shorten it, or point the agent at a shorter file.` };
  }
  return { text };
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
