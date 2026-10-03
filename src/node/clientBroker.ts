/**
 * Where the plain-Node host (#125) sends everything that needs a person:
 * dialogs, toasts, opening things, the clipboard and notifications.
 *
 * The daemon has no window; it has browser connections, and which one a prompt belongs to is the business of
 * the connection-scoped prompts slice (#126), which implements the real
 * broker. This file only defines the seam, and the broker used when there is
 * no client to ask: it never blocks, answers every question with "cancel", and
 * does the few things a daemon can do on its own host.
 *
 * | Member | With no client |
 * |---|---|
 * | `info`/`warn` | undefined: the caller's "dismissed" |
 * | `error`/`flash` | logged |
 * | `input`/`pick`/`pickFolder` | undefined: cancelled |
 * | `openExternal`/`openFile`/`revealInFileManager` | logged, nothing opened |
 * | `runInTerminal` | absent, so the callers do not offer it |
 * | `notify` | `osascript display notification` on the host (decision D3) |
 * | `clipboard.writeText` | `pbcopy`, the text on stdin |
 */
import { execFile, spawn } from 'node:child_process';
import type { HostDialogs, HostServices, HostShell } from '../host/hostServices';

/** The members of `HostServices` that a client answers. */
export interface ClientBroker {
  dialogs: HostDialogs;
  shell: HostShell;
  clipboard: HostServices['clipboard'];
  /** Absent: no notifications at all (the app falls back to `dialogs.info`). */
  notify?: HostServices['notify'];
}

/** How the default broker runs its two tools. Injectable so tests run neither. */
export interface BrokerProcesses {
  /** Run a program with arguments; never through a shell. */
  execFile(file: string, args: string[], done: (err: Error | null) => void): void;
  /** Run a program with `input` on its stdin; resolves on exit 0. */
  pipe(file: string, args: string[], input: string): Promise<void>;
}

export const systemProcesses: BrokerProcesses = {
  execFile(file, args, done) {
    execFile(file, args, { timeout: 15_000 }, (err) => done(err));
  },
  pipe(file, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`))));
      child.stdin.end(input, 'utf8');
    });
  },
};

/**
 * `display notification` with the title and body as `argv`, never spliced into
 * the script: a body is agent text, and inside an AppleScript literal it could
 * close the string and run whatever followed.
 */
export const NOTIFY_SCRIPT = [
  'on run argv',
  'display notification (item 2 of argv) with title (item 1 of argv)',
  'end run',
];

export function notifyArgs(title: string, body: string): string[] {
  return [...NOTIFY_SCRIPT.flatMap((line) => ['-e', line]), '--', title, body];
}

export function createDefaultClientBroker(opts: {
  log: (message: string) => void;
  processes?: BrokerProcesses;
}): ClientBroker {
  const { log } = opts;
  const proc = opts.processes ?? systemProcesses;
  const declined = (what: string) => {
    log(`${what}: no client to ask; treated as cancelled`);
    return Promise.resolve(undefined);
  };
  return {
    dialogs: {
      info: (message) => declined(`info "${message}"`),
      warn: (message) => declined(`warn "${message}"`),
      error: (message) => log(`error: ${message}`),
      flash: (message) => log(`flash: ${message}`),
      input: (options) => declined(`input ${options.title ?? options.prompt ?? ''}`.trim()),
      pick: (_items, options) => declined(`pick ${options?.placeHolder ?? ''}`.trim()),
      pickFolder: () => declined('pickFolder'),
    },
    shell: {
      openExternal: (url) => log(`openExternal ${url}: no client to open it in`),
      openFile: (target) => log(`openFile ${target}: no client to open it in`),
      revealInFileManager: (target) => log(`reveal ${target}: no client to show it in`),
    },
    clipboard: {
      writeText: (text) => proc.pipe('/usr/bin/pbcopy', [], text),
    },
    // `onClick` cannot be honoured: a `display notification` banner has no
    // callback to this process (clicking one opens Script Editor).
    notify: ({ title, body }) => {
      proc.execFile('/usr/bin/osascript', notifyArgs(title, body), (err) => {
        if (err) log(`notification failed: ${String(err)}`);
      });
    },
  };
}
