import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HostClient } from '../src/core/session/hostClient';
import { autoResumeCandidate } from '../src/core/session/recovery';
import { SessionRegistry, type MementoLike } from '../src/core/session/sessionRegistry';
import {
  MAX_FRAME_BYTES,
  MAX_PAGE_BYTES,
  RPC_FORBIDDEN,
  RPC_METHOD_NOT_FOUND,
  RPC_PROTOCOL_MISMATCH,
  RPC_UNAUTHORIZED,
  type EventsResult,
  type HostEvent,
  type HostSnapshot,
} from '../src/shared/sessionProtocol';
import { HostHarness, alive, argsOf, ppidOf, sessionId, sleep, texts, until, untilAsync, userMessage } from './support/hostHarness';

/**
 * The session lifecycle suite (playbook §16, level I; issue #16): real
 * detached session hosts over real Unix sockets, with the fake agent and its
 * real dummy child in place of `claude`. Each block names the §16 row it
 * covers. The Stage 3 basics (survive a detach, reattach, ask after reattach,
 * token, file modes) are in `sessionHost.integration.test.ts`.
 *
 * The orphan sweep rows are `todo` until Stage 4 (#15) adds the sweep.
 */

const h = new HostHarness();
const coreBundle = path.join(h.root, 'core.js');

beforeAll(async () => {
  await h.build();
  await esbuild.build({
    entryPoints: ['test/support/testCore.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: coreBundle,
    define: { 'import.meta.url': '__aw_import_meta_url' },
    banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
    logLevel: 'silent',
  });
}, 60_000);

afterEach(async () => {
  // Anything still running that the test did not leave on purpose is a leak.
  expect(await h.cleanup()).toEqual([]);
});

afterAll(async () => {
  await h.dispose();
});

function memento(): MementoLike {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: (key: string, value: unknown) => data.set(key, value),
  };
}

const replyTexts = (events: HostEvent[]) =>
  events.flatMap((e) => {
    if (e.type !== 'message') return [];
    const m = e.msg as { type?: string; message?: { content?: { type?: string; text?: string }[] } };
    return m.type === 'assistant' ? (m.message?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text) : [];
  });

/** Seqs, deduplicated, must run without a gap. */
function expectContiguous(seqs: number[]): void {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBe(1);
}

