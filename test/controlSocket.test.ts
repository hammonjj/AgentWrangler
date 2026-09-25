import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlClient } from '../src/cli/client';
import { controlSocketPath, controlTokenPath, type RunDirs } from '../src/core/control/paths';
import {
  RPC_AMBIGUOUS,
  RPC_INVALID_PARAMS,
  RPC_PROTOCOL_MISMATCH,
  RPC_UNAUTHORIZED,
  RPC_UNSUPPORTED,
  type ControlSession,
  type ControlSessionsResult,
  type ControlSubscribeResult,
} from '../src/core/control/protocol';
import { ControlError, ControlServer, writeControlToken, type ControlBackend } from '../src/core/control/server';
import { NdjsonPeer, RpcRemoteError, type IncomingNotification } from '../src/core/rpc/ndjsonPeer';
import type { SessionViewEvent } from '../src/core/session/sessionHandle';

const row: ControlSession = {
  key: 'claude:1a2b3c4d',
  sessionId: '1a2b3c4d',
  title: 'A session',
  provider: 'claude',
  status: 'busy',
  cwd: '/Users/test/proj',
  lastActivityAt: 0,
  archived: false,
  runBy: 'hosted',
};

function fakeBackend() {
  const calls: string[] = [];
  let emit: ((e: SessionViewEvent) => void) | undefined;
  let close: ((reason: 'ended' | 'gone' | 'overflow') => void) | undefined;
  let disposed = 0;
  const backend: ControlBackend = {
    describe: () => ({ build: 'test', appPid: 1, startedAt: 0 }),
    status: () => ({ build: 'test', appPid: 1, startedAt: 0, byStatus: { busy: 1 }, running: { hosted: 1, app: 0 } }),
    sessions: ({ all }) => {
      calls.push(`sessions all=${all}`);
      return [row];
    },
    session: (ref) => {
      if (ref === 'amb') throw new ControlError(RPC_AMBIGUOUS, 'two', { matches: [row, row] });
      return { session: row };
    },
    subscribe: (ref, maxBlocks, onEvent, onClosed) => {
      calls.push(`subscribe ${ref} ${maxBlocks}`);
      emit = onEvent;
      close = onClosed;
      return { result: { key: row.key, lifecycle: 'running', blocks: [], truncated: false }, dispose: () => disposed++ };
    },
    send: async (ref, text) => {
      calls.push(`send ${ref} ${text}`);
      return { outcome: 'applied' };
    },
    stop: async (ref, force) => {
      calls.push(`stop ${ref} ${force}`);
      return 'working';
    },
    projects: () => [],
  };
  return { backend, calls, emit: (e: SessionViewEvent) => emit?.(e), close: (r: 'ended') => close?.(r), disposed: () => disposed };
}

let dir: string;
let dirs: RunDirs;
let server: ControlServer | undefined;
const logs: string[] = [];

