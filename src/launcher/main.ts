/**
 * Agent Wrangler.app's launcher (#142): what runs when the app is opened.
 *
 * `Contents/MacOS/Agent Wrangler` is a small signed Mach-O (`launcher.c`)
 * that execs the bundled Node on this file, so the process LaunchServices
 * started is the one doing the work and exits when it is done. The work is
 * `launch.ts`: make sure the core daemon runs, ask it for a sign-in link, open
 * the link in the default browser, exit.
 *
 * Also runnable from a checkout (`node dist/launcher/main.js`), where the
 * daemon it makes sure of is the checkout's, spawned without a LaunchAgent,
 * exactly as `aw daemon start` does there.
 *
 * Usage: `Agent Wrangler [--dry-run]`.
 */
import { execFile } from 'node:child_process';
import { ControlClient } from '../cli/client';
import { locateInstall } from '../core/appBundle';
import { defaultRunDirs } from '../core/control/paths';
import type { ControlWebLinkResult } from '../core/control/protocol';
import { startFileLog } from '../core/fileLog';
import { BUILD_ID } from '../core/session/sessionHostRuntime';
import { toolPath } from '../core/toolPath';
import { coreDaemonAgentFor } from '../node/coreDaemonAgent';
import { alertArgs, launch, parseLauncherArgs } from './launch';

async function main(): Promise<number> {
  const args = parseLauncherArgs(process.argv.slice(2));
  if ('error' in args) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  // LaunchServices, like launchd, starts processes without Homebrew on PATH;
  // the daemon this may spawn (from a checkout) inherits it.
  process.env.PATH = toolPath(process.env.PATH);

  const dirs = defaultRunDirs();
  // The app log, quietly: the terminal (if any) gets only what `out` says.
  const fileLog = startFileLog(dirs.userDataDir, { echo: false });
  const log = (m: string) => fileLog(m);
  const where = locateInstall(__dirname);
  const agent = coreDaemonAgentFor(__dirname, dirs, log);

  try {
    return await launch(
      {
        daemon: {
          ensure: () => agent.ensure(),
          async check() {
            const { holder } = await agent.status();
            if (holder.kind === 'none') return { state: 'not-running' };
            if (holder.kind === 'app') return { state: 'old-app' };
            const { pid, build } = holder.manifest;
            // Unpackaged, any daemon will do, as for `aw daemon start`.
            return { state: !where.isPackaged || build === BUILD_ID ? 'current' : 'other-build', pid, build };
          },
        },
        requestLink: async () => {
          const client = await ControlClient.connect(dirs, { build: BUILD_ID, name: 'launcher' });
          if (!client) return undefined;
          try {
            return await client.request<ControlWebLinkResult>('web.link');
          } finally {
            client.close();
          }
        },
        open: (url) => run('/usr/bin/open', [url]),
        alert: (message, detail) => run('/usr/bin/osascript', alertArgs(message, detail)).catch(() => undefined),
        log,
        out: (t) => process.stdout.write(t),
      },
      { dryRun: args.dryRun },
    );
  } finally {
    fileLog.close();
  }
}

/** Run a tool; rejects on a non-zero exit. */
function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Exit once the log is flushed, and soon regardless: nothing may keep the launcher alive. */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

main().then(finish, (err) => {
  process.stderr.write(`Agent Wrangler: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  finish(1);
});
