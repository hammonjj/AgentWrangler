/**
 * The control socket's server, in the app (playbook §9.10, Stage 8, #21).
 *
 * It holds no policy of its own. It authenticates a client by the per-launch
 * token, checks the protocol version, and hands each method to a
 * `ControlBackend`, which `createControlBackend` builds over the app's own
 * services. Transport-level concerns only: framing, one subscription per
 * connection, and a bound on how far a slow reader may fall behind.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Disposable } from '../events';
import { NdjsonPeer, type IncomingRequest } from '../rpc/ndjsonPeer';
import type { SessionViewEvent } from '../session/sessionHandle';
import {
  CONTROL_PROTOCOL_VERSION,
  DEFAULT_SUBSCRIBE_BLOCKS,
  MAX_CONTROL_LINE_BYTES,
  MAX_SUBSCRIBE_BLOCKS,
  RPC_UNSUPPORTED,
  MUTATING_CONTROL_METHODS,
  RPC_INTERNAL,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PROTOCOL_MISMATCH,
  RPC_UNAUTHORIZED,
  type ControlHelloParams,
  type ControlHelloResult,
  type ControlMethod,
  type ControlProject,
  type ControlRenameResult,
  type ControlSendResult,
  type ControlSession,
  type ControlSessionClosed,
  type ControlSessionResult,
  type ControlStatusResult,
  type ControlSubscribeResult,
  type ControlDelegateParams,
  type ControlDelegateResult,
  type ControlTaskProposeParams,
  type ControlTaskProposeResult,
  type ControlAgentProposeParams,
  type ControlAgentProposeResult,
  type ControlTaskView,
  type ControlWebLinkResult,
  type ControlWebDevice,
  type ControlWebDevicesResult,
  type ControlWebPairResult,
  type ControlWebRevokeResult,
  type ControlMissionsParams,
  type ControlMissionsResult,
  type ControlMissionParams,
  type ControlMissionResult,
  type ControlMissionActParams,
  type ControlMissionActResult,
  type StopOutcome,
  type ControlChildSpawnParams,
  type ControlChildSpawnResult,
  type ControlChildListResult,
  type ControlChildOriginParams,
  type ControlChildSendParams,
  type ControlChildReadParams,
  type ControlChildReadResult,
  type ControlChildStopParams,
  type ControlChildDoneParams,
  type ControlChildDoneResult,
  MAX_TASK_OBJECTIVE_CHARS,
  MAX_CHILD_TEXT_CHARS,
} from './protocol';

/** A method failed in a way the client should be told about by code. */
export class ControlError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ControlSubscription extends Disposable {
  result: ControlSubscribeResult;
}

/** What the socket can ask the app. Every method may throw `ControlError`. */
export interface ControlBackend {
  describe(): Omit<ControlHelloResult, 'protocol' | 'capabilities'>;
  status(): ControlStatusResult;
  sessions(opts: { all: boolean }): ControlSession[];
  session(ref: string): ControlSessionResult;
  subscribe(
    ref: string,
    maxBlocks: number,
    onEvent: (event: SessionViewEvent) => void,
    onClosed: (reason: ControlSessionClosed['reason']) => void,
  ): ControlSubscription;
  send(ref: string, text: string): Promise<ControlSendResult>;
  stop(ref: string, force: boolean): Promise<StopOutcome>;
  /** Set (or, with a blank name, clear) the session's nickname. */
  rename(ref: string, name: string): ControlRenameResult;
  projects(): ControlProject[];
  /** A task proposal the user accepts in the app (#80). Throws `ControlError` when orchestration is off. */
  proposeTask(params: ControlTaskProposeParams): Promise<ControlTaskProposeResult>;
  /** Delegate an outcome (#82): the planner decides one task or several. Throws `ControlError` when orchestration is off. */
  delegate(params: ControlDelegateParams): Promise<ControlDelegateResult>;
  tasks(): ControlTaskView[];
  /** A durable agent's memory proposal (#180). Throws `ControlError` when the conversation is not an agent's. */
  proposeAgentMemory(params: ControlAgentProposeParams): ControlAgentProposeResult;
  /** A single-use browser sign-in link (#127). Throws `ControlError` when the browser workbench is off. */
  webLink(): ControlWebLinkResult;
  /** Start pairing a device (#137). Throws `ControlError` while LAN access is not listening. */
  webPair(): ControlWebPairResult;
  /** Browser devices, loopback and paired (#137). */
  webDevices(): ControlWebDevice[];
  /** Revoke one by id or unique prefix (#137); its connections close at once. */
  webRevoke(id: string): ControlWebRevokeResult;
  /** Missions, read-only (agent mission control). */
  missions(params: ControlMissionsParams): ControlMissionsResult;
  /** One mission, read-only. Throws `ControlError` when no mission matches. */
  mission(params: ControlMissionParams): ControlMissionResult;
  /** A durable agent acts on a mission it delegated, under its grant. Refusals are results, not errors. */
  missionAct(params: ControlMissionActParams): Promise<ControlMissionActResult>;
  /** Child conversations (#198): each runs as the calling durable agent, on its own children only. */
  childSpawn(params: ControlChildSpawnParams): Promise<ControlChildSpawnResult>;
  childList(params: ControlChildOriginParams): ControlChildListResult;
  childSend(params: ControlChildSendParams): Promise<ControlSendResult>;
  childRead(params: ControlChildReadParams): ControlChildReadResult;
  childStop(params: ControlChildStopParams): Promise<StopOutcome>;
  childDone(params: ControlChildDoneParams): Promise<ControlChildDoneResult>;
}

