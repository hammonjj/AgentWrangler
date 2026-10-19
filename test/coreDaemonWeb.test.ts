/**
 * The core daemon serves the browser workbench (#131): `startCoreDaemon`
 * with a `webviewDir` starts the web server over its own app, `web.link` on
 * the control socket (what `aw web open` and the app's launcher ask) returns a
 * sign-in link, the page is served, and a WebSocket client gets the server's
 * `hello` and then a real table snapshot from the daemon's own
 * `DashboardHost`. The client is registered with the daemon's
 * `ClientRegistry`, and a stop closes the listener.
 *
 * As in coreDaemonStart.test.ts: HOME, CLAUDE_CONFIG_DIR and CODEX_HOME point
 * into a temp dir before the app's modules load, the Keychain is a fake, and
 * no session host is ever spawned.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { SecurityRunner } from '../src/core/keychainSecrets';
import type { SessionHostRuntime } from '../src/core/session/hostSupervisor';

// Short: the control socket path must fit in 104 bytes, and macOS's tmpdir is long.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cw-'));
const home = path.join(root, 'home');
const dataDir = path.join(home, 'Library', 'Application Support', 'Agent Wrangler');
const fallbackRunDir = path.join(root, 'fb');
const webviewDir = path.join(root, 'webview');
let port = 0;

/** A port nothing listens on right now, for `web.port` (which refuses 0). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AW_') || key === 'AGENTWRANGLER_HOSTED') delete process.env[key];
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(webviewDir, { recursive: true });
  for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
  port = await freePort();
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ showUsage: false, 'autoPause.enabled': false, codexBinaryPath: path.join(root, 'no-codex'), 'web.port': port }),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const security: SecurityRunner = {
  available: () => true,
  run: async () => ({ code: 44, stdout: '', stderr: 'not found' }),
};

const refusingRuntime: SessionHostRuntime = {
  buildId: 'test',
  prepare: () => Promise.reject(new Error('no session hosts in this test')),
  gc: () => undefined,
};

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function get(p: string, headers: http.OutgoingHttpHeaders): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

interface Frame {
  pane: string;
  body: { type: string; [k: string]: unknown };
}

describe('the core daemon serves the web workbench', () => {
  it('signs in by web.link, serves the page, and a WebSocket client gets hello and a snapshot', async () => {
    expect(os.homedir()).toBe(home);
    const { startCoreDaemon } = await import('../src/daemon/startCore');
    const { ControlClient } = await import('../src/cli/client');
    const { SHELL_PANE, WIRE_PROTOCOL } = await import('../src/shared/shellProtocol');

    const lines: string[] = [];
    const result = await startCoreDaemon({
      dataDir,
      fallbackRunDir,
      build: 'b-test',
      runtime: refusingRuntime,
      log: (m: string) => lines.push(m),
      securityRunner: security,
      fixToolPath: false,
      power: { set: () => undefined, dispose: () => undefined, held: false } as never,
      watchSleep: () => ({ dispose: () => undefined }),
      webviewDir,
    });
    if (!result.started) throw new Error(result.reason);
    const daemon = result.daemon;
    try {
      // `web.link`, as the window and `aw web open` ask it, once the listener is up.
      const client = await ControlClient.connect({ runDir: daemon.paths.runDir, fallbackRunDir }, { build: 'b-test', name: 'window' });
      if (!client) throw new Error('control socket not answering');
      const link = await until(async () => {
        try {
          return await client.request<{ url: string; expiresAt: number }>('web.link');
        } catch {
          return undefined;
        }
      }, 'web.link');
      client.close();
      const url = new URL(link.url);
      expect(url.origin).toBe(`http://127.0.0.1:${port}`);
      expect(url.pathname).toBe('/login');
      expect(daemon.clients.web?.port).toBe(port);

      // The link becomes a persistent device cookie.
      const login = await get(`${url.pathname}${url.search}`, {});
      expect(login.status).toBe(303);
      const setCookie = String(login.headers['set-cookie']?.[0]);
      expect(setCookie).toMatch(/Max-Age=\d+/i);
      const cookie = setCookie.split(';')[0];

      // The page, from the daemon's own webview directory.
      const page = await get('/', { cookie });
      expect(page.status).toBe(200);
      expect(page.body).toContain('aw-build');
      expect(page.body).toContain('webshim');

      // Pairing (#137) over the control socket, as `aw web pair` and `aw web devices` ask it:
      // LAN access is off here, so it says so rather than offering; the device list is the daemon's own store.
      const aw = await ControlClient.connect({ runDir: daemon.paths.runDir, fallbackRunDir }, { build: 'b-test' });
      if (!aw) throw new Error('control socket not answering');
      await expect(aw.request('web.pair')).rejects.toThrow(/not listening/);
      const listed = await aw.request<{ devices?: { id: string }[] } | { id: string }[]>('web.devices');
      const devices = Array.isArray(listed) ? listed : (listed.devices ?? []);
      expect(devices).toHaveLength(1);
      aw.close();

      // Dictation (#141) is registered: a POST without the device cookie is 401, not 404/405.
      const post = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/dictation', method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'audio/webm' }, agent: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('x');
      });
      expect(post).toBe(401);

      // The files side (#139, #140) is wired too: the folder browser and the file view answer a signed-in device, and 401 without one.
      expect((await get('/api/dirs', {})).status).toBe(401);
      expect((await get('/api/dirs', { cookie })).status).not.toBe(404);
      expect((await get(`/api/view?path=${encodeURIComponent('/etc/hosts')}`, { cookie })).status).not.toBe(404);

      // A WebSocket client: hello first, then the table's snapshot on `ready`.
      const frames: Frame[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}`, cookie } });
      ws.on('message', (data) => frames.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const hello = await until(() => frames[0], 'hello');
      expect(hello.pane).toBe(SHELL_PANE);
      expect(hello.body).toMatchObject({ type: 'hello', protocol: WIRE_PROTOCOL });
      expect(daemon.clients.registry.size).toBe(1);

      ws.send(JSON.stringify({ pane: 'dashboard', body: { type: 'ready' }, commandId: 'w.1' }));
      const snapshot = await until(() => frames.find((f) => f.pane === 'dashboard' && f.body.type === 'snapshot'), 'snapshot');
      expect(Array.isArray(snapshot.body.sessions)).toBe(true);

      // A toast with no originating client reaches the connected client.
      daemon.host.dialogs.flash('hello from the daemon');
      await until(() => frames.some((f) => f.pane === SHELL_PANE && JSON.stringify(f.body).includes('hello from the daemon')), 'toast');

      ws.close();
      await until(() => daemon.clients.registry.size === 0, 'unregistered');
    } finally {
      await daemon.stop('signal');
    }

    // The listener went with the daemon.
    await expect(get('/', {})).rejects.toThrow();
    // Never the real home.
    expect(lines.filter((l) => l.includes(os.userInfo().homedir))).toEqual([]);
  });
});
