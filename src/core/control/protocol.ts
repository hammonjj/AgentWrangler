/**
 * The core control socket: what the `aw` command-line client says to a running
 * Agent Wrangler (`run/core.sock`, playbook §9.10, Stage 8, #21).
 *
 * The CLI is a client of the app and never a supervisor: it never connects to
 * session hosts, and everything it does goes through the same paths as the
 * menu and the pane (`send` through the session's handle, `stop` through the
 * same close as the menu's Stop…).
 *
 * Wire: the host protocol's codec (`NdjsonPeer`, NDJSON JSON-RPC 2.0), on a
 * 0600 socket in the 0700 `run/` directory, with a per-launch token in
 * `run/core.token` (0600) that `hello` must present.
 *
 * What is frozen within protocol v1: method names, their params, the result
 * fields listed here, the error codes, and the `session.event` /
 * `session.closed` envelopes. Changes within v1 are additive only, as in §9.6:
 * new fields, new methods (older apps answer `-32601`), new `capabilities`.
 * **Enumerations may grow too**, as in §9.5: a reader must tolerate a
 * status, lifecycle, outcome, `runBy`, `pending.kind` or close reason it does
 * not know. The wire's unions are declared here, not borrowed from the UI
 * model, so that renaming a UI status cannot silently change the wire.
 *
 * **Not frozen:** the `ConvBlock` / `SessionViewEvent` payloads inside
 * `subscribe` and `session.event`. Those are AW's UI shape and change with it.
 * Only the CLI that ships in the same bundle may parse them; a third-party
 * client must not. `hello` reports the app's build so a CLI from another
 * build can say so.
 *
 * Pure types, constants and one pure function. No Node, no DOM: the CLI and
 * the core both bundle it.
 */
import type { SessionViewEvent } from '../session/sessionHandle';
import type { ConvBlock } from '../../shared/conversation';

export const CONTROL_PROTOCOL_VERSION = 1;
/** Beside the host sockets, or in the fallback run directory when that path is too long. */
export const CONTROL_SOCKET_NAME = 'core.sock';
export const CONTROL_TOKEN_NAME = 'core.token';
/** Longest request line the core accepts from a client. Text to send, not images. */
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024;
/** `subscribe` returns at most this many of the newest blocks, whatever `maxBlocks` asks. */
export const MAX_SUBSCRIBE_BLOCKS = 200;
export const DEFAULT_SUBSCRIBE_BLOCKS = 50;

// Shared with the host protocol, same meanings.
export { RPC_UNAUTHORIZED, RPC_PROTOCOL_MISMATCH, RPC_METHOD_NOT_FOUND, RPC_INVALID_PARAMS, RPC_INTERNAL } from '../../shared/sessionProtocol';
/** No session matches the reference. */
export const RPC_NOT_FOUND = -32004;
/** More than one session matches. `data: {matches: ControlSessionRef[]}`. */
export const RPC_AMBIGUOUS = -32005;
/** The session exists, but not in a way that allows this (e.g. `send` to one AW does not run). */
export const RPC_UNSUPPORTED = -32006;

export const CONTROL_METHODS = ['hello', 'status', 'sessions', 'session', 'subscribe', 'send', 'stop', 'projects', 'task.propose', 'delegate', 'tasks', 'web.link', 'web.pair', 'web.devices', 'web.devices.revoke'] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];
/** Methods that change something. Logged by the core (method and session, never content). */
export const MUTATING_CONTROL_METHODS: readonly ControlMethod[] = ['send', 'stop', 'task.propose', 'delegate'];
/** The longest objective `task.propose` and `delegate` accept. An outcome, not a document. */
export const MAX_TASK_OBJECTIVE_CHARS = 20_000;

// ---- the wire's own enumerations (they may grow; see the header) ----

export type ControlStatus = 'blocked' | 'waiting' | 'done' | 'busy' | 'stuck' | 'ended';
export type ControlLifecycle = 'starting' | 'idle' | 'running' | 'ending' | 'ended' | 'error' | 'connecting' | 'unreachable';
export type ControlCommandOutcome = 'applied' | 'stale' | 'gone' | 'unsupported';

export interface ControlHelloParams {
  client: { name: string; build: string; pid: number };
  protocol: { min: number; max: number };
  token: string;
}

export interface ControlHelloResult {
  protocol: number;
  /** The app's build id; a CLI from another build should say so. */
  build: string;
  appPid: number;
  startedAt: number;
  /** Features beyond v1's base, for additions within v1. None yet. */
  capabilities: string[];
}

/**
 * Who runs a session:
 * - `hosted`: AW, somewhere that outlives the app (a session host, or Codex's
 *   background server);
 * - `app`: AW, in its own process (ends with the app);
 * - `external`: a terminal, an editor, another app.
 */
