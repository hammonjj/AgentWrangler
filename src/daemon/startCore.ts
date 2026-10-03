/**
 * The core daemon's composition (#130, plan §4): everything
 * `src/electron/main.ts` builds except windows, on plain Node.
 *
 * - `createNodeHost` + `createApp` + `start()`;
 * - the control socket, exactly as the app serves it (`createControlBackend`);
 * - the quit policy: `stop('signal')` is ⌘Q (hosts keep running),
 *   `stop('menuStopAll')` is ⌥⌘Q (they end too);
 * - a power assertion (`caffeinate -i -w <pid>`) while an agent it runs is
 *   working, from the same `shouldPreventAppSuspension` the window uses;
 * - wake handling through the timer-gap watcher, for `onSystemResume`;
 * - the manifest, `run/core-daemon.json`;
 * - Discord, in-process (#138), once the separate remote daemon is retired.
 *
 * Single instance: the control socket. If anything answers on it, the app or
 * another daemon holds the core, and this refuses before building anything.
 *
 * Separate from `main.ts` (signals, env, `process.exit`) so a test can start
 * and stop it against temp directories.
 */
import * as path from 'node:path';
import type { AgentWranglerApp } from '../app/createApp';
import { createApp } from '../app/createApp';
import { createControlBackend } from '../app/controlBackend';
import { ControlServer, ensurePrivateDir, writeControlToken } from '../core/control/server';
import { socketAnswers, type SocketProbe } from '../core/control/probe';
import {
  coreDaemonPaths,
  describeCoreHolder,
  findCoreHolder,
  removeCoreManifest,
  writeCoreManifest,
  type CoreDaemonManifest,
  type CoreDaemonPaths,
  type CoreHolder,
} from '../core/daemon/coreDaemon';
import type { Disposable } from '../core/events';
import type { SecurityRunner } from '../core/keychainSecrets';
import { menuBarSessions, shouldPreventAppSuspension } from '../core/menuBar';
import type { SessionHostRuntime } from '../core/session/hostSupervisor';
import { agentCount, quitPolicy, type QuitDecision, type QuitSource } from '../core/session/quitPolicy';
import { watchForSleep } from '../core/sleepWatcher';
import type { HostServices } from '../host/hostServices';
import { createNodeHost, type NodeHost } from '../node/nodeHost';
import { createPowerAssertion, type PowerAssertion } from '../node/powerAssertion';

export interface StartCoreDaemonOptions {
  /** `~/Library/Application Support/Agent Wrangler`, or a temp dir in tests. */
  dataDir: string;
  /** Default `~/.agentwrangler/run`. */
  fallbackRunDir?: string;
  build: string;
  runtime: SessionHostRuntime;
  /** The runtime clone this daemon runs from, for the manifest (and so the GC keeps it). */
  runtimeDir?: string;
  /**
   * Discord, in this process (#138): fed the core's own list, applying presses
   * through its own actions. `retireDaemon` stops the separate remote daemon
   * (and removes its LaunchAgent) before the first connect.
   */
  remoteInProcess?: HostServices['remoteInProcess'];
  log: (message: string) => void;
  /** Tests: the Keychain, PATH, the socket probe, power and sleep. */
  securityRunner?: SecurityRunner;
  fixToolPath?: boolean;
  probe?: SocketProbe;
  power?: PowerAssertion;
  watchSleep?: (onWake: (gapMs: number) => void) => Disposable;
  /** "Open at login" changed: the LaunchAgent's `RunAtLoad` follows it. */
  onOpenAtLoginChange?: () => void;
  pid?: number;
  now?: () => number;
}

export interface RunningCoreDaemon {
  readonly app: AgentWranglerApp;
  readonly host: NodeHost;
  readonly paths: CoreDaemonPaths;
  readonly manifest: CoreDaemonManifest;
  readonly power: PowerAssertion;
  /**
   * Apply the quit policy for `source`, end what it says to end, and dispose
   * everything. Safe to call twice; the second call returns the first's
   * decision.
   */
  stop(source: QuitSource): Promise<QuitDecision>;
}

export type StartCoreResult =
  | { started: true; daemon: RunningCoreDaemon }
  | { started: false; holder: CoreHolder; reason: string };

