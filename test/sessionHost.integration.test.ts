import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RpcRemoteError } from '../src/core/rpc/ndjsonPeer';
import { recordFromManifest } from '../src/core/session/recovery';
import { RPC_UNAUTHORIZED } from '../src/shared/sessionProtocol';
import { HostHarness, alive, sessionId, sleep, texts, until } from './support/hostHarness';

/**
 * Real detached session hosts over real Unix sockets, with a scripted agent
 * (`AW_SESSION_HOST_FAKE=1`) in place of `claude`. What Stage 3 promises:
 * a session outlives the client that started it, a new client reattaches from
 * the manifest, an ask is answered after reattach, and `end` leaves nothing.
 * The rest of the §16 matrix is in `sessionLifecycle.integration.test.ts`.
 */

const h = new HostHarness();

beforeAll(() => h.build(), 60_000);
afterEach(async () => {
  expect(await h.cleanup()).toEqual([]);
});
afterAll(() => h.dispose());

describe('session host, end to end', () => {
  it('outlives its client, and a new client reattaches and carries on', async () => {
    const id = sessionId(1);
    const view = h.spawn(id);
    await view.send('hello');
    await until(() => texts(view).includes('echo: hello'));
    const m = await h.manifestWithAgent(id);
    expect(m.hostStartTime).toBeTruthy();

    // The app quits: it lets go of the host without ending it.
    view.detach();
    await sleep(300);
    expect(alive(m.hostPid)).toBe(true);
    expect(alive(m.agentPid)).toBe(true);

    // The next run finds it, reattaches, and the conversation is still there.
    const again = h.adopt(id);
    await until(() => texts(again).includes('echo: hello'));
    await until(() => again.lifecycle === 'idle');

    await again.send('second');
    await until(() => texts(again).includes('echo: second'));
    // Replayed once, not twice.
    expect(texts(again).filter((t) => t === 'echo: hello')).toHaveLength(1);

    await again.end();
    await until(() => !alive(m.hostPid) && !alive(m.agentPid));
  }, 30_000);

  it('holds a pending ask while nobody is connected, and it is answerable after reattach', async () => {
    const id = sessionId(2);
    const view = h.spawn(id);
    await view.send('please ask');
    await until(() => view.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'));
    view.detach();

    const again = h.adopt(id);
    await until(() => again.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'));
    const card = again.blocks.find((b) => b.kind === 'permission') as { requestId: string };
    expect(await again.decide(card.requestId, 'allow')).toBe('applied');
    await until(() => texts(again).includes('allowed'));

    const m = h.manifest(id)!;
    await again.end();
    await until(() => !alive(m.hostPid));
  }, 30_000);

  it('records the exit in the manifest and leaves no process after end', async () => {
    const id = sessionId(3);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    await view.end();
    expect(view.lifecycle).toBe('ended');
    await until(() => !alive(m.hostPid) && !alive(m.agentPid));
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'stopped' });
  }, 30_000);

  it('writes the launch options and origin into the manifest, for a core that lost the record (#72)', async () => {
    const id = sessionId(8);
    const origin = { kind: 'orchestration', missionId: 'm1', attemptId: 'a1' };
    const view = h.spawn(id, { model: 'opus', effort: 'high', origin });
    await until(() => h.manifest(id) !== undefined);
    expect(h.manifest(id)).toMatchObject({ launch: { model: 'opus', effort: 'high', resume: false }, origin });
    expect(recordFromManifest(h.manifest(id)!)).toMatchObject({ sessionId: id, launch: { model: 'opus', effort: 'high' }, origin });
    await view.end();
  }, 30_000);

  it('refuses a client without the token', async () => {
    const id = sessionId(4);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;

    const raw = await h.connect(m, { token: '' });
    const hello = raw.request('hello', { client: { role: 'core', build: 'x', pid: 1 }, protocol: { min: 1, max: 1 }, token: 'wrong' });
    await expect(hello).rejects.toMatchObject({ code: RPC_UNAUTHORIZED });
    await expect(raw.request('snapshot', {})).rejects.toBeInstanceOf(RpcRemoteError);

    await view.end();
    await until(() => !alive(m.hostPid));
  }, 30_000);

  it('tells the view when its host dies without an exit record', async () => {
    const id = sessionId(6);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    process.kill(h.manifest(id)!.hostPid, 'SIGKILL');
    await until(() => view.lifecycle === 'error');
    expect(view.lastExit?.reason).toBe('lost');
  }, 30_000);

  it('ends its agent and records why when it is sent SIGTERM', async () => {
    const id = sessionId(7);
    const view = h.spawn(id);
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = await h.manifestWithAgent(id);
    view.detach();
    process.kill(m.hostPid, 'SIGTERM');
    await until(() => !alive(m.hostPid) && !alive(m.agentPid));
    expect(h.manifest(id)?.exit).toMatchObject({ reason: 'signal', hostSignal: 'SIGTERM' });
  }, 30_000);

  it('keeps its files private: run dir 0700, token and manifest 0600, socket 0600', async () => {
    const id = sessionId(5);
    const view = h.spawn(id);
    await until(() => h.manifest(id) !== undefined);
    const m = h.manifest(id)!;
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    expect(mode(h.runDir)).toBe(0o700);
    expect(mode(path.join(h.runDir, `${m.hostId}.token`))).toBe(0o600);
    expect(mode(path.join(h.runDir, `${m.hostId}.json`))).toBe(0o600);
    expect(mode(m.socketPath)).toBe(0o600);
    await view.end();
    await until(() => !alive(m.hostPid));
  }, 30_000);
});
