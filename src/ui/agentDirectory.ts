/**
 * What the panes need from the app to show durable agents (#179). The table
 * pane lists and edits them (`AgentDirectory`); the conversation pane shows
 * an agent with nothing to continue as an empty conversation whose first
 * message starts one, and the memory of the agent a conversation belongs to
 * (`AgentConversations`).
 */
import type { Disposable } from '../core/events';
import type { ImageAttachment } from '../shared/conversation';
import type { AgentMemoryPaneView, DurableAgentView } from '../shared/durableAgents';
import type { AgentSession } from '../shared/model';

export interface AgentDirectory {
  views(): DurableAgentView[];
  /** The agent a session belongs to, for its row: `current` when it is the conversation the agent continues. */
  ownerOf(provider: string, sessionId: string): { id: string; name: string; current: boolean } | undefined;
  /** Show the agent's continuing conversation to the requesting client. Starts nothing. */
  open(id: string): void;
  /**
   * Create (no `id`) or edit. `input` is what a client sent, checked again
   * here. An edit that ends the current conversation is confirmed first;
   * `cancelled` when the user said no.
   */
  save(id: string | undefined, input: unknown): Promise<{ id: string } | { error: string } | { cancelled: true }>;
  /** Confirm, then forget the agent. Its sessions stay. */
  remove(id: string): Promise<void>;
  startFresh(id: string): void;
  /** Pin or archive (#182). */
  setFlag(id: string, flag: 'pinned' | 'archived', on: boolean): void;
  /** Remember, edit, forget, approve or reject (#180). `op` is what a client sent. */
  memory(id: string, op: unknown): { error?: string };
  /** Make an earlier conversation the agent's current one again (#181). */
  makeCurrent(id: string, sessionKey: string): { error?: string };
  /** Give a session to an agent, or (`agentId` absent) take it off the one that has it (#181). */
  assign(sessionKey: string, agentId: string | undefined): { error?: string };
  onDidChange(listener: () => void): Disposable;
}

export interface AgentConversations {
  /** The empty conversation of an agent with nothing to continue; undefined for an unknown agent. */
  draft(id: string): { session: AgentSession; notice?: string } | undefined;
  /** Start the agent's conversation with its first message, and show it in place of the draft. */
  start(id: string, text: string, images?: ImageAttachment[]): Promise<void>;
  /** The memory strip for a conversation: the agent it belongs to, by session key or draft key. */
  memoryFor(key: string): AgentMemoryPaneView | undefined;
  memory(id: string, op: unknown): { error?: string };
  /** Whether typing to this stopped Codex thread should resume it: it is an agent's current conversation (#181). */
  resumesOnType(provider: string, sessionId: string): boolean;
  onDidChange(listener: () => void): Disposable;
}
