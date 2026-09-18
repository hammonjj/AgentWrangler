/**
 * What a click on a session row should do, and what the conversation pane
 * should offer. Pure, so the rules are testable.
 */
import type { AgentSession, OpenTarget } from '../shared/model';

/** Every session opens in the local conversation pane. */
export function openTargetFor(): OpenTarget { return 'conversation'; }

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
  return s.status === 'waiting' || s.status === 'done' || s.statusIsEstimated === true ? 'adopt' : undefined;
}
