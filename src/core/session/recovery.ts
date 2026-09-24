/**
 * What a restart means for each session Agent Wrangler was running.
 *
 * Pure. The registry applies it once at startup, before anything else reads
 * it (`docs/plans/session-lifecycle-architecture.md` §7.3). Until session hosts
 * exist (Stage 3), every AW-run session is a child of the app, so nothing
 * survives a restart: a session that was `live` when the app last ran was cut
 * off, and becomes `interrupted`. Its conversation is intact (it is the
 * transcript), which is why every interrupted session is offered for Resume,
 * not just the newest.
 */
import type { SessionRecord } from './sessionRegistry';

/** Records not touched for this long are dropped: old history, not a session to come back to. */
export const RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** An interrupted session is shown as such for this long, then it is just an ended one. */
export const INTERRUPTED_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Only this recent an interruption is brought back automatically (the setting). */
export const AUTO_RESUME_WINDOW_MS = 8 * 60 * 60 * 1000;
/** Keep the file small: the newest this many. */
export const MAX_RECORDS = 100;

export interface StartupResult {
  records: SessionRecord[];
  /** The sessions this restart interrupted, newest first. */
  interrupted: SessionRecord[];
}

/**
 * Classify every record for a fresh start: `live` becomes `interrupted` (the
 * process died with the app), unless its session is still running in a host
 * that outlived the app (`stillRunning`, from the manifests); everything else
 * keeps its state; stale records are dropped and the list is capped.
 */
export function classifyOnStartup(
  records: SessionRecord[],
  now: number,
  stillRunning: ReadonlySet<string> = new Set(),
): StartupResult {
  const running = new Set([...stillRunning].map((id) => id.toLowerCase()));
  const interrupted: SessionRecord[] = [];
  const kept: SessionRecord[] = [];
  for (const r of records) {
    if (running.has(r.sessionId.toLowerCase())) {
      kept.push(r.state === 'live' ? r : { ...r, state: 'live', endedReason: undefined, updatedAt: now });
      continue;
    }
    if (now - r.lastShownAt > RECORD_MAX_AGE_MS) continue;
    if (r.state === 'live') {
      const next: SessionRecord = { ...r, state: 'interrupted', endedReason: 'app-restart', updatedAt: now };
      interrupted.push(next);
      kept.push(next);
    } else {
      kept.push(r);
    }
  }
  const byNewest = (a: SessionRecord, b: SessionRecord) => b.lastShownAt - a.lastShownAt;
  kept.sort(byNewest);
  interrupted.sort(byNewest);
  return { records: kept.slice(0, MAX_RECORDS), interrupted };
}

/** Whether a record should show as interrupted on its row right now. */
export function showsInterrupted(r: SessionRecord | undefined, now: number): boolean {
  return r?.state === 'interrupted' && now - r.lastShownAt <= INTERRUPTED_SHOWN_MS;
}

/**
 * The one session to resume automatically at startup, if any: the newest
 * Claude session this restart interrupted, recent enough, and not one the
 * orchestrator owns (it offers Resume/Retry for those itself; orchestration
 * plan §1.3, A6).
 */
export function autoResumeCandidate(interrupted: SessionRecord[], now: number): SessionRecord | undefined {
  const newest = interrupted.find((r) => r.provider === 'claude' && originKind(r.origin) !== 'orchestration');
  if (!newest) return undefined;
  return now - newest.lastShownAt <= AUTO_RESUME_WINDOW_MS ? newest : undefined;
}

function originKind(origin: unknown): string | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const kind = (origin as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}
