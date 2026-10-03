/**
 * The Mac's own shell for the core daemon (#131): what a loopback browser's
 * "Open on this Mac" does (#140). The Electron app uses its native one; the
 * daemon has no Electron, so it uses `/usr/bin/open`, never through a shell
 * and never with a path that could read as a flag (`--`).
 *
 * No `runInTerminal`: starting a terminal command needs the app's Terminal
 * automation grant, so that action is simply not offered.
 */
import { execFile } from 'node:child_process';
import type { HostShell } from '../host/hostServices';

export function createMacShell(log: (message: string) => void, run: (file: string, args: string[], done: (err: Error | null) => void) => void = (f, a, d) => execFile(f, a, { timeout: 15_000 }, (err) => d(err))): HostShell {
  const open = (args: string[], what: string) =>
    run('/usr/bin/open', args, (err) => {
      if (err) log(`${what} failed: ${err.message}`);
    });
  return {
    openExternal: (url) => {
      // Only web and mail links: `open` would launch anything else.
      if (!/^(https?|mailto):/i.test(url)) return log('openExternal: refused a non-web link');
      open(['--', url], 'openExternal');
    },
    openFile: (target) => open(['--', target], 'openFile'),
    revealInFileManager: (target) => open(['-R', '--', target], 'reveal'),
  };
}
