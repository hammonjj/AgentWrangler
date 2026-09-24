// Spike S4 (#8): a minimal JSON-RPC client for `codex app-server`, over any of the three
// transports the spike compares:
//   - a Unix socket that `app-server --listen unix://PATH` serves  (option a)
//   - `codex app-server proxy [--sock PATH]` as a stdio child       (option b; still WebSocket)
//   - a plain `app-server --stdio` child                            (today's AW)
// Every frame in and out is logged with a timestamp, so a scenario can be replayed from the
// log. Nothing is auto-answered: the scenario decides what to do with server requests.

import type * as net from 'node:net';
import * as fs from 'node:fs';
import { connectUnixSocket, websocketOver } from './wsUnix.ts';
import * as readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface Frame { id?: number | string; method?: string; params?: any; result?: any; error?: any }

export type Transport =
  | { kind: 'unix'; path: string }
  | { kind: 'proxy'; binary: string; sock?: string; env: NodeJS.ProcessEnv }
  | { kind: 'stdio'; binary: string; env: NodeJS.ProcessEnv; args?: string[] };

export class Rpc {
  readonly frames: Array<{ at: number; dir: 'in' | 'out'; frame: Frame }> = [];
  private nextId = 1;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private waiters: Array<{ test(f: Frame): boolean; resolve(f: Frame): void }> = [];
  private out?: Writable;
  private sendText?: (text: string) => void;
  private socket?: net.Socket;
  child?: ChildProcess;
  closed = false;
  closeReason = '';

  readonly name: string;
  private readonly logPath: string;

  constructor(name: string, logPath: string) {
    this.name = name;
    this.logPath = logPath;
  }

  async connect(transport: Transport): Promise<void> {
    let input: Readable;
    if (transport.kind === 'unix') {
      // The listener speaks WebSocket over the Unix socket (see wsUnix.ts), not NDJSON.
      const socket = await connectUnixSocket(transport.path);
      socket.on('error', (e) => this.onClose(`socket error ${e.message}`));
      socket.on('close', () => this.onClose('socket closed'));
      this.socket = socket;
      const link = await websocketOver(socket, socket);
      this.sendText = link.send;
      input = link.lines;
    } else {
      const args = transport.kind === 'proxy'
        ? ['app-server', 'proxy', ...(transport.sock ? ['--sock', transport.sock] : [])]
        : (transport.args ?? ['app-server', '--stdio']);
      const child = spawn(transport.binary, args, { env: transport.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d) => this.note(`stderr: ${String(d).trim().slice(0, 500)}`));
      child.on('exit', (code, signal) => this.onClose(`child exit ${code ?? signal}`));
      this.child = child;
      if (transport.kind === 'proxy') {
        // `proxy` is a byte pipe to the control socket, so WebSocket runs over its stdio.
        const link = await websocketOver(child.stdout!, child.stdin!);
        this.sendText = link.send;
        input = link.lines;
      } else {
        this.out = child.stdin!;
        input = child.stdout!;
      }
    }
    readline.createInterface({ input }).on('line', (line) => this.receive(line));
  }

  note(text: string): void {
    fs.appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), client: this.name, note: text })}\n`);
  }

  private record(dir: 'in' | 'out', frame: Frame): void {
    this.frames.push({ at: Date.now(), dir, frame });
    fs.appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), client: this.name, dir, frame })}\n`);
  }

  private receive(line: string): void {
    let frame: Frame;
    try { frame = JSON.parse(line); } catch { this.note(`non-JSON line: ${line.slice(0, 200)}`); return; }
    this.record('in', frame);
    if (frame.id !== undefined && !frame.method) {
      const p = this.pending.get(Number(frame.id));
      if (p) {
        this.pending.delete(Number(frame.id));
        if (frame.error) p.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
        else p.resolve(frame.result);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.test(frame)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.note(`closed: ${reason}`);
    for (const p of this.pending.values()) p.reject(new Error(`closed: ${reason}`));
    this.pending.clear();
  }

  private write(frame: Frame): void {
    this.record('out', frame);
    if (this.sendText) this.sendText(JSON.stringify(frame));
    else this.out!.write(`${JSON.stringify(frame)}\n`);
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: number | string, result: unknown): void { this.write({ id, result }); }

  waitFor(test: (f: Frame) => boolean, timeoutMs = 30000, label = 'frame'): Promise<Frame> {
    const seen = this.frames.find((entry) => entry.dir === 'in' && test(entry.frame));
    if (seen) return Promise.resolve(seen.frame);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({ test, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  }

  /** Frames that arrived after `since`, for "did X show up on the new connection?" checks. */
  inbound(since = 0): Frame[] { return this.frames.filter((e) => e.dir === 'in' && e.at >= since).map((e) => e.frame); }

  async initialize(clientName = 'aw-spike-s4'): Promise<any> {
    const result = await this.request('initialize', {
      clientInfo: { name: clientName, title: 'AW spike S4', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
    return result;
  }

  /** Drop the connection abruptly, the way an app quit or crash would. */
  drop(): void {
    if (this.socket) this.socket.destroy();
    if (this.child) this.child.kill('SIGKILL');
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
