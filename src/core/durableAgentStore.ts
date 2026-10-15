/**
 * The durable agents (#179), kept in Agent Wrangler's own state.
 *
 * Agent Wrangler owns this record and nothing else does: the agent's
 * instructions reach a session at launch, and no Claude Code or Codex file is
 * written to make it so. Writes apply one change to freshly-read storage, as
 * `NicknameService` does, so two panes editing different agents do not
 * clobber each other.
 */

import { randomUUID } from 'node:crypto';
import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';
import {
  createAgent,
  editAgent,
  linkSession,
  parseStoredAgents,
  startFresh,
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
