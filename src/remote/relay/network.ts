/**
 * What the relay link needs from Supabase (#173), and nothing more: join a private topic,
 * broadcast on it, hear broadcasts on it, and write the daemon's heartbeat. The real one is
 * `supabaseNetwork.ts`; tests use an in-memory one.
 */
import type { Disposable } from '../../core/events';

export interface RelayChannel {
  /** Broadcast `payload` as `event`. Resolves once the relay has it. */
  send(event: string, payload: unknown): Promise<void>;
  /**
   * Broadcast over REST, as a device posts its `connect` (#186). It does not go through this
   * channel's socket, so this channel hears it too: the lobby probe uses that to check the
   * path a phone's request takes.
   */
  httpSend(event: string, payload: unknown): Promise<void>;
  /** Broadcasts others sent on this topic. */
  on(event: string, listener: (payload: unknown) => void): void;
  leave(): Promise<void>;
}

export interface RelayJoinOptions {
  presence?: Record<string, unknown>;
  /** The joined channel errored, closed or timed out (not by `leave()`): it may hear nothing more. */
  onLost?(reason: string): void;
}

export interface RelayNetwork extends Disposable {
  /** The signed-in user's id: every topic carries it. */
  readonly uid: string;
  /**
   * Join a private topic. Rejects when the join is refused (not this user's topic, or the
   * account is not an owner) or times out. `presence` is tracked on the topic once joined.
   */
  join(topic: string, opts?: RelayJoinOptions): Promise<RelayChannel>;
  /** Upsert the daemon's heartbeat row (`public.daemons`). */
  heartbeat(daemonId: string, build: string): Promise<void>;
}
