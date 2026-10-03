/**
 * The few `launchctl` verbs the LaunchAgents use (the remote daemon, #74, and
 * the core daemon, #130), in one place. Always the per-user GUI domain
 * (`gui/<uid>`), which is where an Aqua-limited agent lives.
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
