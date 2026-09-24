/**
 * The one Codex app-server Agent Wrangler owns, running detached so that its
 * threads (in-flight turns, pending approvals and questions) outlive the app.
 *
 * `docs/plans/session-lifecycle-architecture.md` §11 item 8 and Stage 5, from
 * spike S4 (`docs/plans/spikes/s4-codex-restart.md`):
 *
 * - One `codex app-server --listen unix://<path>`, detached into its own
 *   session, stdout/stderr to a log file (never a pipe, which would tie it to
 *   this process). Codex puts the real socket (0600) under
 *   `/tmp/codex-daemon-<uid>/` and makes `<path>` a symlink to it.
 * - Launched from a **pinned copy** of the extension's `bin/<platform>/`
 *   directory under `runtimes/codex-<version>/`: VS Code prunes old extension
 *   directories, and a long-lived server must not find its executable gone.
 *   APFS clones make the copy cheap. An explicit binary outside an extension
 *   bundle (Homebrew, a custom path) is launched as it is.
 * - A manifest (`run/codex-host.json`, 0600) holds pid, the process start time
 *   (so a reused pid is not mistaken for the server), socket, binary, and the
 *   server's own version from `initialize.userAgent`.
 * - **Not** Codex's machine-wide `app-server daemon`: it cannot start from the
 *   extension's binaries, the `codex` TUI attaches to it, anyone can restart
 *   it, and each restart injects a recovery turn.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CodexHostManifest {
  v: 1;
  pid: number;
  /** `ps -o lstart=` of `pid` when it was launched. A different value means the pid was reused. */
  procStart?: string;
  /** The path handed to `--listen unix://`; a symlink Codex makes to the real socket. */
  socketPath: string;
  /** The executable actually running (inside `runtimeDir` when pinned). */
  binary: string;
  /** The pinned copy, when the binary came from an extension bundle. */
  runtimeDir?: string;
  /** The binary it was pinned from. */
  pinnedFrom?: string;
  /** `codex --version` of the binary at launch, e.g. `0.155.0-alpha.16.3`. */
  version?: string;
  /** The server's `initialize.userAgent`, recorded on first connect. */
  userAgent?: string;
  startedAt: number;
  logFile: string;
}

export interface CodexHostDeps {
  /** Agent Wrangler's user-data directory; `run/` and `runtimes/` go under it. */
  baseDir: string;
  /** The binary a new server should come from (already resolved: see `resolveCodexBinary`). */
  binary: () => string;
  log?: (message: string) => void;
  spawn?: typeof cp.spawn;
  isAlive?: (pid: number) => boolean;
  processStart?: (pid: number) => string | undefined;
  versionOf?: (binary: string) => string | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the socket to appear after launch. */
  launchTimeoutMs?: number;
}

/** What the server is doing, for deciding how to stop it. */
export type StopSignal = 'SIGTERM' | 'SIGINT';

/**
 * How to stop the server. `SIGTERM` drains, and with a turn pending it never
 * exits (S4 saw one alive 30 minutes later), so it is only safe when nothing is
 * active. `SIGINT` exits at once and records running turns as interrupted.
 */
export function stopSignalFor(activeThreads: number): StopSignal {
  return activeThreads > 0 ? 'SIGINT' : 'SIGTERM';
}

/** `codex-cli 0.155.0-alpha.16.3` → `0.155.0-alpha.16.3`. */
export function parseCliVersion(output: string): string | undefined {
  const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(output);
  return match?.[1];
}

