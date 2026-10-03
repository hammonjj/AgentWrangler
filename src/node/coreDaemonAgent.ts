/**
 * Starting, stopping and describing the core daemon (#130), for whoever asks:
 * `aw daemon start|stop|status`, and the Electron app when
 * `experimental.coreDaemon` is on.
 *
 * Packaged: a LaunchAgent, `com.hammonjj.agentwrangler.core`, that runs the
 * daemon on the bundled Node from the session hosts' cloned runtime (the
 * remote daemon's pattern, `remoteDaemonAgent.ts`), so replacing the bundle
 * never deletes it from under itself. The plist names the runtime, which names
 * the build, so a new build is a changed plist: rewritten, booted out (the old
 * daemon gets SIGTERM and leaves its hosts running), bootstrapped again. The
 * new daemon reattaches the hosts through `HostSupervisor.scan`, as the app
 * does after an update.
 *
 * - `RunAtLoad` follows "Open at login"; otherwise it is started on demand
 *   (`launchctl kickstart`).
 * - `KeepAlive.SuccessfulExit = false`: restarted after a crash, not after a
 *   stop (exit 0), nor after refusing because the app holds the core (exit 0).
 *
 * Unpackaged (a checkout): no LaunchAgent, which would point launchd at a
 * worktree that may be removed. The daemon is spawned detached from the
 * checkout's `dist/` instead.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { socketAnswers, type SocketProbe } from '../core/control/probe';
import {
  CORE_DAEMON_LABEL,
  coreDaemonEntryFor,
  coreDaemonEnv,
  coreDaemonPaths,
  findCoreHolder,
  pidAlive,
  readSetting,
  writeQuitIntent,
  type CoreDaemonManifest,
  type CoreDaemonPaths,
  type CoreHolder,
} from '../core/daemon/coreDaemon';
import { hostProcessEnv, type SessionHostRuntime } from '../core/session/hostSupervisor';
import { QUIT_STOP_BOUND_MS } from '../core/session/quitPolicy';
import { renderLaunchAgent } from '../remote/daemon/launchAgent';
import { bootstrapWithRetry, guiDomain, launchAgentPlistPath, launchctl as systemLaunchctl, type Launchctl } from './launchd';

export interface CoreDaemonAgentOptions {
  dataDir: string;
  /** Default `~/.agentwrangler/run`. */
  fallbackRunDir?: string;
  /** Where the daemon runs from: the same runtime session hosts use. */
  runtime: SessionHostRuntime;
  isPackaged: boolean;
  log: (message: string) => void;
  /** Tests: everything that touches launchd, processes or time. */
  launchctl?: Launchctl;
  probe?: SocketProbe;
  plistPath?: string;
  domain?: string;
  spawnDetached?: (exe: string, args: string[], env: NodeJS.ProcessEnv, logFile: string) => number | undefined;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long `ensure` waits for the daemon to answer. Default 30 s. */
  startTimeoutMs?: number;
  /** How long `stop` waits for it to exit. Default the quit bound plus 10 s. */
  stopTimeoutMs?: number;
}

export type EnsureOutcome = 'running' | 'started' | 'installed' | 'updated' | 'spawned';

export interface CoreDaemonStatus {
  holder: CoreHolder;
  /** The LaunchAgent's plist is installed (packaged starts only). */
  launchAgent: boolean;
  plistPath: string;
}

export type CoreStopResult =
  | { outcome: 'stopped'; pid: number }
  /** Nothing answers on the socket. */
  | { outcome: 'not-running' }
  /** The Electron app holds the core; quit it instead. */
  | { outcome: 'app' }
  | { outcome: 'timeout'; pid: number };

/** Something the user has to act on, worded for them. */
export class CoreDaemonError extends Error {}

export interface CoreDaemonAgent {
  readonly paths: CoreDaemonPaths;
  readonly plistPath: string;
  /** The plist this build would install, with "Open at login" as it is now. */
  renderPlist(): Promise<string>;
  /** Make sure the daemon is running on this build. Resolves once it answers. */
  ensure(): Promise<{ outcome: EnsureOutcome; manifest: CoreDaemonManifest }>;
  /** Rewrite an installed plist whose `RunAtLoad` is out of date. No reload: launchd reads it at login. */
  syncPlist(): Promise<boolean>;
  status(): Promise<CoreDaemonStatus>;
  /** SIGTERM with an intent: `all` ends hosted conversations too (⌥⌘Q). */
  stop(all: boolean): Promise<CoreStopResult>;
}

