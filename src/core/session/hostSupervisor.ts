/**
 * Starts session hosts, finds the ones a previous run of the app left behind,
 * and hands out a `HostClient` for each (playbook §5, §7.3, Stage 3).
 *
 * It never decides anything about a session: that is `RunnerService`'s and
 * the registry's. It knows where hosts live on disk (`run/`: manifests,
 * tokens, sockets; `logs/`; the cloned runtimes), how to start one detached,
 * and whether a manifest's host is still the same live process.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { endProcess, type EndOutcome } from '../../claude/runner/adopt';
import { isSameProcessAlive, startTimeOf } from '../procStart';
import type { LaunchPolicy } from '../../shared/launchPolicy';
import type { HostBoot, HostManifest } from '../../shared/sessionProtocol';
import { HostClient } from './hostClient';
import { readManifest, readManifests, removeHostFiles } from './manifestFile';

/** Where a host runs from. The Electron front end clones and signs its own bundle; tests use Node. */
export interface SessionHostRuntime {
  readonly buildId: string;
  /** The executable and entry script for a new host. May clone the running bundle first. */
  prepare(): Promise<{ exe: string; entry: string; runtimeDir?: string }>;
  /** Remove cloned runtimes no live host uses. */
  gc?(inUse: Set<string>): void;
}

export interface HostSupervisorOptions {
  /** 0700: manifests, tokens and (when the path is short enough) sockets. */
  runDir: string;
  /** For sockets when `runDir` would exceed macOS's 104-byte socket path limit. */
  fallbackRunDir: string;
  logDir: string;
  runtime: SessionHostRuntime;
  log: (msg: string) => void;
  /** The app's build, told to each host and compared with its own in `hello`. */
  build: string;
  /** Extra environment for hosts (tests: `AW_SESSION_HOST_FAKE`). */
  hostEnv?: Record<string, string>;
  /** How long a new host gets to write its manifest. */
  startTimeoutMs?: number;
  /** `lifecycle.orphanIdleHours`, read at each spawn and pushed to hosts on connect. */
  orphanIdleHours?: () => number;
}

export interface HostLaunch {
  cwd: string;
  /** Always set: the session's id, fresh or resumed, known before the host starts. */
  sessionId: string;
  resume?: boolean;
  permissionMode?: string;
  model?: string;
  effort?: string;
  binary: string;
  /** Handed to the host as is; it applies the `claude` half. */
  policy?: LaunchPolicy;
  /** The registry's `origin`, written into the manifest (#72). */
  origin?: unknown;
}

export interface ScanResult {
  /** Hosts still running (same pid, same start time). */
  alive: HostManifest[];
  /** Hosts that are gone; `exit` says whether they reported why. */
  dead: HostManifest[];
  /**
   * Hosts still running whose manifest is from a version this build does not
   * know (after a downgrade). Their sessions are held, not ownerless: never
   * adopted, never resumed a second time, their files never collected.
   */
  foreign: HostManifest[];
}

/**
 * A dead host with no exit record keeps its manifest until the orphan sweep
 * has cleared its session (`forget`), or this long at most.
 */
const LOST_MANIFEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Host logs outlive their host by this long, for a look after the fact; then they go. */
export const HOST_LOG_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** How long a signalled host gets before SIGKILL: longer than the 5 s it gives its agent. */
const HOST_STOP_GRACE_MS = 10_000;
/** A token with no manifest beside it is from a host that never came up (the app went first). */
const STRAY_TOKEN_KEEP_MS = 24 * 60 * 60 * 1000;

/** Longest usable socket path: macOS's `sun_path` is 104 bytes including the NUL (spike S3). */
export const MAX_SOCKET_PATH_BYTES = 103;

export class HostSupervisor {
  constructor(private opts: HostSupervisorOptions) {}

  /**
   * Read every manifest and sort the hosts into alive and dead. Synchronous,
   * so startup can do it before anything else looks at sessions (§7.3 step 1).
   */
  scan(): ScanResult {
    const alive: HostManifest[] = [];
    const dead: HostManifest[] = [];
    const foreign: HostManifest[] = [];
    for (const { manifest, known } of readManifests(this.opts.runDir, true)) {
      const live = isSameProcessAlive(manifest.hostPid, manifest.hostStartTime);
      if (!known) {
        if (live) foreign.push(manifest);
        continue; // a dead foreign host's files are its own version's to clear up
      }
      if (live) alive.push(manifest);
      else dead.push(manifest);
    }
    return { alive, dead, foreign };
  }

  /**
   * Remove what gone hosts left: manifests, tokens, sockets, and runtimes
   * nothing uses. A host that died without an exit record keeps its manifest
   * for a while: it names the agent that may still be running, which the
   * Stage 4 orphan sweep needs.
   */
  collect(scan: ScanResult, now = Date.now()): void {
    for (const m of scan.dead) {
      if (m.exit || now - m.startedAt > LOST_MANIFEST_KEEP_MS) removeHostFiles(this.opts.runDir, m);
    }
    const holding = [...scan.alive, ...scan.foreign, ...scan.dead.filter((m) => !m.exit)];
    const inUse = new Set(holding.map((m) => m.runtimeDir).filter((d): d is string => typeof d === 'string'));
    try {
      this.opts.runtime.gc?.(inUse);
    } catch (err) {
      this.opts.log(`runtime gc failed: ${String(err)}`);
    }
    this.collectStrays(now);
  }

