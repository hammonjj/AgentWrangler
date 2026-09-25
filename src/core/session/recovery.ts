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
import type { HostManifest } from '../../shared/sessionProtocol';
import type { LiveRecordInput, SessionRecord, SessionRecordState } from './sessionRegistry';

/**
 * `endedReason` of a session whose host died without an exit record. Its
 * agent may have been orphaned (and swept); the session is resumable, but
 * never automatically: a host that crashed once can crash again, and an
 * automatic resume would make that a loop (§8 "Host crashes").
 */
export const HOST_LOST = 'host lost';
/** `endedReason` of a session the idle-orphan rule parked (§7.5). */
export const IDLE_PARKED = 'idle';

/** What became of a session, from the manifest of its host once that host is gone. */
export interface HostOutcome {
  state: SessionRecordState;
  reason: string;
  /** When that host started: its record says nothing about a run begun after it. */
  hostStartedAt?: number;
}

/**
 * Slack for comparing the host's start with the record's `liveSince`: the
 * record is written just after the spawn call, the host stamps its own start
 * once it is running, and either can land first.
 */
const LIVE_SINCE_SLACK_MS = 60_000;

/**
 * Read a dead host's exit record (§7.3 step 2):
 * - none: the host was lost → `interrupted`, never resumed automatically;
 * - `ended`: the agent finished on its own → `ended`;
 * - `stopped` by the idle-orphan rule → `stopped` (parked; Resume brings it back);
 * - `stopped` by a client, or `signal` (logout, `kill`) → `interrupted`;
 * - `error`, `crashed`, and any reason this build does not know → `failed`.
 */
export function deadHostOutcome(m: Pick<HostManifest, 'exit'>): HostOutcome {
  const exit = m.exit;
  if (!exit) return { state: 'interrupted', reason: HOST_LOST };
  const reason = exit.reason ?? 'ended';
  if (reason === 'ended') return { state: 'ended', reason: 'ended' };
  if (reason === 'stopped') {
    return exit.trigger === 'idleTimeout' ? { state: 'stopped', reason: IDLE_PARKED } : { state: 'interrupted', reason: 'host stopped' };
  }
  if (reason === 'signal') return { state: 'interrupted', reason: `host signalled${exit.hostSignal ? ` (${exit.hostSignal})` : ''}` };
  return { state: 'failed', reason: exit.error ?? `host exit: ${reason}` };
}

/**
 * One outcome per session from the dead hosts' manifests. A session can have
 * several (a version migration leaves the old host's record behind): the
 * newest host decides.
 */
export function outcomesFromDeadHosts(dead: HostManifest[], bootTimeMs?: number): Map<string, HostOutcome> {
  const newest = new Map<string, HostManifest>();
  for (const m of dead) {
    if (!m.sessionId) continue;
    const id = m.sessionId.toLowerCase();
    const prev = newest.get(id);
    if (!prev || m.startedAt >= prev.startedAt) newest.set(id, m);
  }
  return new Map(
    [...newest].map(([id, m]) => {
      // No record, and the machine has booted since the host started: it was
      // a reboot or a power-off, not a host crash. That comes back like a
      // logout (§8 "Reboot"), auto-resume included.
      const rebooted = !m.exit && bootTimeMs !== undefined && bootTimeMs > m.startedAt;
      const outcome: HostOutcome = rebooted ? { state: 'interrupted', reason: 'machine restarted' } : deadHostOutcome(m);
      return [id, { ...outcome, hostStartedAt: m.startedAt }];
    }),
  );
}

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
 * that outlived the app (`stillRunning`, from the manifests), or a host that
 * has since died says what became of it (`deadHosts`, from
 * `outcomesFromDeadHosts`); everything else keeps its state; stale records are
 * dropped and the list is capped. Neither the age rule nor the cap drops a
 * record that was `live` coming in, or one still running in a host.
 *
 * `interrupted` holds only sessions left interrupted, so a session whose host
 * finished, failed or was parked while the app was away is never resumed
 * automatically.
 */
export function classifyOnStartup(
  records: SessionRecord[],
  now: number,
  stillRunning: ReadonlySet<string> = new Set(),
  deadHosts: ReadonlyMap<string, HostOutcome> = new Map(),
): StartupResult {
  const running = new Set([...stillRunning].map((id) => id.toLowerCase()));
  const interrupted: SessionRecord[] = [];
  // Never dropped by the age rule or the cap: sessions still running in a
  // host, and every record the app still thought live. `lastShownAt` says
  // when the pane last showed a session, not whether it runs, so a hosted
  // session nobody looked at for a while sorts last; and a Codex thread
  // recorded live is most likely still running in the background server,
  // which only a record lets this start rejoin (#72).
  const pinned: SessionRecord[] = [];
  const rest: SessionRecord[] = [];
  for (const r of records) {
    const id = r.sessionId.toLowerCase();
    if (running.has(id)) {
      pinned.push(r.state === 'live' ? r : { ...r, state: 'live', endedReason: undefined, updatedAt: now });
      continue;
    }
    if (r.state !== 'live' && now - r.lastShownAt > RECORD_MAX_AGE_MS) continue;
    if (r.state === 'live') {
      // Only a record the app still thought live takes the host's word: one
      // already stopped (Close) or ended here stays what this app recorded.
      // And only a host of this run: one that died before the session was
      // last brought back (say, resumed in-process since) is old news.
      const dead = deadHosts.get(id);
      const current =
        dead && (r.liveSince === undefined || dead.hostStartedAt === undefined || dead.hostStartedAt >= r.liveSince - LIVE_SINCE_SLACK_MS);
      const outcome = current && dead ? dead : { state: 'interrupted' as const, reason: 'app-restart' };
      const next: SessionRecord = { ...r, state: outcome.state, endedReason: outcome.reason, updatedAt: now };
      if (next.state === 'interrupted') interrupted.push(next);
      pinned.push(next);
    } else {
      rest.push(r);
    }
  }
  const byNewest = (a: SessionRecord, b: SessionRecord) => b.lastShownAt - a.lastShownAt;
  rest.sort(byNewest);
  interrupted.sort(byNewest);
  // The cap trims history only: pinned records all stay, even past it.
  const out = [...pinned, ...rest.slice(0, Math.max(0, MAX_RECORDS - pinned.length))].sort(byNewest);
  return { records: out, interrupted };
}

/**
 * The registry record for a host adopted with none (it was lost, or dropped
 * before #72): rebuilt from what the host wrote down about its launch, so the
 * session comes back on its model, mode and effort, and a §7.4 migration
 * does not restart it on the defaults.
 */
export function recordFromManifest(
  manifest: Pick<HostManifest, 'sessionId' | 'cwd' | 'launch' | 'origin'> & { startedAt?: number },
): LiveRecordInput | undefined {
  if (!manifest.sessionId) return undefined;
  const l = manifest.launch ?? {};
  return {
    sessionId: manifest.sessionId,
    provider: 'claude',
    cwd: manifest.cwd,
    launch: prune({ model: l.model, permissionMode: l.permissionMode, effort: l.effort, binary: l.binary }),
    origin: manifest.origin,
    // The run began when the host did, not now: otherwise that host's exit
    // record would read as old news at the next start, and a crash or a
    // finish would come back as a plain interruption (auto-resume included).
    liveSince: manifest.startedAt,
  };
}

function prune<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
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
  // Its host crashed: offered on its row, never brought back by itself (§8).
  if (newest.endedReason === HOST_LOST) return undefined;
  return now - newest.lastShownAt <= AUTO_RESUME_WINDOW_MS ? newest : undefined;
}

function originKind(origin: unknown): string | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const kind = (origin as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}
