import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeSdkSession, type QueryFn } from '../src/claude/runner/claudeSdkSession';
import { NdjsonPeer, RpcRemoteError } from '../src/core/rpc/ndjsonPeer';
import { MAX_SOCKET_PATH_BYTES, newHostId } from '../src/core/session/hostSupervisor';
import { classifyOnStartup } from '../src/core/session/recovery';
import type { SessionRecord } from '../src/core/session/sessionRegistry';
import { agentEnv } from '../src/sessionHost/env';
import { OutQueue } from '../src/sessionHost/outQueue';
import { HostServer } from '../src/sessionHost/server';
import { MAX_INLINE_IMAGE_CHARS, slimForWire } from '../src/sessionHost/wire';
import { MAX_PAGE_BYTES, RPC_FORBIDDEN, RPC_RESYNC, type EventsResult, type HostEvent } from '../src/shared/sessionProtocol';

describe('agentEnv', () => {
  it('strips what the host must not pass on to claude, and keeps the rest', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      AW_HOST_ID: 'x',
      __CFBundleIdentifier: 'com.hammonjj.agentwrangler',
      XPC_SERVICE_NAME: 'application.x',
      EMPTY: undefined,
    });
    // AGENTWRANGLER_HOSTED is added: the permission hook reads it (Stage 4).
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/test', AGENTWRANGLER_HOSTED: '1' });
  });
});

describe('slimForWire', () => {
  const big = 'A'.repeat(MAX_INLINE_IMAGE_CHARS + 1);

  it('drops large base64 image data and says how much', () => {
    const msg = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] }] },
    };
    const out = slimForWire(msg) as typeof msg;
    const image = (out.message.content[0].content as { source: { data: string; omittedBytes?: number } }[])[0];
    expect(image.source.data).toBe('');
    expect(image.source.omittedBytes).toBe(big.length);
    // The original is untouched.
    expect((msg.message.content[0].content[0] as { source: { data: string } }).source.data).toBe(big);
  });

  it('returns the very same object when there is nothing to drop', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'image', source: { type: 'base64', data: 'small' } }, { type: 'text', text: 'hi' }] } };
    expect(slimForWire(msg)).toBe(msg);
  });
});

describe('OutQueue', () => {
  function sink() {
    const written: string[] = [];
    let accept = true;
    let drain: (() => void) | undefined;
    return {
      written,
      block: () => (accept = false),
      release: () => {
        accept = true;
        drain?.();
      },
      write(chunk: Buffer) {
        written.push(chunk.toString());
        return accept;
      },
      once(_e: 'drain', l: () => void) {
        drain = l;
      },
    };
  }

  it('writes straight through while the socket keeps up', () => {
    const s = sink();
    const q = new OutQueue(s, 100);
    q.push('a\n', true);
    q.push('b\n', true);
    expect(s.written).toEqual(['a\n', 'b\n']);
    expect(q.idle).toBe(true);
  });

  it('holds events while the socket is full, and drops only events when over budget', () => {
    const s = sink();
    let overflows = 0;
    const q = new OutQueue(s, 10, () => overflows++);
    s.block();
    q.push('first\n', true); // written, then the socket asks us to wait
    q.push('event1\n', true);
    q.push('reply1\n', false);
    q.push('event2-too-big\n', true); // over budget: drops queued events
    expect(overflows).toBe(1);
    s.release();
    expect(s.written).toEqual(['first\n', 'reply1\n']);
  });
});

describe('classifyOnStartup with surviving hosts', () => {
  it('keeps a session live when its host is still running, even if the record said otherwise', () => {
    const rec = (sessionId: string, state: SessionRecord['state']): SessionRecord => ({
      v: 1,
      sessionId,
      provider: 'claude',
      cwd: '/Users/test/proj',
      launch: {},
      state,
      createdAt: 0,
      lastShownAt: 1000,
      updatedAt: 0,
    });
    const { records, interrupted } = classifyOnStartup([rec('Hosted', 'live'), rec('gone', 'live'), rec('odd', 'interrupted')], 2000, new Set(['hosted', 'odd']));
    const state = (id: string) => records.find((r) => r.sessionId === id)?.state;
    expect(state('Hosted')).toBe('live');
    expect(state('odd')).toBe('live');
    expect(state('gone')).toBe('interrupted');
    expect(interrupted.map((r) => r.sessionId)).toEqual(['gone']);
  });
});

