/**
 * The core daemon's composition (#130): `startCoreDaemon` builds the core on
 * the plain-Node host, serves the control socket, writes its manifest, refuses
 * to be a second core, and stops by the quit policy, all under vitest (plain
 * Node, no Electron) against temp directories.
 *
 * As in nodeHost.test.ts: HOME, CLAUDE_CONFIG_DIR and CODEX_HOME point into a
 * temp dir before the app's modules load, the Keychain runner is a fake, and
 * the session-host runtime refuses to prepare, so no host is ever spawned.
 * The power assertion and the sleep watcher are fakes too.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SecurityRunner } from '../src/core/keychainSecrets';
import type { SessionHostRuntime } from '../src/core/session/hostSupervisor';
import type { PowerAssertion } from '../src/node/powerAssertion';
import type { RemoteInvocation } from '../src/remote/transport';

vi.mock('electron', () => {
  throw new Error('electron was imported under the core daemon');
});

// Short: the control socket path must fit in 104 bytes, and macOS's tmpdir is long.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cd-'));
const home = path.join(root, 'home');
const dataDir = path.join(home, 'Library', 'Application Support', 'Agent Wrangler');
const fallbackRunDir = path.join(root, 'fb');

beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AW_') || key === 'AGENTWRANGLER_HOSTED') delete process.env[key];
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // No usage reads (no network, no login token) and no Codex binary to find.
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ showUsage: false, 'autoPause.enabled': false, codexBinaryPath: path.join(root, 'no-codex') }),
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

function fakePower(): PowerAssertion & { sets: boolean[]; disposed: boolean } {
  const p = {
    sets: [] as boolean[],
    disposed: false,
    held: false,
    set(wanted: boolean) {
      p.sets.push(wanted);
      p.held = wanted;
    },
    dispose() {
      p.disposed = true;
      p.held = false;
    },
  };
  return p;
}

describe('startCoreDaemon', () => {
  it('starts the core, serves aw, refuses a second core, and stops with hosts left running', async () => {
    expect(os.homedir()).toBe(home);
    const { startCoreDaemon } = await import('../src/daemon/startCore');
    const { socketAnswers } = await import('../src/core/control/probe');
    const { readCoreManifest } = await import('../src/core/daemon/coreDaemon');
    const { ControlClient } = await import('../src/cli/client');

    const lines: string[] = [];
    const power = fakePower();
    let wake: ((gap: number) => void) | undefined;
    let sleepDisposed = false;
    const loginChanges: number[] = [];
    const base = {
      dataDir,
      fallbackRunDir,
      build: 'b-test',
      runtime: refusingRuntime,
      runtimeDir: '/Users/test/rt',
      log: (m: string) => lines.push(m),
      securityRunner: security,
      fixToolPath: false,
    };
    const result = await startCoreDaemon({
      ...base,
      power,
      watchSleep: (onWake) => {
        wake = onWake;
        return { dispose: () => (sleepDisposed = true) };
      },
      onOpenAtLoginChange: () => loginChanges.push(1),
    });
    if (!result.started) throw new Error(result.reason);
    const daemon = result.daemon;

    // The socket is where the app's would be, and it answers.
    expect(daemon.paths.socketPath.endsWith('core.sock')).toBe(true);
    expect(await socketAnswers(daemon.paths.socketPath)).toBe(true);
    expect(lines).toContain('Agent Wrangler started');

    // The manifest names this process and its runtime.
    expect(readCoreManifest(daemon.paths.manifestPath)).toMatchObject({ pid: process.pid, build: 'b-test', dataDir, runtimeDir: '/Users/test/rt' });

    // `aw` works: the CLI's client, its handshake and a read.
    const client = await ControlClient.connect({ runDir: daemon.paths.runDir, fallbackRunDir }, { build: 'b-test' });
    expect(client).toBeDefined();
    expect(client!.hello.build).toBe('b-test');
    const status = await client!.request<{ sessions?: unknown }>('status');
    expect(status).toBeTypeOf('object');
    client!.close();

    // Power: synced at once, nothing working, so not held.
    expect(power.sets[0]).toBe(false);

    // Wake: the app rechecks its links.
    const resume = vi.spyOn(daemon.app, 'onSystemResume');
    wake!(120_000);
    expect(resume).toHaveBeenCalledTimes(1);

    // Open at login → the plist's RunAtLoad.
    await daemon.host.settingsStore.update('openAtLogin', true);
    expect(loginChanges).toHaveLength(1);

    // A second core, of either kind, refuses before building anything.
    const second = await startCoreDaemon({ ...base, power: fakePower(), watchSleep: () => ({ dispose: () => undefined }) });
    expect(second.started).toBe(false);
    if (!second.started) {
      expect(second.holder.kind).toBe('daemon');
      expect(second.reason).toContain(`pid ${process.pid}`);
    }

    // An ordinary stop: hosts would keep running; everything else goes.
    const stopHosted: boolean[] = [];
    const realStop = daemon.app.stopAllForQuit.bind(daemon.app);
    daemon.app.stopAllForQuit = (ms, o) => {
      stopHosted.push(o?.includeHosted ?? false);
      return realStop(ms, o);
    };
    const decision = await daemon.stop('signal');
    expect(decision).toMatchObject({ stopHosted: false, confirm: false });
    expect(stopHosted).toEqual([false]);
    expect(await daemon.stop('menuStopAll')).toBe(decision); // once only
    expect(power.disposed).toBe(true);
    expect(sleepDisposed).toBe(true);
    expect(fs.existsSync(daemon.paths.manifestPath)).toBe(false);
    expect(await socketAnswers(daemon.paths.socketPath)).toBe(false);

    // Never the real home.
    expect(lines.filter((l) => l.includes(os.userInfo().homedir))).toEqual([]);
  });

  it('stop --all ends hosted sessions too', async () => {
    const { startCoreDaemon } = await import('../src/daemon/startCore');
    const result = await startCoreDaemon({
      dataDir,
      fallbackRunDir,
      build: 'b-test',
      runtime: refusingRuntime,
      log: () => undefined,
      securityRunner: security,
      fixToolPath: false,
      power: fakePower(),
      watchSleep: () => ({ dispose: () => undefined }),
    });
    if (!result.started) throw new Error(result.reason);
    const seen: boolean[] = [];
    const real = result.daemon.app.stopAllForQuit.bind(result.daemon.app);
    result.daemon.app.stopAllForQuit = (ms, o) => {
      seen.push(o?.includeHosted ?? false);
      return real(ms, o);
    };
    expect(await result.daemon.stop('menuStopAll')).toMatchObject({ stopHosted: true });
    expect(seen).toEqual([true]);
  });

  it('runs Discord in-process: retires the remote daemon first, then connects with the Keychain token (#138)', async () => {
    const { startCoreDaemon } = await import('../src/daemon/startCore');
    const { Emitter } = await import('../src/core/events');
    const dir = path.join(root, 'discord');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        showUsage: false,
        'autoPause.enabled': false,
        codexBinaryPath: path.join(root, 'no-codex'),
        'remote.enabled': true,
        'remote.discord.guildId': 'G1',
        'remote.discord.channelId': 'C1',
        'remote.discord.authorizedUserIds': 'U1',
      }),
    );
    const keychain: string[][] = [];
    const securityWithToken: SecurityRunner = {
      available: () => true,
      run: async (args) => {
        keychain.push(args);
        return args[0] === 'find-generic-password' && args.includes('remote.discord.botToken')
          ? { code: 0, stdout: 'tok-kc\n', stderr: '' }
          : { code: 44, stdout: '', stderr: 'not found' };
      },
    };
    const order: string[] = [];
    let retired!: () => void;
    const retiring = new Promise<void>((r) => (retired = r));
    const transports: { token: string; connected: boolean }[] = [];
    const result = await startCoreDaemon({
      dataDir: dir,
      fallbackRunDir,
      build: 'b-test',
      runtime: refusingRuntime,
      log: () => undefined,
      securityRunner: securityWithToken,
      fixToolPath: false,
      power: fakePower(),
      watchSleep: () => ({ dispose: () => undefined }),
      remoteInProcess: {
        retireDaemon: async () => {
          order.push('retire');
          await retiring;
          order.push('retired');
        },
        mirrorFile: path.join(dir, 'mirrors.json'),
        makeTransport: (token) => {
          order.push('transport');
          const invoke = new Emitter<RemoteInvocation>();
          const conn = new Emitter<void>();
          const t = {
            id: 'fake',
            token,
            connected: false,
            onDidInvoke: (l: (i: RemoteInvocation) => void) => invoke.event(l),
            onDidChangeConnection: (l: () => void) => conn.event(l),
            connect: async () => {
              t.connected = true;
              conn.fire();
            },
            disconnect: async () => {
              t.connected = false;
              conn.fire();
            },
            publish: async () => ({ channelId: 'C1', messageId: 'M1' }),
            update: async () => undefined,
            close: async () => undefined,
            reply: async () => undefined,
            notify: async () => undefined,
            dispose: () => undefined,
          };
          transports.push(t);
          return t;
        },
      },
    });
    if (!result.started) throw new Error(result.reason);

    // Nothing connects, and the Keychain is not read, while the remote daemon is still going.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['retire']);
    expect(transports).toEqual([]);

    retired();
    const deadline = Date.now() + 3000;
    while (!transports[0]?.connected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['retire', 'retired', 'transport']);
    expect(transports.map((t) => t.token)).toEqual(['tok-kc']);
    expect(transports[0].connected).toBe(true);
    expect(keychain.some((a) => a[0] === 'find-generic-password' && a.includes('remote.discord.botToken'))).toBe(true);

    // A stop hangs up.
    await result.daemon.stop('signal');
    expect(transports[0].connected).toBe(false);
  });

  it('refuses while the app holds the core, and builds nothing', async () => {
    const { startCoreDaemon } = await import('../src/daemon/startCore');
    const dir = path.join(root, 'app-holds');
    const lines: string[] = [];
    const result = await startCoreDaemon({
      dataDir: dir,
      fallbackRunDir,
      build: 'b-test',
      runtime: refusingRuntime,
      log: (m) => lines.push(m),
      securityRunner: security,
      fixToolPath: false,
      probe: async () => true, // something answers, and no daemon manifest: the app
    });
    expect(result.started).toBe(false);
    if (!result.started) expect(result.holder.kind).toBe('app');
    expect(fs.existsSync(dir)).toBe(false);
    expect(lines).toEqual([]);
  });
});
