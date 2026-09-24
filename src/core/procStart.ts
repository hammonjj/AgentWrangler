/**
 * When a process started, as `ps` prints it, so a pid can be checked against
 * the one that was recorded. Pids are reused; a manifest naming pid 4321 means
 * nothing once some other program has been given 4321 (playbook §12, "PID reuse").
 *
 * The string is compared, not parsed: both sides read it the same way.
 */
import { execFileSync } from 'node:child_process';

/**
 * `ps -o lstart= -p <pid>`, trimmed, or undefined when there is no such process.
 *
 * Always read in UTC and the C locale: `lstart` is printed in the local time
 * zone and language, so a laptop that changed time zone (or a user who changed
 * locale) would otherwise see every recorded start time differ, and take every
 * live session host for dead (CP2 review).
 */
export function startTimeOf(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Alive, and (when a start time was recorded) the same process that recorded it. */
export function isSameProcessAlive(pid: number | undefined, recordedStart: string | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: it exists but belongs to someone else, so it is not ours either.
    return false;
  }
  if (recordedStart === undefined) return true;
  return startTimeOf(pid) === recordedStart;
}