describe('newHostId', () => {
  it('is eight base32 characters, keeping socket paths short', () => {
    const id = newHostId();
    expect(id).toMatch(/^[a-z2-7]{8}$/);
    expect(Buffer.byteLength(`/Users/some-long-user/Library/Application Support/Agent Wrangler/run/${id}.sock`)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
  });
});

describe('HostServer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsrv-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A started session whose agent emits `count` messages of `size` characters, then idles. */
  async function session(opts: { ringBytes?: number; count?: number; size?: number } = {}) {
    const query: QueryFn = () => {
      const stream = (async function* () {
        for (let i = 0; i < (opts.count ?? 0); i++) {
          yield { type: 'assistant', uuid: `a${i}`, message: { content: [{ type: 'text', text: 'x'.repeat(opts.size ?? 10) }] } };
        }
        await new Promise<void>(() => undefined);
      })();
      return Object.assign(stream, { interrupt: async () => undefined, close: () => undefined }) as never;
    };
    const s = new ClaudeSdkSession({ cwd: '/Users/test/proj', sessionId: 's1' }, { query, binary: '/b', log: () => undefined, ringBytes: opts.ringBytes });
    s.start();
    await new Promise((r) => setTimeout(r, 20));
    return s;
  }

  async function serve(s: ClaudeSdkSession) {
    const sock = path.join(dir, `${newHostId()}.sock`);
    const server = new HostServer({
      session: s,
      token: 'secret',
      log: () => undefined,
      describe: () => ({ hostId: 'h', hostBuild: 'b', provider: 'claude', sdkVersion: 'x', hostPid: process.pid, cwd: '/Users/test/proj', startedAt: 0, capabilities: [] }),
    });
    await server.listen(sock);
    const client = async (role: 'core' | 'observer' = 'core') => {
      const socket = net.createConnection(sock);
      await new Promise((r) => socket.once('connect', r));
      const events: HostEvent[] = [];
      const peer = new NdjsonPeer({ jsonrpc: true, write: (l) => socket.write(l) });
      peer.onNotification((n) => n.method === 'event' && events.push((n.params as { event: HostEvent }).event));
      socket.on('data', (c: Buffer) => peer.feed(c));
      await peer.request('hello', { client: { role, build: 't', pid: 1 }, protocol: { min: 1, max: 1 }, token: 'secret' });
      return { peer, events, close: () => socket.destroy() };
    };
    return { server, client };
  }

  it('pages held events under the cap, with nextSeq where each page stopped', async () => {
    const s = await session({ count: 60, size: 50_000 });
    const { server, client } = await serve(s);
    const { peer, close } = await client();
    let from = 0;
    let pages = 0;
    const seen: number[] = [];
    for (;;) {
      const page = await peer.request<EventsResult>('events', { fromSeq: from, maxBytes: 10 * MAX_PAGE_BYTES });
      pages++;
      seen.push(...page.events.map((e) => e.seq));
      if (page.done) break;
      expect(page.nextSeq).toBe(page.events[page.events.length - 1].seq);
      from = page.nextSeq;
    }
    expect(seen).toEqual(seen.map((_, i) => i + 1));
    expect(seen.length).toBe(s.snapshot().seq);
    // ~3 MB of events in pages of at most 1 MiB, however large a page was asked for.
    expect(pages).toBeGreaterThanOrEqual(3);
    close();
    await server.close();
  });

  it('answers subscribe from an evicted seq with resync', async () => {
    const s = await session({ ringBytes: 2000, count: 50, size: 100 });
    const { server, client } = await serve(s);
    const { peer, close } = await client();
    await expect(peer.request('subscribe', { fromSeq: 0 })).rejects.toMatchObject({ code: RPC_RESYNC });
    const snap = await peer.request<{ seq: number; ring: { fromSeq: number } }>('snapshot', {});
    await expect(peer.request('subscribe', { fromSeq: snap.ring.fromSeq })).resolves.toEqual({ ok: true });
    close();
    await server.close();
  });

  it('streams events to a subscriber, and forbids an observer from commanding', async () => {
    const s = await session();
    const { server, client } = await serve(s);
    const core = await client('core');
    await core.peer.request('subscribe', { fromSeq: s.snapshot().seq });
    s.send({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(core.events.some((e) => e.type === 'state')).toBe(true);

    const observer = await client('observer');
    await expect(observer.peer.request('send', { message: {} })).rejects.toMatchObject({ code: RPC_FORBIDDEN });
    await expect(observer.peer.request('snapshot', {})).resolves.toMatchObject({ sessionId: 's1' });
    core.close();
    observer.close();
    await server.close();
  });

  it('answers an unknown method with -32601', async () => {
    const { server, client } = await serve(await session());
    const { peer, close } = await client();
    await expect(peer.request('nope', {})).rejects.toBeInstanceOf(RpcRemoteError);
    await expect(peer.request('nope', {})).rejects.toMatchObject({ code: -32601 });
    close();
    await server.close();
  });
});
