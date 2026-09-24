import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Emitter, type Disposable } from '../core/events';
import { NdjsonPeer } from '../core/rpc/ndjsonPeer';
import { resolveCodexBinary } from './binary';

export interface RpcNotification { method: string; params?: any }
export interface RpcServerRequest extends RpcNotification { id: string | number }

/**
 * Codex's `app-server --stdio`: one child, NDJSON JSON-RPC on its pipes, every
 * AW-run Codex thread multiplexed over it. Execution and transport only;
 * translating a thread's traffic into a conversation is `CodexRunner`'s job.
 */
export class CodexAppServer implements Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private peer?: NdjsonPeer;
  private notifications = new Emitter<RpcNotification>();
  private requests = new Emitter<RpcServerRequest>();
  private starting?: Promise<void>;

  constructor(
    private readonly binary: () => string,
    private readonly log: (message: string) => void = () => undefined,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  onNotification = (listener: (event: RpcNotification) => void): Disposable => this.notifications.event(listener);
  onRequest = (listener: (event: RpcServerRequest) => void): Disposable => this.requests.event(listener);

  async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async startInner(): Promise<void> {
    const child = this.spawnProcess(resolveCodexBinary(this.binary()), ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const peer = new NdjsonPeer({
      write: (line) => {
        if (!child.stdin.writable) throw new Error('Codex App Server is not connected');
        child.stdin.write(line);
      },
      log: (message) => this.log(`codex app-server sent ${message}`),
      // Our own child: its lines were never capped before, and a large tool result must not be dropped.
      maxLineBytes: Number.POSITIVE_INFINITY,
    });
    this.peer = peer;
    peer.onNotification((n) => this.notifications.fire(n));
    peer.onRequest((r) => this.requests.fire(r));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => this.log(`codex app-server: ${String(data).trim()}`));
    // A missing/misconfigured binary reports through ChildProcess's `error`
    // event rather than `exit`. Always consume it so monitoring can continue
    // even when interactive Codex support is unavailable.
    child.on('error', (error) => this.onExit(child, error));
    child.on('exit', (code, signal) => this.onExit(child, new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`)));
    child.stdout.on('data', (chunk: Buffer) => peer.feed(chunk));
    await peer.request('initialize', {
      clientInfo: { name: 'agent-wrangler', title: 'Agent Wrangler', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    peer.notify('initialized', {});
  }

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.child) {
      await this.start();
      if (!this.child) throw new Error('Codex App Server did not start');
    }
    const peer = this.peer;
    if (!peer) throw new Error('Codex App Server is not connected');
    return peer.request<T>(method, params);
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) return;
    this.peer?.notify(method, params);
  }

  respond(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    const peer = this.peer;
    if (!peer) throw new Error('Codex App Server is not connected');
    if (error) peer.respondError(id, error);
    else peer.respond(id, result);
  }

  private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child && this.child !== undefined) return;
    this.child = undefined;
    this.peer?.close(error);
    this.peer = undefined;
  }

  dispose(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.peer?.close(new Error('Codex App Server disposed'));
    this.peer = undefined;
    this.notifications.dispose();
    this.requests.dispose();
  }
}
