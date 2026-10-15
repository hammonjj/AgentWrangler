/**
 * What the panes need from the app to show durable agents (#179). The table
 * pane lists and edits them (`AgentDirectory`); the conversation pane shows
 * an agent with nothing to continue as an empty conversation whose first
 * message starts one (`AgentConversations`).
 */
import type { Disposable } from '../core/events';
import type { ImageAttachment } from '../shared/conversation';
import type { DurableAgentView } from '../shared/durableAgents';
import type { AgentSession } from '../shared/model';

export interface AgentDirectory {
  views(): DurableAgentView[];
  /** The agent a session is the current conversation of, for its row. */
  ownerOf(provider: string, sessionId: string): { id: string; name: string } | undefined;
  /** Show the agent's continuing conversation to the requesting client. Starts nothing. */
  open(id: string): void;
  /** Create (no `id`) or edit. `input` is what a client sent, checked again here. */
  save(id: string | undefined, input: unknown): { id: string } | { error: string };
  /** Confirm, then forget the agent. Its sessions stay. */
  remove(id: string): Promise<void>;
  startFresh(id: string): void;
  onDidChange(listener: () => void): Disposable;
}

export interface AgentConversations {
  /** The empty conversation of an agent with nothing to continue; undefined for an unknown agent. */
  draft(id: string): { session: AgentSession; notice?: string } | undefined;
  /** Start the agent's conversation with its first message, and show it in place of the draft. */
  start(id: string, text: string, images?: ImageAttachment[]): Promise<void>;
}
