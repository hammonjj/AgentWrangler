/**
 * JSON-RPC to a Codex app-server, over one of two transports:
 *
 * - **stdio**: a child `codex app-server --stdio`, NDJSON on its pipes. It ends
 *   when this process does, and every thread with it. The fallback.
 * - **host**: the detached server `CodexHost` owns, WebSocket over its Unix
 *   socket (one message per text frame). It outlives this process, so a
 *   dropped connection is reconnected, and a restart of the app finds its
 *   threads still running (Stage 5).
 *
 * Whichever it is, a connection after the first fires `onReconnect`, saying
 * whether the server behind it is the same process (a reconnect: pending asks
 * are re-sent on `thread/resume`) or a new one (a restart: everything in
 * flight is gone, and request ids start again at 0).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { Emitter, type Disposable } from '../core/events';
import { resolveCodexBinary } from './binary';
import { CodexHost } from './codexHost';
import { connectUnixWebSocket } from './wsClient';

export interface RpcNotification { method: string; params?: any }
export interface RpcServerRequest extends RpcNotification { id: string | number }

/** One message-oriented connection to a server. */
export interface CodexTransport {
  send(text: string): void;
  close(): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: (reason: string) => void): void;
}

export interface CodexConnection {
  transport: CodexTransport;
  /** Identifies the server process. The same value after a reconnect means the same server. */
  instance: string;
}

export interface CodexConnector {
  readonly kind: 'stdio' | 'host';
  connect(): Promise<CodexConnection>;
  /** Reconnect by itself after an unexpected close (the server may still be running). */
  readonly persistent: boolean;
  /** Called with the `initialize` result of every connection. */
  initialized?(result: any): void;
}

export interface ReconnectEvent {
  instance: string;
  /** The server is a different process from last time: nothing that was in flight survived. */
  restarted: boolean;
}

/** A child `codex app-server --stdio`: gone with this process. */
export function stdioConnector(
  binary: () => string,
  log: (message: string) => void = () => undefined,
  spawnProcess: typeof spawn = spawn,
): CodexConnector {
  let launches = 0;
  return {
    kind: 'stdio',
    persistent: false,
    async connect() {
      const child: ChildProcessWithoutNullStreams = spawnProcess(resolveCodexBinary(binary()), ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const messageListeners: ((text: string) => void)[] = [];
      const closeListeners: ((reason: string) => void)[] = [];
      let closed: string | undefined;
      const finish = (reason: string) => {
        if (closed !== undefined) return;
        closed = reason;
        for (const listener of closeListeners) listener(reason);
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data) => log(`codex app-server: ${String(data).trim()}`));
      // A missing/misconfigured binary reports through ChildProcess's `error`
      // event rather than `exit`. Always consume it so monitoring can continue
      // even when interactive Codex support is unavailable.
      child.on('error', (error) => finish(error.message));
      child.on('exit', (code, signal) => finish(`Codex App Server exited (${code ?? signal ?? 'unknown'})`));
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => { for (const listener of messageListeners) listener(line); });
      const transport: CodexTransport = {
        send(text) {
          // A child that failed to spawn has already said why; say it again here.
          if (closed !== undefined) throw new Error(closed);
          if (!child.stdin.writable) throw new Error('Codex App Server is not connected');
          child.stdin.write(`${text}\n`);
        },
        close() {
          child.kill();
          finish('Codex App Server disposed');
        },
        onMessage(listener) { messageListeners.push(listener); },
        onClose(listener) {
          if (closed !== undefined) {
            const reason = closed;
            queueMicrotask(() => listener(reason));
          } else closeListeners.push(listener);
        },
      };
      return { transport, instance: `stdio:${child.pid ?? 'unknown'}:${++launches}` };
    },
  };
}

/** The detached server `host` owns, over its socket. Launches it if it is not running. */
export function hostConnector(host: CodexHost, connect: typeof connectUnixWebSocket = connectUnixWebSocket): CodexConnector {
  return {
    kind: 'host',
    persistent: true,
    async connect() {
      const manifest = await host.ensure();
      const transport = await connect(manifest.socketPath);
      return { transport, instance: CodexHost.instanceOf(manifest) };
    },
    initialized(result) {
      host.noteUserAgent(typeof result?.userAgent === 'string' ? result.userAgent : undefined);
    },
  };
}

/** Delays between reconnect attempts; the last repeats. */
const RECONNECT_DELAYS_MS = [250, 1000, 2000, 5000, 10_000];

