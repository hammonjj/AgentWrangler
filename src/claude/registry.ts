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
  /**
   * A name the user gave the session (`/rename`). Claude Code also writes a
   * derived `<project>-<hash>` name (`nameSource: "derived"`) for every session;
   * those say nothing the Project column doesn't and are dropped here, so a
   * `name` on an entry is always one worth showing ahead of the title.
   */
  name?: string;
  /**
   * Claude Code's own view of what the session is doing, rewritten into the pid
   * file on every state change. Undocumented; verified in 2.1.270, where the
   * internal state maps `running → busy`, `requires_action → waiting`,
   * `idle → idle` (plus `shell` for an idle session with a shell open).
   *
   * This is the only push signal for "the human answered a permission prompt":
   * there is no hook for it, and the next hook event after `PermissionRequest`
   * is `PostToolUse`, which does not arrive until the tool has *finished*.
   */
  liveStatus?: string;
  /**
   * Why it is waiting, when `liveStatus` is `waiting`: `permission prompt` or
   * `input needed` (AskUserQuestion and the `dialog:` tools). Absent otherwise.
   */
  waitingFor?: string;
  /** When `liveStatus` last changed. Claude Code's clock, which is ours too. */
  statusUpdatedAtMs?: number;
  /**
   * When the CLI process started, as `ps -o lstart` prints it in UTC. Lets a
   * pid be checked before it is signalled: pids are reused (spike S1).
   */
  procStart?: string;
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
 * Every `<pid>.json` in the registry, live or dead: pid, session id and start
 * time only. For the orphan sweep, which has to tell a stale file from a live
 * process itself (and must see both).
 */
export async function readProcessEntries(dir: string): Promise<{ pid: number; sessionId: string; procStart?: string }[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { pid: number; sessionId: string; procStart?: string }[] = [];
  for (const name of names) {
    if (!REGISTRY_FILE_RE.test(name)) continue;
    try {
      const e = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { pid?: unknown; sessionId?: unknown; procStart?: unknown };
      if (!Number.isInteger(e?.pid) || (e.pid as number) <= 0 || typeof e.sessionId !== 'string') continue;
      out.push({ pid: e.pid as number, sessionId: e.sessionId, procStart: typeof e.procStart === 'string' ? e.procStart : undefined });
    } catch {
      // unreadable or half-written: nothing to act on
    }
  }
  return out;
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
    const e = obj as Partial<RegistryEntry> & {
      nameSource?: unknown;
      status?: unknown;
      waitingFor?: unknown;
      statusUpdatedAt?: unknown;
    };
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
      name: typeof e.name === 'string' && e.nameSource !== 'derived' ? e.name : undefined,
      liveStatus: typeof e.status === 'string' ? e.status : undefined,
      waitingFor: typeof e.waitingFor === 'string' ? e.waitingFor : undefined,
      procStart: typeof e.procStart === 'string' ? e.procStart : undefined,
      // Only meaningful alongside a status, and only as a number: a missing or
      // malformed stamp must read as "no opinion", never as epoch 0, which
      // would compare older than every block.
      statusUpdatedAtMs:
        typeof e.status === 'string' && typeof e.statusUpdatedAt === 'number' && Number.isFinite(e.statusUpdatedAt)
          ? e.statusUpdatedAt
          : undefined,
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
