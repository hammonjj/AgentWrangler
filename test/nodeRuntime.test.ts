/**
 * The bundled Node runtime (#129): where hosts, the remote daemon and `aw`
 * find their executable and entry, and what environment they get. Fake
 * bundles in a temp dir; nothing here runs a real host.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostProcessEnv } from '../src/core/session/hostSupervisor';
import { cloneLaunch, createSessionHostRuntime, devLaunch } from '../src/electron/sessionHostRuntime';
import { daemonEntryFor, remoteDaemonEnv, renderLaunchAgent } from '../src/remote/daemon/launchAgent';

const HOST_APP = '/Users/test/Library/Application Support/Agent Wrangler/runtimes/b1/Agent Wrangler Host.app';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-node-runtime-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

/** A bundle shaped like the packaged app, with shell scripts for executables. */
function fakeBundle(root: string, opts: { node: boolean }): string {
  const app = path.join(root, 'Agent Wrangler.app');
  write(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>Agent Wrangler</string></dict></plist>\n');
  write(
    path.join(app, 'Contents', 'MacOS', 'Agent Wrangler'),
    '#!/bin/bash\necho "electron RUN_AS_NODE=${ELECTRON_RUN_AS_NODE:-} $*"\n',
    0o755,
  );
  for (const name of ['sessionHost', 'remoteDaemon', 'cli']) {
    write(path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'dist', name, 'main.js'), '');
  }
  if (opts.node) {
    write(path.join(app, 'Contents', 'Resources', 'node', 'bin', 'node'), '#!/bin/bash\necho "node RUN_AS_NODE=${ELECTRON_RUN_AS_NODE:-} $*"\n', 0o755);
  }
  return app;
}

