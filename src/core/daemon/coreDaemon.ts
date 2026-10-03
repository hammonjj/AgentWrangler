/**
 * The core daemon's shared facts (#130, plan §4): where its files are, how it
 * is recognised, and the one rule both sides keep, **never two cores at once**.
 *
 * "The core" is `createApp` plus the control socket, and it runs in the core
 * daemon (a LaunchAgent on plain Node, `src/daemon/main.ts`). Whoever serves
 * `run/core.sock` holds it, and a second daemon refuses to start. The
 * question is asked one way (`findCoreHolder`): does the control socket
 * answer, and if it does, is the daemon's manifest naming a live process?
 * An answer with no daemon behind it is an Electron-era app (before #142)
 * still running its own core; it is quit before the daemon takes over.
 *
 * No app imports: the daemon, the launcher and `aw` all read this.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { controlSocketPath, controlTokenPath, defaultRunDirs, type RunDirs } from '../control/paths';
import type { SocketProbe } from '../control/probe';
import { quitIntentSource, type QuitIntent, type QuitSource } from '../session/quitPolicy';

export const CORE_DAEMON_LABEL = 'com.hammonjj.agentwrangler.core';
/** In `run/`: pid, build and start time of the running daemon. */
export const CORE_MANIFEST_NAME = 'core-daemon.json';
/** In `run/`: why the next SIGTERM is coming (`QuitIntent`), written by `aw daemon stop`. */
export const QUIT_INTENT_NAME = 'quit-intent';
/** In `logs/`: the daemon's stdout and stderr. */
export const CORE_DAEMON_LOG_NAME = 'core-daemon.log';

export interface CoreDaemonPaths extends RunDirs {
  dataDir: string;
  socketPath: string;
  tokenPath: string;
  manifestPath: string;
  quitIntentPath: string;
  logDir: string;
  logFile: string;
}

/**
 * Every path from the data directory. `fallbackRunDir` defaults to
 * `~/.agentwrangler/run`, as the app's does; the control socket goes there only
 * when the primary path is too long for a socket.
 */
export function coreDaemonPaths(dataDir: string, fallbackRunDir: string = defaultRunDirs().fallbackRunDir): CoreDaemonPaths {
  const runDirs: RunDirs = { runDir: path.join(dataDir, 'run'), fallbackRunDir };
  const logDir = path.join(dataDir, 'logs');
  return {
    ...runDirs,
    dataDir,
    socketPath: controlSocketPath(runDirs),
    tokenPath: controlTokenPath(runDirs),
    manifestPath: path.join(runDirs.runDir, CORE_MANIFEST_NAME),
    quitIntentPath: path.join(runDirs.runDir, QUIT_INTENT_NAME),
    logDir,
    logFile: path.join(logDir, CORE_DAEMON_LOG_NAME),
  };
}

// ---- Manifest ----

export interface CoreDaemonManifest {
  pid: number;
  build: string;
  startedAt: number;
  dataDir: string;
  /** The runtime clone it runs from, so a session-host GC never removes it. */
  runtimeDir?: string;
}

export function parseCoreManifest(text: string): CoreDaemonManifest | undefined {
  try {
    const m = JSON.parse(text) as Partial<CoreDaemonManifest>;
    if (typeof m.pid !== 'number' || !Number.isInteger(m.pid) || m.pid <= 0) return undefined;
    if (typeof m.build !== 'string' || typeof m.startedAt !== 'number' || typeof m.dataDir !== 'string') return undefined;
    return {
      pid: m.pid,
      build: m.build,
      startedAt: m.startedAt,
      dataDir: m.dataDir,
      ...(typeof m.runtimeDir === 'string' ? { runtimeDir: m.runtimeDir } : {}),
    };
  } catch {
    return undefined;
  }
}

