/**
 * The bundled Node runtime (#129, #142): where hosts, the core daemon and
 * `aw` find their executable and entry, and what environment they get. Fake
 * bundles in a temp dir; nothing here runs a real host.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coreDaemonEntryFor } from '../src/core/daemon/coreDaemon';
import { hostProcessEnv } from '../src/core/session/hostSupervisor';
import { cloneLaunch, createSessionHostRuntime, devLaunch } from '../src/core/session/sessionHostRuntime';

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
  write(path.join(app, 'Contents', 'MacOS', 'Agent Wrangler'), '#!/bin/bash\necho "launcher $*"\n', 0o755);
  for (const name of ['sessionHost', 'daemon', 'cli', 'launcher']) {
    write(path.join(app, 'Contents', 'Resources', 'app', 'dist', name, 'main.js'), '');
  }
  if (opts.node) {
    write(path.join(app, 'Contents', 'Resources', 'node', 'bin', 'node'), '#!/bin/bash\necho "node $*"\n', 0o755);
  }
  return app;
}

describe('host launch specs', () => {
  it('runs a clone on its renamed bundled Node, from its programs', () => {
    expect(cloneLaunch(HOST_APP)).toEqual({
      exe: `${HOST_APP}/Contents/Resources/node/bin/Agent Wrangler Host`,
      entry: `${HOST_APP}/Contents/Resources/app/dist/sessionHost/main.js`,
      env: {},
    });
  });

  it('runs unpackaged hosts on this Node and the repo dist (#125)', () => {
    expect(devLaunch('/Users/test/proj', '/usr/local/bin/node')).toEqual({
      exe: '/usr/local/bin/node',
      entry: '/Users/test/proj/dist/sessionHost/main.js',
      env: {},
    });
  });

  it('finds the core daemon entry beside the session host entry', () => {
    expect(coreDaemonEntryFor(cloneLaunch(HOST_APP).entry)).toBe(`${HOST_APP}/Contents/Resources/app/dist/daemon/main.js`);
  });
});

describe('host environment', () => {
  it('never passes on an inherited ELECTRON_RUN_AS_NODE (aw run from an Electron-based editor)', () => {
    const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' };
    expect(hostProcessEnv(base, {}, undefined)).toEqual({ PATH: '/usr/bin' });
    expect(hostProcessEnv(base, undefined, { AW_SESSION_HOST_FAKE: '1' })).toEqual({ PATH: '/usr/bin', AW_SESSION_HOST_FAKE: '1' });
  });
});

describe('cloned runtime', () => {
  const runtimeFor = (bundle: string, userDataDir: string, logs: string[]) =>
    createSessionHostRuntime({
      userDataDir,
      appRoot: path.join(bundle, 'Contents', 'Resources', 'app'),
      isPackaged: true,
      execPath: path.join(bundle, 'Contents', 'Resources', 'node', 'bin', 'node'),
      log: (m) => logs.push(m),
    });

  it('clones the bundle and renames its Node to the host name', async () => {
    const root = tmp();
    const bundle = fakeBundle(root, { node: true });
    const logs: string[] = [];
    const rt = await runtimeFor(bundle, path.join(root, 'data'), logs).prepare();
    const hostApp = path.join(root, 'data', 'runtimes', 'dev', 'Agent Wrangler Host.app');
    expect(rt).toEqual({ ...cloneLaunch(hostApp), runtimeDir: path.join(root, 'data', 'runtimes', 'dev') });
    expect(fs.existsSync(rt.exe)).toBe(true);
    expect(fs.existsSync(path.join(hostApp, 'Contents', 'Resources', 'node', 'bin', 'node'))).toBe(false);
    // The launcher is renamed too, so `pgrep` on the app's executable never finds a clone.
    expect(fs.existsSync(path.join(hostApp, 'Contents', 'MacOS', 'Agent Wrangler Host'))).toBe(true);
    // The original is untouched.
    expect(fs.existsSync(path.join(bundle, 'Contents', 'Resources', 'node', 'bin', 'node'))).toBe(true);
    expect(execFileSync(rt.exe, ['x'], { encoding: 'utf8' })).toBe('node x\n');
    expect(logs.some((l) => l.startsWith('cloned'))).toBe(true);
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

  it('refuses a bundle with no Node, rather than running something else', async () => {
    const root = tmp();
    const bundle = fakeBundle(root, { node: false });
    await expect(runtimeFor(bundle, path.join(root, 'data'), []).prepare()).rejects.toThrow(/no bundled Node/);
    expect(fs.existsSync(path.join(root, 'data', 'runtimes', 'dev'))).toBe(false);
  });
});

describe('bin/aw', () => {
  const aw = path.resolve(__dirname, '..', 'bin', 'aw');
  const runAw = (app: string, args: string[]) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AW_APP: app };
    return execFileSync('/bin/bash', [aw, ...args], { encoding: 'utf8', env });
  };

  it('runs the CLI on the bundled Node from the bundle', () => {
    const app = fakeBundle(tmp(), { node: true });
    expect(runAw(app, ['status'])).toBe(`node ${app}/Contents/Resources/app/dist/cli/main.js status\n`);
  });
});