describe('host launch specs', () => {
  it('runs a clone on its renamed bundled Node, from the unpacked programs, with no RUN_AS_NODE', () => {
    expect(cloneLaunch(HOST_APP, true)).toEqual({
      exe: `${HOST_APP}/Contents/Resources/node/bin/Agent Wrangler Host`,
      entry: `${HOST_APP}/Contents/Resources/app.asar.unpacked/dist/sessionHost/main.js`,
      env: {},
    });
  });

  it('falls back to the renamed Electron executable as Node for a bundle without Node', () => {
    expect(cloneLaunch(HOST_APP, false)).toEqual({
      exe: `${HOST_APP}/Contents/MacOS/Agent Wrangler Host`,
      entry: `${HOST_APP}/Contents/Resources/app.asar/dist/sessionHost/main.js`,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('runs unpackaged hosts on the Electron binary and the repo dist', () => {
    expect(devLaunch('/Users/test/proj', '/Users/test/proj/node_modules/electron/dist/Electron')).toEqual({
      exe: '/Users/test/proj/node_modules/electron/dist/Electron',
      entry: '/Users/test/proj/dist/sessionHost/main.js',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('finds the daemon entry beside an unpacked session host entry', () => {
    expect(daemonEntryFor(cloneLaunch(HOST_APP, true).entry)).toBe(`${HOST_APP}/Contents/Resources/app.asar.unpacked/dist/remoteDaemon/main.js`);
  });
});

describe('host environment', () => {
  it('drops an inherited RUN_AS_NODE unless the runtime asks for it', () => {
    const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' };
    expect(hostProcessEnv(base, {}, undefined)).toEqual({ PATH: '/usr/bin' });
    expect(hostProcessEnv(base, undefined, undefined)).toEqual({ PATH: '/usr/bin' });
    expect(hostProcessEnv({ PATH: '/usr/bin' }, { ELECTRON_RUN_AS_NODE: '1' }, { AW_SESSION_HOST_FAKE: '1' })).toEqual({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      AW_SESSION_HOST_FAKE: '1',
    });
  });

  it('gives the remote daemon LaunchAgent the bundled Node and no RUN_AS_NODE', () => {
    const rt = { ...cloneLaunch(HOST_APP, true), runtimeDir: '/Users/test/rt/b1' };
    const env = remoteDaemonEnv({ runDir: '/Users/test/run', fallbackRunDir: '/tmp/aw-501' }, rt);
    expect(env).toEqual({ AW_RUN_DIR: '/Users/test/run', AW_FALLBACK_RUN_DIR: '/tmp/aw-501', AW_REMOTE_RUNTIME_DIR: '/Users/test/rt/b1' });
    const plist = renderLaunchAgent({ label: 'com.example.remote', program: rt.exe, args: [daemonEntryFor(rt.entry)], env, logFile: '/Users/test/l.log' });
    expect(plist).toContain('<string>/Users/test/Library/Application Support/Agent Wrangler/runtimes/b1/Agent Wrangler Host.app/Contents/Resources/node/bin/Agent Wrangler Host</string>');
    expect(plist).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('keeps RUN_AS_NODE in the daemon environment for the Electron fallback', () => {
    const env = remoteDaemonEnv({ runDir: '/r', fallbackRunDir: '/f' }, { ...cloneLaunch(HOST_APP, false) });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.AW_REMOTE_RUNTIME_DIR).toBeUndefined();
  });
});

describe('cloned runtime', () => {
  const runtimeFor = (bundle: string, userDataDir: string, logs: string[]) =>
    createSessionHostRuntime({
      userDataDir,
      appRoot: path.join(bundle, 'Contents', 'Resources', 'app.asar'),
      isPackaged: true,
      execPath: path.join(bundle, 'Contents', 'MacOS', 'Agent Wrangler'),
      log: (m) => logs.push(m),
    });

  it('clones the bundle and renames its Node to the host name', async () => {
    const root = tmp();
    const bundle = fakeBundle(root, { node: true });
    const logs: string[] = [];
    const rt = await runtimeFor(bundle, path.join(root, 'data'), logs).prepare();
    const hostApp = path.join(root, 'data', 'runtimes', 'dev', 'Agent Wrangler Host.app');
    expect(rt).toEqual({ ...cloneLaunch(hostApp, true), runtimeDir: path.join(root, 'data', 'runtimes', 'dev') });
    expect(fs.existsSync(rt.exe)).toBe(true);
    expect(fs.existsSync(path.join(hostApp, 'Contents', 'Resources', 'node', 'bin', 'node'))).toBe(false);
    // The original is untouched.
    expect(fs.existsSync(path.join(bundle, 'Contents', 'Resources', 'node', 'bin', 'node'))).toBe(true);
    expect(execFileSync(rt.exe, ['x'], { encoding: 'utf8' })).toBe('node RUN_AS_NODE= x\n');
    expect(logs.some((l) => l.includes('bundled Node'))).toBe(true);
  });

  it('reuses an existing clone and still finds its Node', async () => {
    const root = tmp();
    const bundle = fakeBundle(root, { node: true });
    const first = await runtimeFor(bundle, path.join(root, 'data'), []).prepare();
    const logs: string[] = [];
    const second = await runtimeFor(bundle, path.join(root, 'data'), logs).prepare();
    expect(second).toEqual(first);
    expect(logs.some((l) => l.startsWith('cloned'))).toBe(false);
  });

  it('falls back to Electron as Node when the bundle has no Node', async () => {
    const root = tmp();
    const bundle = fakeBundle(root, { node: false });
    const rt = await runtimeFor(bundle, path.join(root, 'data'), []).prepare();
    expect(rt.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(path.basename(rt.exe)).toBe('Agent Wrangler Host');
    expect(rt.exe).toContain(`${path.sep}MacOS${path.sep}`);
  });
});

describe('bin/aw', () => {
  const aw = path.resolve(__dirname, '..', 'bin', 'aw');
  const runAw = (app: string, args: string[]) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AW_APP: app };
    return execFileSync('/bin/bash', [aw, ...args], { encoding: 'utf8', env });
  };

  it('runs the CLI on the bundled Node from app.asar.unpacked', () => {
    const app = fakeBundle(tmp(), { node: true });
    expect(runAw(app, ['status'])).toBe(`node RUN_AS_NODE= ${app}/Contents/Resources/app.asar.unpacked/dist/cli/main.js status\n`);
  });

  it('falls back to the app binary as Node for an install without bundled Node', () => {
    const app = fakeBundle(tmp(), { node: false });
    expect(runAw(app, ['status'])).toBe(`electron RUN_AS_NODE=1 ${app}/Contents/Resources/app.asar/dist/cli/main.js status\n`);
  });
});
