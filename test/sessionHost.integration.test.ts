import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerView } from '../src/claude/runner/runnerView';
import { HostSupervisor } from '../src/core/session/hostSupervisor';
import { readManifests } from '../src/core/session/manifestFile';
import { adoptHostedClaude, spawnHostedClaude } from '../src/core/session/remoteClaudeHandle';
import { NdjsonPeer, RpcRemoteError } from '../src/core/rpc/ndjsonPeer';
import { RPC_UNAUTHORIZED } from '../src/shared/sessionProtocol';

/**
 * Real detached session hosts over real Unix sockets, with a scripted agent
 * (`AW_SESSION_HOST_FAKE=1`) in place of `claude`. What Stage 3 promises:
 * a session outlives the client that started it, a new client reattaches from
 * the manifest, an ask is answered after reattach, and `end` leaves nothing.
 */

// Short: socket paths must stay under macOS's 104-byte limit.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awh-'));
const runDir = path.join(root, 'run');
const bundle = path.join(root, 'host.js');
const noHistory = async () => ({ blocks: [], truncated: false });

function supervisor(): HostSupervisor {
  return new HostSupervisor({
    runDir,
    fallbackRunDir: path.join(root, 'fb'),
    logDir: path.join(root, 'logs'),
    runtime: { buildId: 'test', prepare: async () => ({ exe: process.execPath, entry: bundle }) },
    log: () => undefined,
    build: 'test',
    hostEnv: { AW_SESSION_HOST_FAKE: '1' },
  });
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const texts = (v: RunnerView) => v.blocks.map((b) => ('text' in b ? b.text : `[${b.kind}]`));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const manifestFor = (sessionId: string) => readManifests(runDir).find((m) => m.manifest.sessionId === sessionId)?.manifest;

beforeAll(async () => {
  await esbuild.build({
    entryPoints: ['src/sessionHost/main.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: bundle,
    define: { 'import.meta.url': '__aw_import_meta_url', AW_SDK_VERSION: '"test"' },
    banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  for (const { manifest } of readManifests(runDir)) {
    if (alive(manifest.hostPid)) process.kill(manifest.hostPid, 'SIGKILL');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('session host, end to end', () => {
  it('outlives its client, and a new client reattaches and carries on', async () => {
    const view = spawnHostedClaude({ cwd: root, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('hello');
    await until(() => texts(view).includes('echo: hello'));
    const m = manifestFor('aaaaaaaa-0000-4000-8000-000000000001')!;
    expect(m.hostStartTime).toBeTruthy();

    // The app quits: it lets go of the host without ending it.
    view.detach();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(m.hostPid)).toBe(true);

    // The next run finds it, reattaches, and the conversation is still there.
    const sup = supervisor();
    const { alive: found } = sup.scan();
    const manifest = found.find((x) => x.sessionId === m.sessionId)!;
    expect(manifest).toBeDefined();
    const again = adoptHostedClaude(manifest, {}, { supervisor: sup, binary: '/fake', log: () => undefined, loadHistory: noHistory });
    again.start();
    await until(() => texts(again).includes('echo: hello'));
    await until(() => again.lifecycle === 'idle');

    await again.send('second');
    await until(() => texts(again).includes('echo: second'));
    // Replayed once, not twice.
    expect(texts(again).filter((t) => t === 'echo: hello')).toHaveLength(1);

    await again.end();
    await until(() => !alive(m.hostPid));
  }, 30_000);

  it('holds a pending ask while nobody is connected, and it is answerable after reattach', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000002';
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('please ask');
    await until(() => view.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'));
    view.detach();

    const sup = supervisor();
    const manifest = sup.scan().alive.find((x) => x.sessionId === id)!;
    const again = adoptHostedClaude(manifest, {}, { supervisor: sup, binary: '/fake', log: () => undefined, loadHistory: noHistory });
    again.start();
    await until(() => again.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'));
    const card = again.blocks.find((b) => b.kind === 'permission') as { requestId: string };
    expect(await again.decide(card.requestId, 'allow')).toBe('applied');
    await until(() => texts(again).includes('allowed'));

    await again.end();
    await until(() => !alive(manifest.hostPid));
  }, 30_000);

  it('records the exit in the manifest and leaves no process after end', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000003';
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const pid = manifestFor(id)!.hostPid;
    await view.end();
    expect(view.lifecycle).toBe('ended');
    await until(() => !alive(pid));
    expect(manifestFor(id)?.exit).toBeDefined();
  }, 30_000);

  it('refuses a client without the token', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000004';
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await until(() => manifestFor(id) !== undefined);
    const m = manifestFor(id)!;

    const socket = net.createConnection(m.socketPath);
    await new Promise((r) => socket.once('connect', r));
    const peer = new NdjsonPeer({ jsonrpc: true, write: (l) => socket.write(l) });
    socket.on('data', (c: Buffer) => peer.feed(c));
    const hello = peer.request('hello', { client: { role: 'core', build: 'x', pid: 1 }, protocol: { min: 1, max: 1 }, token: 'wrong' });
    await expect(hello).rejects.toMatchObject({ code: RPC_UNAUTHORIZED });
    await expect(peer.request('snapshot', {})).rejects.toBeInstanceOf(RpcRemoteError);
    socket.destroy();

    await view.end();
    await until(() => !alive(m.hostPid));
  }, 30_000);

  it('tells the view when its host dies without an exit record', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000006';
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    process.kill(manifestFor(id)!.hostPid, 'SIGKILL');
    await until(() => view.lifecycle === 'error');
    expect(view.lastExit?.reason).toBe('lost');
  }, 30_000);

  it('ends its agent and records why when it is sent SIGTERM', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000007';
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const pid = manifestFor(id)!.hostPid;
    view.detach();
    process.kill(pid, 'SIGTERM');
    await until(() => !alive(pid));
    expect(manifestFor(id)?.exit).toBeDefined();
  }, 30_000);

  it('keeps its files private: run dir 0700, token and manifest 0600, socket 0600', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000005';
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor(), binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    await until(() => manifestFor(id) !== undefined);
    const m = manifestFor(id)!;
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    expect(mode(runDir)).toBe(0o700);
    expect(mode(path.join(runDir, `${m.hostId}.token`))).toBe(0o600);
    expect(mode(path.join(runDir, `${m.hostId}.json`))).toBe(0o600);
    expect(mode(m.socketPath)).toBe(0o600);
    await view.end();
    await until(() => !alive(m.hostPid));
  }, 30_000);
});