export function createCoreDaemonAgent(opts: CoreDaemonAgentOptions): CoreDaemonAgent {
  const paths = coreDaemonPaths(opts.dataDir, opts.fallbackRunDir);
  const plistPath = opts.plistPath ?? launchAgentPlistPath(CORE_DAEMON_LABEL);
  const domain = opts.domain ?? guiDomain();
  const service = `${domain}/${CORE_DAEMON_LABEL}`;
  const run = opts.launchctl ?? systemLaunchctl;
  const probe = opts.probe ?? socketAnswers;
  const alive = opts.alive ?? pidAlive;
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const spawnDetached = opts.spawnDetached ?? defaultSpawnDetached;

  const holder = () => findCoreHolder({ socketPath: paths.socketPath, manifestPath: paths.manifestPath, probe, alive });

  const renderPlist = async (): Promise<string> => {
    const rt = await opts.runtime.prepare();
    return renderLaunchAgent({
      label: CORE_DAEMON_LABEL,
      program: rt.exe,
      args: [coreDaemonEntryFor(rt.entry)],
      env: coreDaemonEnv({ dataDir: paths.dataDir, fallbackRunDir: paths.fallbackRunDir }, rt),
      logFile: paths.logFile,
      runAtLoad: readSetting(paths.dataDir, 'openAtLogin', false),
    });
  };

  const readInstalled = (): string | undefined => {
    try {
      return fs.readFileSync(plistPath, 'utf8');
    } catch {
      return undefined;
    }
  };

  const ensurePackaged = async (): Promise<EnsureOutcome> => {
    fs.mkdirSync(paths.logDir, { recursive: true });
    const text = await renderPlist();
    const installed = readInstalled();
    if (installed !== text) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, text, { mode: 0o644 });
      // A running daemon of another build gets SIGTERM here: an ordinary stop.
      await run(['bootout', service]).catch(() => undefined);
      await bootstrapWithRetry(run, domain, plistPath);
      // `RunAtLoad` may be off; starts it if bootstrap did not.
      await run(['kickstart', service]);
      opts.log(`core daemon: ${installed === undefined ? 'installed' : 'updated'} its LaunchAgent`);
      return installed === undefined ? 'installed' : 'updated';
    }
    if (!(await run(['print', service]).then(() => true, () => false))) {
      await bootstrapWithRetry(run, domain, plistPath);
    }
    // Starts it if it is not running; leaves a running one alone.
    await run(['kickstart', service]);
    opts.log('core daemon: started it');
    return 'started';
  };

  const ensureUnpackaged = async (): Promise<EnsureOutcome> => {
    const rt = await opts.runtime.prepare();
    fs.mkdirSync(paths.logDir, { recursive: true });
    const env = hostProcessEnv(process.env, coreDaemonEnv({ dataDir: paths.dataDir, fallbackRunDir: paths.fallbackRunDir }, rt), undefined);
    const pid = spawnDetached(rt.exe, [coreDaemonEntryFor(rt.entry)], env, paths.logFile);
    opts.log(`core daemon: spawned pid ${pid ?? '?'} (unpackaged, no LaunchAgent)`);
    return 'spawned';
  };

  /** Until a daemon answers, or the time is up. */
  const waitForDaemon = async (): Promise<CoreDaemonManifest> => {
    const deadline = Date.now() + (opts.startTimeoutMs ?? 30_000);
    for (;;) {
      const h = await holder();
      if (h.kind === 'daemon' && (!opts.isPackaged || h.manifest.build === opts.runtime.buildId)) return h.manifest;
      if (h.kind === 'app') throw new CoreDaemonError('The Agent Wrangler app started its own core first; quit it, then try again.');
      if (Date.now() >= deadline) {
        throw new CoreDaemonError(`The core daemon did not start. See ${paths.logFile}.`);
      }
      await sleep(250);
    }
  };

  return {
    paths,
    plistPath,
    renderPlist,
    async ensure() {
      const h = await holder();
      if (h.kind === 'app') {
        throw new CoreDaemonError(
          'The Agent Wrangler app is running the core. Quit it first, or turn on "Run the core in the background" in its settings and restart it.',
        );
      }
      // Unpackaged, any daemon will do: there is no LaunchAgent to update.
      if (h.kind === 'daemon' && (!opts.isPackaged || h.manifest.build === opts.runtime.buildId)) {
        return { outcome: 'running', manifest: h.manifest };
      }
      const outcome = opts.isPackaged ? await ensurePackaged() : await ensureUnpackaged();
      return { outcome, manifest: await waitForDaemon() };
    },
    async syncPlist() {
      if (!opts.isPackaged) return false;
      const installed = readInstalled();
      if (installed === undefined) return false;
      const text = await renderPlist();
      if (installed === text) return false;
      fs.writeFileSync(plistPath, text, { mode: 0o644 });
      opts.log('core daemon: rewrote its LaunchAgent for "Open at login"');
      return true;
    },
    async status() {
      return { holder: await holder(), launchAgent: fs.existsSync(plistPath), plistPath };
    },
    async stop(all) {
      const h = await holder();
      if (h.kind === 'none') return { outcome: 'not-running' };
      if (h.kind === 'app') return { outcome: 'app' };
      const { pid } = h.manifest;
      writeQuitIntent(paths.quitIntentPath, all ? 'stop-all' : 'stop');
      try {
        kill(pid, 'SIGTERM');
      } catch (err) {
        fs.rmSync(paths.quitIntentPath, { force: true });
        throw new CoreDaemonError(`Could not signal the core daemon (pid ${pid}): ${String(err)}`);
      }
      const deadline = Date.now() + (opts.stopTimeoutMs ?? QUIT_STOP_BOUND_MS + 10_000);
      while (alive(pid)) {
        if (Date.now() >= deadline) return { outcome: 'timeout', pid };
        await sleep(200);
      }
      return { outcome: 'stopped', pid };
    },
  };
}

function defaultSpawnDetached(exe: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): number | undefined {
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(exe, args, { detached: true, stdio: ['ignore', fd, fd], env });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}
