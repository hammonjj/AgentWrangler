/**
 * What stopping the core daemon does, by why it was stopped.
 *
 * Pure. The daemon is only ever stopped by a signal (launchd's stop, a
 * bootout on update, `aw daemon stop`), and `aw daemon stop --all` says what
 * it wants beforehand with a `run/quit-intent` file:
 *
 * - `signal`: an ordinary stop. Hosted conversations keep running and the next
 *   daemon reattaches them.
 * - `stopAll`: `aw daemon stop --all`, which ends them too.
 *
 * Two kinds of session. **Hosted** ones run in session hosts and keep running:
 * only `stopAll` ends them. Every Claude conversation is one (#122). **Local**
 * ones are children of the daemon and cannot survive it, so every stop ends
 * them: only Codex threads with the background Codex server off are. Nothing
 * ever asks first: there is no window to ask in.
 */

export type QuitSource = 'signal' | 'stopAll';

export interface QuitDecision {
  /** End hosted sessions too, rather than leaving them running. */
  stopHosted: boolean;
  /** How long to wait for the agents being ended to go, before exiting anyway. */
  stopWithinMs: number;
}

/** The bound on a graceful stop. Long enough for an interrupt and a flush, short enough for a logout. */
export const QUIT_STOP_BOUND_MS = 10_000;

export function quitPolicy(input: { source: QuitSource; local: number; hosted: number }): QuitDecision {
  return { stopHosted: input.source === 'stopAll', stopWithinMs: QUIT_STOP_BOUND_MS };
}

/** How fresh a `quit-intent` marker must be to count. An old one is left over, not an announcement. */
export const QUIT_INTENT_MAX_AGE_MS = 60_000;

/**
 * What a `run/quit-intent` marker may say. `aw daemon stop` (#130) writes it
 * before it signals the core daemon:
 * - `stop`: the same as a bare SIGTERM: hosts keep running;
 * - `stop-all`: `aw daemon stop --all`: hosts end too.
 */
export type QuitIntent = 'stop' | 'stop-all';

const INTENT_SOURCES: Record<QuitIntent, QuitSource> = {
  stop: 'signal',
  'stop-all': 'stopAll',
};

/**
 * Parse `run/quit-intent`. Its content is the reason (a `QuitIntent`);
 * anything unreadable, unknown or stale is ignored and the stop counts as a
 * plain signal.
 */
export function quitIntentSource(content: string | undefined, writtenMsAgo: number | undefined): QuitSource | undefined {
  if (content === undefined || writtenMsAgo === undefined) return undefined;
  if (writtenMsAgo < 0 || writtenMsAgo > QUIT_INTENT_MAX_AGE_MS) return undefined;
  const intent = content.trim();
  return Object.prototype.hasOwnProperty.call(INTENT_SOURCES, intent) ? INTENT_SOURCES[intent as QuitIntent] : undefined;
}

/** "3 agents" / "1 agent". */
export function agentCount(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`;
}
