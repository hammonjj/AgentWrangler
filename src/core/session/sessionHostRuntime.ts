/**
 * Where a session host runs from: a clone of the app's own bundle.
 *
 * A host lives for days, and `app:install` replaces the bundle under it. So
 * hosts do not run from `/Applications`: on first use per build, the bundle is
 * APFS-cloned (`cp -c`, close to free) to `runtimes/<buildId>/Agent Wrangler
 * Host.app`, its executable renamed, and hosts are spawned from there
 * (playbook §11.7, spike S2). The rename keeps a host out of the install
 * script's and `killall`'s name matches; the clone keeps lazily loaded files
 * present after the original is deleted; and the build's identity stays put.
 *
 * Re-signed with the app's own certificate after the rename (decided at CP0,
 * since builds are certificate-signed since #56): `codesign --verify` passes
 * and TCC's designated requirement ("this bundle id, this certificate") still
 * matches. If signing fails, the clone S2 measured (renamed, unmodified
 * Info.plist, unverifiable but runnable) is kept.
 *
 * What runs in the clone is the bundle's pinned Node (#129, decision D1):
 * `Contents/Resources/node/bin/node`, renamed `Agent Wrangler Host` in the
 * clone for the same reason as the executable, on the programs electron-builder
 * unpacks beside the asar (`app.asar.unpacked/dist/…`), since plain Node cannot
 * read an asar. A bundle without `Resources/node` (built without
 * scripts/fetch-node.mjs) falls back to what every build before #129 did: the
 * renamed Electron executable with `ELECTRON_RUN_AS_NODE`, reading the asar.
 *
 * Unpackaged (`npm run electron`), there is no bundle worth cloning: hosts run
 * straight from the Electron binary and the repo's `dist/`.
 *
 * No Electron import, so a plain-Node caller (the daemon, #125/#130) builds the
 * same runtime: it passes `execIsNode`, and when its `execPath` is the bundled
 * Node rather than the bundle's main executable, the `bundle` to clone.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionHostRuntime } from './hostSupervisor';
import { REMOTE_MANIFEST_NAME } from '../../remote/daemon/protocol';
import { CORE_MANIFEST_NAME } from '../daemon/coreDaemon';

declare const AW_BUILD_ID: string | undefined;
export const BUILD_ID = typeof AW_BUILD_ID === 'string' ? AW_BUILD_ID : 'dev';

const HOST_APP = 'Agent Wrangler Host.app';
const HOST_EXE = 'Agent Wrangler Host';
/** The pinned Node inside a bundle (electron-builder.yml `extraResources`). */
const NODE_DIR = ['Contents', 'Resources', 'node', 'bin'];

/** How to start a host program (session host or remote daemon) from one runtime. */
export interface HostLaunchSpec {
  exe: string;
  /** The session host's entry; the remote daemon's is beside it (`daemonEntryFor`). */
  entry: string;
  /** What the executable needs in its environment to act as Node. */
  env: Record<string, string>;
}

/**
 * Unpackaged: the running executable on the repo's `dist/`. The Electron
 * binary needs `ELECTRON_RUN_AS_NODE` to act as Node; plain Node needs nothing.
 */
