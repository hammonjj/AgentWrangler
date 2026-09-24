import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexHost,
  extensionBinDir,
  hostEnv,
  parseCliVersion,
  stopSignalFor,
  userAgentVersion,
} from '../src/codex/codexHost';
import { decodeFrames, encodeFrame, websocketOver } from '../src/codex/wsClient';

describe('wsClient framing', () => {
  it('round-trips short, medium and long text frames through the mask', () => {
    for (const size of [5, 300, 70_000]) {
      const text = 'x'.repeat(size);
      const frame = encodeFrame(0x1, Buffer.from(text));
      expect(frame[1] & 0x80).toBe(0x80); // clients mask
      const { frames, rest } = decodeFrames(frame);
      expect(rest.length).toBe(0);
      expect(frames).toHaveLength(1);
      expect(frames[0].payload.toString()).toBe(text);
    }
  });

  it('waits for the rest of a frame split across chunks', () => {
    const frame = encodeFrame(0x1, Buffer.from('hello world'));
    const first = decodeFrames(frame.subarray(0, 5));
    expect(first.frames).toHaveLength(0);
    const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(5)]));
    expect(second.frames[0].payload.toString()).toBe('hello world');
  });
});

/** The server end of a socket: what the client wrote, and a way to write back. */
function socketPair() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const client = new Duplex({
    read() {},
    write(chunk, _enc, done) { toServer.write(chunk); done(); },
  });
  toClient.on('data', (chunk) => client.push(chunk));
  return { client, toServer, toClient };
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

