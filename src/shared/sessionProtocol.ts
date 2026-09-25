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
import type { LaunchPolicy } from './launchPolicy';

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
  /**
   * Every field of the SDK's `canUseTool` options except `signal`, as the SDK
   * gave them (`agentID`, `blockedPath`, `decisionReason`, …). A host lives
   * for days; a field a later core wants must already be on the wire.
   */
  options?: Record<string, unknown>;
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

/**
 * Why the agent stopped.
 * - `ended`: on its own (the conversation finished, `/exit`).
 * - `stopped`: a client asked (`end`).
 * - `signal`: the host was sent a signal (logout, `kill`) and ended it.
 * - `error`: it failed (could not start, the stream threw).
 * - `crashed`: the host itself failed and ended it.
 * - `lost`: never sent or written by a host. The core's own conclusion that a
 *   host died without reporting anything; its agent may be orphaned.
 * Readers treat an unknown reason as `error`.
 */
export type ExitReason = 'ended' | 'stopped' | 'signal' | 'error' | 'crashed' | 'lost';

export interface HostExit {
  reason?: ExitReason;
  /** Set when the agent stopped because something failed, rather than ending cleanly. */
  error?: string;
  /** The agent process's own exit code and signal, when the host spawned it and saw it go. */
  code?: number | null;
  signal?: string | null;
  /** With `reason: 'signal'`: the signal the host received. */
  hostSignal?: string;
  /** The last of the agent's stderr, for a failure worth explaining. */
  stderrTail?: string;
  /**
   * With `reason: 'stopped'`: what stopped it when no client asked.
   * `idleTimeout`: the idle-orphan rule (§7.5) parked an idle session no
   * client had connected to for `orphanIdleHours`. Added in Stage 4; readers
   * ignore values they do not know.
   */
  trigger?: 'idleTimeout';
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
  /**
   * The newest raw message of each kind in `LATEST_MESSAGE_KINDS`, kept
   * however long ago it was sent: level information (the session's init, its
   * background tasks, its state) that the ring would eventually evict, and
   * that a core needs to know before, say, moving an idle session to a new host.
   */
  latest?: Record<string, unknown>;
}

/**
 * Message kinds `latest` keeps, as `type` or `type/subtype`. Additive: a later
 * host may keep more; a reader ignores kinds it does not know.
 */
export const LATEST_MESSAGE_KINDS = [
  'system/init',
  'system/status',
  'system/background_tasks_changed',
  'system/session_state_changed',
  'result',
  'rate_limit_event',
] as const;

/**
 * The `latest` key for a raw message, when it is one `latest` keeps: its
 * `type/subtype` if that is listed, else its bare `type` (every `result` has
 * a subtype, `success` or an error, and all of them are kept as `result`).
 */
export function latestKindOf(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const m = msg as { type?: unknown; subtype?: unknown };
  if (typeof m.type !== 'string') return undefined;
  const kinds = LATEST_MESSAGE_KINDS as readonly string[];
  if (typeof m.subtype === 'string' && kinds.includes(`${m.type}/${m.subtype}`)) return `${m.type}/${m.subtype}`;
  return kinds.includes(m.type) ? m.type : undefined;
}

/**
 * How many background tasks (`run_in_background` shells, subagents, …) the
 * session reported last, from `latest`. Ending the CLI kills every one of
 * them, so a session with any is never ended automatically: not by the
 * idle-orphan rule, not by a version migration (§7.4, §7.5). Unknown or
 * malformed counts as none only when nothing was ever reported.
 */
