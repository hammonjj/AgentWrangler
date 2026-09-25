/**
 * The CLI's side of the control socket: connect, present the token, then ask.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { NdjsonPeer, type IncomingNotification } from '../core/rpc/ndjsonPeer';
import { controlSocketPath, controlTokenPath, type RunDirs } from '../core/control/paths';
import { CONTROL_PROTOCOL_VERSION, type ControlHelloParams, type ControlHelloResult } from '../core/control/protocol';

/** A request gets this long before the CLI gives up on the app. */
const REQUEST_TIMEOUT_MS = 30_000;

export class ControlClient {
  private constructor(
    private readonly socket: net.Socket,
    private readonly peer: NdjsonPeer,
    readonly hello: ControlHelloResult,
  ) {}

  /**
   * Connect to the running app. `undefined` means it is not running (no
   * token, no socket, or nothing listening on it); anything else wrong throws.
   */
  static async connect(dirs: RunDirs, client: { build: string }): Promise<ControlClient | undefined> {
    let token: string;
    try {
      token = fs.readFileSync(controlTokenPath(dirs), 'utf8').trim();
    } catch {
      return undefined;
    }
    const socketPath = controlSocketPath(dirs);
    const socket = await new Promise<net.Socket | undefined>((resolve, reject) => {
      const s = net.connect(socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', (err: NodeJS.ErrnoException) => {
        // A socket file left by a crash refuses; something else in its place is not a socket.
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'ENOTSOCK') resolve(undefined);
        else reject(err);
      });
    });
    if (!socket) return undefined;
    const peer = new NdjsonPeer({ write: (line) => socket.write(line), jsonrpc: true });
    socket.on('data', (chunk: Buffer) => peer.feed(chunk));
    socket.on('close', () => peer.close(new Error('Agent Wrangler closed the connection')));
    socket.on('error', () => undefined);
    const params: ControlHelloParams = {
      client: { name: 'aw', build: client.build, pid: process.pid },
      protocol: { min: CONTROL_PROTOCOL_VERSION, max: CONTROL_PROTOCOL_VERSION },
      token,
    };
    try {
      const hello = await peer.request<ControlHelloResult>('hello', params, { timeoutMs: REQUEST_TIMEOUT_MS });
      return new ControlClient(socket, peer, hello);
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  request<T>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.peer.request<T>(method, params, { timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS });
  }

  onNotification(listener: (n: IncomingNotification) => void): void {
    this.peer.onNotification(listener);
  }

  onClose(listener: () => void): void {
    this.socket.on('close', listener);
  }

  close(): void {
    this.peer.dispose();
    this.socket.end();
  }
}