describe('websocketOver', () => {
  it('upgrades, delivers text frames (including ones sent with the 101), and answers pings', async () => {
    const { client, toServer, toClient } = socketPair();
    let request = '';
    const written: Buffer[] = [];
    toServer.on('data', (chunk: Buffer) => {
      if (!request) {
        request = chunk.toString();
        const key = /Sec-WebSocket-Key: (\S+)/.exec(request)![1];
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        toClient.write(Buffer.concat([
          Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
          serverFrame('{"early":true}'),
        ]));
        return;
      }
      written.push(chunk);
    });
    const ws = await websocketOver(client);
    expect(request).toMatch(/^GET \/ HTTP\/1\.1\r\nHost: localhost\r\nUpgrade: websocket/);
    const got: string[] = [];
    ws.onMessage((text) => got.push(text));
    toClient.write(serverFrame('{"id":1}'));
    toClient.write(Buffer.from([0x89, 0x00])); // ping
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(got).toEqual(['{"early":true}', '{"id":1}']);
    const pong = decodeFrames(Buffer.concat(written)).frames.find((f) => f.opcode === 0xa);
    expect(pong).toBeDefined();

    ws.send('{"method":"x"}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = decodeFrames(Buffer.concat(written)).frames.filter((f) => f.opcode === 0x1).map((f) => f.payload.toString());
    expect(sent).toEqual(['{"method":"x"}']);

    const reasons: string[] = [];
    ws.onClose((reason) => reasons.push(reason));
    toClient.write(Buffer.from([0x88, 0x00]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reasons).toEqual(['closed by server']);
    expect(() => ws.send('x')).toThrow(/closed/);
  });

  it('rejects a refused upgrade', async () => {
    const { client, toServer, toClient } = socketPair();
    toServer.once('data', () => toClient.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await expect(websocketOver(client)).rejects.toThrow(/refused the WebSocket upgrade/);
  });
});

describe('CodexHost helpers', () => {
  it('stops with SIGTERM only when nothing is active (SIGTERM drains forever on a pending turn)', () => {
    expect(stopSignalFor(0)).toBe('SIGTERM');
    expect(stopSignalFor(2)).toBe('SIGINT');
  });

  it('reads versions from --version and from initialize.userAgent', () => {
    expect(parseCliVersion('codex-cli 0.155.0-alpha.16.3\n')).toBe('0.155.0-alpha.16.3');
    expect(parseCliVersion('nonsense')).toBeUndefined();
    expect(userAgentVersion('agent-wrangler/0.155.0-alpha.16.3 (Mac OS 26.5.0; arm64) test')).toBe('0.155.0-alpha.16.3');
    expect(userAgentVersion(undefined)).toBeUndefined();
  });

  it('pins only binaries inside an OpenAI extension bundle', () => {
    expect(extensionBinDir('/Users/test/.vscode/extensions/openai.chatgpt-26.1.2-darwin-arm64/bin/macos-aarch64/codex'))
      .toBe('/Users/test/.vscode/extensions/openai.chatgpt-26.1.2-darwin-arm64/bin/macos-aarch64');
    expect(extensionBinDir('/opt/homebrew/bin/codex')).toBeUndefined();
    expect(extensionBinDir('codex')).toBeUndefined();
  });

  it('strips what would make the server think it is the app', () => {
    const env = hostEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', __CFBundleIdentifier: 'x', XPC_SERVICE_NAME: 'y', HOME: '/Users/test' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/test' });
  });
});

describe('CodexHost lifecycle', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-host-'));
    dirs.push(dir);
    return dir;
  };

  /** A fake extension bundle and a spawn that "starts" a server by creating the socket. */
  function setup() {
    const base = tmp();
    const bundle = path.join(tmp(), 'openai.chatgpt-26.1.2-darwin-arm64', 'bin', 'macos-aarch64');
    fs.mkdirSync(path.join(bundle, 'codex-resources'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bundle, 'codex-resources', 'r.txt'), 'r');
    const alive = new Set<number>();
    const spawned: { binary: string; args: string[]; options: any }[] = [];
    const killed: { pid: number; signal: string }[] = [];
    let nextPid = 4000;
    const host = new CodexHost({
      baseDir: base,
      binary: () => path.join(bundle, 'codex'),
      versionOf: () => '0.155.0-test',
      isAlive: (pid) => alive.has(pid),
      processStart: (pid) => `start-${pid}`,
      kill: (pid, signal) => { killed.push({ pid, signal }); alive.delete(pid); },
      sleep: async () => undefined,
      spawn: ((binary: string, args: string[], options: any) => {
        const pid = nextPid++;
        alive.add(pid);
        spawned.push({ binary, args, options });
        const socket = args[2].replace('unix://', '');
        fs.writeFileSync(socket, '');
        return Object.assign(new EventEmitter(), { pid, unref() {} });
      }) as any,
    });
    return { base, bundle, host, alive, spawned, killed };
  }

  it('launches one detached server from a pinned copy and writes a 0600 manifest', async () => {
    const { base, host, spawned } = setup();
    const m = await host.ensure();
    expect(spawned).toHaveLength(1);
    const runtime = path.join(base, 'runtimes', 'codex-0.155.0-test');
    expect(spawned[0].binary).toBe(path.join(runtime, 'codex'));
    expect(fs.readFileSync(path.join(runtime, 'codex-resources', 'r.txt'), 'utf8')).toBe('r');
    expect(spawned[0].args).toEqual(['app-server', '--listen', `unix://${path.join(base, 'run', 'codex-app-server.sock')}`]);
    expect(spawned[0].options).toMatchObject({ detached: true });
    expect(spawned[0].options.stdio[0]).toBe('ignore');
    expect(typeof spawned[0].options.stdio[1]).toBe('number');
    expect(m).toMatchObject({ v: 1, pid: 4000, procStart: 'start-4000', runtimeDir: runtime, version: '0.155.0-test' });
    expect(fs.statSync(host.manifestPath).mode & 0o777).toBe(0o600);

    // The next start finds it running and does not launch another.
    expect(await host.ensure()).toEqual(m);
    expect(spawned).toHaveLength(1);
    host.noteUserAgent('agent-wrangler/0.155.0-test (x)');
    expect(host.manifest()?.userAgent).toBe('agent-wrangler/0.155.0-test (x)');
  });

  it('does not mistake a reused pid for the server', async () => {
    const { host, spawned } = setup();
    const m = await host.ensure();
    fs.writeFileSync(host.manifestPath, JSON.stringify({ ...m, procStart: 'someone else' }));
    expect(host.running()).toBeUndefined();
    await host.ensure();
    expect(spawned).toHaveLength(2);
  });

  it('stops with the signal it is given and reports when the server has gone', async () => {
    const { host, killed } = setup();
    const m = await host.ensure();
    expect(await host.stop('SIGINT')).toBe(true);
    expect(killed).toEqual([{ pid: m.pid, signal: 'SIGINT' }]);
    expect(host.running()).toBeUndefined();
  });
});
