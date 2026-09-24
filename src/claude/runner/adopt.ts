/**
 * Ending the process that currently runs a session, so this window can resume
 * the same id in its place.
 *
 * Two processes holding one session id interleave their writes into the same
 * transcript, so the resume must not start until the old one is genuinely
 * gone — not merely signalled. Hence the wait, and hence the escalation: a CLI
 * mid-write can take a moment to finish and exit, and one that has wedged will
 * not exit at all.
 *
 * Pids are reused, so a pid on its own names nothing for long. When the caller
 * knows when the process started (Claude Code records it as `procStart` in
 * `sessions/<pid>.json`; a host records it in its manifest), every signal is
 * preceded by a check that the pid is still that process (playbook §12,
 * "PID reuse"). A pid now running something else is never signalled.
 *
 * Pure apart from the injected `kill`/`isAlive`/`delay`/`startTimeOf`, so the
 * escalation is testable without ever signalling a real process.
 */

export interface ProcessControl {
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  isAlive(pid: number): boolean;
  delay(ms: number): Promise<void>;
  /** `ps -o lstart` of the pid (UTC, C locale), or undefined when unknown. Needed for `expectedStart`. */
  startTimeOf?(pid: number): string | undefined;
}

/** How long the polite signal gets before we stop being polite. */
export const TERM_GRACE_MS = 5000;
/** And how long after SIGKILL before we admit defeat. */
export const KILL_GRACE_MS = 2000;
const POLL_MS = 100;

export type EndOutcome = 'already-gone' | 'exited' | 'killed' | 'refused';

type Identity = 'same' | 'gone' | 'unknown';

/**
 * Stop the process holding a session. Resolves with what it took, and only
 * `refused` means the caller must not resume: the old process is still alive,
 * or (with `expectedStart`) a live pid could not be shown to be it.
 */
export async function endProcess(
  pid: number,
  ctl: ProcessControl,
  expectedStart?: string,
  opts: { termGraceMs?: number } = {},
): Promise<EndOutcome> {
  const identity = (): Identity => {
    if (!ctl.isAlive(pid)) return 'gone';
    if (expectedStart === undefined) return 'same';
    const now = ctl.startTimeOf?.(pid);
    if (now === undefined) return 'unknown';
    // Alive, but a different process: the one we meant has already gone.
    return now === expectedStart ? 'same' : 'gone';
  };

  const first = identity();
  if (first === 'gone') return 'already-gone';
  // Cannot tell whether this pid is still the session's process. Signalling
  // could hit a stranger; calling it gone could put two owners on one id.
  if (first === 'unknown') return 'refused';

  signal(pid, 'SIGTERM', ctl);
  if (await waitForExit(opts.termGraceMs ?? TERM_GRACE_MS, ctl, identity)) return 'exited';

  const before = identity();
  if (before === 'gone') return 'exited';
  if (before === 'unknown') return 'refused';
  signal(pid, 'SIGKILL', ctl);
  return (await waitForExit(KILL_GRACE_MS, ctl, identity)) ? 'killed' : 'refused';
}

function signal(pid: number, sig: 'SIGTERM' | 'SIGKILL', ctl: ProcessControl): void {
  try {
    ctl.kill(pid, sig);
  } catch {
    // Gone between the check and the signal, or not ours to signal. The
    // liveness poll is the real answer either way.
  }
}

async function waitForExit(budgetMs: number, ctl: ProcessControl, identity: () => Identity): Promise<boolean> {
  for (let waited = 0; waited < budgetMs; waited += POLL_MS) {
    await ctl.delay(POLL_MS);
    if (identity() === 'gone') return true;
  }
  return identity() === 'gone';
}
