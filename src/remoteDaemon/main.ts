/**
 * The remote daemon (#74): Discord, kept running while the app is not.
 *
 * Run by launchd from the app's LaunchAgent (or, unpackaged, spawned detached
 * by the app) as `<runtime exe> dist/remoteDaemon/main.js` with
 * `ELECTRON_RUN_AS_NODE=1`, from the same cloned runtime session hosts use, so
 * a reinstall does not delete it from under itself. stdout and stderr go to
 * `logs/remote-daemon.log`.
 *
 * Environment:
 * - `AW_RUN_DIR`, `AW_FALLBACK_RUN_DIR`: where the host manifests are and where
 *   its own socket, token and manifest go (default: the app's own);
 * - `AW_REMOTE_RUNTIME_DIR`: the runtime clone it runs from, recorded in its
 *   manifest so the app does not collect it.
 *
 * One per user: if another daemon already answers on the socket, this one
 * exits cleanly (and launchd, told to restart only on a crash, leaves it).
 */
import * as net from 'node:net';
import { defaultRunDirs } from '../core/control/paths';
import { RemoteDaemon } from '../remote/daemon/daemon';
import { remoteDaemonPaths } from '../remote/daemon/paths';

declare const AW_BUILD_ID: string | undefined;
const BUILD_ID = typeof AW_BUILD_ID === 'string' ? AW_BUILD_ID : 'dev';

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString()}] remote pid ${process.pid}: ${message}\n`);
}

/** Something already listening on the socket: another daemon is running. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

async function main(): Promise<void> {
  const defaults = defaultRunDirs();
  const runDirs = {
    runDir: process.env.AW_RUN_DIR || defaults.runDir,
    fallbackRunDir: process.env.AW_FALLBACK_RUN_DIR || defaults.fallbackRunDir,
  };
  const paths = remoteDaemonPaths(runDirs);
  if (await answers(paths.socketPath)) {
    log('another remote daemon is already running; exiting');
    process.exit(0);
  }
  const daemon = new RemoteDaemon({
    ...paths,
    runDir: runDirs.runDir,
    build: BUILD_ID,
    runtimeDir: process.env.AW_REMOTE_RUNTIME_DIR || undefined,
    log,
  });

  let stopping = false;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`${why}; closing the Discord connection`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    void daemon.dispose().finally(() => process.exit(0));
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => stop(signal));
  process.on('uncaughtException', (err) => {
    log(`uncaught: ${err.stack ?? String(err)}`);
    // Non-zero, so launchd restarts it.
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${String(err)}`));

  await daemon.start();
}

main().catch((err) => {
  log(`failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
