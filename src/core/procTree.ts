/**
 * A snapshot of the machine's process tree (pid → parent pid), and the walk up
 * it that says who owns a Claude process.
 *
 * Every live session's pid is in the registry, and a Claude process is always a
 * descendant of whatever surface hosts it: this window's extension host for a
 * panel session, a terminal's shell for a terminal session, some other window's
 * processes for one that lives elsewhere. Walking the parent chain is therefore
 * an exact ownership test, where matching the session cwd against the workspace
 * folders (the previous rule) was a guess that broke on the same folder open in
 * two windows.
 *
 * Reading the table is one `ps` per refresh, a few milliseconds. On a platform
 * without `ps` the table is unavailable and callers fall back to the cwd guess.
 */
import * as cp from 'node:child_process';

/** pid → parent pid. */
export type ProcessTable = Map<number, number>;

/** How far up to walk before assuming a cycle or runaway table. */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * Parse `ps -o pid=,stat=` output into the pids the OS currently has stopped.
 *
 * `stat` is the process state letter plus flags: `T` is stopped by a signal
 * (SIGSTOP, or a terminal stop), `t` is stopped by a debugger. Both mean the
 * same thing here — the process is not running and is not spending anything —
 * and only the first character is the state, so `T+` and `Te` count too.
 *
 * This is what makes pausing honest across windows. A record of "sessions this
 * window stopped" is bookkeeping that another window cannot see and can
 * overwrite; the process state is the fact itself, shared by every window for
 * free, correct after a reload, and true even for a process someone stopped
 * from a shell with `kill -STOP`.
 */
export function parseStoppedPids(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([A-Za-z])/.exec(line);
    if (m && (m[2] === 'T' || m[2] === 't')) out.add(Number(m[1]));
  }
  return out;
}

/**
 * Which of `pids` are stopped right now. Asks about the given pids only, so a
 * suspended editor or a backgrounded shell job elsewhere on the machine can
 * never be mistaken for a paused agent.
 *
 * Resolves to an empty set when there is nothing to ask about, and to
 * `undefined` when `ps` could not answer — which callers must treat as "no
 * information", not as "nothing is paused".
 */
export function readStoppedPids(pids: number[]): Promise<Set<number> | undefined> {
  if (pids.length === 0) return Promise.resolve(new Set());
  // Our own pid rides along so that `ps` always matches something. `ps -p`
  // exits non-zero when none of the pids exist, which is otherwise
  // indistinguishable from `ps` being broken — and reading "they have all
  // ended" as "I could not tell" would leave ended sessions marked paused for
  // as long as the window stayed open. A running process is never reported as
  // stopped, so it cannot show up in the answer.
  const query = [...pids, process.pid].join(',');
  return new Promise((resolve) => {
    cp.execFile('ps', ['-o', 'pid=,stat=', '-p', query], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const stopped = parseStoppedPids(stdout);
      stopped.delete(process.pid);
      resolve(stopped);
    });
  });
}

/** Parse `ps -A -o pid=,ppid=` output: two integers per line, whitespace-separated. */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

/**
 * The parent, grandparent, … of `pid`, nearest first, excluding `pid` itself.
 * Stops at the root (ppid 0/1), a pid missing from the table, or a cycle.
 * Empty when `pid` itself is not in the table, i.e. the process is gone.
 */
export function ancestorsOf(pid: number, table: ProcessTable): number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = pid;
  while (out.length < MAX_ANCESTOR_DEPTH) {
    const parent = table.get(cur);
    if (parent === undefined || parent <= 1 || seen.has(parent)) break;
    out.push(parent);
    seen.add(parent);
    cur = parent;
  }
  return out;
}

/** Read the live table, or undefined where `ps` is unavailable or fails. */
export function readProcessTable(): Promise<ProcessTable | undefined> {
  return new Promise((resolve) => {
    cp.execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve(parseProcessTable(stdout));
    });
  });
}