export async function startCoreDaemon(opts: StartCoreDaemonOptions): Promise<StartCoreResult> {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const paths = coreDaemonPaths(opts.dataDir, opts.fallbackRunDir);

  // ---- Single instance (plan §4): never two cores ----
  const holder = await findCoreHolder({ socketPath: paths.socketPath, manifestPath: paths.manifestPath, probe: opts.probe ?? socketAnswers });
  if (holder.kind !== 'none') {
    return { started: false, holder, reason: describeCoreHolder(holder, now()) };
  }

  const host = createNodeHost({
    dataDir: opts.dataDir,
    log,
    securityRunner: opts.securityRunner,
    fixToolPath: opts.fixToolPath,
    sessionHosts: { runtime: opts.runtime, runDir: paths.runDir, fallbackRunDir: paths.fallbackRunDir, logDir: paths.logDir },
    remoteInProcess: opts.remoteInProcess,
  });
  const app = createApp(host);
  const startedAt = now();

  // ---- The control socket (#21), before start: it is this daemon's claim on the core ----
  ensurePrivateDir(paths.runDir);
  ensurePrivateDir(path.dirname(paths.socketPath));
  const control = new ControlServer({
    token: writeControlToken(paths.tokenPath),
    log,
    backend: createControlBackend(app, {
      build: opts.build,
      appPid: pid,
      startedAt,
      flash: (message) => host.dialogs.flash(message, 4000),
      gate: app.access,
      // WEB SERVER CALL SITE (#127 → #131): see the section below.
      webLink: () => undefined,
    }),
  });
  try {
    await control.listen(paths.socketPath);
  } catch (err) {
    control.dispose();
    app.dispose();
    host.disposeAll();
    throw new Error(`control socket: not serving on ${paths.socketPath}: ${String(err)}`);
  }
  log(`control socket: listening on ${paths.socketPath}`);

  app.start();

  const manifest: CoreDaemonManifest = {
    pid,
    build: opts.build,
    startedAt,
    dataDir: opts.dataDir,
    ...(opts.runtimeDir ? { runtimeDir: opts.runtimeDir } : {}),
  };
  writeCoreManifest(paths.manifestPath, manifest);

  // ---- Power (plan §4): held only while an agent this core runs is working or asking ----
  const power = opts.power ?? createPowerAssertion({ log, pid });
  const syncPower = () => power.set(shouldPreventAppSuspension(menuBarSessions(app)));
  host.subscribe(app.store.onDidUpdate(() => syncPower()));
  syncPower();

  // ---- Sleep: links and the Discord gateway are rechecked on wake ----
  const sleep = (opts.watchSleep ?? ((onWake) => watchForSleep({ onWake })))((gap) => {
    log(`woke after ${Math.round(gap / 1000)} s`);
    app.onSystemResume();
  });

  // ---- Open at login → the LaunchAgent's RunAtLoad ----
  host.subscribe(host.settings.onDidChange((affects) => {
    if (affects('openAtLogin')) opts.onOpenAtLoginChange?.();
  }));

  // ---- WEB SERVER CALL SITE (#127 → #131) ----
  //
  // The HTTP side (`src/core/web/server.ts`) is host-neutral, but what it
  // hands each upgraded socket to (`createBrowserClients` in
  // `src/electron/webPrototype.ts`, over `createWorkbenchHosts` in
  // `src/electron/workbenchWindow.ts`) still lives beside Electron and imports
  // it. Once those move out of `src/electron/`, start it here as `main.ts`
  // does: a `ClientRegistry` (#126) made the host's broker
  // (`host.useBroker`) and the app's surface (`app.attachSurface`), then
  // `new WebServer({ ..., dataDir: host.dataDir, gate: app.access, onClient })`
  // following `web.enabled` and `web.port`; return its `loginLink()` from
  // `webLink` above and dispose it in `teardown` below. Until then `aw web
  // open` says the workbench is off, and dialogs get the default broker's
  // "cancel".
  const web = undefined as Disposable | undefined;

  log(`core daemon started: pid ${pid}, build ${opts.build}`);

  let stopping: Promise<QuitDecision> | undefined;
  const teardown = () => {
    web?.dispose();
    sleep.dispose();
    power.dispose();
    control.dispose();
    app.dispose();
    removeCoreManifest(paths.manifestPath, pid);
    host.disposeAll();
  };

  const stop = (source: QuitSource): Promise<QuitDecision> =>
    (stopping ??= (async () => {
      const counts = app.sessionCounts();
      const decision = quitPolicy({ source, ...counts });
      log(`core daemon stopping (${source}); ${counts.hosted} hosted and ${counts.local} in-process Codex session(s)`);
      // Committed to stopping: `aw send`/`aw stop` must not race the ending below.
      control.stopMutations();
      try {
        await app.stopAllForQuit(decision.stopWithinMs, { includeHosted: decision.stopHosted });
      } catch (err) {
        log(`ending sessions at stop failed: ${String(err)}`);
      }
      if (!decision.stopHosted && counts.hosted > 0) {
        log(`${agentCount(counts.hosted)} keep running in session hosts; the next core reattaches them`);
      }
      // Hang up Discord with the mirror map written, so the next connector
      // (this daemon again, or the app's remote daemon) adopts the open cards.
      await withTimeout(app.stopRemote(), 5000).catch((err) => log(`remote: stopping failed: ${String(err)}`));
      teardown();
      return decision;
    })());

  return { started: true, daemon: { app, host, paths, manifest, power, stop } };
}

/** `p`, or a rejection after `ms`: a stop must not hang on Discord. */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
