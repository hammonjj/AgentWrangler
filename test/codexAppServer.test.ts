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
