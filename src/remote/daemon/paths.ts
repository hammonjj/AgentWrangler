/**
 * Where the remote daemon's socket, token and manifest live, worked out the
 * same way by the daemon and by the app, like `core.sock`'s: beside the host
 * sockets in `run/`, or in the fallback run directory when that path is over
 * macOS's socket path limit. The token and manifest always stay in `run/`.
 */
import * as path from 'node:path';
import { MAX_SOCKET_PATH_BYTES, type RunDirs } from '../../core/control/paths';
import { REMOTE_MANIFEST_NAME, REMOTE_SOCKET_NAME, REMOTE_TOKEN_NAME } from './protocol';

export interface RemoteDaemonPaths {
  socketPath: string;
  tokenPath: string;
  manifestPath: string;
}

export function remoteDaemonPaths(dirs: RunDirs): RemoteDaemonPaths {
  const primary = path.join(dirs.runDir, REMOTE_SOCKET_NAME);
  let socketPath = primary;
  if (Buffer.byteLength(primary) > MAX_SOCKET_PATH_BYTES) {
    socketPath = path.join(dirs.fallbackRunDir, REMOTE_SOCKET_NAME);
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`no socket path short enough for the remote daemon (${socketPath})`);
    }
  }
  return {
    socketPath,
    tokenPath: path.join(dirs.runDir, REMOTE_TOKEN_NAME),
    manifestPath: path.join(dirs.runDir, REMOTE_MANIFEST_NAME),
  };
}
