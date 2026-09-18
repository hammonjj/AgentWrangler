import * as os from 'node:os';
import * as path from 'node:path';

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return path.join(codexHome(), 'sessions');
}
