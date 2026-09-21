/**
 * Where remote control keeps its two files.
 *
 * A fixed path under `~/.cache/agent-wrangler/`, deliberately **not**
 * `HostServices.storageDir`: that is the extension's globalStorage in one front
 * end and the app's userData in the other, and the whole point of these files
 * is that every Agent Wrangler on the machine contends for the same ones. Two
 * processes looking at two different mirror maps would each post their own
 * message for one prompt, which is the exact failure the map exists to prevent.
 *
 * `~/.cache/agent-wrangler/` is already established — dictation keeps its
 * whisper model there.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export function remoteHome(): string {
  return path.join(os.homedir(), '.cache', 'agent-wrangler', 'remote');
}

/** Which remote message mirrors which ask. See `mirrorStore.ts`. */
export function mirrorFile(): string {
  return path.join(remoteHome(), 'mirrors.json');
}

/** Who approved what, from where. See `audit.ts`. */
export function auditFile(): string {
  return path.join(remoteHome(), 'audit.log');
}

/** Which process owns the transport. Phase 3. */
export function leaderFile(): string {
  return path.join(remoteHome(), 'leader.json');
}
