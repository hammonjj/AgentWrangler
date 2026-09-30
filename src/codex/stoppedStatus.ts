import type { SessionRecord } from '../core/session/sessionRegistry';
import type { AgentSession } from '../shared/model';

/** A stopped AW run is stronger evidence than an older, estimated rollout status. */
export function stoppedCodexSession(
  session: AgentSession,
  record: SessionRecord | undefined,
): AgentSession | undefined {
  if (session.provider !== 'codex' || record?.provider !== 'codex' || record.state !== 'stopped') return undefined;
  // Releasing a thread to another client does not end that client's run.
  if (record.endedReason === 'open-elsewhere') return undefined;
  // A later transcript write may be a new turn started outside Agent Wrangler.
  if (session.lastActivityAt > (record.stateChangedAt ?? record.updatedAt)) return undefined;
  return { ...session, status: 'ended', statusIsEstimated: false, progress: undefined };
}
