/**
 * The session host protocol: what an agent's execution layer says and accepts.
 *
 * Stage 1 of the session-lifecycle plan (`docs/plans/session-lifecycle-architecture.md`
 * §5.1, §9) splits Claude execution from translation. The execution half,
 * `ClaudeSdkSession`, speaks exactly these types, so that in Stage 3 it can move
 * into a separate host process and speak them over a socket instead of in-process.
 *
 * Rules that keep that move cheap:
 *
 * - **Provider-native payloads.** `message.msg` is a raw SDK message and
 *   `respondAsk` takes a raw permission result. Nothing here mentions a
 *   `ConvBlock`: blocks are AW's fast-moving UI shape, and a host that lives for
 *   days must not freeze them into a wire type.
 * - **Serializable.** Plain JSON values only: no functions, no class instances.
 * - **Every event carries a `seq`**, monotonic per session, so a client that
 *   reconnects can say where it got to and be replayed only what it missed.
 *
 * Pure types plus one pure reducer. No Node, no DOM, no SDK import (this file is
 * bundled into the webviews too).
 */

/** The host's own minimal lifecycle. Richer states (`connecting`, …) are the core's. */
export type HostState = 'starting' | 'idle' | 'running' | 'ending' | 'exited';

/** One `canUseTool` call, exactly as the SDK reported it. */
export interface RawAsk {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** The SDK's `toolUseID`: lets a card be settled when the tool runs anyway (hook answered it). */
  toolUseId?: string;
  /** `updatedPermissions` the CLI offers for "always allow", passed back verbatim. */
  suggestions?: unknown[];
  title?: string;
  description?: string;
}

/**
 * How an ask stopped being pending.
 *
 * - `responded`: a client answered it through `respondAsk`.
 * - `aborted`: the SDK cancelled it (an interrupt, or the CLI gave up on it).
 * - `answeredElsewhere`: the tool ran or was refused without us: AW's permission
 *   hook raced `canUseTool` and won, which the CLI allows (remote-agent-control §0.1).
 * - `agentExited`: the session ended with the ask still open.
 */
export type AskSettleReason = 'responded' | 'aborted' | 'answeredElsewhere' | 'agentExited';

/** A permission result in the SDK's own shape, kept structural so this file needs no SDK import. */
export type RawPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface HostExit {
  /** Set when the agent stopped because something failed, rather than ending cleanly. */
  error?: string;
  code?: number | null;
  signal?: string | null;
}

/** Host → client. Every event has a `seq`. */
export type HostEvent =
  | { seq: number; type: 'message'; msg: unknown }
  | { seq: number; type: 'ask'; ask: RawAsk }
  | { seq: number; type: 'askSettled'; requestId: string; reason: AskSettleReason; outcome?: 'allowed' | 'denied' }
  | { seq: number; type: 'state'; state: HostState }
  | { seq: number; type: 'sessionId'; sessionId: string }
  | { seq: number; type: 'exit'; exit: HostExit };

/** A `HostEvent` before the log has numbered it. */
export type HostEventBody = OmitSeq<HostEvent>;
type OmitSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** The part of a snapshot that replaying events produces. */
export interface HostReplayState {
  /** The `seq` of the last event this snapshot includes. */
  seq: number;
  state: HostState;
  sessionId?: string;
  pendingAsks: RawAsk[];
  exit?: HostExit;
}

/** Everything a client needs to catch up without the event history. */
export interface HostSnapshot extends HostReplayState {
  /**
   * Identifies this host instance's event stream. Seqs are only comparable
   * within one epoch: a client holding seq 5000 from an earlier epoch must
   * take a fresh snapshot, not subscribe from 5000.
   */
  epoch: string;
  /** What the replay ring holds: events after `fromSeq`. `truncated` once it has evicted any. */
  ring: { fromSeq: number; truncated: boolean };
}

export function emptyHostState(): HostReplayState {
  return { seq: 0, state: 'starting', pendingAsks: [] };
}

/**
 * Fold one event into the replayable state. The host keeps its snapshot with
 * this, so "the snapshot" and "replaying the events" cannot disagree.
 */
export function reduceHostSnapshot<S extends HostReplayState>(snap: S, event: HostEvent): S {
  const next: S = { ...snap, seq: event.seq };
  switch (event.type) {
    case 'ask':
      next.pendingAsks = [...snap.pendingAsks.filter((a) => a.requestId !== event.ask.requestId), event.ask];
      break;
    case 'askSettled':
      next.pendingAsks = snap.pendingAsks.filter((a) => a.requestId !== event.requestId);
      break;
    case 'state':
      next.state = event.state;
      break;
    case 'sessionId':
      next.sessionId = event.sessionId;
      break;
    case 'exit':
      next.state = 'exited';
      next.exit = event.exit;
      next.pendingAsks = [];
      break;
    case 'message':
      break;
  }
  return next;
}

/** Result of `send`. Sends are idempotent on the message `uuid`. */
export interface SendResult {
  accepted: boolean;
  /** A message with this uuid was already sent; nothing was sent again. */
  duplicate: boolean;
}

/** Result of `respondAsk`. `stale`: already settled. `gone`: never known here. */
export type RespondOutcome = 'applied' | 'stale' | 'gone';

/** The control passthrough: the SDK `Query` methods a client may call. */
export type ControlRequest =
  | { op: 'interrupt' }
  | { op: 'setModel'; model?: string }
  | { op: 'setPermissionMode'; mode: string }
  | { op: 'supportedModels' }
  | { op: 'supportedCommands' }
  | { op: 'getContextUsage' };
