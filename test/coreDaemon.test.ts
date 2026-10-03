/**
 * The core daemon's pieces that are not the daemon (#130): its plist, its
 * files, single-instance arbitration, quit intents, the agent that installs
 * and stops it (with launchd, processes and the socket faked), and `aw daemon`.
 * Nothing here touches launchd, the real data directory or a real process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args';
import { runDaemonCommand, type DaemonIo } from '../src/cli/daemon';
import {
  CORE_DAEMON_LABEL,
  coreDaemonEntryFor,
  coreDaemonEnv,
  coreDaemonPaths,
  describeCoreHolder,
  findCoreHolder,
  formatUptime,
  locateInstall,
  parseCoreManifest,
  readCoreManifest,
  readSetting,
  removeCoreManifest,
  takeQuitIntent,
  writeCoreManifest,
  writeQuitIntent,
  type CoreDaemonManifest,
} from '../src/core/daemon/coreDaemon';
import { quitIntentSource, quitPolicy } from '../src/core/session/quitPolicy';
import type { SessionHostRuntime } from '../src/core/session/hostSupervisor';
import { cloneLaunch } from '../src/core/session/sessionHostRuntime';
import { menuBarSessions, shouldPreventAppSuspension } from '../src/core/menuBar';
import { createCoreDaemonAgent, CoreDaemonError, type CoreDaemonAgent } from '../src/node/coreDaemonAgent';
import { renderLaunchAgent } from '../src/remote/daemon/launchAgent';
import type { AgentSession } from '../src/shared/model';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-core-daemon-'));
let seq = 0;
const tempDir = () => {
  const d = path.join(root, `d${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const HOST_APP = '/Users/test/Library/Application Support/Agent Wrangler/runtimes/b1/Agent Wrangler Host.app';

function manifest(over: Partial<CoreDaemonManifest> = {}): CoreDaemonManifest {
  return { pid: 4242, build: 'b1', startedAt: 1_000, dataDir: '/Users/test/data', ...over };
}

describe('plist', () => {
  it('renders the core LaunchAgent: label, bundled Node on the unpacked daemon, keep-alive on crash only, Aqua, log', () => {
    const rt = { ...cloneLaunch(HOST_APP, true), runtimeDir: path.dirname(HOST_APP) };
    const text = renderLaunchAgent({
      label: CORE_DAEMON_LABEL,
      program: rt.exe,
      args: [coreDaemonEntryFor(rt.entry)],
      env: coreDaemonEnv({ dataDir: '/Users/test/data', fallbackRunDir: '/Users/test/.agentwrangler/run' }, rt),
      logFile: '/Users/test/data/logs/core-daemon.log',
      runAtLoad: false,
    });
    expect(text).toContain('<string>com.hammonjj.agentwrangler.core</string>');
    expect(text).toContain(`<string>${HOST_APP}/Contents/Resources/node/bin/Agent Wrangler Host</string>`);
    expect(text).toContain(`<string>${HOST_APP}/Contents/Resources/app.asar.unpacked/dist/daemon/main.js</string>`);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\n {2}<false\/>/);
    expect(text).toMatch(/<key>KeepAlive<\/key>\n {2}<dict>\n {4}<key>SuccessfulExit<\/key>\n {4}<false\/>/);
    expect(text).toContain('<string>Interactive</string>');
    expect(text).toContain('<string>Aqua</string>');
    expect(text).toContain('<string>/Users/test/data/logs/core-daemon.log</string>');
    expect(text).toContain('<key>AW_DATA_DIR</key>');
    expect(text).toContain('<key>AW_CORE_RUNTIME_DIR</key>');
    expect(text).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('keeps RunAtLoad on by default (the remote daemon) and on when asked', () => {
    const base = { label: 'x', program: '/p', args: [], env: {}, logFile: '/l' };
    expect(renderLaunchAgent(base)).toMatch(/<key>RunAtLoad<\/key>\n {2}<true\/>/);
    expect(renderLaunchAgent({ ...base, runAtLoad: true })).toMatch(/<key>RunAtLoad<\/key>\n {2}<true\/>/);
  });

  it('maps a runtime to the daemon entry and environment', () => {
    expect(coreDaemonEntryFor('/r/app.asar/dist/sessionHost/main.js')).toBe('/r/app.asar/dist/daemon/main.js');
    expect(coreDaemonEnv({ dataDir: '/d', fallbackRunDir: '/f' }, { env: { ELECTRON_RUN_AS_NODE: '1' } })).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      AW_DATA_DIR: '/d',
      AW_FALLBACK_RUN_DIR: '/f',
    });
  });
});

describe('locateInstall', () => {
  it('a bundle or runtime clone: packaged, the .app above Resources', () => {
    expect(locateInstall(`${HOST_APP}/Contents/Resources/app.asar.unpacked/dist/daemon`)).toEqual({
      isPackaged: true,
      appRoot: `${HOST_APP}/Contents/Resources/app.asar`,
      bundle: HOST_APP,
    });
  });
  it('a checkout: unpackaged, the repo root', () => {
    expect(locateInstall('/Users/test/src/aw/dist/cli')).toEqual({ isPackaged: false, appRoot: '/Users/test/src/aw' });
  });
});

describe('paths and manifest', () => {
  it('puts everything under the data dir, the socket at run/core.sock like the app', () => {
    const p = coreDaemonPaths('/Users/test/data', '/Users/test/.agentwrangler/run');
    expect(p.socketPath).toBe('/Users/test/data/run/core.sock');
    expect(p.manifestPath).toBe('/Users/test/data/run/core-daemon.json');
    expect(p.quitIntentPath).toBe('/Users/test/data/run/quit-intent');
    expect(p.logFile).toBe('/Users/test/data/logs/core-daemon.log');
  });

  it('writes, reads and removes only its own manifest', () => {
    const file = path.join(tempDir(), 'run', 'core-daemon.json');
    writeCoreManifest(file, manifest({ runtimeDir: '/r' }));
    expect(readCoreManifest(file)).toEqual(manifest({ runtimeDir: '/r' }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    removeCoreManifest(file, 1); // someone else's pid
    expect(fs.existsSync(file)).toBe(true);
    removeCoreManifest(file, 4242);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects malformed manifests', () => {
    expect(parseCoreManifest('not json')).toBeUndefined();
    expect(parseCoreManifest(JSON.stringify({ pid: -1, build: 'b', startedAt: 1, dataDir: '/d' }))).toBeUndefined();
    expect(parseCoreManifest(JSON.stringify({ pid: 3, build: 'b', startedAt: 1 }))).toBeUndefined();
  });

  it('reads one setting without a host, falling back on absence or a wrong type', () => {
    const dir = tempDir();
    expect(readSetting(dir, 'openAtLogin', false)).toBe(false);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ openAtLogin: true, 'experimental.coreDaemon': 'yes' }));
    expect(readSetting(dir, 'openAtLogin', false)).toBe(true);
    expect(readSetting(dir, 'experimental.coreDaemon', false)).toBe(false);
  });
});

describe('findCoreHolder: one core at a time', () => {
  const base = { socketPath: '/s', manifestPath: '/m' };
  it('nothing answers: nobody, whatever a stale manifest says', async () => {
    const h = await findCoreHolder({ ...base, probe: async () => false, read: () => manifest(), alive: () => true });
    expect(h).toEqual({ kind: 'none' });
  });
  it('answers, with a live daemon manifest: the daemon', async () => {
    const h = await findCoreHolder({ ...base, probe: async () => true, read: () => manifest(), alive: () => true });
    expect(h).toEqual({ kind: 'daemon', manifest: manifest() });
    expect(describeCoreHolder(h, 1_000 + 65_000)).toBe('the core daemon is running it (pid 4242, build b1, up 1m 5s)');
  });
  it('answers, with no manifest or a dead pid: the app', async () => {
    expect(await findCoreHolder({ ...base, probe: async () => true, read: () => undefined })).toEqual({ kind: 'app' });
    expect(await findCoreHolder({ ...base, probe: async () => true, read: () => manifest(), alive: () => false })).toEqual({ kind: 'app' });
  });
  it('probes the path it is given', async () => {
    const asked: string[] = [];
    await findCoreHolder({ ...base, probe: async (p) => (asked.push(p), false) });
    expect(asked).toEqual(['/s']);
  });
});

describe('quit intents', () => {
  it('maps stop to an ordinary signal stop and stop-all to ⌥⌘Q', () => {
    expect(quitIntentSource('stop', 10)).toBe('signal');
    expect(quitIntentSource('stop-all\n', 10)).toBe('menuStopAll');
    expect(quitIntentSource('install', 10)).toBe('install');
    expect(quitIntentSource('toString', 10)).toBeUndefined();
  });

  it('policy: a plain stop keeps hosts, stop --all ends them, neither asks', () => {
    const plain = quitPolicy({ source: quitIntentSource('stop', 10)!, local: 2, hosted: 3 });
    expect(plain).toMatchObject({ confirm: false, stopHosted: false });
    const all = quitPolicy({ source: quitIntentSource('stop-all', 10)!, local: 2, hosted: 3 });
    expect(all).toMatchObject({ confirm: false, stopHosted: true });
  });

  it('is consumed by the first reader, and ignored once stale', () => {
    const file = path.join(tempDir(), 'run', 'quit-intent');
    writeQuitIntent(file, 'stop-all');
    expect(takeQuitIntent(file)).toBe('menuStopAll');
    expect(fs.existsSync(file)).toBe(false);
    expect(takeQuitIntent(file)).toBeUndefined();
    writeQuitIntent(file, 'stop-all');
    expect(takeQuitIntent(file, Date.now() + 120_000)).toBeUndefined();
  });
});

describe('power: shouldPreventAppSuspension(menuBarSessions(app))', () => {
  const session = (over: Partial<AgentSession>): AgentSession => ({ key: 'claude:a', sessionId: 'a', title: 't', status: 'busy', ...over }) as AgentSession;
  const app = (sessions: AgentSession[], owned: string[]) => ({
    store: { sessions },
    archive: { isArchived: () => false },
    runners: { owns: (id: string) => owned.includes(id) },
    codexRunners: { owns: () => false },
  });
  it('holds only for a working or asking agent this core runs', () => {
    expect(shouldPreventAppSuspension(menuBarSessions(app([session({ status: 'busy' })], ['a'])))).toBe(true);
    expect(shouldPreventAppSuspension(menuBarSessions(app([session({ status: 'blocked' })], ['a'])))).toBe(true);
    expect(shouldPreventAppSuspension(menuBarSessions(app([session({ status: 'busy' })], [])))).toBe(false);
    expect(shouldPreventAppSuspension(menuBarSessions(app([session({ status: 'waiting' })], ['a'])))).toBe(false);
  });
});

it('formatUptime', () => {
  expect(formatUptime(12_000)).toBe('12s');
  expect(formatUptime(3 * 3600_000 + 5 * 60_000)).toBe('3h 5m');
  expect(formatUptime(2 * 86_400_000 + 3600_000)).toBe('2d 1h');
  expect(formatUptime(-5)).toBe('0s');
});

// ---- The agent: install, update, start, stop, with launchd faked ----

interface World {
  calls: string[][];
  answering: boolean;
  manifest?: CoreDaemonManifest;
  alivePids: Set<number>;
  spawned: { exe: string; args: string[]; env: NodeJS.ProcessEnv }[];
  killed: [number, string][];
  loaded: boolean;
}

function setup(opts: { packaged: boolean; build?: string; settings?: Record<string, unknown>; over?: { dataDir: string; world: World } }) {
  const dataDir = opts.over?.dataDir ?? tempDir();
  if (opts.settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(opts.settings));
  const plistPath = path.join(dataDir, 'LaunchAgents', `${CORE_DAEMON_LABEL}.plist`);
  const build = opts.build ?? 'b2';
  const world: World = opts.over?.world ?? { calls: [], answering: false, alivePids: new Set(), spawned: [], killed: [], loaded: false };
  const paths = coreDaemonPaths(dataDir, path.join(dataDir, 'fb'));
  /** What "the daemon came up" looks like: it answers and writes its manifest. Each build has its own pid. */
  const pidOf = (b: string) => 700 + Number(b.replace(/\D/g, '') || 0);
  const daemonUp = (b = build) => {
    world.answering = true;
    world.manifest = manifest({ pid: pidOf(b), build: b, dataDir });
    world.alivePids.add(pidOf(b));
    writeCoreManifest(paths.manifestPath, world.manifest);
  };
  const runtime: SessionHostRuntime = {
    buildId: build,
    prepare: async () =>
      opts.packaged
        ? { ...cloneLaunch(`/rt/${build}/Agent Wrangler Host.app`, true), runtimeDir: `/rt/${build}` }
        : { exe: '/usr/local/bin/node', entry: '/Users/test/src/aw/dist/sessionHost/main.js', env: {} },
    gc: () => undefined,
  };
  const agent = createCoreDaemonAgent({
    dataDir,
    fallbackRunDir: path.join(dataDir, 'fb'),
    runtime,
    isPackaged: opts.packaged,
    log: () => undefined,
    plistPath,
    domain: 'gui/501',
    probe: async () => world.answering,
    alive: (pid) => world.alivePids.has(pid),
    sleep: async () => undefined,
    startTimeoutMs: 1000,
    stopTimeoutMs: 1000,
    launchctl: async (args) => {
      world.calls.push(args);
      if (args[0] === 'print' && !world.loaded) throw new Error('not loaded');
      if (args[0] === 'bootstrap') world.loaded = true;
      if (args[0] === 'bootout') {
        // The old daemon gets SIGTERM and goes.
        world.loaded = false;
        world.answering = false;
        world.alivePids.clear();
      }
      if (args[0] === 'kickstart') daemonUp();
      return '';
    },
    spawnDetached: (exe, args, env) => {
      world.spawned.push({ exe, args, env });
      daemonUp();
      return pidOf(build);
    },
    kill: (pid, signal) => {
      world.killed.push([pid, signal]);
      world.alivePids.delete(pid);
    },
  });
  return { agent, world, dataDir, plistPath, paths, daemonUp };
}

