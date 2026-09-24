/**
 * Every session Agent Wrangler runs, and what happened to each.
 *
 * Replaces the old runner registry, which remembered only Claude sessions, only
 * their id and folder, and offered back only the newest. This one records both
 * providers, how each was launched, where (repo, worktree, branch), and its
 * state, so after any restart AW can say what became of every session it was
 * running and resume it the way it was started
 * (`docs/plans/session-lifecycle-architecture.md` §10, Stage 2).
 *
 * The core is the only writer. Stored as one JSON document (`sessions.json`):
 * fewer than a hundred records, one writer, "load all, replace one".
 */
import { classifyOnStartup, showsInterrupted, type HostOutcome, type StartupResult } from './recovery';
import type { SessionProvider } from './sessionHandle';

/** The slice of a key-value store this needs. `JsonStore` and a test double both fit. */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): unknown;
}

/**
 * - `live`: running in this app now.
 * - `stopped`: ended on purpose here (Close, Release, a deliberate stop).
 * - `ended`: the agent finished on its own.
 * - `failed`: the agent exited with an error.
 * - `interrupted`: it was live when the app last stopped, so its process was cut off.
 */
export type SessionRecordState = 'live' | 'stopped' | 'ended' | 'failed' | 'interrupted';

export interface LaunchOptionsRecord {
  /** What AW asked for. */
  model?: string;
  permissionMode?: string;
  effort?: string;
  /**
   * What the agent says it applied, when it says. The CLI can silently
   * downgrade effort, and reports the applied level in hook payloads
   * (orchestration plan §1.3, A4). Absent means not reported, not "the same".
   */
  applied?: { model?: string; effort?: string };
  binary?: string;
  cliVersion?: string;
}

export interface SessionRecord {
  v: 1;
  sessionId: string;
  provider: SessionProvider;
  cwd: string;
  /** Captured at launch; the checkout the session worked in. */
  repoRoot?: string;
  worktree?: string;
  branchAtStart?: string;
  launch: LaunchOptionsRecord;
  /**
   * Who started it, opaque here: e.g. `{kind: 'orchestration', missionId, …}`.
   * The registry never interprets it (orchestration plan §1.3, A3).
   */
  origin?: unknown;
  state: SessionRecordState;
  endedReason?: string;
  createdAt: number;
  /** Last time the pane showed it. Decides which interrupted session comes back automatically. */
  lastShownAt: number;
  /**
   * When it last became `live`. A dead host's exit record only speaks for the
   * run that started at or after this; an older host's record is history.
   */
  liveSince?: number;
  updatedAt: number;
}

export interface LiveRecordInput {
  sessionId: string;
  provider: SessionProvider;
  cwd: string;
  repoRoot?: string;
  worktree?: string;
  branchAtStart?: string;
  launch?: LaunchOptionsRecord;
  origin?: unknown;
}

const KEY = 'agentWrangler.sessions';
/** The old runner registry's key, in the surface store. Read once, never deleted (for one release). */
export const LEGACY_KEY = 'agentWrangler.runnerSessions';
/** Legacy records older than this were history even to the old code. */
const LEGACY_WINDOW_MS = 8 * 60 * 60 * 1000;

export class SessionRegistry {
  private readonly now: () => number;

