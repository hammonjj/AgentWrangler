/**
 * Keeping the Mac awake while agents work, without Electron's
 * `powerSaveBlocker` (plan §4).
 *
 * `caffeinate -i -w <pid>` holds an idle-sleep assertion until it is killed or
 * the process it watches exits, so a daemon that crashes cannot leave the
 * machine awake for ever. Toggled the way `syncPowerBlock` in
 * `src/electron/main.ts` toggles its blocker: `set(wanted)` from the store's
 * updates, with `wanted` from `shouldPreventAppSuspension`. Not wired into
 * anything yet; the daemon (#130) does that.
 */
import { spawn } from 'node:child_process';
import type { Disposable } from '../core/events';

/** The part of a child process this needs. */
export interface CaffeinateChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export interface PowerAssertionOptions {
  log: (message: string) => void;
  /** The process whose life bounds the assertion. Default: this one. */
  pid?: number;
  /** Tests: start `caffeinate` with these arguments. */
  spawn?: (args: string[]) => CaffeinateChild;
}

export interface PowerAssertion extends Disposable {
  readonly held: boolean;
  /** Hold the assertion, or let it go. Idempotent. */
  set(wanted: boolean): void;
}

export const CAFFEINATE = '/usr/bin/caffeinate';

export function caffeinateArgs(pid: number): string[] {
  return ['-i', '-w', String(pid)];
}

export function createPowerAssertion(opts: PowerAssertionOptions): PowerAssertion {
  const start =
    opts.spawn ?? ((args: string[]) => spawn(CAFFEINATE, args, { stdio: 'ignore' }));
  const pid = opts.pid ?? process.pid;
  let child: CaffeinateChild | undefined;

  const release = () => {
    const c = child;
    child = undefined;
    c?.kill('SIGTERM');
  };

  return {
    get held() {
      return child !== undefined;
    },
    set(wanted) {
      if (wanted && !child) {
        const c = start(caffeinateArgs(pid));
        child = c;
        // Gone on its own (killed from outside, or never started): not held,
        // so the next `set(true)` starts another.
        const lost = () => {
          if (child === c) child = undefined;
        };
        c.once('exit', lost);
        c.once('error', (err) => {
          opts.log(`caffeinate failed: ${String(err)}`);
          lost();
        });
      } else if (!wanted && child) {
        release();
      }
    },
    dispose: release,
  };
}