describe('createCoreDaemonAgent', () => {
  it('first start, packaged: writes the plist, bootstraps, kickstarts, waits for it to answer', async () => {
    const { agent, world, plistPath } = setup({ packaged: true });
    const r = await agent.ensure();
    expect(r.outcome).toBe('installed');
    expect(r.manifest.pid).toBe(702);
    expect(world.calls.map((c) => c[0])).toEqual(['bootout', 'bootstrap', 'kickstart']);
    expect(world.calls[1]).toEqual(['bootstrap', 'gui/501', plistPath]);
    expect(world.calls[2]).toEqual(['kickstart', `gui/501/${CORE_DAEMON_LABEL}`]);
    const text = fs.readFileSync(plistPath, 'utf8');
    expect(text).toContain('/rt/b2/Agent Wrangler Host.app/Contents/Resources/app.asar.unpacked/dist/daemon/main.js');
    expect(text).toMatch(/<key>RunAtLoad<\/key>\n {2}<false\/>/);
  });

  it('RunAtLoad follows Open at login', async () => {
    const { agent } = setup({ packaged: true, settings: { openAtLogin: true } });
    expect(await agent.renderPlist()).toMatch(/<key>RunAtLoad<\/key>\n {2}<true\/>/);
  });

  it('already running on this build: nothing to do', async () => {
    const { agent, world, daemonUp } = setup({ packaged: true });
    daemonUp('b2');
    expect((await agent.ensure()).outcome).toBe('running');
    expect(world.calls).toEqual([]);
  });

  it('a new build: the plist changes, so bootout (the old one stops, hosts stay) and bootstrap', async () => {
    const old = setup({ packaged: true, build: 'b1' });
    expect((await old.agent.ensure()).manifest.build).toBe('b1');
    const oldText = fs.readFileSync(old.plistPath, 'utf8');
    // The same data dir, plist and launchd; a newer `aw`.
    const next = setup({ packaged: true, build: 'b2', over: { dataDir: old.dataDir, world: old.world } });
    old.world.calls = [];
    const r = await next.agent.ensure();
    expect(r.outcome).toBe('updated');
    expect(r.manifest).toMatchObject({ build: 'b2', pid: 702 });
    expect(fs.readFileSync(old.plistPath, 'utf8')).not.toBe(oldText);
    expect(fs.readFileSync(old.plistPath, 'utf8')).toContain('/rt/b2/');
    expect(old.world.calls.map((c) => c[0])).toEqual(['bootout', 'bootstrap', 'kickstart']);
  });

  it('installed but stopped: kickstart only', async () => {
    const { agent, world } = setup({ packaged: true });
    await agent.ensure();
    world.answering = false;
    world.alivePids.clear();
    world.calls = [];
    expect((await agent.ensure()).outcome).toBe('started');
    expect(world.calls.map((c) => c[0])).toEqual(['print', 'kickstart']);
  });

  it('refuses while the app holds the core', async () => {
    const { agent, world } = setup({ packaged: true });
    world.answering = true; // no manifest: the app
    await expect(agent.ensure()).rejects.toBeInstanceOf(CoreDaemonError);
    expect(world.calls).toEqual([]);
  });

  it('unpackaged: spawns the checkout daemon detached, no launchd', async () => {
    const { agent, world, dataDir } = setup({ packaged: false });
    const r = await agent.ensure();
    expect(r.outcome).toBe('spawned');
    expect(world.calls).toEqual([]);
    expect(world.spawned[0].exe).toBe('/usr/local/bin/node');
    expect(world.spawned[0].args).toEqual(['/Users/test/src/aw/dist/daemon/main.js']);
    expect(world.spawned[0].env.AW_DATA_DIR).toBe(dataDir);
    expect(world.spawned[0].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('stop: intent file, then SIGTERM to the manifest pid', async () => {
    const { agent, world, paths, daemonUp } = setup({ packaged: true });
    daemonUp();
    const r = await agent.stop(false);
    expect(r).toEqual({ outcome: 'stopped', pid: 702 });
    expect(world.killed).toEqual([[702, 'SIGTERM']]);
    expect(fs.readFileSync(paths.quitIntentPath, 'utf8')).toBe('stop');
    daemonUp();
    await agent.stop(true);
    expect(fs.readFileSync(paths.quitIntentPath, 'utf8')).toBe('stop-all');
  });

  it('stop: nothing running, or the app holding the core, signals nobody', async () => {
    const { agent, world } = setup({ packaged: true });
    expect(await agent.stop(false)).toEqual({ outcome: 'not-running' });
    world.answering = true;
    expect(await agent.stop(true)).toEqual({ outcome: 'app' });
    expect(world.killed).toEqual([]);
  });

  it('syncPlist rewrites an installed plist for Open at login, without reloading it', async () => {
    const { agent, world, plistPath, dataDir } = setup({ packaged: true });
    expect(await agent.syncPlist()).toBe(false); // not installed
    await agent.ensure();
    world.calls = [];
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ openAtLogin: true }));
    expect(await agent.syncPlist()).toBe(true);
    expect(fs.readFileSync(plistPath, 'utf8')).toMatch(/<key>RunAtLoad<\/key>\n {2}<true\/>/);
    expect(world.calls).toEqual([]);
    expect(await agent.syncPlist()).toBe(false);
  });
});

