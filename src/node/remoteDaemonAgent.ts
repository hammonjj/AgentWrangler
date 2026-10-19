/**
 * Retiring the old remote daemon (#74, #138).
 *
 * Until Electron was retired (#142), the app ran Discord in a separate
 * LaunchAgent daemon, `com.hammonjj.agentwrangler.remote`, so that it outlived
 * the window. The core daemon runs Discord in-process instead, and nothing
 * starts the remote daemon any more. A machine that ran an Electron-era build
 * may still have it installed, though, so the core daemon calls
 * `retireRemoteDaemon` before it first connects: the two would share the
 * mirror map (`mirrors.json`) and post every card twice.
 *
 * Its files, worked out the way it worked them out: the socket beside the host
 * sockets in `run/` (or the fallback run directory when that path is over
 * macOS's socket path limit), the token and manifest always in `run/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_SOCKET_PATH_BYTES, type RunDirs } from '../core/control/paths';
import { socketAnswers, type SocketProbe } from '../core/control/probe';
import { pidAlive } from '../core/daemon/coreDaemon';
import { guiDomain, launchAgentPlistPath, launchctl, type Launchctl } from './launchd';

/** The old LaunchAgent's label. */
export const REMOTE_DAEMON_LABEL = 'com.hammonjj.agentwrangler.remote';
const REMOTE_SOCKET_NAME = 'remote.sock';
const REMOTE_TOKEN_NAME = 'remote.token';
const REMOTE_MANIFEST_NAME = 'remote-daemon.json';

export interface RemoteDaemonPaths {
  socketPath: string;
  tokenPath: string;
  manifestPath: string;
}

export function remoteDaemonPaths(dirs: RunDirs): RemoteDaemonPaths {
  const primary = path.join(dirs.runDir, REMOTE_SOCKET_NAME);
  let socketPath = primary;
  if (Buffer.byteLength(primary) > MAX_SOCKET_PATH_BYTES) {
    socketPath = path.join(dirs.fallbackRunDir, REMOTE_SOCKET_NAME);
  }
  return {
    socketPath,
    tokenPath: path.join(dirs.runDir, REMOTE_TOKEN_NAME),
    manifestPath: path.join(dirs.runDir, REMOTE_MANIFEST_NAME),
  };
}

export interface RetireRemoteDaemonOptions {
  runDirs: RunDirs;
  log: (message: string) => void;
  /** Tests: everything that touches launchd, sockets, processes or time. */
  launchctl?: Launchctl;
  plistPath?: string;
  domain?: string;
  probe?: SocketProbe;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for it to exit. Default 15 s: its own stop gives up after 5. */
  exitTimeoutMs?: number;
}

export interface RetireResult {
  /** A LaunchAgent plist was there, and was booted out and deleted. */
  removedLaunchAgent: boolean;
  /** A daemon was answering on its socket. */
  wasRunning: boolean;
  /** It is gone (or never ran). False: it outlived the wait. */
  exited: boolean;
}

/**
 * Stop the remote daemon, take its LaunchAgent out of launchd and
 * `~/Library/LaunchAgents`, and remove its socket, token and manifest.
 * Resolves once it has exited, so that the caller can build its own connector
 * knowing nobody else is writing the mirror map (`connector.ts`). Safe to
 * call on every start: with nothing installed and nothing answering, it does
 * nothing.
 *
 * A packaged one goes with `bootout`, which also keeps launchd from starting it
 * again at login. One an unpackaged build spawned (no LaunchAgent) gets
 * SIGTERM, at the pid its manifest names, and only while its socket answers: a
 * manifest left behind by a daemon long gone can name a pid that now belongs
 * to something else.
 */
export async function retireRemoteDaemon(opts: RetireRemoteDaemonOptions): Promise<RetireResult> {
  const paths: RemoteDaemonPaths = remoteDaemonPaths(opts.runDirs);
  const plistPath = opts.plistPath ?? launchAgentPlistPath(REMOTE_DAEMON_LABEL);
  const domain = opts.domain ?? guiDomain();
  const run = opts.launchctl ?? launchctl;
  const probe = opts.probe ?? socketAnswers;
  const alive = opts.alive ?? pidAlive;
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const wasRunning = await probe(paths.socketPath);
  const pid = wasRunning ? readManifestPid(paths.manifestPath) : undefined;

  let removedLaunchAgent = false;
  if (fs.existsSync(plistPath)) {
    // SIGTERM to a running one, and launchd forgets the label: no restart, no login start.
    await run(['bootout', `${domain}/${REMOTE_DAEMON_LABEL}`]).catch(() => undefined);
    fs.rmSync(plistPath, { force: true });
    removedLaunchAgent = true;
    opts.log('remote daemon: removed its LaunchAgent; Discord runs in the core daemon now');
  }

  let exited = true;
  if (pid !== undefined && alive(pid)) {
    if (!removedLaunchAgent) {
      try {
        kill(pid, 'SIGTERM');
        opts.log(`remote daemon: stopped pid ${pid}; Discord runs in the core daemon now`);
      } catch {
        // gone already
      }
    }
    let deadline = Date.now() + (opts.exitTimeoutMs ?? 15_000);
    let killed = false;
    while (alive(pid)) {
      if (Date.now() >= deadline) {
        if (killed) {
          exited = false;
          opts.log(`remote daemon: pid ${pid} has not exited; connecting anyway`);
          break;
        }
        // Two gateway connections for one bot is the one thing not to risk.
        killed = true;
        deadline = Date.now() + 2000;
        opts.log(`remote daemon: pid ${pid} ignored SIGTERM; killing it`);
        try {
          kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      await sleep(100);
    }
  } else if (wasRunning && pid === undefined) {
    // Answering, with no manifest to name it: wait for the socket to go quiet instead.
    const deadline = Date.now() + (opts.exitTimeoutMs ?? 15_000);
    while (await probe(paths.socketPath)) {
      if (Date.now() >= deadline) {
        exited = false;
        opts.log('remote daemon: still answering on its socket; connecting anyway');
        break;
      }
      await sleep(100);
    }
  }

  if (exited) {
    for (const f of [paths.socketPath, paths.tokenPath, paths.manifestPath]) fs.rmSync(f, { force: true });
  }
  return { removedLaunchAgent, wasRunning, exited };
}

function readManifestPid(manifestPath: string): number | undefined {
  try {
    const pid = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
