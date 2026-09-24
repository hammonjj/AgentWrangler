/**
 * Whether to reload the workbench after its renderer process died.
 *
 * A crashed renderer used to leave a blank window. The state it showed lives
 * in the main process (the store, the sessions), and both panes re-initialise
 * from it when they say `ready`, so a reload brings the same view back. What a
 * reload must not do is loop: a renderer that crashes on load would reload
 * forever, so after a few crashes in a short window it stops and says so.
 *
 * Pure (no Electron import), so the rule is testable.
 */

/** At most this many automatic reloads … */
export const MAX_RELOADS = 3;
/** … within this window. */
export const RELOAD_WINDOW_MS = 60_000;

export interface ReloadDecision {
  reload: boolean;
  /** The reload history to keep for next time. */
  history: number[];
}

/**
 * `reason` is Electron's `RenderProcessGoneDetails.reason`. A clean exit is
 * the window closing, not a crash, and is left alone.
 */
export function shouldReloadRenderer(reason: string, history: number[], now: number): ReloadDecision {
  if (reason === 'clean-exit') return { reload: false, history };
  const recent = history.filter((t) => now - t <= RELOAD_WINDOW_MS);
  if (recent.length >= MAX_RELOADS) return { reload: false, history: recent };
  return { reload: true, history: [...recent, now] };
}
