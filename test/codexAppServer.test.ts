import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexAppServer } from '../src/codex/appServer';

describe('CodexAppServer', () => {
  it('initializes, correlates responses, and routes notifications and server requests', async () => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const sent: any[] = [];
    let buffered = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const message = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        sent.push(message);
        if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        if (message.method === 'thread/list') child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
      }
    });
    const server = new CodexAppServer(() => 'codex', () => undefined, (() => child) as any);
    await server.start();
    const notifications: any[] = [];
    const requests: any[] = [];
    server.onNotification((event) => notifications.push(event));
    server.onRequest((event) => requests.push(event));
    child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 't1' } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'item/tool/requestUserInput', id: 7, params: { threadId: 't1' } })}\n`);
    expect(await server.request('thread/list', {})).toEqual({ data: [] });
    expect(sent[0].params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(notifications[0].method).toBe('turn/started');
    expect(requests[0].id).toBe(7);
    server.dispose();
  });

  it('rejects startup cleanly when the Codex binary cannot be spawned', async () => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const server = new CodexAppServer(() => 'missing-codex', () => undefined, (() => {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    }) as any);
    await expect(server.start()).rejects.toThrow('spawn ENOENT');
    server.dispose();
  });
});

/**
 * A stand-in for the `child_process` handle `spawn` would hand back, real
 * enough for `CodexAppServer` to wire up (`stdin`/`stdout`/`stderr` are real
 * streams so `readline` has something to listen to) but backed by no real
 * process — `kill` just records that it was asked.
 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const killSignals: (NodeJS.Signals | number | undefined)[] = [];
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill(signal?: NodeJS.Signals | number) {
      killSignals.push(signal);
      return true;
    },
  });
  return { child, killSignals };
}

describe('CodexAppServer.dispose', () => {
  it('kills its child via the injected spawnProcess', async () => {
    const { child, killSignals } = fakeChild();
    const spawnProcess = (() => child) as unknown as typeof import('node:child_process').spawn;
    const server = new CodexAppServer(() => '/fake/codex', () => undefined, spawnProcess);

    // `start` awaits the app-server's `initialize` reply forever in this fake
    // — nothing here answers it — so it is deliberately not awaited, only
    // caught: `dispose` rejects it, and that rejection is expected, not a
    // test failure. All `dispose` needs is the child to have been assigned,
    // which happens synchronously inside `startInner` before that await.
    const starting = server.start().catch(() => undefined);
    await Promise.resolve();

    server.dispose();
    await starting;

    expect(killSignals).toHaveLength(1);
  });

  it('does nothing when no child was ever started', () => {
    const { killSignals } = fakeChild();
    const spawnProcess = (() => {
      throw new Error('must not spawn');
    }) as unknown as typeof import('node:child_process').spawn;
    const server = new CodexAppServer(() => '/fake/codex', () => undefined, spawnProcess);

    expect(() => server.dispose()).not.toThrow();
    expect(killSignals).toHaveLength(0);
  });

  it('rejects requests still in flight when the child is disposed', async () => {
    const { child } = fakeChild();
    const spawnProcess = (() => child) as unknown as typeof import('node:child_process').spawn;
    const server = new CodexAppServer(() => '/fake/codex', () => undefined, spawnProcess);

    const starting = server.start().catch(() => undefined);
    await Promise.resolve();
    const pending = server.request('someMethod').catch((err: Error) => err);

    server.dispose();
    await starting;

    const result = await pending;
    expect(result).toBeInstanceOf(Error);
  });
});