  /**
   * A lost host's manifest has done its job once the orphan sweep has
   * cleared its session: nothing it names can still be running. Re-checked
   * here, so a manifest whose host came back to life is never removed.
   */
  forget(manifest: HostManifest): void {
    const current = readManifest(path.join(this.opts.runDir, `${manifest.hostId}.json`));
    if (!current || current.exit) return;
    if (isSameProcessAlive(current.hostPid, current.hostStartTime)) return;
    removeHostFiles(this.opts.runDir, current);
  }

  /**
   * The live host holding `sessionId`, of any manifest version: while there
   * is one, the session must not be resumed or taken over (§7.3). Read fresh:
   * hosts come and go while the app runs.
   */
  heldBy(sessionId: string | undefined): { manifest: HostManifest; known: boolean } | undefined {
    if (!sessionId) return undefined;
    const id = sessionId.toLowerCase();
    for (const read of readManifests(this.opts.runDir, true)) {
      if (read.manifest.sessionId?.toLowerCase() !== id) continue;
      if (isSameProcessAlive(read.manifest.hostPid, read.manifest.hostStartTime)) return read;
    }
    return undefined;
  }

  /** The agent pids of every live host, for the orphan sweep: those are owned, never orphans. */
  heldAgentPids(): Set<number> {
    const out = new Set<number>();
    for (const { manifest } of readManifests(this.opts.runDir, true)) {
      if (typeof manifest.agentPid !== 'number') continue;
      if (isSameProcessAlive(manifest.hostPid, manifest.hostStartTime)) out.add(manifest.agentPid);
    }
    return out;
  }

  /**
   * Stop a host this app cannot talk to (unreachable, or a manifest version
   * it does not know): SIGTERM, which makes the host end its agent the way a
   * logout does, escalating to SIGKILL. Only ever the process the manifest
   * names, checked by start time before every signal.
   */
  async stopHost(manifest: HostManifest): Promise<EndOutcome> {
    // Without a recorded start time the pid cannot be proved to be the host.
    if (!manifest.hostStartTime) {
      this.opts.log(`host ${manifest.hostId}: no recorded start time; not signalling pid ${manifest.hostPid}`);
      return 'refused';
    }
    const outcome = await endProcess(
      manifest.hostPid,
      {
        kill: (pid, sig) => process.kill(pid, sig),
        isAlive: (pid) => isSameProcessAlive(pid, undefined),
        startTimeOf,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      manifest.hostStartTime,
      // The host gives its agent 5 s after SIGTERM, then SIGKILLs it and
      // writes its exit record. Killing the host first would orphan the agent.
      { termGraceMs: HOST_STOP_GRACE_MS },
    );
    this.opts.log(`host ${manifest.hostId} (session ${manifest.sessionId}): stopped on request → ${outcome}`);
    return outcome;
  }

  /** Logs of hosts long gone, and tokens of hosts that never came up. */
  private collectStrays(now: number): void {
    const live = new Set(readManifests(this.opts.runDir, true).map((r) => r.manifest.hostId));
    const oldFiles = (dir: string, match: RegExp, keepMs: number) => {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const m = match.exec(name);
        if (!m || live.has(m[1])) continue;
        const file = path.join(dir, name);
        try {
          if (now - fs.statSync(file).mtimeMs > keepMs) fs.rmSync(file, { force: true });
        } catch {
          // gone meanwhile
        }
      }
    };
    oldFiles(this.opts.logDir, /^host-([a-z2-7]{8})\.log$/, HOST_LOG_KEEP_MS);
    oldFiles(this.opts.runDir, /^([a-z2-7]{8})\.token$/, STRAY_TOKEN_KEEP_MS);
  }

  /** Start a host for a session. Returns its client at once; the host comes up in the background. */
  spawn(launch: HostLaunch): { client: HostClient; hostId: string } {
    this.ensurePrivateDir(this.opts.runDir);
    const hostId = newHostId();
    const token = randomBytes(32).toString('base64url');
    const socketPath = this.socketPathFor(hostId);
    const manifestPath = path.join(this.opts.runDir, `${hostId}.json`);
    fs.writeFileSync(path.join(this.opts.runDir, `${hostId}.token`), token, { mode: 0o600 });

    let manifest: HostManifest | undefined;
    const startedAt = Date.now();
    const hostReady = this.launch(hostId, token, socketPath, manifestPath, launch).then((m) => {
      manifest = m;
    });
    const client = new HostClient({
      hostId,
      socketPath,
      token,
      cwd: launch.cwd,
      startedAt,
      hostPid: () => manifest?.hostPid,
      hostStartTime: () => manifest?.hostStartTime,
      readTombstone: () => readManifest(manifestPath)?.exit,
      mode: 'spawn',
      hostReady,
      build: this.opts.build,
      log: this.opts.log,
      orphanIdleHours: this.opts.orphanIdleHours,
    });
    return { client, hostId };
  }