  constructor(
    private store: MementoLike,
    opts: { legacy?: MementoLike; now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    if (opts.legacy) this.migrate(opts.legacy);
  }

  all(): SessionRecord[] {
    const raw = this.store.get<unknown>(KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).sort((a, b) => b.lastShownAt - a.lastShownAt);
  }

  get(sessionId: string | undefined): SessionRecord | undefined {
    if (!sessionId) return undefined;
    const id = sessionId.toLowerCase();
    return this.all().find((r) => r.sessionId.toLowerCase() === id);
  }

  /**
   * Classify every record for this start (`live` → `interrupted`, except the
   * sessions still running in a surviving host) and save the result. Call
   * once, before anything reads the registry or resumes anything.
   */
  startup(stillRunning: ReadonlySet<string> = new Set(), deadHosts: ReadonlyMap<string, HostOutcome> = new Map()): StartupResult {
    const result = classifyOnStartup(this.all(), this.now(), stillRunning, deadHosts);
    this.write(result.records);
    return result;
  }

  /** A session is running here now: record it, or bring its record back to `live`. */
  live(input: LiveRecordInput): SessionRecord {
    const now = this.now();
    const existing = this.get(input.sessionId);
    const record: SessionRecord = {
      v: 1,
      sessionId: input.sessionId,
      provider: input.provider,
      cwd: input.cwd,
      repoRoot: input.repoRoot ?? existing?.repoRoot,
      worktree: input.worktree ?? existing?.worktree,
      branchAtStart: input.branchAtStart ?? existing?.branchAtStart,
      launch: { ...existing?.launch, ...input.launch },
      origin: input.origin ?? existing?.origin,
      state: 'live',
      // Kept while it stays live (an id re-announced mid-run is the same run).
      liveSince: existing?.state === 'live' && existing.liveSince !== undefined ? existing.liveSince : now,
      createdAt: existing?.createdAt ?? now,
      lastShownAt: now,
      updatedAt: now,
    };
    this.write([record, ...this.all().filter((r) => r !== existing && r.sessionId !== existing?.sessionId)]);
    return record;
  }

  /** The pane is showing it now. */
  touch(sessionId: string): void {
    this.patch(sessionId, { lastShownAt: this.now() });
  }

  setState(sessionId: string, state: SessionRecordState, endedReason?: string): void {
    this.patch(sessionId, { state, endedReason });
  }

  /** Record what the agent says it applied, as distinct from what was asked for. */
  noteApplied(sessionId: string, applied: { model?: string; effort?: string }): void {
    const r = this.get(sessionId);
    if (!r) return;
    this.patch(sessionId, { launch: { ...r.launch, applied: { ...r.launch.applied, ...applied } } });
  }

  forget(sessionId: string): void {
    const id = sessionId.toLowerCase();
    this.write(this.all().filter((r) => r.sessionId.toLowerCase() !== id));
  }

  /** Whether its row should say "Interrupted" and offer Resume. */
  isInterrupted(sessionId: string | undefined): boolean {
    return showsInterrupted(this.get(sessionId), this.now());
  }

  private patch(sessionId: string, fields: Partial<SessionRecord>): void {
    const id = sessionId.toLowerCase();
    let changed = false;
    const next = this.all().map((r) => {
      if (r.sessionId.toLowerCase() !== id) return r;
      changed = true;
      return { ...r, ...fields, updatedAt: this.now() };
    });
    if (changed) this.write(next);
  }

  private write(records: SessionRecord[]): void {
    void this.store.update(KEY, records);
  }

  /**
   * One-time import of the old runner registry: Claude sessions only, id,
   * folder and when last shown. The old app never cleared them on quit, so a
   * recent one was running when it stopped; they come in `live` and the
   * startup classification turns them `interrupted`, like any other. The old
   * key is left in place so a rollback still reads it.
   */
  private migrate(legacy: MementoLike): void {
    if (this.store.get<unknown>(KEY, undefined) !== undefined) return;
    const raw = legacy.get<unknown>(LEGACY_KEY, []);
    const now = this.now();
    const imported: SessionRecord[] = [];
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const o = r as { sessionId?: unknown; cwd?: unknown; lastShownAt?: unknown };
        if (typeof o.sessionId !== 'string' || typeof o.cwd !== 'string' || typeof o.lastShownAt !== 'number') continue;
        if (now - o.lastShownAt > LEGACY_WINDOW_MS) continue;
        imported.push({
          v: 1,
          sessionId: o.sessionId,
          provider: 'claude',
          cwd: o.cwd,
          launch: {},
          state: 'live',
          endedReason: 'migrated',
          createdAt: o.lastShownAt,
          lastShownAt: o.lastShownAt,
          updatedAt: now,
        });
      }
    }
    this.write(imported);
  }
}

/** The part of the registry an executor writes to. */
export type ExecutorRegistry = Pick<SessionRegistry, 'live' | 'touch' | 'setState' | 'isInterrupted'> &
  Partial<Pick<SessionRegistry, 'forget'>>;

function isRecord(r: unknown): r is SessionRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<SessionRecord>;
  return (
    typeof o.sessionId === 'string' &&
    (o.provider === 'claude' || o.provider === 'codex') &&
    typeof o.cwd === 'string' &&
    typeof o.state === 'string' &&
    typeof o.lastShownAt === 'number' &&
    typeof o.launch === 'object' &&
    o.launch !== null
  );
}
