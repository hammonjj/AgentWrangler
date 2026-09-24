/**
 * The orphan-`claude` sweep (playbook §7.3, as amended at CP0 from spike S1).
 *
 * The Claude CLI has no single-owner lock: a second process resuming a live id
 * succeeds and silently forks the transcript. So before Agent Wrangler resumes
 * or adopts an id, anything still running it has to be accounted for:
 *
 * - **stale**: a `~/.claude/sessions/<pid>.json` whose pid is dead, or alive
 *   with a start time other than the file's `procStart` (the pid was reused).
 *   A SIGKILLed or OOM'd CLI cannot remove its own file. Ignored.
 * - **held**: the agent of a live session host. That host owns it.
 * - **orphan**: alive, the same process, parent launchd (ppid 1), and no live
 *   host's agent. Its host died without ending it (SIGKILL, OOM, a crash). It
 *   is ended here, and waited for: until it has exited it may still be writing,
 *   and that tail is legitimate conversation the resume must read.
 * - **owner**: alive with any other parent — a terminal, an editor, another
 *   app. Never killed here; that is take-over, with its confirmation.
 *
 * `clear` is the one answer callers need: nothing but stale entries remain, so
 * a resume will be the only process on the id.
 *
 * Pure apart from the injected probes, so every branch is testable without a
 * real process.
 */

/** The fields of a `sessions/<pid>.json` the sweep reads. Never a `.key` file. */
export interface ClaudeProcessEntry {
  pid: number;
  sessionId: string;
  /** `ps -o lstart` of the CLI in UTC, as Claude Code records it. */
  procStart?: string;
}

export interface SweepProbe {
  isAlive(pid: number): boolean;
  /** Read the same way as `procStart` (UTC, C locale), or undefined when unknown. */
  startTimeOf(pid: number): string | undefined;
  parentOf(pid: number): number | undefined;
}

export interface SweepDeps extends SweepProbe {
  /** Every `sessions/<pid>.json`, live or not. */
  entries(): Promise<ClaudeProcessEntry[]>;
  /** The agent pids of every live session host (known and foreign manifests). */
  heldAgentPids(): Set<number>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  delay(ms: number): Promise<void>;
  log(msg: string): void;
}

export type EntryClass = 'stale' | 'held' | 'orphan' | 'owner';

export interface SweepResult {
  /** Orphans that were ended (and have exited). */
  swept: number[];
  /** Orphans that would not die, even to SIGKILL. */
  refused: number[];
  /** Processes some other surface runs the session in: take-over territory. */
  owners: number[];
  /** Agents of live session hosts. */
  held: number[];
  /** Only stale entries are left: resuming makes the one process on this id. */
  clear: boolean;
}

/** How long an orphan gets after SIGTERM (S1: ~2.8 s busy), and after SIGKILL. */
export const ORPHAN_TERM_GRACE_MS = 5000;
export const ORPHAN_KILL_GRACE_MS = 2000;
const POLL_MS = 100;

/** Classify one entry for `sessionId`, or undefined when it is about another session. */
export function classifyEntry(
  entry: ClaudeProcessEntry,
  sessionId: string,
  probe: SweepProbe,
  heldAgentPids: ReadonlySet<number>,
): EntryClass | undefined {
  if (entry.sessionId.toLowerCase() !== sessionId.toLowerCase()) return undefined;
  if (!probe.isAlive(entry.pid)) return 'stale';
  if (entry.procStart !== undefined) {
    const now = probe.startTimeOf(entry.pid);
    // A different process has this pid now. (Unknown is not "different": it
    // might be the CLI, so it falls through and is never killed on a guess.)
    if (now !== undefined && now !== entry.procStart) return 'stale';
    if (now === undefined) return 'owner';
  } else {
    // An older CLI that records no start time: identity cannot be proved, so
    // never kill it, and never resume over it either.
    return 'owner';
  }
  if (heldAgentPids.has(entry.pid)) return 'held';
  return probe.parentOf(entry.pid) === 1 ? 'orphan' : 'owner';
}

/** End every orphan on `sessionId`, wait for each to exit, and say whether a resume is now safe. */
export async function sweepOrphans(sessionId: string, deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = { swept: [], refused: [], owners: [], held: [], clear: false };
  let entries: ClaudeProcessEntry[];
  try {
    entries = await deps.entries();
  } catch (err) {
    deps.log(`orphan sweep for ${sessionId}: could not read the Claude registry (${String(err)})`);
    entries = [];
  }
  const held = deps.heldAgentPids();
  const orphans: ClaudeProcessEntry[] = [];
  for (const entry of entries) {
    const kind = classifyEntry(entry, sessionId, deps, held);
    if (kind === 'orphan') orphans.push(entry);
    else if (kind === 'owner') result.owners.push(entry.pid);
    else if (kind === 'held') result.held.push(entry.pid);
  }
  if (orphans.length > 0) {
    deps.log(`orphan sweep for ${sessionId}: ending ${orphans.map((o) => o.pid).join(', ')}`);
    // Still there, for waiting: an unreadable start time counts as still
    // there, so a `ps` hiccup never turns into "it exited". Proved to be the
    // same process, for signalling: a pid is never signalled on a guess.
    const present = (o: ClaudeProcessEntry) => {
      if (!deps.isAlive(o.pid)) return false;
      const now = deps.startTimeOf(o.pid);
      return now === undefined || now === o.procStart;
    };
    const proved = (o: ClaudeProcessEntry) => deps.isAlive(o.pid) && deps.startTimeOf(o.pid) === o.procStart;
    for (const o of orphans) signal(deps, o.pid, 'SIGTERM');
    let left = await waitFor(orphans, present, ORPHAN_TERM_GRACE_MS, deps);
    if (left.length > 0) {
      deps.log(`orphan sweep for ${sessionId}: ${left.map((o) => o.pid).join(', ')} ignored SIGTERM; killing`);
      for (const o of left) if (proved(o)) signal(deps, o.pid, 'SIGKILL');
      left = await waitFor(left, present, ORPHAN_KILL_GRACE_MS, deps);
    }
    const stuck = new Set(left.map((o) => o.pid));
    for (const o of orphans) (stuck.has(o.pid) ? result.refused : result.swept).push(o.pid);
  }
  result.clear = result.owners.length === 0 && result.held.length === 0 && result.refused.length === 0;
  return result;
}

/** One sentence for a refused resume, or undefined when the sweep left the id clear. */
export function sweepRefusal(r: SweepResult): string | undefined {
  if (r.clear) return undefined;
  if (r.refused.length > 0) return 'An earlier process on this session would not stop, so it was not resumed (two processes on one session would fork its transcript).';
  if (r.held.length > 0) return 'A background session host is still running this session.';
  return 'Another process is running this session; take it over instead.';
}

function signal(deps: SweepDeps, pid: number, sig: 'SIGTERM' | 'SIGKILL'): void {
  try {
    deps.kill(pid, sig);
  } catch {
    // Gone meanwhile, or not ours. The poll decides.
  }
}

async function waitFor(
  procs: ClaudeProcessEntry[],
  alive: (o: ClaudeProcessEntry) => boolean,
  budgetMs: number,
  deps: SweepDeps,
): Promise<ClaudeProcessEntry[]> {
  let left = procs.filter(alive);
  for (let waited = 0; waited < budgetMs && left.length > 0; waited += POLL_MS) {
    await deps.delay(POLL_MS);
    left = left.filter(alive);
  }
  return left;
}
