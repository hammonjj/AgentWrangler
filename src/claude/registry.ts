import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionKind } from '../shared/model';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  version?: string;
  kind?: SessionKind;
  entrypoint?: string;
  name?: string;
}

/** Only `<pid>.json` — the sibling `<pid>.<sha256>.key` files are secrets and must never be read. */
const REGISTRY_FILE_RE = /^\d+\.json$/;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours; ESRCH (and anything else) = not alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Read ~/.claude/sessions/<pid>.json entries, keeping only live processes.
 * Stale entries (crashed CLIs) are expected and filtered out here.
 */
export async function readRegistry(dir: string, alive: (pid: number) => boolean = isPidAlive): Promise<RegistryEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!REGISTRY_FILE_RE.test(name)) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const e = obj as Partial<RegistryEntry>;
    if (!e || typeof e !== 'object') continue;
    if (!Number.isInteger(e.pid) || (e.pid as number) <= 0) continue;
    if (typeof e.sessionId !== 'string' || e.sessionId.length < 8) continue;
    if (!alive(e.pid as number)) continue;
    entries.push({
      pid: e.pid as number,
      sessionId: e.sessionId,
      cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
      startedAt: typeof e.startedAt === 'number' ? e.startedAt : undefined,
      version: typeof e.version === 'string' ? e.version : undefined,
      kind: typeof e.kind === 'string' ? (e.kind as SessionKind) : undefined,
      entrypoint: typeof e.entrypoint === 'string' ? e.entrypoint : undefined,
      name: typeof e.name === 'string' ? e.name : undefined,
    });
  }

  // Dedupe by sessionId — newest startedAt wins.
  const bySession = new Map<string, RegistryEntry>();
  for (const e of entries) {
    const prev = bySession.get(e.sessionId);
    if (!prev || (e.startedAt ?? 0) >= (prev.startedAt ?? 0)) bySession.set(e.sessionId, e);
  }
  return [...bySession.values()];
}
