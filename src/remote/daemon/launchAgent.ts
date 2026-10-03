/**
 * The remote daemon's LaunchAgent plist (#74), as text, and the core
 * daemon's (#130). Pure, so it can be compared with what is installed: an
 * unchanged plist means nothing to reload.
 *
 * - `RunAtLoad`: started at login (and when the app bootstraps it); optional
 *   for the core daemon, which follows "Open at login";
 * - `KeepAlive.SuccessfulExit = false`: restarted after a crash, not after a
 *   clean exit (a second copy that found one already running, or an explicit
 *   stop);
 * - `ProcessType = Interactive`: the Discord gateway's heartbeat must not be
 *   throttled the way a `Background` job's timers are;
 * - `LimitLoadToSessionType = Aqua`: only in a logged-in GUI session, where
 *   the app, the hosts and the login keychain it reads the token from all are.
 */
export interface LaunchAgentSpec {
  label: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  logFile: string;
  /**
   * Start it when the agent is loaded, at login included. Default true (the
   * remote daemon). The core daemon (#130) sets it from "Open at login" and is
   * otherwise started by `launchctl kickstart`.
   */
  runAtLoad?: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderLaunchAgent(spec: LaunchAgentSpec): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${esc(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.program, ...spec.args].map((a) => `    <string>${esc(a)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.keys(spec.env)
      .sort()
      .flatMap((k) => [`    <key>${esc(k)}</key>`, `    <string>${esc(spec.env[k])}</string>`]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    spec.runAtLoad === false ? '  <false/>' : '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${esc(spec.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${esc(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

/**
 * The daemon's own environment (the LaunchAgent's `EnvironmentVariables`):
 * where the run directories are, which runtime it runs from, and whatever the
 * runtime's executable needs to act as Node (`ELECTRON_RUN_AS_NODE` for the
 * Electron binary, nothing for the bundled Node, #129).
 */
export function remoteDaemonEnv(
  runDirs: { runDir: string; fallbackRunDir: string },
  rt: { runtimeDir?: string; env?: Record<string, string> },
): Record<string, string> {
  return {
    ...rt.env,
    AW_RUN_DIR: runDirs.runDir,
    AW_FALLBACK_RUN_DIR: runDirs.fallbackRunDir,
    ...(rt.runtimeDir ? { AW_REMOTE_RUNTIME_DIR: rt.runtimeDir } : {}),
  };
}

/** The session host entry in a runtime → the daemon's, beside it: `.../dist/sessionHost/main.js` → `.../dist/remoteDaemon/main.js`. */
export function daemonEntryFor(sessionHostEntry: string): string {
  return sessionHostEntry.replace(/([\\/])sessionHost([\\/])main\.js$/, '$1remoteDaemon$2main.js');
}
