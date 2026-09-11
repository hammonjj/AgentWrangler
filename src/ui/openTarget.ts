/**
 * What a click on a session row should do, and what the conversation pane
 * should offer as its way out to the real thing. Pure, so the rules are
 * testable: the locator says where the process lives, this says what that means.
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
 * - `runner`: this extension is running it. Checked before the process table,
 *   which would otherwise say `panel` — the process really is a child of this
 *   extension host, but there is no Claude Code panel behind it.
 */
export type LocationKind =
  | 'runner'
  | 'panel'
  | 'terminal'
  | 'other-window'
  | 'external'
  | 'dead'
  | 'unavailable';

/** `agentWrangler.rowClickOpens`. */
export type RowClickBehavior = 'conversation' | 'wherever-it-runs';

/**
 * Decide the click target.
 *
 * The default is unconditional: every row opens the conversation pane, in this
 * window, without stealing focus from anything. That is the whole point of the
 * pane — a click used to fling the user into another VSCode window, and the
 * attention cost of that outweighed the fidelity it bought.
 *
 * `wherever-it-runs` keeps the old routing for one release, as a way back if
 * the pane turns out to be worse for some session type. `inWorkspace` is the
 * old cwd-based ownership guess, used there only when the process tree cannot
 * be read.
 */
export function openTargetFor(
  s: AgentSession,
  location: LocationKind,
  inWorkspace: boolean,
  behavior: RowClickBehavior = 'conversation',
): OpenTarget {
  if (behavior === 'conversation') return 'conversation';

  if (s.provider !== 'claude') return s.status === 'ended' ? 'resume' : 'conversation';
  // A session we run ourselves has nowhere else to be.
  if (location === 'runner') return 'conversation';
  if (s.status === 'ended') return inWorkspace ? 'panel' : 'resume';

  switch (location) {
    case 'panel':
      return 'panel';
    case 'terminal':
      return 'terminal';
    case 'other-window':
      return s.cwd ? 'window' : 'conversation';
    case 'external':
    case 'dead':
      // Opening the panel would resume a session that is still running
      // somewhere else, forking the conversation. The pane is the honest option.
      return 'conversation';
    case 'unavailable':
      // No process tree: the pre-pid heuristics.
      if (inWorkspace) return 'panel';
      if (s.entrypoint === 'claude-vscode' && s.cwd) return 'window';
      return 'conversation';
  }
}

/**
 * The pane's secondary action: how to reach the session where it actually
 * lives, for the times when the pane is not enough — typing into it, today.
 *
 * `undefined` means there is nowhere to go: the session runs outside this
 * VSCode, or its process is already gone.
 *
 * Phase 3 adds `adopt` and `release` here, once there is a runner to adopt
 * into; they are deliberately absent while the pane cannot type.
 */
export type SecondaryAction = 'reveal-panel' | 'show-terminal' | 'focus-window' | 'resume-terminal';

export function secondaryActionFor(
  s: AgentSession,
  location: LocationKind,
  inWorkspace: boolean,
): SecondaryAction | undefined {
  // We are where it runs; there is nowhere to go.
  if (location === 'runner') return undefined;
  if (s.status === 'ended') {
    // Resuming into this window's Claude Code panel only works for a session
    // whose project this window actually has open.
    return inWorkspace && s.provider === 'claude' ? 'reveal-panel' : 'resume-terminal';
  }
  if (s.provider !== 'claude') return undefined;

  switch (location) {
    case 'panel':
      return 'reveal-panel';
    case 'terminal':
      return 'show-terminal';
    case 'other-window':
      return s.cwd ? 'focus-window' : undefined;
    case 'unavailable':
      // No process tree to consult; fall back to the folder guess, which is
      // right often enough to be worth offering.
      if (inWorkspace) return 'reveal-panel';
      return s.entrypoint === 'claude-vscode' && s.cwd ? 'focus-window' : undefined;
    case 'external':
    case 'dead':
      return undefined;
  }
}

/** Button text for the pane's secondary action. */
export const SECONDARY_LABEL: Record<SecondaryAction, string> = {
  'reveal-panel': 'Open in Claude Code',
  'show-terminal': 'Show terminal',
  'focus-window': 'Go to its window',
  'resume-terminal': 'Resume in terminal',
};

/**
 * Whether this session can be pulled into this window, and how.
 *
 * Adopting means ending the process that currently runs the session and
 * resuming the same id here. That is safe precisely because a Claude Code
 * conversation *is* its transcript: resume reads the same file and keeps the
 * same id, so an idle session loses nothing in the handover.
 *
 * The status is the whole guard. A `busy`, `stuck` or `blocked` session has a
 * turn in flight, and ending its process would throw that turn away — so the
 * offer simply is not made until it finishes. `ended` needs no kill at all,
 * which is a different enough act to have its own name.
 */
export function adoptActionFor(s: AgentSession, ownedByRunner: boolean): 'adopt' | 'resume-here' | undefined {
  if (ownedByRunner) return undefined; // already here — release is the opposite move
  if (s.provider !== 'claude') return undefined;
  if (!s.cwd) return undefined; // nothing to set as the working directory
  if (s.status === 'ended') return 'resume-here';
  return s.status === 'waiting' || s.status === 'done' ? 'adopt' : undefined;
}