  /** A client for a host a previous run of the app started (`scan().alive`). */
  attach(manifest: HostManifest, transcriptUuids: Promise<Set<string>>): HostClient {
    let token = '';
    try {
      token = fs.readFileSync(path.join(this.opts.runDir, `${manifest.hostId}.token`), 'utf8').trim();
    } catch (err) {
      this.opts.log(`host ${manifest.hostId}: token unreadable (${String(err)})`);
    }
    return new HostClient({
      hostId: manifest.hostId,
      socketPath: manifest.socketPath,
      token,
      cwd: manifest.cwd,
      startedAt: manifest.startedAt,
      hostPid: () => manifest.hostPid,
      hostStartTime: () => manifest.hostStartTime,
      readTombstone: () => readManifest(path.join(this.opts.runDir, `${manifest.hostId}.json`))?.exit,
      mode: 'adopt',
      transcriptUuids,
      build: this.opts.build,
      log: this.opts.log,
      orphanIdleHours: this.opts.orphanIdleHours,
    });
  }

  // ---- internals ----

  private async launch(
    hostId: string,
    token: string,
    socketPath: string,
    manifestPath: string,
    launch: HostLaunch,
  ): Promise<HostManifest> {
    const runtime = await this.opts.runtime.prepare();
    fs.mkdirSync(this.opts.logDir, { recursive: true });
    const logFile = path.join(this.opts.logDir, `host-${hostId}.log`);
    const logFd = fs.openSync(logFile, 'a', 0o600);
    const boot: HostBoot = {
      token,
      hostId,
      socketPath,
      manifestPath,
      hostBuild: this.opts.runtime.buildId,
      runtimeDir: runtime.runtimeDir,
      orphanIdleHours: this.opts.orphanIdleHours?.(),
      launch: {
        cwd: launch.cwd,
        resume: launch.resume ? launch.sessionId : undefined,
        sessionId: launch.resume ? undefined : launch.sessionId,
        permissionMode: launch.permissionMode,
        model: launch.model,
        effort: launch.effort,
        binary: launch.binary,
        ...(launch.policy ? { policy: launch.policy } : {}),
        origin: launch.origin,
      },
    };
    let exited: string | undefined;
    let pid: number | undefined;
    try {
      // Detached: its own session and process group, so it outlives the app
      // and a signal to the app's group never reaches it. Output to a file,
      // never a pipe to the app (a pipe would break when the app goes).
      const child = spawn(runtime.exe, [runtime.entry], {
        detached: true,
        stdio: ['pipe', logFd, logFd],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.opts.hostEnv },
      });
      pid = child.pid;
      child.once('error', (err) => (exited = String(err)));
      child.once('exit', (code, signal) => (exited = `exited (${code ?? signal})`));
      child.stdin?.end(`${JSON.stringify(boot)}\n`);
      child.unref();
      this.opts.log(`host ${hostId}: spawned pid ${child.pid} for ${launch.cwd} (${launch.resume ? 'resume' : 'new'} ${launch.sessionId})`);
    } finally {
      fs.closeSync(logFd);
    }
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 20_000);
    for (;;) {
      const manifest = readManifest(manifestPath);
      if (manifest) return manifest;
      if (exited) {
        this.abandon(hostId, socketPath);
        throw new Error(`the host ${exited} before it was ready; see ${logFile}`);
      }
      if (Date.now() > deadline) {
        // Never leave a host running that nobody will ever talk to. The pid
        // is still this child's: it has not been reaped (no `exit` yet), so
        // it cannot have been reused.
        if (pid !== undefined && !exited) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // gone
          }
        }
        this.abandon(hostId, socketPath);
        throw new Error(`the host did not come up in time; see ${logFile}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Clear up after a host that never came up. */
  private abandon(hostId: string, socketPath: string): void {
    for (const f of [path.join(this.opts.runDir, `${hostId}.token`), path.join(this.opts.runDir, `${hostId}.json`), socketPath]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // gone
      }
    }
  }

  private socketPathFor(hostId: string): string {
    const primary = path.join(this.opts.runDir, `${hostId}.sock`);
    // Measured before bind: EINVAL from a long path is not specific enough to catch (spike S3).
    if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) return primary;
    this.ensurePrivateDir(this.opts.fallbackRunDir);
    const fallback = path.join(this.opts.fallbackRunDir, `${hostId}.sock`);
    if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) return fallback;
    throw new Error(`no socket path short enough for a session host (${fallback})`);
  }

  /** 0700 and ours, or refuse: a socket directory anyone else can reach is not a private channel (§12). */
  private ensurePrivateDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.statSync(dir);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error(`${dir} belongs to another user; refusing to start session hosts there`);
    }
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
}

/** Eight base32 characters: short enough to keep socket paths under the limit, random enough never to collide. */
export function newHostId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(8);
  let id = '';
  for (const b of bytes) id += alphabet[b & 31];
  return id;
}
