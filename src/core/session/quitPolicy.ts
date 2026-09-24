/**
 * What quitting does, by where the quit came from.
 *
 * Pure. Electron 44 gives no reason on `before-quit`, so the app labels the
 * sources it owns and treats everything else as external
 * (`docs/plans/session-lifecycle-architecture.md` §7.2, §11.10):
 *
 * - `menu`: the app's own Quit item (⌘Q). A person is at the keyboard.
 * - `menuStopAll`: Quit and Stop All Agents (⌥⌘Q).
 * - `signal`: SIGTERM, caught by the handler registered in `whenReady`.
 * - `install`: `install-app.sh` announced itself with a `run/quit-intent` file.
 * - `external`: anything else (an `osascript` quit, Dock → Quit, logout).
 *
 * Two kinds of session. **Local** ones run in this process and cannot survive
 * a quit, so every quit ends them, gracefully and bounded. **Hosted** ones run
 * in session hosts (Stage 3) and keep running: only ⌥⌘Q ends them. Only a menu
 * quit ever asks first, and only when it would end something: a script, a
 * signal or a logout must never block on a dialog nobody will see.
 */

export type QuitSource = 'menu' | 'menuStopAll' | 'signal' | 'install' | 'external';

export interface QuitDecision {
  /** Ask "Quit and stop N agents?" first. */
  confirm: boolean;
  /** End hosted sessions too, rather than leaving them running. */
  stopHosted: boolean;
  /** How long to wait for the agents being ended to go, before exiting anyway. */
  stopWithinMs: number;
  /** Hosted sessions left running, to say so as the app goes (0: say nothing). */
  announceRunning: number;
}

/** The bound on a graceful stop at quit. Long enough for an interrupt and a flush, short enough for a logout. */
export const QUIT_STOP_BOUND_MS = 10_000;

export function quitPolicy(input: { source: QuitSource; local: number; hosted: number }): QuitDecision {
  const stopHosted = input.source === 'menuStopAll';
  return {
    confirm: input.source === 'menu' && input.local > 0,
    stopHosted,
    stopWithinMs: QUIT_STOP_BOUND_MS,
    // A logout is ending everything anyway; there is nobody to tell.
    announceRunning: stopHosted || input.source === 'signal' ? 0 : input.hosted,
  };
}

/** How fresh a `quit-intent` marker must be to count. An old one is left over, not an announcement. */
export const QUIT_INTENT_MAX_AGE_MS = 60_000;

/**
 * Parse `run/quit-intent`. Its content is the reason (`install`); anything
 * unreadable, unknown or stale is ignored and the quit counts as external.
 */
export function quitIntentSource(content: string | undefined, writtenMsAgo: number | undefined): QuitSource | undefined {
  if (content === undefined || writtenMsAgo === undefined) return undefined;
  if (writtenMsAgo < 0 || writtenMsAgo > QUIT_INTENT_MAX_AGE_MS) return undefined;
  return content.trim() === 'install' ? 'install' : undefined;
}

/** "3 agents" / "1 agent". */
export function agentCount(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`;
}