beforeEach(() => {
  // Short: the socket path must stay under macOS's 104 bytes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awc-'));
  dirs = { runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb') };
  logs.length = 0;
});

afterEach(() => {
  server?.dispose();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(backend: ControlBackend, opts: { maxBufferedBytes?: number } = {}) {
  const token = writeControlToken(controlTokenPath(dirs));
  server = new ControlServer({ backend, token, log: (m) => logs.push(m), ...opts });
  await server.listen(controlSocketPath(dirs));
  return token;
}

/** A raw connection, for what the real client would never send. */
async function raw(): Promise<{ peer: NdjsonPeer; socket: net.Socket }> {
  const socket = net.connect(controlSocketPath(dirs));
  await new Promise((r) => socket.once('connect', r));
  const peer = new NdjsonPeer({ write: (l) => socket.write(l), jsonrpc: true });
  socket.on('data', (c: Buffer) => peer.feed(c));
  return { peer, socket };
}

const codeOf = (p: Promise<unknown>) => p.then(() => undefined, (e: RpcRemoteError) => e.code);

describe('control socket', () => {
  it('keeps the token and socket private', async () => {
    await serve(fakeBackend().backend);
    expect(fs.statSync(controlTokenPath(dirs)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirs.runDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(controlSocketPath(dirs)).mode & 0o777).toBe(0o600);
  });

  it('refuses everything before hello, and a hello with the wrong token or protocol', async () => {
    const token = await serve(fakeBackend().backend);
    const { peer, socket } = await raw();
    expect(await codeOf(peer.request('sessions', {}))).toBe(RPC_UNAUTHORIZED);
    expect(await codeOf(peer.request('hello', { token: 'nope', protocol: { min: 1, max: 1 }, client: { name: 't', build: 'x', pid: 1 } }))).toBe(RPC_UNAUTHORIZED);
    expect(await codeOf(peer.request('hello', { token, protocol: { min: 2, max: 3 }, client: { name: 't', build: 'x', pid: 1 } }))).toBe(RPC_PROTOCOL_MISMATCH);
    expect(await codeOf(peer.request('sessions', {}))).toBe(RPC_UNAUTHORIZED);
    expect(logs).toContain('control socket: refused a client with the wrong token');
    socket.destroy();
  });

  it('answers the client, validates params, and passes errors through with their data', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    expect(client.hello).toEqual({ build: 'test', appPid: 1, startedAt: 0, protocol: 1, capabilities: [] });
    expect((await client.request<ControlSessionsResult>('sessions', { all: true })).sessions).toEqual([row]);
    expect(await client.request('send', { ref: '1a2b', text: 'hi' })).toEqual({ outcome: 'applied' });
    expect(await client.request('stop', { ref: '1a2b' })).toEqual({ outcome: 'working' });
    expect(fake.calls).toEqual(['sessions all=true', 'send 1a2b hi', 'stop 1a2b false']);
    // Mutations are logged with the session and the client, never the content.
    expect(logs).toEqual([`control socket: send 1a2b by aw pid ${process.pid}`, `control socket: stop 1a2b by aw pid ${process.pid}`]);
    expect(await codeOf(client.request('send', { ref: '1a2b', text: '  ' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('session', {}))).toBe(RPC_INVALID_PARAMS);
    const amb = await client.request('session', { ref: 'amb' }).catch((e: RpcRemoteError) => e);
    expect(amb).toBeInstanceOf(RpcRemoteError);
    expect((amb as RpcRemoteError).code).toBe(RPC_AMBIGUOUS);
    expect((amb as RpcRemoteError).data).toEqual({ matches: [row, row] });
    client.close();
  });

  it('streams a subscription, ends it, and cleans up when the client goes', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const got: IncomingNotification[] = [];
    client.onNotification((n) => got.push(n));
    expect(await client.request<ControlSubscribeResult>('subscribe', { ref: '1a2b', maxBlocks: 9999 })).toEqual({
      key: row.key,
      lifecycle: 'running',
      blocks: [],
      truncated: false,
    });
    // maxBlocks is capped; the default applies when it is absent.
    expect(fake.calls).toEqual(['subscribe 1a2b 200']);
    fake.emit({ seq: 5, type: 'lifecycle', lifecycle: 'idle' });
    fake.close('ended');
    await waitFor(() => got.length === 2);
    expect(got).toEqual([
      { method: 'session.event', params: { key: row.key, event: { seq: 5, type: 'lifecycle', lifecycle: 'idle' } } },
      { method: 'session.closed', params: { key: row.key, reason: 'ended' } },
    ]);
    expect(fake.disposed()).toBe(1);
    // A second subscription, then the client disconnects: disposed too.
    await client.request('subscribe', { ref: '1a2b' });
    expect(fake.calls.at(-1)).toBe('subscribe 1a2b 50');
    client.close();
    await waitFor(() => fake.disposed() === 2);
  });

  it('cuts off a subscriber that stops reading', async () => {
    const fake = fakeBackend();
    await serve(fake.backend, { maxBufferedBytes: 64 * 1024 });
    const token = fs.readFileSync(controlTokenPath(dirs), 'utf8');
    const { peer, socket } = await raw();
    await peer.request('hello', { token, protocol: { min: 1, max: 1 }, client: { name: 't', build: 'x', pid: 1 } });
    await peer.request('subscribe', { ref: '1a2b' });
    socket.pause();
    const block = { kind: 'user', id: 'u', text: 'x'.repeat(64 * 1024) };
    for (let i = 0; i < 200 && fake.disposed() === 0; i++) fake.emit({ seq: i, type: 'append', blocks: [block as never] });
    expect(fake.disposed()).toBe(1);
    socket.destroy();
  });

  it('reports "not running" when there is no token or nothing listening', async () => {
    expect(await ControlClient.connect(dirs, { build: 'test' })).toBeUndefined();
    await serve(fakeBackend().backend);
    server!.dispose();
    server = undefined;
    fs.writeFileSync(controlSocketPath(dirs), '');
    expect(await ControlClient.connect(dirs, { build: 'test' })).toBeUndefined();
  });

  it('refuses send and stop once the app is quitting, but still answers reads', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    server!.stopMutations();
    expect(await codeOf(client.request('send', { ref: '1a2b', text: 'hi' }))).toBe(RPC_UNSUPPORTED);
    expect(await codeOf(client.request('stop', { ref: '1a2b' }))).toBe(RPC_UNSUPPORTED);
    expect((await client.request<ControlSessionsResult>('sessions', {})).sessions).toEqual([row]);
    expect(fake.calls).toEqual(['sessions all=false']);
    client.close();
  });

  it('a second hello with a bad token logs the connection out', async () => {
    const token = await serve(fakeBackend().backend);
    const { peer, socket } = await raw();
    const client = { name: 't', build: 'x', pid: 1 };
    await peer.request('hello', { token, protocol: { min: 1, max: 1 }, client });
    expect(await codeOf(peer.request('hello', { token: 'nope', protocol: { min: 1, max: 1 }, client }))).toBe(RPC_UNAUTHORIZED);
    expect(await codeOf(peer.request('status', {}))).toBe(RPC_UNAUTHORIZED);
    socket.destroy();
  });

  it('writes a fresh token every launch', () => {
    const a = writeControlToken(controlTokenPath(dirs));
    const b = writeControlToken(controlTokenPath(dirs));
    expect(a).not.toBe(b);
    expect(Buffer.from(b, 'base64url')).toHaveLength(32);
  });
});

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