export class CodexAppServer implements Disposable {
  private transport?: CodexTransport;
  private ready = false;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private notifications = new Emitter<RpcNotification>();
  private requests = new Emitter<RpcServerRequest>();
  private reconnects = new Emitter<ReconnectEvent>();
  private disconnects = new Emitter<string>();
  private starting?: Promise<void>;
  private connector: CodexConnector;
  private instanceId?: string;
  private connectedOnce = false;
  private disposed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  /** From `initialize`: which Codex this is. */
  userAgent?: string;

  constructor(
    connector: CodexConnector | (() => string),
    private readonly log: (message: string) => void = () => undefined,
    spawnProcess: typeof spawn = spawn,
  ) {
    this.connector = typeof connector === 'function' ? stdioConnector(connector, log, spawnProcess) : connector;
  }

  get kind(): 'stdio' | 'host' { return this.connector.kind; }
  /** The server process this is connected to, or was last. */
  get instance(): string | undefined { return this.instanceId; }
  get connected(): boolean { return this.ready; }

  onNotification = (listener: (event: RpcNotification) => void): Disposable => this.notifications.event(listener);
  onRequest = (listener: (event: RpcServerRequest) => void): Disposable => this.requests.event(listener);
  /** A connection after the first is up and initialized. */
  onReconnect = (listener: (event: ReconnectEvent) => void): Disposable => this.reconnects.event(listener);
  /** The connection went away (the server may or may not have). */
  onDisconnect = (listener: (reason: string) => void): Disposable => this.disconnects.event(listener);

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.disposed) throw new Error('Codex App Server disposed');
    if (this.starting) return this.starting;
    this.starting = this.startInner();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async startInner(): Promise<void> {
    const { transport, instance } = await this.connector.connect();
    if (this.disposed) {
      transport.close();
      throw new Error('Codex App Server disposed');
    }
    this.transport = transport;
    transport.onMessage((text) => this.receive(text));
    transport.onClose((reason) => this.onClosed(transport, reason));
    let result: any;
    try {
      result = await this.call('initialize', {
        clientInfo: { name: 'agent-wrangler', title: 'Agent Wrangler', version: '0.0.1' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify('initialized', {});
    } catch (error) {
      if (this.transport === transport) {
        this.transport = undefined;
        transport.close();
      }
      throw error;
    }
    this.userAgent = typeof result?.userAgent === 'string' ? result.userAgent : undefined;
    try { this.connector.initialized?.(result); } catch (error) { this.log(`codex: recording the server version failed: ${String(error)}`); }
    const previous = this.instanceId;
    this.instanceId = instance;
    this.ready = true;
    this.reconnectAttempt = 0;
    if (this.connectedOnce) {
      const restarted = previous !== instance;
      this.log(`codex app-server: reconnected (${restarted ? 'a new server' : 'same server'})`);
      this.reconnects.fire({ instance, restarted });
    }
    this.connectedOnce = true;
  }

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.ready) await this.start();
    return this.call<T>(method, params);
  }

  private call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.write({ method, id, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.transport) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    this.write(error ? { id, error } : { id, result: result ?? {} });
  }

  private write(message: unknown): void {
    if (!this.transport) throw new Error('Codex App Server is not connected');
    this.transport.send(JSON.stringify(message));
  }

  private receive(text: string): void {
    let message: any;
    try { message = JSON.parse(text); } catch {
      this.log(`codex app-server sent invalid JSON: ${text.slice(0, 200)}`);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.requests.fire(message as RpcServerRequest);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex App Server request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') this.notifications.fire(message as RpcNotification);
  }

  private onClosed(transport: CodexTransport, reason: string): void {
    if (this.transport !== transport) return;
    this.transport = undefined;
    const wasReady = this.ready;
    this.ready = false;
    const error = new Error(reason);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.disposed) return;
    if (wasReady) {
      this.log(`codex app-server: connection lost (${reason})`);
      this.disconnects.fire(reason);
    }
    if (this.connector.persistent) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed || this.ready) return;
      this.start().catch((error) => {
        this.log(`codex app-server: reconnect failed (${String(error)})`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Stop talking to the server. A stdio child is killed with it; a host server keeps running. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const transport = this.transport;
    this.transport = undefined;
    this.ready = false;
    transport?.close();
    const error = new Error('Codex App Server disposed');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.notifications.dispose();
    this.requests.dispose();
    this.reconnects.dispose();
    this.disconnects.dispose();
  }
}
