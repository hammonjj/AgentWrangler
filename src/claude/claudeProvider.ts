import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { ConfigGetter } from '../core/config';
import { Emitter, type Disposable } from '../core/events';
import type { AgentProvider, TranscriptAppendEvent } from '../core/provider';
import type { TurnStats } from '../core/turnStats';
import type { AgentSession, TurnProgress } from '../shared/model';
import { statusFromHookState, turnBlockedMsAt, type HookSessionState } from './hookEvents';
import { HookLog } from './hookLog';
import { isSessionJsonlName, projectsDir, sessionsDir } from './paths';
import { readRegistry, type RegistryEntry } from './registry';
import { deriveStatus } from './status';
import { TranscriptIndex, type IndexedTranscript } from './transcriptIndex';
import type { TranscriptSummary } from './transcriptTail';

const REGISTRY_DEBOUNCE_MS = 250;
const TRANSCRIPT_DEBOUNCE_MS = 300;
const FULL_RESCAN_EVERY_MS = 60_000;

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private registry: RegistryEntry[] = [];
  private index = new TranscriptIndex();
  private hooks: HookLog;
  private changeEmitter = new Emitter<void>();
  private appendEmitter = new Emitter<TranscriptAppendEvent>();

  private sessionsWatcher?: fsSync.FSWatcher;
  private projectsWatcher?: fsSync.FSWatcher;
  private registryTimer?: NodeJS.Timeout;
  private fileTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer?: NodeJS.Timeout;
  private lastFullScanMs = 0;
  private started = false;
  private disposed = false;

  constructor(
    private getConfig: ConfigGetter,
    private log: (msg: string) => void = () => undefined,
    /** Absent in tests; progress then carries elapsed and tool counts but no pace band. */
    private turnStats?: TurnStats,
  ) {
    this.hooks = new HookLog(log);
  }

  onDidChange = (listener: () => void): Disposable => this.changeEmitter.event(listener);
  onTranscriptAppended = (listener: (e: TranscriptAppendEvent) => void): Disposable =>
    this.appendEmitter.event(listener);

  /** True once any hook event has been seen — the dashboard warns when hooks are installed but silent. */
  get hooksReporting(): boolean {
    return this.hooks.hasEverReported;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refreshRegistry();
    await this.fullScan();
    await this.hooks.start();
    this.hooks.onDidChange(() => this.changeEmitter.fire());
    this.hooks.onTurnCompleted((ms) => this.turnStats?.record(ms));
    this.ensureWatchers();
    this.schedulePoll();
    this.log(`claude provider started: ${this.registry.length} live session(s), ${this.index.all().length} transcript(s) indexed`);
  }

  async refresh(): Promise<void> {
    await this.refreshRegistry();
    await this.fullScan();
    await this.hooks.scanAll();
    this.changeEmitter.fire();
  }

  async scan(): Promise<AgentSession[]> {
    const cfg = this.getConfig();
    const now = Date.now();
    const sessions: AgentSession[] = [];
    const liveIds = new Set<string>();

    const stuckThresholdMs = cfg.stuckThresholdSeconds * 1000;

    for (const r of this.registry) {
      const id = r.sessionId.toLowerCase();
      liveIds.add(id);
      const idx = this.index.get(id);
      const s = idx?.summary;

      // Hooks are ground truth when this session reports them. Sessions started
      // before the hooks were installed have none (Claude Code snapshots hook
      // config at startup), so they fall back to transcript inference and are
      // flagged estimated rather than silently presented as fact.
      const hook = this.hooks.get(id);
      const status = hook
        ? statusFromHookState(hook, now, stuckThresholdMs)
        : deriveStatus({
            pidAlive: true,
            lastMeaningful: s?.lastMeaningful,
            transcriptMtimeMs: s?.mtimeMs,
            nowMs: now,
            stuckThresholdMs,
          });
      sessions.push(this.buildSession(r, idx, status, now, hook));
    }

    const endedCutoff = now - cfg.endedWindowHours * 3_600_000;
    const ended = this.index
      .all()
      .filter((t) => !liveIds.has(t.sessionId) && t.summary.mtimeMs >= endedCutoff)
      .sort((a, b) => b.summary.mtimeMs - a.summary.mtimeMs)
      .slice(0, cfg.maxEndedSessions);
    for (const t of ended) sessions.push(this.buildEnded(t));

    return sessions;
  }

  private buildSession(
    r: RegistryEntry,
    idx: IndexedTranscript | undefined,
    status: AgentSession['status'],
    now: number,
    hook?: HookSessionState,
  ): AgentSession {
    const s = idx?.summary;
    const cwd = r.cwd ?? s?.cwd;
    return {
      statusIsEstimated: hook === undefined,
      blockedReason: status === 'blocked' ? hook?.blockedReason : undefined,
      activeTool: status === 'busy' ? hook?.activeTool : undefined,
      progress: status === 'busy' && hook ? this.buildProgress(hook, now) : undefined,
      provider: this.id,
      sessionId: r.sessionId,
      key: `${this.id}:${r.sessionId.toLowerCase()}`,
      name: r.name,
      title: this.title(s, r.name, r.sessionId),
      subtitle: s?.lastPrompt,
      cwd,
      projectName: cwd ? path.basename(cwd) : undefined,
      gitBranch: s?.gitBranch,
      status,
      lastActivityAt: s?.mtimeMs ?? r.startedAt ?? now,
      startedAt: r.startedAt,
      kind: r.kind,
      entrypoint: r.entrypoint,
      transcriptPath: idx?.path,
      pid: r.pid,
      prLink: s?.prLink,
    };
  }

  /**
   * Progress for the turn in flight. Returns undefined unless we watched the
   * turn start — a backlog-replayed start has no knowable age, and inventing
   * one would be worse than the blank the caller renders instead.
   */
  private buildProgress(hook: HookSessionState, now: number): TurnProgress | undefined {
    if (hook.turnStartedAtMs === undefined || hook.turnStartUncertain) return undefined;
    const blockedMs = turnBlockedMsAt(hook, now);
    const elapsedMs = Math.max(0, now - hook.turnStartedAtMs - blockedMs);
    return {
      startedAtMs: hook.turnStartedAtMs,
      blockedMs,
      toolCalls: hook.turnToolCalls,
      todo: hook.todo,
      pace: this.turnStats?.classify(elapsedMs),
    };
  }

  private buildEnded(t: IndexedTranscript): AgentSession {
    const s = t.summary;
    return {
      provider: this.id,
      sessionId: t.sessionId,
      key: `${this.id}:${t.sessionId}`,
      title: this.title(s, undefined, t.sessionId),
      subtitle: s.lastPrompt,
      cwd: s.cwd,
      projectName: s.cwd ? path.basename(s.cwd) : undefined,
      gitBranch: s.gitBranch,
      status: 'ended',
      lastActivityAt: s.mtimeMs,
      transcriptPath: t.path,
      prLink: s.prLink,
    };
  }

  private title(s: TranscriptSummary | undefined, registryName: string | undefined, sessionId: string): string {
    return s?.aiTitle ?? registryName ?? s?.slug ?? s?.firstUserText ?? sessionId.slice(0, 8);
  }

  // ---- data refresh ----

  private async refreshRegistry(): Promise<void> {
    this.registry = await readRegistry(sessionsDir());
  }

  private async fullScan(): Promise<void> {
    const cfg = this.getConfig();
    this.lastFullScanMs = Date.now();
    await this.index.scanAll(projectsDir(), {
      liveIds: new Set(this.registry.map((r) => r.sessionId.toLowerCase())),
      endedWindowMs: cfg.endedWindowHours * 3_600_000,
      nowMs: Date.now(),
    });
  }

  // ---- watchers ----

  private ensureWatchers(): void {
    if (this.disposed) return;
    if (!this.sessionsWatcher) {
      this.sessionsWatcher = this.tryWatch(sessionsDir(), false, () => this.onSessionsDirEvent());
    }
    if (!this.projectsWatcher) {
      this.projectsWatcher = this.tryWatch(projectsDir(), true, (filename) => this.onProjectsEvent(filename));
    }
  }

  private tryWatch(
    dir: string,
    recursive: boolean,
    handler: (filename: string | null) => void,
  ): fsSync.FSWatcher | undefined {
    try {
      const w = fsSync.watch(dir, { recursive, persistent: false }, (_event, filename) =>
        handler(filename === null ? null : filename.toString()),
      );
      w.on('error', (err) => {
        this.log(`watcher error on ${dir}: ${String(err)}`);
        w.close();
        if (w === this.sessionsWatcher) this.sessionsWatcher = undefined;
        if (w === this.projectsWatcher) this.projectsWatcher = undefined;
      });
      return w;
    } catch (err) {
      this.log(`cannot watch ${dir}: ${String(err)}`);
      return undefined;
    }
  }

  private onSessionsDirEvent(): void {
    if (this.registryTimer) clearTimeout(this.registryTimer);
    this.registryTimer = setTimeout(() => {
      this.registryTimer = undefined;
      void this.refreshRegistry().then(() => this.changeEmitter.fire());
    }, REGISTRY_DEBOUNCE_MS);
  }

  private onProjectsEvent(filename: string | null): void {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.length !== 2 || !isSessionJsonlName(parts[1])) return;
    const full = path.join(projectsDir(), filename);

    const existing = this.fileTimers.get(full);
    if (existing) clearTimeout(existing);
    this.fileTimers.set(
      full,
      setTimeout(() => {
        this.fileTimers.delete(full);
        void this.index.updateFile(full).then((res) => {
          if (res === null) return; // unchanged
          if (res) this.appendEmitter.fire({ sessionId: res.sessionId, path: res.path });
          this.changeEmitter.fire();
        });
      }, TRANSCRIPT_DEBOUNCE_MS),
    );
  }

  // ---- reconcile poll ----

  private schedulePoll(): void {
    if (this.disposed) return;
    const interval = Math.max(2, this.getConfig().pollIntervalSeconds) * 1000;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.refreshRegistry(); // catches pid deaths (no fs event fires for those)
        this.ensureWatchers(); // recreate if dirs appeared or a watcher died
        this.hooks.ensureWatcher(); // the log dir appears when hooks are installed
        if (Date.now() - this.lastFullScanMs > FULL_RESCAN_EVERY_MS) {
          await this.fullScan(); // safety net for missed watcher events
          await this.hooks.scanAll(); // safety net for missed hook-log events
          await this.hooks.prune(this.getConfig().endedWindowHours * 3_600_000);
        }
        // Fire every tick: staleness (busy→stuck) is clock-driven; the store
        // diffs and only forwards material changes.
        this.changeEmitter.fire();
      } catch (err) {
        this.log(`poll error: ${String(err)}`);
      } finally {
        this.schedulePoll();
      }
    }, interval);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.registryTimer) clearTimeout(this.registryTimer);
    for (const t of this.fileTimers.values()) clearTimeout(t);
    this.fileTimers.clear();
    this.sessionsWatcher?.close();
    this.projectsWatcher?.close();
    this.hooks.dispose();
    this.changeEmitter.dispose();
    this.appendEmitter.dispose();
  }
}
