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