export function backgroundTaskCount(latest: Record<string, unknown> | undefined): number {
  const msg = latest?.['system/background_tasks_changed'] as { tasks?: unknown } | undefined;
  if (!msg) return 0;
  // A report this reader cannot read is not proof of none. Ambient tasks
  // (live-update watchers) are not work: the SDK says to leave them out of
  // activity, and counting them would mean never parking or migrating.
  if (!Array.isArray(msg.tasks)) return 1;
  return msg.tasks.filter((t) => !(t && typeof t === 'object' && (t as { ambient?: unknown }).ambient === true)).length;
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
  /**
   * The model and permission mode as last set through `control`, which no
   * event records. Absent until a client changes them; the launch values
   * (manifest `launch`) hold until then.
   */
  controls?: { model?: string; permissionMode?: string };
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
    case 'message': {
      const kind = latestKindOf(event.msg);
      if (kind) next.latest = { ...snap.latest, [kind]: event.msg };
      break;
    }
    default:
      // An event type this reader does not know: a later host's addition. Ignored.
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

/** Every `control` op this protocol defines; a host advertises the ones it has as `control.<op>`. */
export const CONTROL_OPS = ['interrupt', 'setModel', 'setPermissionMode', 'supportedModels', 'supportedCommands', 'getContextUsage'] as const;

/** The control passthrough: the SDK `Query` methods a client may call. */
export type ControlRequest =
  | { op: 'interrupt' }
  | { op: 'setModel'; model?: string }
  | { op: 'setPermissionMode'; mode: string }
  | { op: 'supportedModels' }
  | { op: 'supportedCommands' }
  | { op: 'getContextUsage' };

// ---------------------------------------------------------------------------
// The wire: a session host serving the protocol on a Unix socket (Stage 3).
//
// NDJSON, JSON-RPC 2.0: one message per line, requests carry `id`,
// notifications do not (playbook §9). The host listens; the core connects.
// Every method but `hello` needs the host's token; `send`, `respondAsk`,
// `control` and `end` need `role: 'core'` (any other role is an observer).
//
// Methods (params → result):
//   hello       HelloParams                         → HelloResult;
//                                                     RPC_PROTOCOL_MISMATCH {data: {min, max}}
//   snapshot    {}                                  → HostSnapshot
//   events      {fromSeq, maxBytes, epoch?}         → EventsResult: a page of held events
//   subscribe   {fromSeq, epoch?}                   → {ok: true}; RPC_RESYNC if the gap is gone
//   send        {message}                           → SendResult
//   respondAsk  {requestId, result}                 → {outcome: RespondOutcome}
//   control     ControlRequest                      → {result}; -32601 for an op the host
//                                                     does not have (see `control.<op>` capabilities)
//   end         {graceMs?}                          → {ok: true}, once the agent has exited
//   ping        {}                                  → {seq, now}
//   configure   ConfigureParams                     → {ok: true}; core only. Stage 4, additive:
//                                                     only sent to a host advertising
//                                                     `configure.orphanIdleHours`
//
// Notifications (host → core):
//   event       {event: HostEvent}                  every event, in seq order
//   resync      {}                                  this client's queue overflowed
//
// Subscribing. `subscribe` replays the held events after `fromSeq` and then
// follows live ones; the replayed events are sent *before* its response. A
// subscription is for small gaps: page a large one with `events` first (a
// client queue holds 4 MiB). If the queue overflows during `subscribe`, the
// answer is RPC_RESYNC and nothing is streamed. After a `resync`
// notification no more events are sent until a new `subscribe` succeeds:
// take a snapshot, page `events`, subscribe again. An `epoch` other than the
// host's is answered with RPC_RESYNC (seqs from another host mean nothing).
//
// Reading forward. Unknown fields, event types, states, exit reasons and
// capabilities are ignored; unknown methods answer -32601; new features are
// announced as `capabilities`. That is what keeps v1 additive.
//
// Frozen at CP2: the methods, the notifications, `HostEvent`, `HostSnapshot`
// and `HostManifest`. `HostBoot` is not frozen: a core only boots a host of
// its own build.
// ---------------------------------------------------------------------------

export const HOST_PROTOCOL_VERSION = 1;

/** Error codes beyond JSON-RPC's own. */
export const RPC_UNAUTHORIZED = -32001;
export const RPC_FORBIDDEN = -32002;
/** `hello` offered no protocol version this host speaks. `data: {min, max}` says which it does. */
export const RPC_PROTOCOL_MISMATCH = -32003;
/** `subscribe`/`events` from a seq the ring no longer holds, from another epoch, or a subscribe that overflowed. */
export const RPC_RESYNC = -32010;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL = -32603;

/** Largest line either side accepts. Longer lines are rejected, never partially applied. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** The most an `events` page may carry: well under a client's 4 MiB queue (spike S3). */
export const MAX_PAGE_BYTES = 1024 * 1024;

export type ClientRole = 'core' | 'observer';

/** The capability a host advertises when it takes `configure`. */
export const CAPABILITY_CONFIGURE_IDLE = 'configure.orphanIdleHours';

/**
 * `configure`: settings the core owns that the host must apply while no core
 * is connected. Fields a host does not know are ignored.
 */
export interface ConfigureParams {
  /** The idle-orphan rule (§7.5): hours with no client before an idle session is parked. 0 = never. */
  orphanIdleHours?: number;
}

export interface HelloParams {
  client: { role: ClientRole; build: string; pid: number; capabilities?: string[] };
  protocol: { min: number; max: number };
  token: string;
}

export interface HelloResult {
  hostId: string;
  protocol: number;
  hostBuild: string;
  provider: 'claude';
  sdkVersion: string;
  /** The Claude Code version the CLI reported, once it has. */
  cliVersion?: string;
  hostPid: number;
  /** The `claude` process, when the host spawned it itself. */
  agentPid?: number;
  agentStartTime?: string;
  cwd: string;
  /** ms epoch the host started, which is when the session's execution started. */
  startedAt: number;
  sessionId?: string;
  state: HostState;
  seq: number;
  epoch: string;
  capabilities: string[];
}

export interface EventsResult {
  events: HostEvent[];
  /** The seq of the last event in this page, or `fromSeq` if the page is empty. Page again from here. */
  nextSeq: number;
  /** Nothing newer than `nextSeq` existed when the page was cut. */
  done: boolean;
}

/**
 * `run/<hostId>.json`, written by the host (atomically, 0600) once it is
 * listening, rewritten when the session id changes, and given an `exit` when
 * the agent has gone. The core reads these before anything else at startup
 * (§7.3). The token is never in here: it is `run/<hostId>.token`.
 *
 * Every later version keeps the meaning of `v`, `hostId`, `hostPid`,
 * `hostStartTime`, `sessionId` and `protocol`. A reader that meets a `v` it
 * does not know, with that host still alive, treats the session as held by a
 * host it cannot talk to: never ownerless, never resumed a second time.
 */
export interface HostManifest {
  v: 1;
  hostId: string;
  provider: 'claude';
  sessionId?: string;
  cwd: string;
  hostPid: number;
  /** `ps -o lstart=` of the host, read in UTC and the C locale (`procStart.ts`). */
  hostStartTime?: string;
  agentPid?: number;
  agentStartTime?: string;
  /**
   * How the session was launched, so it can be described even if the core's
   * registry lost it. `policy` (#71, additive) is kept here too, so a session
   * adopted without a registry record still moves to a new host with its
   * rules; readers parse it with `parseLaunchPolicy`.
   */
  launch?: { resume?: boolean; permissionMode?: string; model?: string; effort?: string; binary?: string; policy?: LaunchPolicy };
  socketPath: string;
  protocol: number;
  hostBuild: string;
  /** The cloned runtime this host runs from; kept until no manifest references it. */
  runtimeDir?: string;
  sdkVersion: string;
  cliVersion?: string;
  startedAt: number;
  /** Written when the agent exits. A dead host with no exit record was lost. */
  exit?: HostExit & { at: number; lastSeq: number };
}

/**
 * What the core hands a new host on stdin, as one JSON line, before stdin is
 * closed. On stdin because argv is visible to `ps` and the environment is
 * inherited by `claude` and every tool it runs; the token is in here.
 */
export interface HostBoot {
  token: string;
  hostId: string;
  socketPath: string;
  manifestPath: string;
  hostBuild: string;
  runtimeDir?: string;
  /** The idle-orphan rule's hours at spawn; `configure` changes it later. Absent = never. */
  orphanIdleHours?: number;
  launch: {
    cwd: string;
    resume?: string;
    sessionId?: string;
    permissionMode?: string;
    model?: string;
    effort?: string;
    /** Absolute path of the `claude` to spawn. */
    binary: string;
    /**
     * The session's launch policy (`launchPolicy.ts`). Only its `claude` half
     * is used; the host applies it to the SDK options as given and decides nothing.
     */
    policy?: LaunchPolicy;
  };
}
