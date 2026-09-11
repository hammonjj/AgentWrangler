/**
 * What a click on a session row should do. Pure, so the rules are testable:
 * the locator says where the process lives, this says what that means.
 */
import type { AgentSession, OpenTarget } from '../shared/model';

/**
 * Where a live session's process was found relative to this window.
 *
 * - `panel`: a descendant of this extension host, i.e. a Claude Code panel in
 *   this window.
 * - `terminal`: a descendant of one of this window's integrated terminals.
 * - `other-window`: inside this VSCode app, but not this window.
 * - `external`: alive, but not under this VSCode app at all (an iTerm session,
 *   a different VSCode build). Nothing here can reveal it.
 * - `dead`: the pid is gone; the registry has not caught up yet.
 * - `unavailable`: no process table on this platform, or the session has no pid.
 */
export type LocationKind = 'panel' | 'terminal' | 'other-window' | 'external' | 'dead' | 'unavailable';

/**
 * Decide the click target. `inWorkspace` is the old cwd-based ownership guess;
 * it survives only as the fallback when the process tree cannot be read, and
 * for ended sessions, which have no process to locate and are resumed into the
 * panel of the window whose project they belong to.
 */
export function openTargetFor(s: AgentSession, location: LocationKind, inWorkspace: boolean): OpenTarget {
  if (s.provider !== 'claude') return s.status === 'ended' ? 'resume' : 'viewer';
  if (s.status === 'ended') return inWorkspace ? 'panel' : 'resume';

  switch (location) {
    case 'panel':
      return 'panel';
    case 'terminal':
      return 'terminal';
    case 'other-window':
      return s.cwd ? 'window' : 'viewer';
    case 'external':
    case 'dead':
      // Opening the panel would resume a session that is still running
      // somewhere else, forking the conversation. Read-only is the honest option.
      return 'viewer';
    case 'unavailable':
      // No process tree: the pre-pid heuristics.
      if (inWorkspace) return 'panel';
      if (s.entrypoint === 'claude-vscode' && s.cwd) return 'window';
      return 'viewer';
  }
}