/** `…/codex-cli/0.155.0-alpha.16.3 (Mac OS …)` → `0.155.0-alpha.16.3`. */
export function userAgentVersion(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const match = /\/(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(userAgent);
  return match?.[1];
}

/** The `bin/<platform>/` directory of an OpenAI extension bundle a binary sits in, if it does. */
export function extensionBinDir(binary: string): string | undefined {
  const dir = path.dirname(binary);
  const parts = dir.split(path.sep);
  const bin = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  const ext = parts.length >= 3 ? parts[parts.length - 3] : undefined;
  if (bin !== 'bin' || !ext || !/^openai\.chatgpt-\d/.test(ext)) return undefined;
  return dir;
}

/** A directory-name-safe version label. */
function safeLabel(version: string): string {
  return version.replace(/[^0-9A-Za-z._-]/g, '_');
}

function defaultProcessStart(pid: number): string | undefined {
  try {
    const out = cp.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function defaultVersionOf(binary: string): string | undefined {
  try {
    return parseCliVersion(cp.execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }));
  } catch {
    return undefined;
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** The environment a detached server gets: this app's, minus what makes a child think it is the app. */
export function hostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('ELECTRON_')) delete next[key];
  }
  delete next.__CFBundleIdentifier;
  delete next.XPC_SERVICE_NAME;
  return next;
}

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export class CodexHost {
  readonly runDir: string;
  readonly runtimesDir: string;
  readonly manifestPath: string;
  readonly socketPath: string;
  readonly logFile: string;
  private readonly log: (message: string) => void;
  private readonly spawnProcess: typeof cp.spawn;
  private readonly isAlive: (pid: number) => boolean;
  private readonly processStart: (pid: number) => string | undefined;
  private readonly versionOf: (binary: string) => string | undefined;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private ensuring?: Promise<CodexHostManifest>;

  constructor(private readonly deps: CodexHostDeps) {
    this.runDir = path.join(deps.baseDir, 'run');
    this.runtimesDir = path.join(deps.baseDir, 'runtimes');
    this.manifestPath = path.join(this.runDir, 'codex-host.json');
    this.socketPath = path.join(this.runDir, 'codex-app-server.sock');
    this.logFile = path.join(this.runDir, 'codex-app-server.log');
    this.log = deps.log ?? (() => undefined);
    this.spawnProcess = deps.spawn ?? cp.spawn;
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.processStart = deps.processStart ?? defaultProcessStart;
    this.versionOf = deps.versionOf ?? defaultVersionOf;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The manifest on disk, if it is readable. Says nothing about whether the server is alive. */
  manifest(): CodexHostManifest | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (raw?.v !== 1 || typeof raw.pid !== 'number' || typeof raw.socketPath !== 'string') return undefined;
      return raw as CodexHostManifest;
    } catch {
      return undefined;
    }
  }

  /** The manifest, when its server is still the process that wrote it. */
  running(): CodexHostManifest | undefined {
    const m = this.manifest();
    if (!m || !this.isAlive(m.pid)) return undefined;
    if (m.procStart !== undefined) {
      const now = this.processStart(m.pid);
      if (now !== undefined && now !== m.procStart) return undefined;
    }
    if (!fs.existsSync(m.socketPath)) return undefined;
    return m;
  }

  /** Stable for the life of one server process: request ids are only unique within it. */
  static instanceOf(m: CodexHostManifest): string {
    return `${m.pid}@${m.startedAt}`;
  }

  /** The running server, launching one if there is none. */
  ensure(): Promise<CodexHostManifest> {
    if (!this.ensuring) {
      this.ensuring = Promise.resolve()
        .then(() => this.running() ?? this.launch())
        .finally(() => { this.ensuring = undefined; });
    }
    return this.ensuring;
  }

  /** Record what the server says it is, from `initialize`. */
  noteUserAgent(userAgent: string | undefined): void {
    const m = this.manifest();
    if (!m || !userAgent || m.userAgent === userAgent) return;
    this.writeManifest({ ...m, userAgent });
  }

  /**
   * Whether a newer Codex is available than the one the server runs. Updating
   * means restarting the server, which ends in-flight turns and pending asks,
   * so the caller decides when (only when idle, or on the user's command).
   */
  outdated(): { running?: string; available?: string } | undefined {
    const m = this.running();
    if (!m) return undefined;
    const binary = this.deps.binary();
    const source = m.pinnedFrom ?? m.binary;
    if (binary === source) return undefined;
    const available = this.versionOf(binary);
    const runningVersion = userAgentVersion(m.userAgent) ?? m.version;
    if (!available || available === runningVersion) return undefined;
    return { running: runningVersion, available };
  }

  /** Signal the server and wait (bounded) for it to go. True once it has. */
  async stop(signal: StopSignal, withinMs = 5000): Promise<boolean> {
    const m = this.running();
    if (!m) return true;
    this.log(`codex host: ${signal} to ${m.pid}`);
    try { this.kill(m.pid, signal); } catch { return !this.isAlive(m.pid); }
    const deadline = this.now() + withinMs;
    while (this.now() < deadline) {
      if (!this.isAlive(m.pid)) return true;
      await this.sleep(100);
    }
    return !this.isAlive(m.pid);
  }

  private async launch(): Promise<CodexHostManifest> {
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    const source = this.deps.binary();
    const { binary, runtimeDir, version } = this.pin(source);
    try { fs.unlinkSync(this.socketPath); } catch { /* none left */ }
    this.rotateLog();
    const fd = fs.openSync(this.logFile, 'a', 0o600);
    let child: cp.ChildProcess;
    try {
      child = this.spawnProcess(binary, ['app-server', '--listen', `unix://${this.socketPath}`], {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: os.homedir(),
        env: hostEnv(),
      });
    } finally {
      fs.closeSync(fd);
    }
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.unref();
    const pid = child.pid;
    const deadline = this.now() + (this.deps.launchTimeoutMs ?? 15_000);
    while (!fs.existsSync(this.socketPath)) {
      if (spawnError) throw spawnError;
      if (pid === undefined || !this.isAlive(pid)) throw new Error(`Codex app-server exited at launch (see ${this.logFile})`);
      if (this.now() > deadline) {
        try { this.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        throw new Error(`Codex app-server did not open its socket in time (see ${this.logFile})`);
      }
      await this.sleep(100);
    }
    const manifest: CodexHostManifest = {
      v: 1,
      pid: pid!,
      procStart: this.processStart(pid!),
      socketPath: this.socketPath,
      binary,
      runtimeDir,
      pinnedFrom: runtimeDir ? source : undefined,
      version,
      startedAt: this.now(),
      logFile: this.logFile,
    };
    this.writeManifest(manifest);
    this.log(`codex host: started ${binary} (${version ?? 'unknown version'}) as ${pid}`);
    this.collectRuntimes(runtimeDir);
    return manifest;
  }

  /** Copy an extension bundle's `bin/<platform>/` into `runtimes/codex-<version>/` and run from there. */
  private pin(source: string): { binary: string; runtimeDir?: string; version?: string } {
    const version = this.versionOf(source);
    const binDir = extensionBinDir(source);
    if (!binDir || !version) return { binary: source, version };
    const runtimeDir = path.join(this.runtimesDir, `codex-${safeLabel(version)}`);
    const binary = path.join(runtimeDir, path.basename(source));
    if (fs.existsSync(binary)) return { binary, runtimeDir, version };
    fs.mkdirSync(this.runtimesDir, { recursive: true, mode: 0o700 });
    const staging = `${runtimeDir}.tmp-${process.pid}`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      // A clone on APFS: the bundle is ~300 MB, the clone is free.
      fs.cpSync(binDir, staging, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
      fs.renameSync(staging, runtimeDir);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (fs.existsSync(binary)) return { binary, runtimeDir, version };
      this.log(`codex host: could not pin ${binDir} (${String(error)}); running it in place`);
      return { binary: source, version };
    }
    return { binary, runtimeDir, version };
  }

  /** Remove pinned runtimes nothing runs from any more. */
  private collectRuntimes(keep: string | undefined): void {
    let names: string[];
    try { names = fs.readdirSync(this.runtimesDir); } catch { return; }
    for (const name of names) {
      if (!name.startsWith('codex-')) continue;
      const dir = path.join(this.runtimesDir, name);
      if (dir === keep) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use or gone */ }
    }
  }

  private rotateLog(): void {
    try {
      if (fs.statSync(this.logFile).size > LOG_ROTATE_BYTES) fs.renameSync(this.logFile, `${this.logFile}.1`);
    } catch { /* no log yet */ }
  }

  private writeManifest(m: CodexHostManifest): void {
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.manifestPath);
  }
}