// ---- aw daemon ----

describe('aw daemon: arguments', () => {
  it('parses start, stop, stop --all and status', () => {
    expect(parseArgs(['daemon', 'start'])).toEqual({ kind: 'daemon', action: 'start', all: false, json: false });
    expect(parseArgs(['daemon', 'stop'])).toEqual({ kind: 'daemon', action: 'stop', all: false, json: false });
    expect(parseArgs(['daemon', 'stop', '--all'])).toEqual({ kind: 'daemon', action: 'stop', all: true, json: false });
    expect(parseArgs(['daemon', 'status', '--json'])).toEqual({ kind: 'daemon', action: 'status', all: false, json: true });
  });
  it('refuses the rest', () => {
    expect(parseArgs(['daemon'])).toHaveProperty('error');
    expect(parseArgs(['daemon', 'restart'])).toHaveProperty('error');
    expect(parseArgs(['daemon', 'start', '--all'])).toEqual({ error: 'aw daemon: unknown option --all' });
    expect(parseArgs(['daemon', 'status', '--all'])).toEqual({ error: 'aw daemon: unknown option --all' });
    expect(parseArgs(['daemon', 'stop', 'now'])).toEqual({ error: 'aw daemon stop: unexpected "now"' });
  });
});

describe('aw daemon: commands', () => {
  const io = (env: Record<string, string | undefined> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const value: DaemonIo & { out_: string[]; err_: string[] } = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      env,
      now: () => 1_000 + 3_725_000,
      out_: out,
      err_: err,
    };
    return value;
  };
  const fake = (over: Partial<Pick<CoreDaemonAgent, 'ensure' | 'stop' | 'status'>> = {}) => ({
    ensure: async () => ({ outcome: 'installed' as const, manifest: manifest() }),
    stop: async () => ({ outcome: 'stopped' as const, pid: 4242 }),
    status: async () => ({ holder: { kind: 'daemon' as const, manifest: manifest() }, launchAgent: true, plistPath: '/p.plist' }),
    ...over,
  });

  it('start reports what it did', async () => {
    const i = io();
    expect(await runDaemonCommand({ action: 'start', all: false, json: false }, fake(), i)).toBe(0);
    expect(i.out_.join('')).toBe('Installed and started the core daemon: pid 4242, build b1.\n');
  });

  it('start explains a refusal and exits 1', async () => {
    const i = io();
    const code = await runDaemonCommand({ action: 'start', all: false, json: false }, fake({ ensure: async () => { throw new CoreDaemonError('app holds it'); } }), i);
    expect(code).toBe(1);
    expect(i.err_.join('')).toBe('aw daemon start: app holds it\n');
  });

  it('stop --all is refused inside an agent; a plain stop is not', async () => {
    let stops = 0;
    const agent = fake({ stop: async () => (stops++, { outcome: 'stopped' as const, pid: 1 }) });
    const inAgent = io({ CLAUDECODE: '1' });
    expect(await runDaemonCommand({ action: 'stop', all: true, json: false }, agent, inAgent)).toBe(3);
    expect(stops).toBe(0);
    expect(await runDaemonCommand({ action: 'stop', all: false, json: false }, agent, inAgent)).toBe(0);
    expect(stops).toBe(1);
    expect(inAgent.out_.join('')).toContain('keep running');
  });

  it('status: pid, build and uptime; exit 1 when not running', async () => {
    const i = io();
    expect(await runDaemonCommand({ action: 'status', all: false, json: false }, fake(), i)).toBe(0);
    expect(i.out_.join('')).toContain('pid      4242');
    expect(i.out_.join('')).toContain('build    b1');
    expect(i.out_.join('')).toContain('uptime   1h 2m');
    const j = io();
    const none = fake({ status: async () => ({ holder: { kind: 'none' as const }, launchAgent: false, plistPath: '/p' }) });
    expect(await runDaemonCommand({ action: 'status', all: false, json: true }, none, j)).toBe(1);
    expect(JSON.parse(j.out_.join(''))).toEqual({ running: false, holder: 'none', launchAgent: false });
  });
});
