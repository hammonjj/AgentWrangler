/**
 * The app's own log: `<dataDir>/agent-wrangler.log`, one timestamped line per
 * message, also echoed to stdout.
 *
 * Appended, never rotated by us: it is a developer log, and a rotation scheme
 * is a thing to get wrong before there is a reason for one. Shared by the
 * Electron main process and the plain-Node host (#125), so both write the same
 * file in the same format.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const LOG_FILE_NAME = 'agent-wrangler.log';

export interface FileLog {
  (message: string): void;
  /** Close the file. Later messages still reach stdout; they are not written. */
  close(): void;
}

export function startFileLog(dir: string, options: { echo?: boolean } = {}): FileLog {
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(path.join(dir, LOG_FILE_NAME), { flags: 'a' });
  // A failed write must not become an uncaught 'error' and take the process with it.
  stream.on('error', () => undefined);
  let open = true;
  const echo = options.echo ?? true;
  const log = ((message: string) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (open) stream.write(`${line}\n`);
    // eslint-disable-next-line no-console
    if (echo) console.log(line);
  }) as FileLog;
  log.close = () => {
    if (!open) return;
    open = false;
    stream.end();
  };
  return log;
}
