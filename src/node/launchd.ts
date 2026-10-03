/**
 * The few `launchctl` verbs the core daemon's LaunchAgent uses (#130), and
 * the retirement of the old remote daemon's (#74, #138), in one place, with
 * the plist itself. Always the per-user GUI domain (`gui/<uid>`), which is
 * where an Aqua-limited agent lives.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export type Launchctl = (args: string[]) => Promise<string>;

export const launchctl: Launchctl = (args) =>
  new Promise((resolve, reject) => {
    execFile('/bin/launchctl', args, { timeout: 15_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`launchctl ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });

export function guiDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `gui/${uid}`;
}

/** `~/Library/LaunchAgents/<label>.plist`. */
export function launchAgentPlistPath(label: string, home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/**
 * A LaunchAgent plist, as text. Pure, so it can be compared with what is
 * installed: an unchanged plist means nothing to reload.
 *
 * - `RunAtLoad`: started when loaded, at login included. The core daemon sets
 *   it from "Open at login" and is otherwise started by `launchctl kickstart`;
 * - `KeepAlive.SuccessfulExit = false`: restarted after a crash, not after a
 *   clean exit (a second copy that found one already running, or a stop);
 * - `ProcessType = Interactive`: the Discord gateway's heartbeat must not be
 *   throttled the way a `Background` job's timers are;
 * - `LimitLoadToSessionType = Aqua`: only in a logged-in GUI session, where
 *   the hosts and the login keychain it reads secrets from are.
 */
export interface LaunchAgentSpec {
  label: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  logFile: string;
  /** Start it when the agent is loaded, at login included. Default true. */
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

/** Bootstrap, retried: straight after a `bootout` launchd can still be tearing the old one down. */
export async function bootstrapWithRetry(run: Launchctl, domain: string, plistPath: string, attempts = 10, delayMs = 300): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await run(['bootstrap', domain, plistPath]);
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}
