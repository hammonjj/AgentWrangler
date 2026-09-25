/**
 * Where the control socket and its token live, worked out the same way by the
 * app (which serves them) and by the CLI (which looks for them), so neither
 * has to tell the other.
 *
 * The socket goes beside the host sockets in `run/` unless that path is over
 * macOS's socket path limit, in which case it goes in the fallback run
 * directory, exactly like a host's (playbook §9.1). The token always stays in
 * `run/`.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { CONTROL_SOCKET_NAME, CONTROL_TOKEN_NAME } from './protocol';

/** `sun_path` is 104 bytes on macOS, NUL included (spike S3). */
export const MAX_SOCKET_PATH_BYTES = 103;

export interface RunDirs {
  /** `~/Library/Application Support/Agent Wrangler/run` */
  runDir: string;
  /** `~/.agentwrangler/run`, for sockets whose primary path is too long. */
  fallbackRunDir: string;
}

/** The app's own directories, for a process that is not the app (the CLI). */
export function defaultRunDirs(home: string = os.homedir()): RunDirs & { userDataDir: string } {
  const userDataDir = path.join(home, 'Library', 'Application Support', 'Agent Wrangler');
  return { userDataDir, runDir: path.join(userDataDir, 'run'), fallbackRunDir: path.join(home, '.agentwrangler', 'run') };
}

export function controlSocketPath(dirs: RunDirs): string {
  const primary = path.join(dirs.runDir, CONTROL_SOCKET_NAME);
  if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) return primary;
  const fallback = path.join(dirs.fallbackRunDir, CONTROL_SOCKET_NAME);
  if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) return fallback;
  throw new Error(`no socket path short enough for the control socket (${fallback})`);
}

export function controlTokenPath(dirs: RunDirs): string {
  return path.join(dirs.runDir, CONTROL_TOKEN_NAME);
}