describe('restarts and crashes of the core', () => {
  it('UI closes while the agent is generating: the host keeps going with no client', async () => {
    const id = sessionId(101);
    const view = h.spawn(id);
    await view.send('slow');
    await until(() => view.lifecycle === 'running');
    view.detach();

    await sleep(2500); // the reply lands meanwhile, with nobody connected
    const again = h.adopt(id);
    await until(() => texts(again).includes('echo: slow'));
    await until(() => again.lifecycle === 'idle');
    await again.end();
  }, 30_000);

  it('core SIGKILL mid-turn: the host survives, is reparented, and a new core adopts it', async () => {
    const id = sessionId(102);
    const core = spawn(process.execPath, [coreBundle, JSON.stringify({ root: h.root, runDir: h.runDir, logDir: h.logDir, bundle: h.bundle, sessionId: id, then: 'slow' })], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    h.track(core.pid!);
    await new Promise<void>((resolve, reject) => {
      core.stdout!.on('data', (d: Buffer) => d.toString().includes('READY') && resolve());
      core.once('exit', (code) => reject(new Error(`test core exited early (${code})`)));
    });
    const m = await h.manifestWithAgent(id);
    core.kill('SIGKILL');
    await until(() => !alive(core.pid));

    expect(alive(m.hostPid)).toBe(true);
    expect(alive(m.agentPid)).toBe(true);
    await until(() => ppidOf(m.hostPid) === 1, 5000, 'the host to be reparented to launchd');

    const again = h.adopt(id);
    await until(() => texts(again).includes('echo: slow'), 15_000);
    expect(again.lifecycle === 'idle' || again.lifecycle === 'running').toBe(true);
    await again.end();
    await until(() => !alive(m.hostPid) && !alive(m.agentPid));
  }, 45_000);

  it('double-owner race at startup: a surviving host keeps its session live, never interrupted or resumed twice', async () => {
    const hosted = sessionId(103);
    const gone = sessionId(104);
    const view = h.spawn(hosted);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(hosted);

    // The last run recorded both as live; only one still has a host.
    const store = memento();
    const before = new SessionRegistry(store);
    before.live({ sessionId: gone, provider: 'claude', cwd: '/Users/test/proj' });
    before.live({ sessionId: hosted, provider: 'claude', cwd: h.root });
    view.detach();

    // A new core: manifests first (§7.3 step 1), then classify.
    const sup = h.supervisor();
    const scan = sup.scan();
    const registry = new SessionRegistry(store);
    const startup = registry.startup(new Set(scan.alive.map((x) => x.sessionId!)));
    expect(registry.get(hosted)?.state).toBe('live');
    expect(startup.interrupted.map((r) => r.sessionId)).toEqual([gone]);
    expect(autoResumeCandidate(startup.interrupted, Date.now())?.sessionId).toBe(gone);

    // Adopting it reuses the same host and agent: no second process on the transcript.
    const again = h.adopt(hosted, sup);
    await until(() => again.lifecycle === 'idle');
    const owners = sup.scan().alive.filter((x) => x.sessionId === hosted);
    expect(owners).toHaveLength(1);
    expect(owners[0].agentPid).toBe(m.agentPid);
    expect(alive(m.agentPid)).toBe(true);
    await again.end();
  }, 30_000);

  it('worktree association survives reattach and resume', async () => {
    const id = sessionId(105);
    const wt = path.join(h.root, 'proj-wt');
    fs.mkdirSync(wt, { recursive: true });
    const store = memento();
    new SessionRegistry(store).live({ sessionId: id, provider: 'claude', cwd: wt, repoRoot: '/Users/test/proj', worktree: wt, branchAtStart: 'feat/x' });
    const view = h.spawn(id, { cwd: wt });
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    view.detach();

    // Restart while the host lives: still live, still in its worktree.
    let registry = new SessionRegistry(store);
    registry.startup(new Set(h.supervisor().scan().alive.map((x) => x.sessionId!)));
    expect(registry.get(id)).toMatchObject({ state: 'live', repoRoot: '/Users/test/proj', worktree: wt, branchAtStart: 'feat/x' });
    const again = h.adopt(id);
    const m = h.manifest(id)!;
    expect(m.cwd).toBe(wt);
    await until(() => again.lifecycle === 'idle');
    await again.end();
    await until(() => !alive(m.hostPid));

    // Restart after it stopped: interrupted, still in its worktree.
    registry = new SessionRegistry(store);
    const sup = h.supervisor();
    const scan = sup.scan();
    registry.startup(new Set(scan.alive.map((x) => x.sessionId!)));
    expect(registry.get(id)).toMatchObject({ state: 'interrupted', worktree: wt });
    sup.collect(scan);

    // Resume: a new host in the same worktree, and the record keeps it without being told again.
    const resumed = h.spawn(id, { cwd: wt, resume: true });
    registry.live({ sessionId: id, provider: 'claude', cwd: wt });
    await until(() => h.manifest(id) !== undefined);
    expect(h.manifest(id)).toMatchObject({ cwd: wt, launch: { resume: true } });
    expect(registry.get(id)).toMatchObject({ state: 'live', repoRoot: '/Users/test/proj', worktree: wt });
    await resumed.end();
  }, 45_000);
});

describe('crashes of the host and the agent', () => {
  it('host SIGKILL: the view reports lost; an idle agent exits on EOF; the manifest is kept for the sweep', async () => {
    const id = sessionId(201);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    process.kill(m.hostPid, 'SIGKILL');
    await until(() => view.lifecycle === 'error');
    expect(view.lastExit?.reason).toBe('lost');
    await until(() => !alive(m.agentPid), 5000, 'the idle agent to exit on stdin EOF');

    const sup = h.supervisor();
    const scan = sup.scan();
    const dead = scan.dead.find((x) => x.hostId === m.hostId);
    expect(dead?.exit).toBeUndefined();
    sup.collect(scan);
    expect(fs.existsSync(path.join(h.runDir, `${m.hostId}.json`))).toBe(true);
  }, 30_000);

  it('host SIGKILL mid-turn: the busy agent survives as an orphan of launchd (what the sweep must find)', async () => {
    const id = sessionId(202);
    const view = h.spawn(id);
    await view.send('hold');
    await until(() => view.lifecycle === 'running');
    const m = await h.manifestWithAgent(id);
    await sleep(200);
    process.kill(m.hostPid, 'SIGKILL');
    await until(() => view.lifecycle === 'error');
    await until(() => ppidOf(m.agentPid!) === 1, 5000, 'the agent to be reparented');
    expect(alive(m.agentPid)).toBe(true);
    h.leaveRunning(m.agentPid!); // until the sweep exists (#15), cleanup ends it
    // Its manifest names it, with the start time the sweep's identity check needs.
    expect(h.manifest(id)).toMatchObject({ agentPid: m.agentPid });
    expect(h.manifest(id)?.agentStartTime).toBeTruthy();
  }, 30_000);

  it('agent crash: exit record with code and stderr tail, the view fails, the host drains and exits', async () => {
    const id = sessionId(203);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    await view.send('crash');
    await until(() => view.lifecycle === 'error');
    expect(view.lastExit?.reason).toBe('error');
    await until(() => !alive(m.hostPid), 5000, 'the host to exit once the exit was delivered');
    const exit = h.manifest(id)?.exit;
    expect(exit).toMatchObject({ reason: 'error', code: 3 });
    expect(exit?.stderrTail).toContain('boom');

    const sup = h.supervisor();
    const scan = sup.scan();
    expect(scan.dead.find((x) => x.hostId === m.hostId)?.exit?.reason).toBe('error');
    sup.collect(scan);
    expect(fs.existsSync(path.join(h.runDir, `${m.hostId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(h.runDir, `${m.hostId}.token`))).toBe(false);
  }, 30_000);

  // The orphan sweep (#15) is covered in `sessionHostRecovery.integration.test.ts`
  // (a SIGKILLed host's real orphan swept, then one process on the resumed id)
  // and `orphanSweep.test.ts` (non-launchd owners never swept; stale and reused
  // pids ignored; the sweep resolves only once the orphan has exited, and
  // `RunnerService.resume` awaits it before the history is read).
});

describe('ending agents (§7.1)', () => {
  it('end on a busy turn interrupts first, keeps the in-flight reply, and needs no signal', async () => {
    const id = sessionId(301);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    const c = await h.connect(m);
    await c.request('subscribe', { fromSeq: 0 });
    await c.request('send', { message: userMessage('hold') });
    await sleep(300);
    const t0 = Date.now();
    await c.request('end', { graceMs: 3000 }, 30_000);
    expect(Date.now() - t0).toBeLessThan(2500);
    await until(() => c.replies().includes('interrupted'));
    await until(() => !alive(m.agentPid) && !alive(m.hostPid));
    // Exited on stdin EOF after the turn ended: no SIGTERM was needed.
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'stopped', code: 0 });
    view.detach();
  }, 30_000);

  it('end escalates to SIGTERM when the agent ignores both the interrupt and stdin EOF', async () => {
    const id = sessionId(302);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    const c = await h.connect(m);
    await c.request('send', { message: userMessage('stubborn') });
    await sleep(300);
    const t0 = Date.now();
    await c.request('end', { graceMs: 300 }, 30_000);
    const took = Date.now() - t0;
    // grace (0.3 s) + EOF wait (1 s), then SIGTERM; well before the SIGKILL step.
    expect(took).toBeGreaterThanOrEqual(1200);
    expect(took).toBeLessThan(4000);
    await until(() => !alive(m.agentPid) && !alive(m.hostPid));
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'stopped', signal: 'SIGTERM' });
    view.detach();
  }, 30_000);

  it('host SIGTERM ends a busy agent at once, without waiting for its turn', async () => {
    const id = sessionId(303);
    const view = h.spawn(id);
    await view.send('hold');
    await until(() => view.lifecycle === 'running');
    const m = await h.manifestWithAgent(id);
    view.detach();
    const t0 = Date.now();
    process.kill(m.hostPid, 'SIGTERM');
    await until(() => !alive(m.hostPid) && !alive(m.agentPid), 5000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'signal', hostSignal: 'SIGTERM', signal: 'SIGTERM' });
  }, 30_000);

  it('host SIGTERM on an agent that ignores SIGTERM still leaves no child (SIGKILL)', async () => {
    const id = sessionId(304);
    const view = h.spawn(id);
    await view.send('wedge');
    await until(() => view.lifecycle === 'running');
    const m = await h.manifestWithAgent(id);
    view.detach();
    await sleep(200);
    process.kill(m.hostPid, 'SIGTERM');
    await until(() => !alive(m.hostPid), 12_000, 'the host to exit');
    expect(alive(m.agentPid)).toBe(false);
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'signal', hostSignal: 'SIGTERM' });
  }, 30_000);

  it('end during a pending ask: the interrupt aborts the ask, the card is settled, and it ends promptly', async () => {
    const id = sessionId(305);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = await h.manifestWithAgent(id);
    const c = await h.connect(m);
    await c.request('subscribe', { fromSeq: 0 });
    await c.request('send', { message: userMessage('please ask') });
    await until(() => c.events.some((e) => e.type === 'ask'));
    const t0 = Date.now();
    await c.request('end', { graceMs: 3000 }, 30_000);
    expect(Date.now() - t0).toBeLessThan(2500);
    await until(() => c.events.some((e) => e.type === 'askSettled'));
    await until(() => !alive(m.agentPid) && !alive(m.hostPid));
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'stopped', code: 0 });
    view.detach();
  }, 30_000);

  it('stop all: parallel, bounded, and nothing left: no host, no agent, no socket', async () => {
    const ids = [sessionId(311), sessionId(312), sessionId(313)];
    const views = ids.map((id) => h.spawn(id));
    await Promise.all(views.map((v) => v.send('hi')));
    await until(() => views.every((v) => texts(v).includes('echo: hi')));
    const manifests = await Promise.all(ids.map((id) => h.manifestWithAgent(id)));
    const t0 = Date.now();
    await Promise.all(views.map((v) => v.end()));
    expect(Date.now() - t0).toBeLessThan(10_000);
    await until(() => manifests.every((m) => !alive(m.hostPid) && !alive(m.agentPid)));
    for (const [i, id] of ids.entries()) {
      expect(h.manifest(id)?.exit?.reason).toBe('stopped');
      expect(fs.existsSync(manifests[i].socketPath)).toBe(false);
    }
  }, 30_000);
});

describe('clients', () => {
  it('two core clients both get events, a second answer is stale, an observer cannot command', async () => {
    const id = sessionId(401);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const a = await h.connect(m);
    const b = await h.connect(m);
    const obs = await h.connect(m, { role: 'observer' });
    const odd = await h.connect(m, { role: 'admin' }); // an unknown role is an observer
    for (const c of [a, b, obs]) await c.request('subscribe', { fromSeq: 0 });

    await a.request('send', { message: userMessage('please ask') });
    await until(() => [a, b, obs].every((c) => c.events.some((e) => e.type === 'ask')));
    const ask = a.events.find((e) => e.type === 'ask') as Extract<HostEvent, { type: 'ask' }>;
    const allow = { behavior: 'allow', updatedInput: {} };
    expect(await a.request('respondAsk', { requestId: ask.ask.requestId, result: allow })).toEqual({ outcome: 'applied' });
    expect(await b.request('respondAsk', { requestId: ask.ask.requestId, result: allow })).toEqual({ outcome: 'stale' });
    await until(() => [a, b, obs].every((c) => c.replies().includes('allowed')));

    for (const c of [obs, odd]) {
      for (const [method, params] of [
        ['send', { message: userMessage('nope') }],
        ['respondAsk', { requestId: ask.ask.requestId, result: allow }],
        ['control', { op: 'interrupt' }],
        ['end', {}],
      ] as const) {
        await expect(c.request(method, params)).rejects.toMatchObject({ code: RPC_FORBIDDEN });
      }
      expect((await c.request<HostSnapshot>('snapshot')).state).toBe('idle');
    }
    await view.end();
  }, 30_000);

  it('send is idempotent on uuid over the wire', async () => {
    const id = sessionId(402);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const c = await h.connect(h.manifest(id)!);
    await c.request('subscribe', { fromSeq: 0 });
    const msg = userMessage('once');
    expect(await c.request('send', { message: msg })).toEqual({ accepted: true, duplicate: false });
    expect(await c.request('send', { message: msg })).toEqual({ accepted: false, duplicate: true });
    await until(() => c.replies().includes('echo: once'));
    await sleep(300);
    expect(c.replies().filter((r) => r === 'echo: once')).toHaveLength(1);
    await view.end();
  }, 30_000);

  it('token mismatch: refused, nothing readable, and the core client gives up instead of retrying', async () => {
    const id = sessionId(403);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = h.manifest(id)!;

    const raw = await h.connect(m, { token: '' });
    await expect(raw.request('hello', { client: { role: 'core', build: 'x', pid: 1 }, protocol: { min: 1, max: 1 }, token: 'wrong' })).rejects.toMatchObject({ code: RPC_UNAUTHORIZED });
    for (const method of ['snapshot', 'subscribe', 'events', 'send', 'ping']) {
      await expect(raw.request(method, { fromSeq: 0 })).rejects.toMatchObject({ code: RPC_UNAUTHORIZED });
    }
    await view.send('more');
    await until(() => texts(view).includes('echo: more'));
    expect(raw.events).toHaveLength(0);

    const links: string[] = [];
    const client = new HostClient({ hostId: m.hostId, socketPath: m.socketPath, token: 'wrong', cwd: m.cwd, startedAt: m.startedAt, hostPid: () => m.hostPid, hostStartTime: () => m.hostStartTime, mode: 'adopt', build: 'test', log: () => undefined });
    client.onLink((s) => links.push(s));
    const before = h.hostLog(m).split('wrong token').length;
    client.start();
    await until(() => links.includes('unreachable'));
    await sleep(1500);
    expect(h.hostLog(m).split('wrong token').length - before).toBe(1);
    client.detach();
    await view.end();
  }, 30_000);

  it('protocol mismatch: an unsupported range is refused with the range the host speaks; unknowns answer -32601', async () => {
    const id = sessionId(404);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const raw = await h.connect(m, { token: '' });
    const refused = raw.request('hello', { client: { role: 'core', build: 'x', pid: 1 }, protocol: { min: 2, max: 3 }, token: h.token(m) });
    await expect(refused).rejects.toMatchObject({ code: RPC_PROTOCOL_MISMATCH, data: { min: 1, max: 1 } });
    // A range that includes v1 is fine, and unknown hello fields are ignored.
    const ok = await h.connect(m, { token: '' });
    await expect(ok.request('hello', { client: { role: 'core', build: 'x', pid: 1, future: true }, protocol: { min: 1, max: 9 }, token: h.token(m), extra: 1 })).resolves.toMatchObject({ protocol: 1 });
    await expect(ok.request('noSuchMethod')).rejects.toMatchObject({ code: RPC_METHOD_NOT_FOUND });
    await expect(ok.request('control', { op: 'reboot' })).rejects.toMatchObject({ code: RPC_METHOD_NOT_FOUND });
    await view.end();
  }, 30_000);
});

describe('large output and slow clients (§9.2, §9.7)', () => {
  it('a 10 MB tool result goes through whole; a 16 MiB+ one is stubbed, never sent; an oversize line from a client drops only that client', async () => {
    const id = sessionId(501);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const c = await h.connect(m);
    const toolResults = (events: HostEvent[]) =>
      events.filter((e): e is Extract<HostEvent, { type: 'message' }> => e.type === 'message' && (e.msg as { type?: string }).type === 'user');

    // 10 MB is more than a client's 4 MiB queue: live subscribers are told to
    // resync, and the event is there, whole, for the page that catches them up.
    await view.send('big:10000000');
    await until(() => texts(view).includes('big done'), 30_000);
    const held = toolResults((await c.page()).events);
    expect(held).toHaveLength(1);
    expect(JSON.stringify(held[0].msg).length).toBeGreaterThan(10_000_000);

    // Over the frame limit: a stub goes out instead, live and small.
    await c.request('subscribe', { fromSeq: (await c.request<HostSnapshot>('snapshot')).seq });
    await view.send('big:17000000');
    await until(() => texts(view).filter((t) => t === 'big done').length === 2, 30_000);
    await until(() => toolResults(c.events).length === 1, 10_000);
    expect(toolResults(c.events)[0].msg).toMatchObject({ type: 'user', omitted: true });
    expect((toolResults(c.events)[0].msg as { bytes: number }).bytes).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(c.closed).toBe(false);

    const bad = await h.connect(m);
    bad.socket.write(`${'x'.repeat(MAX_FRAME_BYTES + 1024)}\n`);
    await until(() => bad.closed, 10_000, 'the host to drop the oversize client');
    expect(c.closed).toBe(false);
    expect(await c.request('ping')).toMatchObject({ seq: expect.any(Number) });
    await view.end();
  }, 90_000);

  it('a paused reader overflows its queue and gets one resync; the agent never stalls; paging recovers without looping', async () => {
    const id = sessionId(502);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const slow = await h.connect(m);
    const fast = await h.connect(m);
    await slow.request('subscribe', { fromSeq: 0 });
    await fast.request('subscribe', { fromSeq: 0 });
    slow.socket.pause();

    // ~10 MB of deltas from the dummy agent's stdout.
    const t0 = Date.now();
    await fast.request('send', { message: userMessage('flood:2500:4000') });
    await untilAsync(async () => (await fast.lastResult()) === 'flood done', 20_000, 'the flood to finish while a client is paused');
    expect(Date.now() - t0).toBeLessThan(15_000);

    slow.socket.resume();
    await until(() => slow.resyncs === 1, 10_000, 'a resync');
    await sleep(300);
    expect(slow.resyncs).toBe(1);

    // Recover as the core does: snapshot, page, subscribe from where paging stopped.
    const snap = await slow.request<HostSnapshot>('snapshot');
    let cursor = Math.max(snap.ring.fromSeq, ...slow.events.map((e) => e.seq));
    const paged: HostEvent[] = [];
    let pages = 0;
    for (;;) {
      const page = await slow.request<EventsResult>('events', { fromSeq: cursor, maxBytes: 64 * 1024 * 1024, epoch: snap.epoch });
      pages++;
      const bytes = page.events.reduce((n, e) => n + JSON.stringify(e).length, 0);
      if (page.events.length > 1) expect(bytes).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(page.nextSeq).toBe(page.events.length > 0 ? page.events[page.events.length - 1].seq : cursor);
      paged.push(...page.events);
      cursor = page.nextSeq;
      if (page.done) break;
    }
    expect(pages).toBeGreaterThan(2);
    await slow.request('subscribe', { fromSeq: cursor, epoch: snap.epoch });
    await sleep(300);
    expect(slow.resyncs).toBe(1);
    expect(replyTexts([...slow.events, ...paged])).toContain('flood done');
    expectContiguous([...slow.events, ...paged].map((e) => e.seq));
    await view.end();
  }, 60_000);

  it('the core client resyncs once after falling behind, and ends up with every event exactly once', async () => {
    const id = sessionId(503);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const logs: string[] = [];
    const sup = h.supervisor({ log: (l) => logs.push(l) });
    const client = sup.attach(m, Promise.resolve(new Set()));
    const seen: HostEvent[] = [];
    client.subscribe(0, (e) => seen.push(e));
    const links: string[] = [];
    client.onLink((s) => links.push(s));
    client.start();
    await until(() => links.includes('live'));
    (client as unknown as { socket: net.Socket }).socket.pause();

    const driver = await h.connect(m);
    await driver.request('send', { message: userMessage('flood:2500:4000') });
    await untilAsync(async () => (await driver.lastResult()) === 'flood done', 20_000, 'the flood to finish');
    (client as unknown as { socket: net.Socket }).socket.resume();

    await until(() => replyTexts(seen).includes('flood done'), 20_000, 'the core client to catch up');
    expect(logs.filter((l) => l.includes('fell behind'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('resync failed'))).toHaveLength(0);
    const real = seen.filter((e, i) => i === 0 || e.seq !== seen[i - 1].seq);
    expectContiguous(real.map((e) => e.seq));
    const deltas = seen.filter((e) => e.type === 'message' && (e.msg as { type?: string }).type === 'stream_event');
    expect(new Set(deltas.map((e) => e.seq)).size).toBe(deltas.length);
    client.detach();
    await view.end();
  }, 60_000);

  it('subscribe from 0 early in a host\'s life replays everything and does not resync', async () => {
    const id = sessionId(504);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const first = await h.connect(m);
    await expect(first.request('subscribe', { fromSeq: 0 })).resolves.toEqual({ ok: true });
    await view.send('hi');
    await until(() => first.replies().includes('echo: hi'));

    const later = await h.connect(m);
    await expect(later.request('subscribe', { fromSeq: 0 })).resolves.toEqual({ ok: true });
    await until(() => later.replies().includes('echo: hi'));
    expect(later.events[0].seq).toBe(1);
    expect((await later.request<HostSnapshot>('snapshot')).ring).toEqual({ fromSeq: 0, truncated: false });
    expect(later.resyncs).toBe(0);
    await view.end();
  }, 30_000);
});

describe('files on disk', () => {
  it('stale socket from a SIGKILLed host refuses connections and the host is classified dead', async () => {
    const id = sessionId(601);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    view.detach();
    process.kill(m.hostPid, 'SIGKILL');
    await until(() => !alive(m.hostPid));
    expect(fs.existsSync(m.socketPath)).toBe(true);
    await expect(new Promise((resolve, reject) => net.createConnection(m.socketPath).once('connect', resolve).once('error', reject))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const scan = h.supervisor().scan();
    expect(scan.alive.some((x) => x.hostId === m.hostId)).toBe(false);
    expect(scan.dead.some((x) => x.hostId === m.hostId)).toBe(true);
  }, 30_000);

  it('a live host whose socket is gone stays held: never interrupted, never reported lost', async () => {
    const id = sessionId(602);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    view.detach();
    fs.rmSync(m.socketPath);

    const store = memento();
    new SessionRegistry(store).live({ sessionId: id, provider: 'claude', cwd: h.root });
    const sup = h.supervisor();
    const scan = sup.scan();
    expect(scan.alive.map((x) => x.hostId)).toContain(m.hostId);
    const registry = new SessionRegistry(store);
    expect(registry.startup(new Set(scan.alive.map((x) => x.sessionId!))).interrupted).toHaveLength(0);

    const again = h.adopt(id, sup);
    await sleep(2000);
    expect(again.lifecycle).not.toBe('idle');
    expect(again.lastExit).toBeUndefined();
    expect(alive(m.hostPid)).toBe(true);
    again.detach();
    // Unreachable without its socket: only a signal can stop it now.
    h.leaveRunning(m.hostPid);
    h.leaveRunning(m.agentPid!);
  }, 30_000);
});

describe('environment hygiene', () => {
  it('the agent gets none of ELECTRON_*, AW_*, __CFBundleIdentifier, XPC_SERVICE_NAME or the token, in env or argv', async () => {
    const id = sessionId(701);
    const sup = h.supervisor({
      hostEnv: {
        __CFBundleIdentifier: 'com.test.agentwrangler',
        XPC_SERVICE_NAME: 'application.com.test.agentwrangler',
        ELECTRON_TEST_LEAK: '1',
        AW_TEST_LEAK: '1',
        KEEP_ME_TEST: 'kept',
      },
    });
    const view = h.spawn(id, { supervisor: sup });
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    const env = h.agentEnv(m.agentPid!);
    const token = h.token(m);

    expect(env.KEEP_ME_TEST).toBe('kept'); // the env did reach it
    expect(Object.keys(env).filter((k) => k.startsWith('ELECTRON_') || k.startsWith('AW_'))).toEqual([]);
    expect(env.__CFBundleIdentifier).toBeUndefined();
    expect(env.XPC_SERVICE_NAME).toBeUndefined();
    expect(Object.values(env).some((v) => v.includes(token))).toBe(false);
    expect(argsOf(m.hostPid)).not.toContain(token);
    expect(argsOf(m.agentPid!)).not.toContain(token);
    await view.end();
  }, 30_000);
});