export interface ControlServerOptions {
  backend: ControlBackend;
  token: string;
  log: (message: string) => void;
  /** Bytes a subscriber may leave unread before its subscription is dropped. Default 8 MiB. */
  maxBufferedBytes?: number;
}

interface Conn {
  socket: net.Socket;
  peer: NdjsonPeer;
  authed: boolean;
  /** Who it said it was at `hello`, for the audit log. Self-reported. */
  client?: string;
  subscription?: ControlSubscription;
}

const DEFAULT_MAX_BUFFERED = 8 * 1024 * 1024;

export class ControlServer implements Disposable {
  private server?: net.Server;
  private socketPath?: string;
  private readonly conns = new Set<Conn>();
  private readonly token: Buffer;
  /** Set once the app starts quitting: reads still work, changes do not. */
  private mutationsStopped = false;

  constructor(private readonly opts: ControlServerOptions) {
    this.token = Buffer.from(opts.token, 'utf8');
  }

  /**
   * The app is quitting: refuse `send` and `stop` from now on, so a command
   * cannot race the quit's own ending of sessions.
   */
  stopMutations(): void {
    this.mutationsStopped = true;
  }

  /**
   * Listen on `socketPath` (0600). A socket file already there is a previous
   * run's: the app holds a single-instance lock, so no live server owns it.
   */
  listen(socketPath: string): Promise<void> {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // nothing there
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        // Accept failures (EMFILE, …) arrive here; unheard, they would be an
        // uncaught exception in the app's main process.
        server.on('error', (err) => this.opts.log(`control socket: ${String(err)}`));
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (err) {
          this.opts.log(`control socket: could not restrict ${socketPath}: ${String(err)}`);
        }
        this.server = server;
        this.socketPath = socketPath;
        resolve();
      });
    });
  }

  dispose(): void {
    for (const conn of this.conns) {
      conn.subscription?.dispose();
      conn.peer.dispose();
      conn.socket.destroy();
    }
    this.conns.clear();
    this.server?.close();
    this.server = undefined;
    if (this.socketPath) {
      try {
        fs.rmSync(this.socketPath, { force: true });
      } catch {
        // gone
      }
    }
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = {
      socket,
      authed: false,
      peer: new NdjsonPeer({
        write: (line) => {
          if (!socket.destroyed) socket.write(line);
        },
        jsonrpc: true,
        maxLineBytes: MAX_CONTROL_LINE_BYTES,
        onOversize: () => socket.destroy(),
      }),
    };
    this.conns.add(conn);
    socket.on('data', (chunk: Buffer) => conn.peer.feed(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      conn.subscription?.dispose();
      conn.peer.dispose();
      this.conns.delete(conn);
    });
    conn.peer.onRequest((req) => void this.dispatch(conn, req));
  }

  private async dispatch(conn: Conn, req: IncomingRequest): Promise<void> {
    try {
      conn.peer.respond(req.id, await this.handle(conn, req));
    } catch (err) {
      const failure = err instanceof ControlError ? err : new ControlError(RPC_INTERNAL, err instanceof Error ? err.message : String(err));
      conn.peer.respondError(req.id, {
        code: failure.code,
        message: failure.message,
        ...(failure.data === undefined ? {} : { data: failure.data }),
      });
    }
  }

  private async handle(conn: Conn, req: IncomingRequest): Promise<unknown> {
    const p = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
    const method = req.method as ControlMethod;
    if (method === 'hello') return this.hello(conn, p as unknown as ControlHelloParams);
    if (!conn.authed) throw new ControlError(RPC_UNAUTHORIZED, 'hello first, with the token');
    const backend = this.opts.backend;
    const mutating = MUTATING_CONTROL_METHODS.includes(method);
    if (mutating || method === 'subscribe') {
      // The session, or the repository a task is for; never the text.
      const target =
        method === 'task.propose' || method === 'delegate'
          ? path.basename(String(p.folder ?? ''))
          : method === 'agent.propose'
            ? `memory ${p.op === 'forget' ? 'forget' : 'add'}`
            : method === 'mission.act'
              ? `${String(p.act)} ${String(p.ref)}`
              : method === 'child.spawn'
                ? `${p.provider === 'codex' ? 'codex' : 'claude'} ${typeof p.name === 'string' ? p.name : ''}`
                : String(p.ref);
      this.opts.log(`control socket: ${method} ${target.slice(0, 80)} by ${conn.client ?? '?'}`);
    }
    if (mutating && this.mutationsStopped) throw new ControlError(RPC_UNSUPPORTED, 'Agent Wrangler is quitting');
    switch (method) {
      case 'status':
        return backend.status();
      case 'sessions':
        return { sessions: backend.sessions({ all: p.all === true }) };
      case 'session':
        return backend.session(ref(p));
      case 'subscribe': {
        const wanted = typeof p.maxBlocks === 'number' && Number.isFinite(p.maxBlocks) ? Math.floor(p.maxBlocks) : DEFAULT_SUBSCRIBE_BLOCKS;
        return this.subscribe(conn, ref(p), Math.max(0, Math.min(MAX_SUBSCRIBE_BLOCKS, wanted)));
      }
      case 'send': {
        if (typeof p.text !== 'string' || p.text.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, 'text is required');
        return (await backend.send(ref(p), p.text)) satisfies ControlSendResult;
      }
      case 'stop':
        return { outcome: await backend.stop(ref(p), p.force === true) };
      case 'rename': {
        if (typeof p.name !== 'string' || p.name.length > 200) throw new ControlError(RPC_INVALID_PARAMS, 'name must be a string of at most 200 characters');
        return backend.rename(ref(p), p.name) satisfies ControlRenameResult;
      }
      case 'projects':
        return { projects: backend.projects() };
      case 'task.propose':
        return (await backend.proposeTask(taskParams(p))) satisfies ControlTaskProposeResult;
      case 'delegate':
        return (await backend.delegate(taskParams(p))) satisfies ControlDelegateResult;
      case 'tasks':
        return { tasks: backend.tasks() };
      case 'agent.propose':
        return backend.proposeAgentMemory(agentProposeParams(p)) satisfies ControlAgentProposeResult;
      case 'web.link':
        // Never the link itself: it is a credential for two minutes.
        this.opts.log(`control socket: web.link by ${conn.client ?? '?'}`);
        return backend.webLink() satisfies ControlWebLinkResult;
      case 'web.pair':
        // Never the code: it is a credential for five minutes.
        if (this.mutationsStopped) throw new ControlError(RPC_UNSUPPORTED, 'Agent Wrangler is quitting');
        this.opts.log(`control socket: web.pair by ${conn.client ?? '?'}`);
        return backend.webPair() satisfies ControlWebPairResult;
      case 'web.devices':
        return { devices: backend.webDevices() } satisfies ControlWebDevicesResult;
      case 'web.devices.revoke': {
        if (typeof p.id !== 'string' || p.id.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, 'id is required');
        if (this.mutationsStopped) throw new ControlError(RPC_UNSUPPORTED, 'Agent Wrangler is quitting');
        this.opts.log(`control socket: web.devices.revoke ${p.id.slice(0, 40)} by ${conn.client ?? '?'}`);
        return backend.webRevoke(p.id.trim()) satisfies ControlWebRevokeResult;
      }
      case 'missions':
        return backend.missions({ all: p.all === true, mine: p.mine === true, ...originParam(p, false) }) satisfies ControlMissionsResult;
      case 'mission':
        return backend.mission({ ref: ref(p), ...originParam(p, false) }) satisfies ControlMissionResult;
      case 'mission.act':
        return (await backend.missionAct(missionActParams(p))) satisfies ControlMissionActResult;
      case 'child.spawn':
        return (await backend.childSpawn(childSpawnParams(p))) satisfies ControlChildSpawnResult;
      case 'child.list':
        return backend.childList({ origin: childOrigin(p) }) satisfies ControlChildListResult;
      case 'child.send':
        return (await backend.childSend({ origin: childOrigin(p), ref: ref(p), text: childText(p.text, 'text') })) satisfies ControlSendResult;
      case 'child.read': {
        const last = typeof p.last === 'number' && Number.isFinite(p.last) ? Math.max(1, Math.min(MAX_SUBSCRIBE_BLOCKS, Math.floor(p.last))) : undefined;
        return backend.childRead({ origin: childOrigin(p), ref: ref(p), ...(last !== undefined ? { last } : {}) }) satisfies ControlChildReadResult;
      }
      case 'child.stop':
        return { outcome: await backend.childStop({ origin: childOrigin(p), ref: ref(p), force: p.force === true }) };
      case 'child.done':
        return (await backend.childDone({ origin: childOrigin(p), ref: ref(p), discard: p.discard === true })) satisfies ControlChildDoneResult;
      default:
        throw new ControlError(RPC_METHOD_NOT_FOUND, `no method ${req.method}`);
    }
  }

  private hello(conn: Conn, p: ControlHelloParams): ControlHelloResult {
    // A later hello replaces the first: it has to pass on its own.
    conn.authed = false;
    const offered = typeof p?.token === 'string' ? Buffer.from(p.token, 'utf8') : Buffer.alloc(0);
    if (offered.length !== this.token.length || !timingSafeEqual(offered, this.token)) {
      this.opts.log('control socket: refused a client with the wrong token');
      throw new ControlError(RPC_UNAUTHORIZED, 'bad token');
    }
    const min = typeof p.protocol?.min === 'number' ? p.protocol.min : 1;
    const max = typeof p.protocol?.max === 'number' ? p.protocol.max : 1;
    if (CONTROL_PROTOCOL_VERSION < min || CONTROL_PROTOCOL_VERSION > max) {
      throw new ControlError(RPC_PROTOCOL_MISMATCH, `this app speaks control protocol ${CONTROL_PROTOCOL_VERSION}`, {
        min: CONTROL_PROTOCOL_VERSION,
        max: CONTROL_PROTOCOL_VERSION,
      });
    }
    conn.authed = true;
    const name = typeof p.client?.name === 'string' ? p.client.name.slice(0, 40) : '?';
    conn.client = `${name} pid ${typeof p.client?.pid === 'number' ? p.client.pid : '?'}`;
    return { ...this.opts.backend.describe(), protocol: CONTROL_PROTOCOL_VERSION, capabilities: [] };
  }

  /**
   * Replace any subscription this connection had. Events are written as they
   * come; a client that stops reading is cut off once `maxBufferedBytes` sit
   * unread, with `session.closed {reason: 'overflow'}`, rather than letting
   * the app's heap grow for it.
   */
  private subscribe(conn: Conn, sessionRef: string, maxBlocks: number): ControlSubscribeResult {
    conn.subscription?.dispose();
    conn.subscription = undefined;
    const limit = this.opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
    let closed = false;
    // The ref until the backend has resolved it to a key.
    let key = sessionRef;
    const close = (reason: ControlSessionClosed['reason']) => {
      if (closed) return;
      closed = true;
      sub?.dispose();
      if (conn.subscription === sub) conn.subscription = undefined;
      conn.peer.notify('session.closed', { key, reason } satisfies ControlSessionClosed);
    };
    let sub: ControlSubscription | undefined;
    sub = this.opts.backend.subscribe(
      sessionRef,
      maxBlocks,
      (event) => {
        if (closed) return;
        if (conn.socket.writableLength > limit) {
          close('overflow');
          return;
        }
        conn.peer.notify('session.event', { key, event });
      },
      (reason) => close(reason),
    );
    key = sub.result.key;
    if (closed) {
      sub.dispose();
    } else {
      conn.subscription = sub;
    }
    return sub.result;
  }
}

