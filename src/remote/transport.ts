/**
 * The boundary a remote surface implements.
 *
 * Everything above this line is Agent Wrangler: sessions, asks, and the actions
 * that answer them. Everything below it is one service's API — Discord today,
 * Slack or a push service later — and nothing above may know which. A transport
 * is handed a `RemoteAsk` and an opaque id, and hands back a choice and who
 * made it. It is told nothing about hooks, markers, providers, or how a
 * decision is applied, because it has no business acting on any of that.
 *
 * In particular a transport performs **no authorisation**. It reports who
 * pressed; the service decides whether that person may. Splitting it the other
 * way would put the allowlist in as many places as there are transports.
 */
import type { Disposable } from '../core/events';
import type { RemoteAsk, RemoteNotice } from '../shared/remote';

/** Where a mirrored ask lives on the remote service. Addressable after a restart. */
export interface RemoteMessageRef {
  channelId: string;
  messageId: string;
}

/** Who pressed. `id` must be stable and immutable — a username is neither. */
export interface RemoteActor {
  id: string;
  displayName: string;
}

/**
 * A press, as it arrives. Every field is foreign input: `choiceId` is whatever
 * came back off the wire and has not been checked against the ask, and `scope`
 * is what the service uses to reject anything from outside the configured
 * guild and channel before it looks anything up.
 */
export interface RemoteInvocation {
  interactionId: string;
  choiceId: string;
  actor: RemoteActor;
  scope: { guildId?: string; channelId?: string };
}

/** Why a mirrored ask is being closed, and what the message should end up saying. */
export interface RemoteClose {
  /**
   * `answered` is the one that carries information the others cannot: a
   * question was not allowed or denied, it was *answered with something*, and
   * which something is the whole news. `label` is that answer.
   */
  outcome: 'allowed' | 'denied' | 'answered' | 'answered-locally' | 'cancelled';
  /** Present when a remote press caused it; absent when it was settled at the machine. */
  by?: RemoteActor;
  /** The choice that was pressed, for the wording — `allow`, `always`, `deny`, `approve`, `opt<n>`. */
  choiceId?: string;
  /** What that choice's button said, for an `answered` outcome. */
  label?: string;
  atMs: number;
}

export interface RemoteTransport extends Disposable {
  readonly id: string;
  readonly connected: boolean;

  onDidInvoke(listener: (invocation: RemoteInvocation) => void): Disposable;
  onDidChangeConnection(listener: () => void): Disposable;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * The machine woke from sleep: the connection is probably dead and does not
   * know it yet. Reconnect now rather than at the next missed heartbeat.
   */
  wake?(): void;

  /** Post the ask. `interactionId` is opaque and is what comes back on a press. */
  publish(interactionId: string, ask: RemoteAsk): Promise<RemoteMessageRef>;
  /** The ask changed while still open. Rare: a new prompt is a new ask, not an edit. */
  update(ref: RemoteMessageRef, interactionId: string, ask: RemoteAsk): Promise<void>;
  /** It is over. Must leave no pressable control behind. */
  close(ref: RemoteMessageRef, ask: RemoteAsk, outcome: RemoteClose): Promise<void>;
  /** A private word with whoever pressed: not authorised, too late, unknown. */
  reply(invocation: RemoteInvocation, text: string): Promise<void>;
  /**
   * Announce something that already happened. Post and forget: no ref comes
   * back, because nothing will ever edit or close it.
   */
  notify(notice: RemoteNotice): Promise<void>;
}
