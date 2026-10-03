/**
 * Starting the remote daemon (#74), the way this front end can.
 *
 * Packaged: a LaunchAgent (`~/Library/LaunchAgents/<label>.plist`) that runs
 * the daemon from the session hosts' cloned runtime, so `app:install` never
 * deletes it from under itself, and launchd restarts it after a crash and
 * starts it at login. The plist names the runtime, which names the build, so a
 * new build is a changed plist: rewritten, booted out, bootstrapped again.
 *
 * Unpackaged (`npm run electron`): no LaunchAgent, which would point launchd at
 * a checkout that may be a worktree about to be removed. The daemon is spawned
 * detached from the repo's `dist/`, as hosts are, unless one already answers.
 *
 * No Electron, and in `src/node/`: the Electron main process starts it, and
 * the core daemon retires it (`retireRemoteDaemon`, #138), since it runs
 * Discord in-process instead.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hostProcessEnv, type SessionHostRuntime } from '../core/session/hostSupervisor';
import type { RunDirs } from '../core/control/paths';
import { socketAnswers } from '../core/control/probe';
import type { HostServices } from '../host/hostServices';
import type { EnsureReason } from '../remote/daemon/client';
import { pidAlive } from '../core/daemon/coreDaemon';
import type { SocketProbe } from '../core/control/probe';
import { daemonEntryFor, remoteDaemonEnv, renderLaunchAgent } from '../remote/daemon/launchAgent';
import { remoteDaemonPaths, type RemoteDaemonPaths } from '../remote/daemon/paths';
import { REMOTE_DAEMON_LABEL } from '../remote/daemon/protocol';
import { bootstrapWithRetry, guiDomain, launchAgentPlistPath, launchctl, type Launchctl } from './launchd';

export interface RemoteDaemonAgentOptions {
  runDirs: RunDirs;
  logDir: string;
  runtime: SessionHostRuntime;
  isPackaged: boolean;
  log: (message: string) => void;
  /**
   * True while a core daemon holds the core (#138). It runs Discord itself and
   * retires this daemon, so `ensure` then starts nothing: two connectors would
   * share one mirror map and post every card twice. Absent: never.
   */
  coreDaemonHolds?: () => Promise<boolean>;
}

export function createRemoteDaemonAgent(opts: RemoteDaemonAgentOptions): NonNullable<HostServices['remoteDaemon']> {
  const paths = remoteDaemonPaths(opts.runDirs);
  const plistPath = launchAgentPlistPath(REMOTE_DAEMON_LABEL);
  const domain = guiDomain();
  const service = `${domain}/${REMOTE_DAEMON_LABEL}`;
  const logFile = path.join(opts.logDir, 'remote-daemon.log');
  let running: Promise<void> = Promise.resolve();
  let saidCoreDaemon = false;

  const ensurePackaged = async (why: EnsureReason): Promise<void> => {
    const rt = await opts.runtime.prepare();
    fs.mkdirSync(opts.logDir, { recursive: true });
    const text = renderLaunchAgent({
      label: REMOTE_DAEMON_LABEL,
      program: rt.exe,
      args: [daemonEntryFor(rt.entry)],
      env: remoteDaemonEnv(opts.runDirs, rt),
      logFile,
    });
    let installed: string | undefined;
    try {
      installed = fs.readFileSync(plistPath, 'utf8');
    } catch {
      // not installed
    }
    if (installed !== text) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, text, { mode: 0o644 });
      await launchctl(['bootout', service]).catch(() => undefined);
      await bootstrapWithRetry(launchctl, domain, plistPath);
      opts.log(`remote daemon: ${installed === undefined ? 'installed' : 'updated'} its LaunchAgent (${why})`);
      return;
    }
    if (!(await launchctl(['print', service]).then(() => true, () => false))) {
      await bootstrapWithRetry(launchctl, domain, plistPath);
      opts.log(`remote daemon: loaded its LaunchAgent (${why})`);
      return;
    }
    if (why === 'outdated') {
      await launchctl(['kickstart', '-k', service]);
      opts.log('remote daemon: restarted it on this build');
    } else if (why === 'unreachable') {
      // Starts it if it is not running; leaves a running one alone.
      await launchctl(['kickstart', service]);
    }
  };

  const ensureUnpackaged = async (): Promise<void> => {
    if (await socketAnswers(paths.socketPath)) return;
    const rt = await opts.runtime.prepare();
    fs.mkdirSync(opts.logDir, { recursive: true });
    const fd = fs.openSync(logFile, 'a', 0o600);
    try {
      const child = spawn(rt.exe, [daemonEntryFor(rt.entry)], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: hostProcessEnv(process.env, remoteDaemonEnv(opts.runDirs, rt), undefined),
      });
      child.unref();
      opts.log(`remote daemon: spawned pid ${child.pid} (unpackaged, no LaunchAgent)`);
    } finally {
      fs.closeSync(fd);
    }
  };

  return {
    paths,
    replaceOutdated: opts.isPackaged,
    // One at a time: a reconnect's `ensure` must not race a start's.
    ensure(why) {
      const run = running.then(async () => {
        if (await opts.coreDaemonHolds?.()) {
          if (!saidCoreDaemon) opts.log('remote daemon: not starting it; the core daemon runs Discord');
          saidCoreDaemon = true;
          return;
        }
        saidCoreDaemon = false;
        await (opts.isPackaged ? ensurePackaged(why) : ensureUnpackaged());
      });
      running = run.catch(() => undefined);
      return run;
    },
    async remove() {
      // Every start with remote control off comes here: only act on an installed one.
      if (opts.isPackaged && fs.existsSync(plistPath)) {
        await launchctl(['bootout', service]).catch(() => undefined);
        fs.rmSync(plistPath, { force: true });
        opts.log('remote daemon: removed its LaunchAgent');
      }
    },
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
 * The migration to Discord in the core daemon (#138): stop the remote daemon,
 * take its LaunchAgent out of launchd and `~/Library/LaunchAgents`, and remove
 * its socket, token and manifest. Resolves once it has exited, so that the
 * caller can build its own connector knowing nobody else is writing the mirror
 * map (`connector.ts`). Safe to call on every start: with nothing installed and
 * nothing answering, it does nothing.
 *
 * A packaged one goes with `bootout`, which also keeps launchd from starting it
 * again at login. One the unpackaged app spawned (no LaunchAgent) gets SIGTERM,
 * at the pid its manifest names, and only while its socket answers: a manifest
 * left behind by a daemon long gone can name a pid that now belongs to
 * something else.
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