export function readCoreManifest(manifestPath: string): CoreDaemonManifest | undefined {
  try {
    return parseCoreManifest(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Written whole (temp file, then rename), 0600, so a reader never sees half of one. */
export function writeCoreManifest(manifestPath: string, manifest: CoreDaemonManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
}

/** Remove the manifest, but only this process's: a successor may already have written its own. */
export function removeCoreManifest(manifestPath: string, pid: number): void {
  if (readCoreManifest(manifestPath)?.pid !== pid) return;
  fs.rmSync(manifestPath, { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, someone else's. Not ours to stop, but alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---- Single instance ----

export type CoreHolder =
  | { kind: 'none' }
  /** The core daemon answers on the socket; its manifest says which one. */
  | { kind: 'daemon'; manifest: CoreDaemonManifest }
  /** Something answers and no live daemon claims it: an Electron-era app's core (before #142). */
  | { kind: 'app' };

export interface FindCoreHolderOptions {
  socketPath: string;
  manifestPath: string;
  probe: SocketProbe;
  alive?: (pid: number) => boolean;
  read?: (manifestPath: string) => CoreDaemonManifest | undefined;
}

/**
 * Who serves the control socket. The socket is the authority: a manifest
 * left by a crash means nothing unless something answers, and an answer with
 * no live daemon behind it is an Electron-era app (which writes no manifest).
 */
export async function findCoreHolder(opts: FindCoreHolderOptions): Promise<CoreHolder> {
  if (!(await opts.probe(opts.socketPath))) return { kind: 'none' };
  const manifest = (opts.read ?? readCoreManifest)(opts.manifestPath);
  if (manifest && (opts.alive ?? pidAlive)(manifest.pid)) return { kind: 'daemon', manifest };
  return { kind: 'app' };
}

/** One line for a log or a dialog: who holds the core. */
export function describeCoreHolder(holder: CoreHolder, now: number = Date.now()): string {
  switch (holder.kind) {
    case 'none':
      return 'nothing is running the core';
    case 'daemon':
      return `the core daemon is running it (pid ${holder.manifest.pid}, build ${holder.manifest.build}, up ${formatUptime(now - holder.manifest.startedAt)})`;
    case 'app':
      return 'an older Agent Wrangler app is running it';
  }
}

// ---- Launch ----

/** Where a program of ours was installed; see `appBundle.ts`. */
export { locateInstall } from '../appBundle';

/** The session host entry in a runtime → the daemon's, beside it: `.../dist/sessionHost/main.js` → `.../dist/daemon/main.js`. */
export function coreDaemonEntryFor(sessionHostEntry: string): string {
  return sessionHostEntry.replace(/([\\/])sessionHost([\\/])main\.js$/, '$1daemon$2main.js');
}

/**
 * The daemon's environment (the LaunchAgent's `EnvironmentVariables`, or a
 * detached spawn's): its data directory, the fallback run directory, the
 * runtime it runs from, and whatever extra the runtime asks for.
 */
export function coreDaemonEnv(
  dirs: { dataDir: string; fallbackRunDir: string },
  rt: { runtimeDir?: string; env?: Record<string, string> },
): Record<string, string> {
  return {
    ...rt.env,
    AW_DATA_DIR: dirs.dataDir,
    AW_FALLBACK_RUN_DIR: dirs.fallbackRunDir,
    ...(rt.runtimeDir ? { AW_CORE_RUNTIME_DIR: rt.runtimeDir } : {}),
  };
}

// ---- Quit intent ----

/** Announce the next SIGTERM's reason. */
export function writeQuitIntent(file: string, intent: QuitIntent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, intent, { mode: 0o600 });
}

/** Read and consume the marker: one announcement is good for one quit. */
export function takeQuitIntent(file: string, now: number = Date.now()): QuitSource | undefined {
  try {
    const content = fs.readFileSync(file, 'utf8');
    // mtime has sub-millisecond precision and `Date.now()` does not: a marker
    // written this instant can look a fraction of a millisecond in the future.
    const raw = now - fs.statSync(file).mtimeMs;
    const age = raw < 0 && raw > -1000 ? 0 : raw;
    fs.rmSync(file, { force: true });
    return quitIntentSource(content, age);
  } catch {
    return undefined; // no marker: not an announced quit
  }
}

// ---- Settings, read without a host ----

/** One value from `<dataDir>/settings.json`, for code that runs before (or without) a host. */
export function readSetting<T>(dataDir: string, key: string, fallback: T): T {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    const v = all[key];
    return v === undefined || typeof v !== typeof fallback ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

// ---- Words ----

/** "3d 4h", "2h 5m", "4m 10s", "12s". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