export type RunBy = 'hosted' | 'app' | 'external';

export interface ControlSessionRef {
  key: string;
  sessionId: string;
  title: string;
}

/** One row, as the table shows it. A deliberate subset of `AgentSession`, kept stable. */
export interface ControlSession extends ControlSessionRef {
  provider: string;
  status: ControlStatus;
  projectName?: string;
  cwd?: string;
  gitBranch?: string;
  worktree?: string;
  model?: string;
  pid?: number;
  lastActivityAt: number;
  archived: boolean;
  runBy: RunBy;
  /** What a blocked session is waiting on: usually a tool name. */
  blockedOn?: string;
}

export interface ControlStatusResult {
  build: string;
  appPid: number;
  startedAt: number;
  /** Sessions shown in the table (archived ones excluded), by status. */
  byStatus: Partial<Record<ControlStatus, number>>;
  /** Sessions AW runs: in hosts (survive a quit; every Claude one) and as children of the app (do not; Codex `--stdio`). */
  running: { hosted: number; app: number };
}

export interface ControlSessionsParams {
  /** Include archived rows. */
  all?: boolean;
}

export interface ControlSessionsResult {
  sessions: ControlSession[];
}

export interface ControlSessionParams {
  /** A session key (`claude:<id>`), a session id, or a unique prefix of one (4+ characters). */
  ref: string;
}

/** What AW's registry remembers about a session it ran. */
export interface ControlRecordView {
  state: string;
  endedReason?: string;
  createdAt: number;
  launch: { model?: string; effort?: string; permissionMode?: string };
}

export interface ControlPendingView {
  kind: 'permission' | 'question' | 'plan';
  /** One line: the tool and what it will do, the first question, or the plan's first line. */
  summary: string;
}

export interface ControlSessionResult {
  session: ControlSession;
  record?: ControlRecordView;
  /** Only for sessions AW runs: what the handle says it is doing. */
  lifecycle?: ControlLifecycle;
  pending?: ControlPendingView;
}

export interface ControlSubscribeParams extends ControlSessionParams {
  /** How many of the newest blocks to return. Default 50, at most 200. */
  maxBlocks?: number;
}

/**
 * `subscribe`: only for sessions AW runs. One subscription per connection
 * today (a new one replaces the last); close the connection to stop. The
 * notifications carry `key`, so a later version can allow several.
 */
export interface ControlSubscribeResult {
  key: string;
  sessionId?: string;
  lifecycle: ControlLifecycle;
  /** The newest blocks. Not frozen: AW's own block shape (see the header). */
  blocks: ConvBlock[];
  /** Older blocks exist than the ones returned. */
  truncated: boolean;
}

/** Notification after `subscribe`. Not frozen inside `event`. */
export interface ControlSessionEvent {
  key: string;
  event: SessionViewEvent;
}

/** Notification: the subscription is over. The connection stays usable. */
export interface ControlSessionClosed {
  key: string;
  /** `ended` the session stopped; `gone` AW no longer runs it; `overflow` the client read too slowly. */
  reason: 'ended' | 'gone' | 'overflow';
}

export interface ControlSendParams extends ControlSessionParams {
  text: string;
}

export interface ControlSendResult {
  outcome: ControlCommandOutcome;
  /** Why it was not applied, when there is something to say (e.g. open read-only elsewhere). */
  reason?: string;
}

export interface ControlStopParams extends ControlSessionParams {
  /** Stop even when it is working, which throws the turn away. */
  force?: boolean;
}

/**
 * - `stopped`: the process running it was ended (or the Codex thread released).
 * - `working`: it is mid-turn and `force` was not given; nothing was done.
 * - `nothing`: no process is known for it.
 * - `refused`: the process could not be stopped (it ignored both signals, or could not be verified).
 * - `hostRefused`: the session host holding it did not stop.
 */
export type StopOutcome = 'stopped' | 'working' | 'nothing' | 'refused' | 'hostRefused';

export interface ControlStopResult {
  outcome: StopOutcome;
}

export interface ControlProject {
  dir: string;
  name: string;
  lastUsedAt?: number;
  favourite?: boolean;
  /** Titles of live sessions working in its checkout. */
  occupiedBy?: string[];
}

export interface ControlProjectsResult {
  projects: ControlProject[];
}

/**
 * `task.propose` (#80): hand a piece of work to a task. It only ever makes a
 * **proposal**: AW assesses the task, routes it, and waits for the user to
 * accept or change the route in the app. Nothing runs until they do, which is
 * why an agent may call it where it may not call `send` or `stop`.
 */
