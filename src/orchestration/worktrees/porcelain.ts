/**
 * Parsers for the two git outputs the worktree manager reads. Pure; the input
 * is foreign, so anything unexpected is skipped rather than trusted.
 */

export interface GitWorktree {
  /** Absolute, as git reports it (the real path: `/private/var/…`, not `/var/…`). */
  path: string;
  head?: string;
  /** Short name (`aw/m/t1`), or undefined on a detached HEAD. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  /** Present when locked; the reason, or '' when none was given. */
  locked?: string;
  /** Present when git would prune it: its directory is gone. */
  prunable?: string;
}

/** `git worktree list --porcelain -z`: attributes end in NUL, records in an extra NUL. */
export function parseWorktreeList(out: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let cur: GitWorktree | undefined;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) result.push(cur);
      cur = undefined;
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const value = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) result.push(cur);
      cur = { path: value, bare: false, detached: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = value;
    else if (key === 'prunable') cur.prunable = value;
  }
  if (cur) result.push(cur);
  return result;
}

export interface StatusEntry {
  /** The two-letter XY code: `??` untracked, ` M` modified, … */
  code: string;
  path: string;
}

/** `git status --porcelain=v1 -z`: `XY path\0`, with renames and copies followed by `orig\0`. */
export function parseStatus(out: string): StatusEntry[] {
  const fields = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4 || f[2] !== ' ') continue;
    const code = f.slice(0, 2);
    entries.push({ code, path: f.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip the original path
  }
  return entries;
}

/** `lsof -F pn` output → the pids whose listed name is `dir` or inside it. */
export function parseLsofCwds(out: string, dir: string): number[] {
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && Number.isInteger(pid)) {
      const name = line.slice(1);
      if (name === dir || name.startsWith(`${dir}/`)) pids.add(pid);
    }
  }
  return [...pids];
}
