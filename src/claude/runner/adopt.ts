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
 * Pure apart from the injected `kill`/`isAlive`/`delay`, so the escalation is
 * testable without ever signalling a real process.
 */

export interface ProcessControl {
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  isAlive(pid: number): boolean;
  delay(ms: number): Promise<void>;
}

/** How long the polite signal gets before we stop being polite. */
export const TERM_GRACE_MS = 5000;
/** And how long after SIGKILL before we admit defeat. */
export const KILL_GRACE_MS = 2000;
const POLL_MS = 100;

export type EndOutcome = 'already-gone' | 'exited' | 'killed' | 'refused';

/**
 * Stop the process holding a session. Resolves with what it took, and only
 * `refused` means the caller must not resume: the old process is still alive.
 */
export async function endProcess(pid: number, ctl: ProcessControl): Promise<EndOutcome> {
  if (!ctl.isAlive(pid)) return 'already-gone';

  try {
    ctl.kill(pid, 'SIGTERM');
  } catch {
    // Gone between the check and the signal, or not ours to signal. The
    // liveness poll below is the real answer either way.
  }
  if (await waitForExit(pid, TERM_GRACE_MS, ctl)) return 'exited';

  try {
    ctl.kill(pid, 'SIGKILL');
  } catch {
    // Same as above.
  }
  return (await waitForExit(pid, KILL_GRACE_MS, ctl)) ? 'killed' : 'refused';
}

async function waitForExit(pid: number, budgetMs: number, ctl: ProcessControl): Promise<boolean> {
  for (let waited = 0; waited < budgetMs; waited += POLL_MS) {
    await ctl.delay(POLL_MS);
    if (!ctl.isAlive(pid)) return true;
  }
  return !ctl.isAlive(pid);
}
