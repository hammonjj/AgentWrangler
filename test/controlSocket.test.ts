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
  RPC_NOT_FOUND,
  RPC_PROTOCOL_MISMATCH,
  RPC_UNAUTHORIZED,
  RPC_UNSUPPORTED,
  type ControlSession,
  type ControlSessionsResult,
  type ControlSubscribeResult,
  type ControlTaskView,
  type ControlTasksResult,
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

const taskView: ControlTaskView = {
  missionId: 'm1',
  title: 'Fix the parser',
  state: 'route proposed — waiting for you',
  repoRoot: '/Users/test/proj',
  createdAt: 0,
};

function fakeBackend() {
  const calls: string[] = [];
  const origins: unknown[] = [];
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
    rename: (ref, name) => {
      calls.push(`rename ${ref} ${name}`);
      return { title: name || 'Own title' };
    },
    projects: () => [],
    proposeTask: async (p) => {
      origins.push(p.origin);
      calls.push(`propose ${p.folder} ${p.objective} [${(p.acceptanceCriteria ?? []).join('|')}] ${p.harness ?? '-'}`);
      if (p.objective === 'off') throw new ControlError(RPC_UNSUPPORTED, 'Tasks are off.');
      return { task: { ...taskView }, verdict: 'route', route: 'Sonnet · medium' };
    },
    delegate: async (p) => {
      origins.push(p.origin);
      calls.push(`delegate ${p.folder} ${p.objective} [${(p.acceptanceCriteria ?? []).join('|')}] ${p.harness ?? '-'}`);
      return { task: { ...taskView }, decision: 'multiple', tasks: [{ key: 't1', title: 'One' }, { key: 't2', title: 'Two' }] };
    },
    tasks: () => [taskView],
    proposeAgentMemory: (p) => {
      calls.push(`agent.propose ${p.origin.provider}:${p.origin.sessionId} ${p.op} ${p.kind ?? '-'} ${p.text ?? p.itemId ?? ''}`);
      if (p.origin.sessionId === 'stranger') throw new ControlError(RPC_UNSUPPORTED, 'This conversation does not belong to a durable agent.');
      return { agent: 'PO', proposalId: 'p-00000001' };
    },
    webLink: () => {
      calls.push('webLink');
      return { url: 'http://127.0.0.1:1/login?code=synthetic', expiresAt: 1 };
    },
    webPair: () => {
      calls.push('webPair');
      return { url: 'https://test-mac.local:1/pair?code=ABCD2345', code: 'ABCD2345', expiresAt: 1 };
    },
    webDevices: () => [{ id: 'device-synthetic-1', name: 'Safari on iOS', scope: 'lan', createdAt: 1, lastSeen: 1 }],
    webRevoke: (id) => {
      calls.push(`webRevoke ${id}`);
      return { device: { id: 'device-synthetic-1', name: 'Safari on iOS', scope: 'lan', createdAt: 1, lastSeen: 1 } };
    },
    missions: (p) => {
      calls.push(`missions all=${p.all} mine=${p.mine}`);
      origins.push(p.origin);
      return { missions: [] };
    },
    mission: (p) => {
      calls.push(`mission ${p.ref}`);
      throw new ControlError(RPC_NOT_FOUND, `no mission matches "${p.ref}"`);
    },
    missionAct: async (p) => {
      calls.push(`missionAct ${p.act} ${p.ref} ${p.how ?? '-'} ${p.task ?? '-'}`);
      origins.push(p.origin);
      return { outcome: 'requested', message: 'Asked the user.' };
    },
  };
  return { backend, calls, origins, emit: (e: SessionViewEvent) => emit?.(e), close: (r: 'ended') => close?.(r), disposed: () => disposed };
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

  it('proposes a task, validates it, logs the repository but never the objective, and lists tasks (#80)', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const r = await client.request('task.propose', {
      folder: '/Users/test/proj',
      objective: 'secret objective',
      acceptanceCriteria: [' a ', '', 'b'],
      harness: 'codex',
    });
    expect(r).toEqual({ task: taskView, verdict: 'route', route: 'Sonnet · medium' });
    expect(fake.calls).toEqual(['propose /Users/test/proj secret objective [a|b] codex']);
    expect(logs).toEqual([`control socket: task.propose proj by aw pid ${process.pid}`]);
    expect(logs.join('\n')).not.toContain('secret');
    expect((await client.request<ControlTasksResult>('tasks')).tasks).toEqual([taskView]);

    expect(await codeOf(client.request('task.propose', { folder: 'relative/dir', objective: 'x' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('task.propose', { folder: '/Users/test/proj', objective: '  ' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('task.propose', { folder: '/Users/test/proj', objective: 'x'.repeat(20_001) }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('task.propose', { folder: '/Users/test/proj', objective: 'x', acceptanceCriteria: 'a; b' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('task.propose', { folder: '/Users/test/proj', objective: 'x', harness: 'gpt' }))).toBe(RPC_INVALID_PARAMS);
    // The origin only decides where the card shows: a malformed one is dropped, not refused (#81).
    await client.request('task.propose', { folder: '/Users/test/proj', objective: 'o', origin: { provider: 'claude', sessionId: 'abcd-1234' } });
    await client.request('task.propose', { folder: '/Users/test/proj', objective: 'o', origin: { provider: 'claude', sessionId: '../../etc' } });
    expect(fake.origins.slice(-2)).toEqual([{ provider: 'claude', sessionId: 'abcd-1234' }, undefined]);
    const off = await client.request('task.propose', { folder: '/Users/test/proj', objective: 'off' }).catch((e: RpcRemoteError) => e);
    expect((off as RpcRemoteError).code).toBe(RPC_UNSUPPORTED);
    expect((off as RpcRemoteError).message).toBe('Tasks are off.');

    // A proposal is a change: refused once the app is quitting, like send and stop.
    server!.stopMutations();
    expect(await codeOf(client.request('task.propose', { folder: '/Users/test/proj', objective: 'x' }))).toBe(RPC_UNSUPPORTED);
    expect((await client.request<ControlTasksResult>('tasks')).tasks).toEqual([taskView]);
    client.close();
  });

  it('takes a memory proposal from an agent conversation, logs it without its text, and is a change (#180)', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const origin = { provider: 'claude', sessionId: 'abcd-1234' };
    expect(await client.request('agent.propose', { origin, op: 'add', kind: 'decision', text: 'secret note' })).toEqual({ agent: 'PO', proposalId: 'p-00000001' });
    await client.request('agent.propose', { origin, op: 'forget', itemId: 'm-1a2b3c4d' });
    expect(fake.calls).toEqual(['agent.propose claude:abcd-1234 add decision secret note', 'agent.propose claude:abcd-1234 forget - m-1a2b3c4d']);
    expect(logs).toEqual([`control socket: agent.propose memory add by aw pid ${process.pid}`, `control socket: agent.propose memory forget by aw pid ${process.pid}`]);
    expect(logs.join('\n')).not.toContain('secret');

    // No origin, a malformed one, or an op it does not know: refused, since the origin is which agent's card it is.
    expect(await codeOf(client.request('agent.propose', { op: 'add', text: 'x' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('agent.propose', { origin: { provider: 'claude', sessionId: '../../etc' }, op: 'add', text: 'x' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('agent.propose', { origin, op: 'write', text: 'x' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('agent.propose', { origin, op: 'add', text: 'x'.repeat(2001) }))).toBe(RPC_INVALID_PARAMS);
    const stranger = await client.request('agent.propose', { origin: { provider: 'claude', sessionId: 'stranger' }, op: 'add', text: 'x' }).catch((e: RpcRemoteError) => e);
    expect((stranger as RpcRemoteError).code).toBe(RPC_UNSUPPORTED);

    server!.stopMutations();
    expect(await codeOf(client.request('agent.propose', { origin, op: 'add', text: 'x' }))).toBe(RPC_UNSUPPORTED);
    client.close();
  });

  it('delegates with the same checked params, logs the repository but never the objective, and is a change (#82)', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const r = await client.request('delegate', {
      folder: '/Users/test/proj',
      objective: 'secret outcome',
      acceptanceCriteria: [' a ', 'b'],
      origin: { provider: 'codex', sessionId: 'thread-1234' },
    });
    expect(r).toEqual({ task: taskView, decision: 'multiple', tasks: [{ key: 't1', title: 'One' }, { key: 't2', title: 'Two' }] });
    expect(fake.calls).toEqual(['delegate /Users/test/proj secret outcome [a|b] -']);
    expect(fake.origins).toEqual([{ provider: 'codex', sessionId: 'thread-1234' }]);
    expect(logs).toEqual([`control socket: delegate proj by aw pid ${process.pid}`]);
    expect(await codeOf(client.request('delegate', { folder: 'relative/dir', objective: 'x' }))).toBe(RPC_INVALID_PARAMS);
    server!.stopMutations();
    expect(await codeOf(client.request('delegate', { folder: '/Users/test/proj', objective: 'x' }))).toBe(RPC_UNSUPPORTED);
    client.close();
  });

  it('rename reaches the backend, logs the session and never the name, and is refused while quitting', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    expect(await client.request('rename', { ref: 'claude:abcd1234', name: 'Issue #7: Fix tray' })).toEqual({ title: 'Issue #7: Fix tray' });
    expect(await client.request('rename', { ref: 'claude:abcd1234', name: '' })).toEqual({ title: 'Own title' });
    expect(await codeOf(client.request('rename', { ref: 'claude:abcd1234' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('rename', { name: 'x' }))).toBe(RPC_INVALID_PARAMS);
    expect(fake.calls).toEqual(['rename claude:abcd1234 Issue #7: Fix tray', 'rename claude:abcd1234 ']);
    expect(logs.join('\n')).not.toContain('Fix tray');
    server!.stopMutations();
    expect(await codeOf(client.request('rename', { ref: 'claude:abcd1234', name: 'x' }))).toBe(RPC_UNSUPPORTED);
    client.close();
  });

  it('missions and mission are reads; mission.act needs an origin and a well-formed act, and is logged by act and ref only', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const origin = { provider: 'claude', sessionId: 'synthetic-session-1' };
    expect(await client.request('missions', { all: true, origin })).toEqual({ missions: [] });
    expect(await codeOf(client.request('mission', { ref: 'ABCD' }))).toBe(RPC_NOT_FOUND);
    // Without an origin there is no agent to act as.
    expect(await codeOf(client.request('mission.act', { ref: 'ABCD', act: 'cancel' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('mission.act', { origin, ref: 'ABCD', act: 'merge' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('mission.act', { origin, ref: 'ABCD', act: 'finish' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('mission.act', { origin, ref: 'ABCD', act: 'finish', how: 'force-push' }))).toBe(RPC_INVALID_PARAMS);
    expect(await codeOf(client.request('mission.act', { origin, ref: 'ABCD', act: 'cancel', how: 'keep' }))).toBe(RPC_INVALID_PARAMS);
    const r = await client.request<{ outcome: string }>('mission.act', { origin, ref: 'ABCD', act: 'finish', how: 'merge-local' });
    expect(r.outcome).toBe('requested');
    expect(fake.calls).toEqual(['missions all=true mine=false', 'mission ABCD', 'missionAct finish ABCD merge-local -']);
    expect(fake.origins).toEqual([origin, origin]);
    expect(logs).toContain(`control socket: mission.act finish ABCD by aw pid ${process.pid}`);
    expect(logs.join('\n')).not.toContain('synthetic-session-1');
    server!.stopMutations();
    expect(await codeOf(client.request('mission.act', { origin, ref: 'ABCD', act: 'cancel' }))).toBe(RPC_UNSUPPORTED);
    client.close();
  });

  it('web.link returns the sign-in link and logs the call, never the link (#127)', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const r = await client.request<{ url: string; expiresAt: number }>('web.link');
    expect(r.url).toContain('/login?code=');
    expect(fake.calls).toEqual(['webLink']);
    expect(logs).toEqual([`control socket: web.link by aw pid ${process.pid}`]);
    client.close();
  });

  it('web.pair, web.devices and web.devices.revoke reach the backend; the code is never logged (#137)', async () => {
    const fake = fakeBackend();
    await serve(fake.backend);
    const client = (await ControlClient.connect(dirs, { build: 'test' }))!;
    const pair = await client.request<{ url: string; code: string }>('web.pair');
    expect(pair.code).toBe('ABCD2345');
    const list = await client.request<{ devices: { id: string }[] }>('web.devices');
    expect(list.devices.map((d) => d.id)).toEqual(['device-synthetic-1']);
    await client.request('web.devices.revoke', { id: ' devi ' });
    expect(await codeOf(client.request('web.devices.revoke', {}))).toBe(RPC_INVALID_PARAMS);
    expect(fake.calls).toEqual(['webPair', 'webRevoke devi']);
    expect(logs.join('\n')).not.toContain('ABCD2345');
    expect(logs).toEqual([`control socket: web.pair by aw pid ${process.pid}`, `control socket: web.devices.revoke  devi  by aw pid ${process.pid}`]);
    server!.stopMutations();
    expect(await codeOf(client.request('web.pair'))).toBe(RPC_UNSUPPORTED);
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