export function devLaunch(appRoot: string, execPath: string, execIsNode = false): HostLaunchSpec {
  return {
    exe: execPath,
    entry: path.join(appRoot, 'dist', 'sessionHost', 'main.js'),
    env: execIsNode ? {} : { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Packaged, inside a host clone (`.../Agent Wrangler Host.app`): its renamed
 * Node on the unpacked programs, or, for a bundle with no Node, its renamed
 * Electron executable as Node on the asar.
 */
export function cloneLaunch(hostApp: string, bundledNode: boolean): HostLaunchSpec {
  const resources = path.join(hostApp, 'Contents', 'Resources');
  if (bundledNode) {
    return { exe: path.join(hostApp, ...NODE_DIR, HOST_EXE), entry: path.join(resources, 'app.asar.unpacked', 'dist', 'sessionHost', 'main.js'), env: {} };
  }
  return {
    exe: path.join(hostApp, 'Contents', 'MacOS', HOST_EXE),
    entry: path.join(resources, 'app.asar', 'dist', 'sessionHost', 'main.js'),
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export interface RuntimeOptions {
  userDataDir: string;
  /** `app.getAppPath()`: the asar in a packaged app, the repo root in development. */
  appRoot: string;
  isPackaged: boolean;
  /** `process.execPath`. */
  execPath: string;
  /**
   * True when `execPath` is plain Node (the daemon), not Electron. Only the
   * unpackaged launch reads it: a packaged clone knows what it contains.
   */
  execIsNode?: boolean;
  /**
   * The `.app` to clone. Defaults to the bundle `execPath` is the main
   * executable of (`X.app/Contents/MacOS/X`), which is right for Electron; a
   * caller running the bundled Node (`X.app/Contents/Resources/node/bin/node`)
   * says which bundle it is in.
   */
  bundle?: string;
  log: (msg: string) => void;
}

export function createSessionHostRuntime(opts: RuntimeOptions): SessionHostRuntime {
  const runtimesDir = path.join(opts.userDataDir, 'runtimes');
  let preparing: Promise<HostLaunchSpec & { runtimeDir?: string }> | undefined;

  const prepare = async () => {
    if (!opts.isPackaged) return devLaunch(opts.appRoot, opts.execPath, opts.execIsNode);
    const runtimeDir = path.join(runtimesDir, BUILD_ID);
    const hostApp = path.join(runtimeDir, HOST_APP);
    // The clone moves into place in one step, so its executable means it is whole.
    if (!fs.existsSync(path.join(hostApp, 'Contents', 'MacOS', HOST_EXE))) await cloneRuntime(opts.bundle ?? bundleOf(opts.execPath), runtimeDir, opts.log);
    return { ...cloneLaunch(hostApp, fs.existsSync(path.join(hostApp, ...NODE_DIR, HOST_EXE))), runtimeDir };
  };

  return {
    buildId: BUILD_ID,
    // One clone per build even when two sessions start at once.
    prepare: () => (preparing ??= prepare().catch((err) => {
      preparing = undefined;
      throw err;
    })),
    gc(hostsInUse: Set<string>) {
      // The remote daemon (#74) runs from one of these clones too, and a new
      // build only moves it on once the app has connected to it.
      const inUse = new Set(hostsInUse);
      const daemonRuntime = remoteDaemonRuntime(path.join(opts.userDataDir, 'run', REMOTE_MANIFEST_NAME));
      if (daemonRuntime) inUse.add(daemonRuntime);
      // So does the core daemon (#130); its manifest names its runtime the same way.
      const coreRuntime = remoteDaemonRuntime(path.join(opts.userDataDir, 'run', CORE_MANIFEST_NAME));
      if (coreRuntime) inUse.add(coreRuntime);
      let names: string[];
      try {
        names = fs.readdirSync(runtimesDir);
      } catch {
        return;
      }
      for (const name of names) {
        const dir = path.join(runtimesDir, name);
        if (name === BUILD_ID || inUse.has(dir)) continue;
        // `runtimes/` is shared: the Codex server's pinned binary (`codex-*`) lives
        // here too. Only ever remove what is recognisably a session host clone.
        if (name.startsWith('codex-') || !fs.existsSync(path.join(dir, HOST_APP))) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        opts.log(`removed the unused session host runtime ${name}`);
      }
    },
  };
}

/** The runtime a live remote daemon runs from, from its manifest. */
function remoteDaemonRuntime(manifestPath: string): string | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { pid?: unknown; runtimeDir?: unknown };
    if (typeof m.pid !== 'number' || typeof m.runtimeDir !== 'string') return undefined;
    process.kill(m.pid, 0); // throws if it is gone
    return m.runtimeDir;
  } catch {
    return undefined;
  }
}

/** `.../X.app/Contents/MacOS/X` → `.../X.app`. */
function bundleOf(execPath: string): string {
  return path.resolve(path.dirname(execPath), '..', '..');
}

async function cloneRuntime(bundle: string, runtimeDir: string, log: (msg: string) => void): Promise<void> {
  const started = Date.now();
  const tmp = `${runtimeDir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const hostApp = path.join(tmp, HOST_APP);
  // `-c`: an APFS clone, blocks shared with the original. Falls back to a copy elsewhere.
  // Async throughout: this runs on the Electron main thread, and codesign takes most of a second.
  await run('/bin/cp', ['-c', '-R', bundle, hostApp]);
  const macos = path.join(hostApp, 'Contents', 'MacOS');
  const original = fs.readdirSync(macos).find((f) => !f.startsWith('.'));
  if (!original) throw new Error(`no executable in ${macos}`);
  fs.renameSync(path.join(macos, original), path.join(macos, HOST_EXE));
  // The Node hosts actually run, renamed the same way: a host is an `Agent
  // Wrangler Host` to `ps`, `pgrep` and `killall`, never a `node` that a
  // `killall node` would take down. Its own signature does not name the file.
  const nodeDir = path.join(hostApp, ...NODE_DIR);
  const bundledNode = fs.existsSync(path.join(nodeDir, 'node'));
  if (bundledNode) fs.renameSync(path.join(nodeDir, 'node'), path.join(nodeDir, HOST_EXE));
  const signed = await resign(hostApp, bundle, original, log);
  // Into place in one step, so a half-made runtime is never used.
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.renameSync(tmp, runtimeDir);
  log(`cloned the session host runtime for build ${BUILD_ID} in ${Date.now() - started} ms (${signed ? 're-signed' : 'unsigned clone'}, ${bundledNode ? 'bundled Node' : 'no bundled Node: Electron as Node'})`);
}

/**
 * Point the clone's Info.plist at the renamed executable and re-sign it with
 * the identity the original was signed with. On any failure, put Info.plist
 * back, leaving the unmodified (runnable, unverifiable) clone S2 measured.
 */
async function resign(hostApp: string, original: string, originalExe: string, log: (msg: string) => void): Promise<boolean> {
  const plist = path.join(hostApp, 'Contents', 'Info.plist');
  const identity = await signingIdentity(original);
  if (!identity) {
    log('the app is not certificate-signed; the session host runtime is left unsigned');
    return false;
  }
  try {
    await run('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', HOST_EXE, plist]);
    await run('/usr/bin/codesign', ['--force', '--preserve-metadata=entitlements,requirements,flags,runtime', '--sign', identity, hostApp]);
    await run('/usr/bin/codesign', ['--verify', hostApp]);
    return true;
  } catch (err) {
    log(`re-signing the session host runtime failed (${String(err).slice(0, 300)}); using the unsigned clone`);
    try {
      await run('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', originalExe, plist]);
    } catch {
      // the clone still runs; its signature was already broken by the rename
    }
    return false;
  }
}

/** Run a tool; resolves with its stdout and stderr, rejects on a non-zero exit or after a minute. */
function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** The certificate the running bundle is signed with, or undefined for ad-hoc and unsigned. */
async function signingIdentity(bundle: string): Promise<string | undefined> {
  // codesign prints its details on stderr, and exits 0.
  try {
    const { stdout, stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle]);
    return parseAuthority(`${stdout}\n${stderr}`);
  } catch {
    return undefined; // unsigned
  }
}

function parseAuthority(text: string): string | undefined {
  const m = /^Authority=(.+)$/m.exec(text);
  return m?.[1]?.trim() || undefined;
}
