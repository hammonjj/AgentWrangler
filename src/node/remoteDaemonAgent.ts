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
 * No Electron: the Electron main process and the core daemon (#130) both use
 * it, which is why it lives in `src/node/`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hostProcessEnv, type SessionHostRuntime } from '../core/session/hostSupervisor';
import type { RunDirs } from '../core/control/paths';
import { socketAnswers } from '../core/control/probe';
import type { HostServices } from '../host/hostServices';
import type { EnsureReason } from '../remote/daemon/client';
import { daemonEntryFor, remoteDaemonEnv, renderLaunchAgent } from '../remote/daemon/launchAgent';
import { remoteDaemonPaths } from '../remote/daemon/paths';
import { REMOTE_DAEMON_LABEL } from '../remote/daemon/protocol';
import { bootstrapWithRetry, guiDomain, launchAgentPlistPath, launchctl } from './launchd';

export interface RemoteDaemonAgentOptions {
  runDirs: RunDirs;
  logDir: string;
  runtime: SessionHostRuntime;
  isPackaged: boolean;
  log: (message: string) => void;
}

export function createRemoteDaemonAgent(opts: RemoteDaemonAgentOptions): NonNullable<HostServices['remoteDaemon']> {
  const paths = remoteDaemonPaths(opts.runDirs);
  const plistPath = launchAgentPlistPath(REMOTE_DAEMON_LABEL);
  const domain = guiDomain();
  const service = `${domain}/${REMOTE_DAEMON_LABEL}`;
  const logFile = path.join(opts.logDir, 'remote-daemon.log');
  let running: Promise<void> = Promise.resolve();

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
      const run = running.then(() => (opts.isPackaged ? ensurePackaged(why) : ensureUnpackaged()));
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
