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
 * Unpackaged (`npm run electron`), there is no bundle worth cloning: hosts run
 * straight from the Electron binary and the repo's `dist/`.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionHostRuntime } from '../core/session/hostSupervisor';

declare const AW_BUILD_ID: string | undefined;
export const BUILD_ID = typeof AW_BUILD_ID === 'string' ? AW_BUILD_ID : 'dev';

const HOST_APP = 'Agent Wrangler Host.app';
const HOST_EXE = 'Agent Wrangler Host';

export interface RuntimeOptions {
  userDataDir: string;
  /** `app.getAppPath()`: the asar in a packaged app, the repo root in development. */
  appRoot: string;
  isPackaged: boolean;
  /** `process.execPath`. */
  execPath: string;
  log: (msg: string) => void;
}

export function createSessionHostRuntime(opts: RuntimeOptions): SessionHostRuntime {
  const runtimesDir = path.join(opts.userDataDir, 'runtimes');
  let preparing: Promise<{ exe: string; entry: string; runtimeDir?: string }> | undefined;

  const prepare = async () => {
    if (!opts.isPackaged) {
      return { exe: opts.execPath, entry: path.join(opts.appRoot, 'dist', 'sessionHost', 'main.js') };
    }
    const runtimeDir = path.join(runtimesDir, BUILD_ID);
    const hostApp = path.join(runtimeDir, HOST_APP);
    const exe = path.join(hostApp, 'Contents', 'MacOS', HOST_EXE);
    if (!fs.existsSync(exe)) await cloneRuntime(bundleOf(opts.execPath), runtimeDir, opts.log);
    return { exe, entry: path.join(hostApp, 'Contents', 'Resources', 'app.asar', 'dist', 'sessionHost', 'main.js'), runtimeDir };
  };

  return {
    buildId: BUILD_ID,
    // One clone per build even when two sessions start at once.
    prepare: () => (preparing ??= prepare().catch((err) => {
      preparing = undefined;
      throw err;
    })),
    gc(inUse: Set<string>) {
      let names: string[];
      try {
        names = fs.readdirSync(runtimesDir);
      } catch {
        return;
      }
      for (const name of names) {
        const dir = path.join(runtimesDir, name);
        if (name === BUILD_ID || inUse.has(dir)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        opts.log(`removed the unused session host runtime ${name}`);
      }
    },
  };
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
  const signed = await resign(hostApp, bundle, original, log);
  // Into place in one step, so a half-made runtime is never used.
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.renameSync(tmp, runtimeDir);
  log(`cloned the session host runtime for build ${BUILD_ID} in ${Date.now() - started} ms (${signed ? 're-signed' : 'unsigned clone'})`);
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