/** 0700 and ours, or refuse: a directory anyone else can reach is not a private channel (§12). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user; not serving the control socket there`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** `task.propose`'s params, and `delegate`'s, checked. The folder must be absolute: the app has no cwd of the caller's. */
export function taskParams(p: Record<string, unknown>): ControlTaskProposeParams {
  if (typeof p.folder !== 'string' || !path.isAbsolute(p.folder)) throw new ControlError(RPC_INVALID_PARAMS, 'folder must be an absolute path');
  if (typeof p.objective !== 'string' || p.objective.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, 'objective is required');
  if (p.objective.length > MAX_TASK_OBJECTIVE_CHARS) {
    throw new ControlError(RPC_INVALID_PARAMS, `objective is longer than ${MAX_TASK_OBJECTIVE_CHARS} characters`);
  }
  const criteria = p.acceptanceCriteria;
  if (criteria !== undefined && (!Array.isArray(criteria) || criteria.some((c) => typeof c !== 'string'))) {
    throw new ControlError(RPC_INVALID_PARAMS, 'acceptanceCriteria must be a list of strings');
  }
  if (p.harness !== undefined && p.harness !== 'claude' && p.harness !== 'codex') {
    throw new ControlError(RPC_INVALID_PARAMS, 'harness must be claude or codex');
  }
  // An origin that doesn't parse is dropped, not refused: it only decides where the card shows.
  const o = p.origin as { provider?: unknown; sessionId?: unknown } | undefined;
  const origin =
    o && (o.provider === 'claude' || o.provider === 'codex') && typeof o.sessionId === 'string' && /^[\w-]{4,128}$/.test(o.sessionId)
      ? { provider: o.provider as 'claude' | 'codex', sessionId: o.sessionId }
      : undefined;
  return {
    folder: p.folder,
    objective: p.objective,
    acceptanceCriteria: ((criteria as string[] | undefined) ?? []).map((c) => c.trim()).filter(Boolean),
    ...(p.harness ? { harness: p.harness } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** `agent.propose`'s params, checked for shape; what they say is checked by the agent's memory rules. */
export function agentProposeParams(p: Record<string, unknown>): ControlAgentProposeParams {
  const o = p.origin as { provider?: unknown; sessionId?: unknown } | undefined;
  if (!o || (o.provider !== 'claude' && o.provider !== 'codex') || typeof o.sessionId !== 'string' || !/^[\w-]{4,128}$/.test(o.sessionId)) {
    throw new ControlError(RPC_INVALID_PARAMS, 'run this inside an agent conversation: it is the conversation that proposes');
  }
  if (p.op !== 'add' && p.op !== 'forget') throw new ControlError(RPC_INVALID_PARAMS, 'op must be add or forget');
  const str = (v: unknown, max: number, name: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max) throw new ControlError(RPC_INVALID_PARAMS, `${name} must be a string of at most ${max} characters`);
    return v;
  };
  const kind = str(p.kind, 20, 'kind');
  const text = str(p.text, 2000, 'text');
  const itemId = str(p.itemId, 20, 'itemId');
  return {
    origin: { provider: o.provider, sessionId: o.sessionId },
    op: p.op,
    ...(kind !== undefined ? { kind } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(itemId !== undefined ? { itemId } : {}),
  };
}

/** A conversation reference as `aw` reads it from its agent's environment. `required`: refuse without one. */
export function originParam(p: Record<string, unknown>, required: boolean): { origin?: { provider: 'claude' | 'codex'; sessionId: string } } {
  const o = p.origin as { provider?: unknown; sessionId?: unknown } | undefined;
  if (o && (o.provider === 'claude' || o.provider === 'codex') && typeof o.sessionId === 'string' && /^[\w-]{4,128}$/.test(o.sessionId)) {
    return { origin: { provider: o.provider, sessionId: o.sessionId } };
  }
  if (required) throw new ControlError(RPC_INVALID_PARAMS, "run this inside the agent's own conversation: the grant is the agent's, and the conversation says which agent it is");
  return {};
}

/** `mission.act`'s params, checked for shape. Whether it may run is the grant decision's. */
export function missionActParams(p: Record<string, unknown>): ControlMissionActParams {
  const { origin } = originParam(p, true);
  if (p.act !== 'accept' && p.act !== 'finish' && p.act !== 'cancel') throw new ControlError(RPC_INVALID_PARAMS, 'act must be accept, finish or cancel');
  const finishes = ['merge-local', 'pull-request', 'keep', 'discard'];
  if (p.how !== undefined && (typeof p.how !== 'string' || !finishes.includes(p.how))) {
    throw new ControlError(RPC_INVALID_PARAMS, 'how must be merge-local, pull-request, keep or discard');
  }
  if (p.act === 'finish' && p.how === undefined) throw new ControlError(RPC_INVALID_PARAMS, 'finish needs how: merge-local, pull-request, keep or discard');
  if (p.act === 'cancel' && p.how !== undefined) throw new ControlError(RPC_INVALID_PARAMS, 'cancel takes no how');
  if (p.task !== undefined && (typeof p.task !== 'string' || p.task.length === 0 || p.task.length > 64)) throw new ControlError(RPC_INVALID_PARAMS, 'task must be a task id or key');
  return {
    origin: origin!,
    ref: ref(p),
    act: p.act,
    ...(p.how !== undefined ? { how: p.how as ControlMissionActParams['how'] } : {}),
    ...(typeof p.task === 'string' ? { task: p.task } : {}),
  };
}

/** A `child.*` method's origin: required, since the calling agent's conversation is who acts. */
function childOrigin(p: Record<string, unknown>): { provider: 'claude' | 'codex'; sessionId: string } {
  const o = p.origin as { provider?: unknown; sessionId?: unknown } | undefined;
  if (o && (o.provider === 'claude' || o.provider === 'codex') && typeof o.sessionId === 'string' && /^[\w-]{4,128}$/.test(o.sessionId)) {
    return { provider: o.provider, sessionId: o.sessionId };
  }
  throw new ControlError(RPC_INVALID_PARAMS, "run this inside a durable agent's own conversation: the conversation says which agent's children these are");
}

function childText(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, `${name} is required`);
  if (v.length > MAX_CHILD_TEXT_CHARS) throw new ControlError(RPC_INVALID_PARAMS, `${name} is longer than ${MAX_CHILD_TEXT_CHARS} characters`);
  return v;
}

/** `child.spawn`'s params, checked for shape. Whether the caller may spawn is `authorize`'s. */
export function childSpawnParams(p: Record<string, unknown>): ControlChildSpawnParams {
  const origin = childOrigin(p);
  const prompt = childText(p.prompt, 'prompt');
  if (p.provider !== undefined && p.provider !== 'claude' && p.provider !== 'codex') throw new ControlError(RPC_INVALID_PARAMS, 'provider must be claude or codex');
  if (p.folder !== undefined && (typeof p.folder !== 'string' || !path.isAbsolute(p.folder))) throw new ControlError(RPC_INVALID_PARAMS, 'folder must be an absolute path');
  if (p.name !== undefined && (typeof p.name !== 'string' || p.name.trim().length === 0 || p.name.length > 80)) throw new ControlError(RPC_INVALID_PARAMS, 'name must be a short string');
  return {
    origin,
    prompt,
    ...(p.provider ? { provider: p.provider } : {}),
    ...(typeof p.folder === 'string' ? { folder: p.folder } : {}),
    ...(typeof p.name === 'string' ? { name: p.name.trim() } : {}),
  };
}

function ref(p: Record<string, unknown>): string {
  if (typeof p.ref !== 'string' || p.ref.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, 'ref is required');
  return p.ref;
}

/**
 * Create the run directory if needed (0700, ours), and write a fresh token
 * (0600). A new token every launch: a client that read the last one has to
 * read it again, and a token copied somewhere stops working at the next start.
 */
export function writeControlToken(tokenPath: string): string {
  ensurePrivateDir(path.dirname(tokenPath));
  const token = randomBytes(32).toString('base64url');
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, tokenPath);
  return token;
}
