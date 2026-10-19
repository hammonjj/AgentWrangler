/**
 * The durable agents (#179), kept in Agent Wrangler's own state.
 *
 * Agent Wrangler owns this record and nothing else does: the agent's
 * instructions reach a session at launch, and no Claude Code or Codex file is
 * written to make it so. Writes apply one change to freshly-read storage, as
 * `NicknameService` does, so two panes editing different agents do not
 * clobber each other.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';
import { addProposal, applyMemoryOp, type MemoryOp, type MemoryProposalInput } from '../shared/agentMemory';
import {
  createAgent,
  editAgent,
  hasSession,
  linkSession,
  parseStoredAgents,
  setAgentFlag,
  startFresh,
  unassignSession,
  type AgentSessionRef,
  type DurableAgent,
  type DurableAgentInput,
} from '../shared/durableAgents';

const STORAGE_KEY = 'agentWrangler.durableAgents';

export class DurableAgentStore {
  private agents: DurableAgent[];
  private emitter = new Emitter<void>();

  constructor(
    private storage: KeyValueStorage,
    private now: () => number = Date.now,
    private newId: () => string = randomUUID,
    /** Eight hex characters, for memory item and proposal ids. */
    private hex: () => string = () => randomBytes(4).toString('hex'),
  ) {
    this.agents = this.read();
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  private read(): DurableAgent[] {
    return parseStoredAgents(this.storage.get<unknown>(STORAGE_KEY, []));
  }

  get list(): readonly DurableAgent[] {
    return this.agents;
  }

  get(id: string): DurableAgent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  /** The agent whose current conversation this is. */
  ownerOf(provider: string, sessionId: string): DurableAgent | undefined {
    const id = sessionId.toLowerCase();
    return this.agents.find((a) => a.current?.provider === provider && a.current.sessionId.toLowerCase() === id);
  }

  /** The agent this conversation belongs to, current or earlier (#181). */
  holderOf(provider: string, sessionId: string): { agent: DurableAgent; current: boolean } | undefined {
    const ref = { provider: provider as AgentSessionRef['provider'], sessionId };
    const owner = this.ownerOf(provider, sessionId);
    if (owner) return { agent: owner, current: true };
    const earlier = this.agents.find((a) => hasSession(a, ref));
    return earlier ? { agent: earlier, current: false } : undefined;
  }

  /**
   * Give a session to an agent as its current conversation (#181). A session
   * belongs to one agent at most, so any other agent that had it lets go.
   */
  assign(id: string, ref: Omit<AgentSessionRef, 'linkedAt'>): DurableAgent | undefined {
    if (!this.get(id)) return undefined;
    let out: DurableAgent | undefined;
    this.write((all) =>
      all.map((a) => {
        if (a.id === id) {
          out = linkSession(a, { ...ref, linkedAt: this.now() }, this.now());
          return out;
        }
        return hasSession(a, ref) ? unassignSession(a, ref, this.now()) : a;
      }),
    );
    return out;
  }

  /** Take a session off whichever agent has it. */
  unassign(ref: Omit<AgentSessionRef, 'linkedAt'>): boolean {
    const holder = this.holderOf(ref.provider, ref.sessionId);
    if (!holder) return false;
    this.change(holder.agent.id, (a) => unassignSession(a, ref, this.now()));
    return true;
  }

  setFlag(id: string, flag: 'pinned' | 'archived', on: boolean): DurableAgent | undefined {
    return this.change(id, (a) => setAgentFlag(a, flag, on, this.now()));
  }

  /** Remember, edit, forget, approve or reject (#180). The error is the user's to read. */
  memory(id: string, op: MemoryOp): { agent: DurableAgent } | { error: string } {
    // Applied to the agent as freshly read, like every other write here.
    let error: string | undefined;
    const out = this.change(id, (a) => {
      const applied = applyMemoryOp(a.memory, op, this.now(), () => `m-${this.hex()}`);
      if ('error' in applied) {
        error = applied.error;
        return a;
      }
      return applied.memory === a.memory ? a : { ...a, memory: applied.memory, updatedAt: this.now() };
    });
    if (error) return { error };
    return out ? { agent: out } : { error: 'That agent no longer exists.' };
  }

  /** Record a proposal the agent made. Nothing is remembered until the user approves it. */
  propose(id: string, input: MemoryProposalInput): { proposalId?: string } | { error: string } {
    let result: { proposalId?: string } | { error: string } = { error: 'That agent no longer exists.' };
    this.change(id, (a) => {
      const added = addProposal(a.memory, input, `p-${this.hex()}`, this.now());
      if ('error' in added) {
        result = added;
        return a;
      }
      result = added.proposalId ? { proposalId: added.proposalId } : {};
      return added.memory === a.memory ? a : { ...a, memory: added.memory };
    });
    return result;
  }

  create(input: DurableAgentInput): DurableAgent {
    const agent = createAgent(this.newId(), input, this.now());
    this.write((all) => [...all, agent]);
    return agent;
  }

  update(id: string, input: DurableAgentInput): DurableAgent | undefined {
    return this.change(id, (a) => editAgent(a, input, this.now()));
  }

  /** Forget the agent. Its sessions stay; they become unassigned. */
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.write((all) => all.filter((a) => a.id !== id));
    return true;
  }

  link(id: string, ref: Omit<AgentSessionRef, 'linkedAt'>, previousId?: string): DurableAgent | undefined {
    return this.change(id, (a) => linkSession(a, { ...ref, linkedAt: this.now() }, this.now(), previousId));
  }

  startFresh(id: string): DurableAgent | undefined {
    return this.change(id, (a) => startFresh(a, this.now()));
  }

  private change(id: string, fn: (a: DurableAgent) => DurableAgent): DurableAgent | undefined {
    let out: DurableAgent | undefined;
    this.write((all) =>
      all.map((a) => {
        if (a.id !== id) return a;
        out = fn(a);
        return out;
      }),
    );
    return out;
  }

  private write(fn: (all: DurableAgent[]) => DurableAgent[]): void {
    const before = JSON.stringify(this.agents);
    const next = fn(this.read());
    this.agents = next;
    if (JSON.stringify(next) === before) return;
    void this.storage.update(STORAGE_KEY, next);
    this.emitter.fire();
  }
}