export interface ControlTaskProposeParams {
  /** Any folder inside the repository. The task's branch is cut from the primary checkout's HEAD. */
  folder: string;
  objective: string;
  acceptanceCriteria?: string[];
  /** Which agent the router should prefer within the tier it picks. A preference, not a pin. */
  harness?: 'claude' | 'codex';
  /**
   * The conversation asking, from its agent's environment (#81). Its pane
   * shows the proposal as a card. Self-reported, so it only decides where a
   * proposal is *shown*; it grants nothing.
   */
  origin?: { provider: 'claude' | 'codex'; sessionId: string };
}

/** One task, as `aw tasks` lists it. */
export interface ControlTaskView {
  missionId: string;
  title: string;
  /** One line: "route proposed — waiting for you", "running", "verified", … Not an enumeration. */
  state: string;
  repoRoot: string;
  branch?: string;
  createdAt: number;
}

export interface ControlTaskProposeResult {
  task: ControlTaskView;
  /** `route`: a route is proposed; anything else: the user has to pick one. May grow. */
  verdict: string;
  /** The proposed model and effort, when there is one ("Sonnet · medium"). */
  route?: string;
  /** Why the router decided as it did, in one line. */
  summary?: string;
  note?: string;
}

export interface ControlTasksResult {
  tasks: ControlTaskView[];
}

/**
 * `delegate` (#82): hand an outcome to Agent Wrangler without choosing a task
 * or a mission. The planner decides; the proposal (one task) or the plan
 * (several) waits on a card in the origin conversation. Like `task.propose`
 * it only ever proposes, and the origin is only where the card is shown.
 */
export type ControlDelegateParams = ControlTaskProposeParams;

export interface ControlDelegateResult {
  task: ControlTaskView;
  /**
   * `single`: one task, proposed. `multiple`: a plan, waiting for review.
   * `planning`: the planner had not decided when the call returned; the card
   * will show what it decides. `failed`: it could not be planned (`note` says
   * why). May grow.
   */
  decision: string;
  /** For `single`: as `task.propose` has them. */
  verdict?: string;
  route?: string;
  summary?: string;
  /** For `multiple`: the plan's tasks, in the order they would run. */
  tasks?: { key: string; title: string }[];
  note?: string;
}

/**
 * `web.link` (#127): a single-use sign-in link for the browser workbench,
 * good for `expiresAt - now` (two minutes). `aw web open` opens it; `aw web
 * url` prints it. Refused with `RPC_UNSUPPORTED` when the workbench is off or
 * not listening.
 */
export interface ControlWebLinkResult {
  url: string;
  expiresAt: number;
}

/**
 * `web.pair` (#137): start pairing a device on the home network. `url` is
 * the LAN listener's `/pair?code=…` link (what the QR code says); `code` is
 * the same code for typing, eight characters. Single use, until `expiresAt`
 * (five minutes); a new one replaces it. Refused with `RPC_UNSUPPORTED` while
 * LAN access is not listening.
 */
export interface ControlWebPairResult {
  url: string;
  code: string;
  expiresAt: number;
}

/** One browser device (#137). Ids and a name, never a credential. */
export interface ControlWebDevice {
  id: string;
  name: string;
  /** `loopback`: a browser on this Mac (`aw web open`). `lan`: paired over the home network. May grow. */
  scope: string;
  createdAt: number;
  lastSeen: number;
}

/** `web.devices` (#137). */
export interface ControlWebDevicesResult {
  devices: ControlWebDevice[];
}

/** `web.devices.revoke {id}` (#137): `id` or a unique prefix of 4+ characters. Its connections close at once. */
export interface ControlWebRevokeResult {
  device: ControlWebDevice;
}

/**
 * Resolve what a user typed to one session: a key, an id (any case), or a
 * unique id prefix of four characters or more. Exact matches win over prefixes.
 */
export function resolveSessionRef<T extends ControlSessionRef>(
  sessions: readonly T[],
  ref: string,
): { match: T } | { error: 'notFound' } | { error: 'ambiguous'; matches: T[] } {
  const wanted = ref.trim().toLowerCase();
  if (wanted.length === 0) return { error: 'notFound' };
  const exact = sessions.filter((s) => s.key.toLowerCase() === wanted || s.sessionId.toLowerCase() === wanted);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous', matches: exact };
  // `claude:1a2b` is a key prefix; `1a2b` an id prefix.
  const withKey = wanted.includes(':');
  const bare = withKey ? wanted.slice(wanted.indexOf(':') + 1) : wanted;
  if (bare.length < 4) return { error: 'notFound' };
  const prefixed = sessions.filter((s) => (withKey ? s.key : s.sessionId).toLowerCase().startsWith(wanted));
  if (prefixed.length === 1) return { match: prefixed[0] };
  if (prefixed.length > 1) return { error: 'ambiguous', matches: prefixed };
  return { error: 'notFound' };
}
