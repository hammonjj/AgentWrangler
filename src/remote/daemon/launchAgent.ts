/**
 * The remote daemon's LaunchAgent plist (#74), as text. Pure, so it can be
 * compared with what is installed: an unchanged plist means nothing to reload.
 *
 * - `RunAtLoad`: started at login (and when the app bootstraps it);
 * - `KeepAlive.SuccessfulExit = false`: restarted after a crash, not after a
 *   clean exit (a second copy that found one already running, or an explicit
 *   stop);
 * - `ProcessType = Interactive`: the Discord gateway's heartbeat must not be
 *   throttled the way a `Background` job's timers are;
 * - `LimitLoadToSessionType = Aqua`: only in a logged-in GUI session, where
 *   the app, the hosts and the keychain it was handed a token from all are.
 */
export interface LaunchAgentSpec {
  label: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  logFile: string;
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
    '  <true/>',
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

/** The session host entry in a runtime → the daemon's, beside it: `.../dist/sessionHost/main.js` → `.../dist/remoteDaemon/main.js`. */
export function daemonEntryFor(sessionHostEntry: string): string {
  return sessionHostEntry.replace(/([\\/])sessionHost([\\/])main\.js$/, '$1remoteDaemon$2main.js');
}
