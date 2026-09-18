import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { Emitter, type Disposable } from '../core/events';
import { resolveCodexBinary } from './binary';

export interface RpcNotification { method: string; params?: any }
export interface RpcServerRequest extends RpcNotification { id: string | number }

export class CodexAppServer implements Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
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
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => this.log(`codex app-server: ${String(data).trim()}`));
    // A missing/misconfigured binary reports through ChildProcess's `error`
    // event rather than `exit`. Always consume it so monitoring can continue
    // even when interactive Codex support is unavailable.
    child.on('error', (error) => this.onExit(error));
    child.on('exit', (code, signal) => this.onExit(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`)));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.receive(line));
    await this.request('initialize', {
      clientInfo: { name: 'agent-wrangler', title: 'Agent Wrangler', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
  }

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.child) {
      await this.start();
      if (!this.child) throw new Error('Codex App Server did not start');
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ method, id, ...(params === undefined ? {} : { params }) });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    this.write(error ? { id, error } : { id, result: result ?? {} });
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch {
      this.log(`codex app-server sent invalid JSON: ${line.slice(0, 200)}`);
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

  private onExit(error: Error): void {
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  dispose(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.onExit(new Error('Codex App Server disposed'));
    this.notifications.dispose();
    this.requests.dispose();
  }
}
