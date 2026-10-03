/**
 * The core daemon (#130, plan §4): Agent Wrangler's core with no window.
 *
 * Run by launchd from the LaunchAgent `com.hammonjj.agentwrangler.core` (or,
 * from a checkout, spawned detached by `aw daemon start`) as
 * `<runtime node> dist/daemon/main.js`, on the bundled Node, from the session
 * hosts' cloned runtime, unpacked beside the asar. stdout and stderr go to
 * `logs/core-daemon.log`; the app log (`agent-wrangler.log`) gets the same
 * lines the app would write.
 *
 * Environment:
 * - `AW_DATA_DIR`: the data directory (default: the app's own,
 *   `~/Library/Application Support/Agent Wrangler`);
 * - `AW_FALLBACK_RUN_DIR`: for a socket path too long for `run/`;
 * - `AW_CORE_RUNTIME_DIR`: the runtime clone it runs from, for its manifest.
 *
 * Exit codes: 0 for a stop (SIGTERM) and for refusing because the core is
 * already running elsewhere, so launchd (`KeepAlive.SuccessfulExit = false`)
 * leaves it; 1 for a crash or a failed start, so launchd restarts it. Agents
 * are in session hosts and Codex app-server processes, not here: a restart of
 * this process reattaches them.
 *
 * `--version` prints the build and exits, without touching anything.
 */
import * as path from 'node:path';
import { defaultRunDirs } from '../core/control/paths';
import { locateInstall, takeQuitIntent } from '../core/daemon/coreDaemon';
import { startFileLog } from '../core/fileLog';
import { QUIT_STOP_BOUND_MS, type QuitSource } from '../core/session/quitPolicy';
import { BUILD_ID, createSessionHostRuntime } from '../core/session/sessionHostRuntime';
import { toolPath } from '../core/toolPath';
import { createCoreDaemonAgent } from '../node/coreDaemonAgent';
import { createRemoteDaemonAgent } from '../node/remoteDaemonAgent';
import { startCoreDaemon, type RunningCoreDaemon } from './startCore';

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    process.stdout.write(`Agent Wrangler core daemon, build ${BUILD_ID}, Node ${process.versions.node}\n`);
    return;
  }
  // launchd, like Finder, starts processes without Homebrew on PATH.
  process.env.PATH = toolPath(process.env.PATH);

  const defaults = defaultRunDirs();
  const dataDir = process.env.AW_DATA_DIR || defaults.userDataDir;
  const fallbackRunDir = process.env.AW_FALLBACK_RUN_DIR || defaults.fallbackRunDir;
  const log = startFileLog(dataDir);
  const say = (m: string) => log(`core daemon pid ${process.pid}: ${m}`);
  const where = locateInstall(__dirname);
  say(`starting — build ${BUILD_ID}, Node ${process.versions.node}, ${where.isPackaged ? 'packaged' : 'unpackaged'}, data ${dataDir}`);

  const runtime = createSessionHostRuntime({
    userDataDir: dataDir,
    appRoot: where.appRoot,
    isPackaged: where.isPackaged,
    execPath: process.execPath,
    execIsNode: true,
    bundle: where.bundle,
    log,
  });
  const runDirs = { runDir: path.join(dataDir, 'run'), fallbackRunDir };
  const logDir = path.join(dataDir, 'logs');
  const agent = createCoreDaemonAgent({ dataDir, fallbackRunDir, runtime, isPackaged: where.isPackaged, log });

  let daemon: RunningCoreDaemon | undefined;
  let stopping = false;
  const stop = (why: string, source: QuitSource) => {
    if (stopping) return;
    stopping = true;
    say(`${why}; stopping (${source})`);
    // The policy bounds ending agents at QUIT_STOP_BOUND_MS; this bounds everything else.
    const force = setTimeout(() => process.exit(0), QUIT_STOP_BOUND_MS + 10_000);
    force.unref();
    void (daemon ? daemon.stop(source) : Promise.resolve()).finally(() => process.exit(0));
  };
  // SIGTERM is launchd's stop, `aw daemon stop`'s, and a bootout on update:
  // an ordinary stop, unless `aw daemon stop --all` announced otherwise.
  process.on('SIGTERM', () => stop('SIGTERM', takeQuitIntent(agent.paths.quitIntentPath) ?? 'signal'));
  process.on('SIGINT', () => stop('SIGINT', 'signal'));
  process.on('SIGHUP', () => stop('SIGHUP', 'signal'));
  process.on('uncaughtException', (err) => {
    say(`uncaught: ${err.stack ?? String(err)}`);
    // Non-zero, so launchd restarts it.
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => say(`unhandled rejection: ${String(err)}`));

  const result = await startCoreDaemon({
    dataDir,
    fallbackRunDir,
    build: BUILD_ID,
    runtime,
    runtimeDir: process.env.AW_CORE_RUNTIME_DIR || undefined,
    remoteDaemon: createRemoteDaemonAgent({ runDirs, logDir, runtime, isPackaged: where.isPackaged, log }),
    log,
    // Beside this file: `dist/webview`, unpacked from the asar in a packaged build (#131).
    webviewDir: path.resolve(__dirname, '..', 'webview'),
    onOpenAtLoginChange: () => {
      agent.syncPlist().catch((err) => say(`could not update the LaunchAgent: ${String(err)}`));
    },
  });
  if (!result.started) {
    say(`not starting: ${result.reason}`);
    log.close();
    // Clean, so launchd does not restart it into the same refusal.
    process.exit(0);
  }
  daemon = result.daemon;
}

main().catch((err) => {
  process.stderr.write(`[${new Date().toISOString()}] core daemon pid ${process.pid}: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
