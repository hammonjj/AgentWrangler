import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { ConfigGetter } from '../core/config';
import { Emitter, type Disposable } from '../core/events';
import type { AgentProvider, TranscriptAppendEvent } from '../core/provider';
import type { TurnStats } from '../core/turnStats';
import { clearWorktreeCache, worktreeFor } from '../core/worktree';
import type { AgentSession, HookHealth, TurnProgress } from '../shared/model';
import { settleBlockAt, statusFromHookState, turnBlockedMsAt, type HookSessionState } from './hookEvents';
import { currentState, type InstallState } from './hookInstall';
import { HookLog, hookLogDir, type PermissionBehavior } from './hookLog';
import { suggestionDestination, suggestionLabels } from './permissionDetail';
import { isSessionJsonlName, projectsDir, sessionsDir } from './paths';
import { readRegistry, type RegistryEntry } from './registry';
import { blockClearedByClaude, deriveStatus, turnOver } from './status';
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
  /** Last read of the hook block in settings.json; undefined until the first check. */
  private installState?: InstallState;
  private changeEmitter = new Emitter<void>();
  private appendEmitter = new Emitter<TranscriptAppendEvent>();
  private hookHealthEmitter = new Emitter<void>();

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

  /** Hook install state for the dashboard banner; undefined until settings.json has been read once. */
  get hookHealth(): HookHealth | undefined {
    const st = this.installState;
    if (!st) return undefined;
    return { kind: st.kind, reporting: this.hooks.hasEverReported, why: 'why' in st ? st.why : undefined };
  }

  onDidChangeHookHealth = (listener: () => void): Disposable => this.hookHealthEmitter.event(listener);

  /**
   * Re-read the hook block in settings.json. Fires only on a real change, so it
   * is safe to call from every refresh and poll — the file is small and the
   * user may edit it by hand, or another window may run the installer.
   */
  async refreshHookHealth(): Promise<void> {
    const next = await currentState(hookLogDir());
    const changed = JSON.stringify(next) !== JSON.stringify(this.installState);
    this.installState = next;
    if (changed) this.hookHealthEmitter.fire();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refreshRegistry();
    await this.fullScan();
    await this.refreshHookHealth();
    await this.hooks.start();
    this.hooks.onDidChange(() => this.changeEmitter.fire());
    this.hooks.onTurnCompleted((ms) => this.turnStats?.record(ms));
    this.ensureWatchers();
    this.schedulePoll();
    this.log(`claude provider started: ${this.registry.length} live session(s), ${this.index.all().length} transcript(s) indexed`);
  }

  async refresh(): Promise<void> {
    // The one place worktrees are re-checked: a `git worktree add` between polls
    // would otherwise keep reporting the answer from before it existed.
    clearWorktreeCache();
    await this.refreshRegistry();
    await this.fullScan();
    await this.refreshHookHealth();
    this.hooks.ensureWatcher(); // an install that just ran created the log dir
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
      let hook = this.hooks.get(id);
      let status = hook
        ? statusFromHookState(hook, now, stuckThresholdMs)
        : deriveStatus({
            pidAlive: true,
            lastMeaningful: s?.lastMeaningful,
            transcriptMtimeMs: s?.mtimeMs,
            lastAssistantText: s?.lastAssistantText,
            nowMs: now,
            stuckThresholdMs,
          });

      // The one thing hooks cannot report: a permission prompt answered in the
      // Claude Code window. Nothing fires until the allowed tool *finishes*, so
      // without this the row sits in Blocked on you for as long as the command
      // runs. Claude Code's own status in the pid file says otherwise, and says
      // it at once.
      if (hook && status === 'blocked' && blockClearedByClaude(hook.blockedSinceMs, r)) {
        // `idle` means the turn ended outright (a denial that stopped it); the
        // waiting/done split below then applies as usual.
        status = r.liveStatus === 'busy' ? 'busy' : 'waiting';
        // Bank the wait at the moment Claude Code recorded the answer, so the
        // turn starts counting work again instead of more blocked time.
        hook = settleBlockAt(hook, r.statusUpdatedAtMs ?? now);
      }

      // A conversation nobody has typed into yet: the process exists (a new
      // panel, a /clear) but there is no transcript and nothing to wait for.
      // It appears the moment the first prompt lands.
      if (idx === undefined && status === 'waiting') continue;

      // Hooks say "turn over, idle"; whether that is Waiting-on-you or Done
      // depends on what the reply said, which the hook carries on Stop. A
      // resumed session has no Stop of ours yet, so the transcript's last
      // reply stands in.
      if (hook && status === 'waiting') status = this.idleStatus(hook, s);

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
    const blocked = status === 'blocked';
    // Buttons only while the hook script is provably still waiting.
    const pending = blocked && this.hooks.pendingRequestExists(hook?.permissionRequestId);
    const suggestions = pending ? (hook?.permissionSuggestions ?? []) : [];
    const wt = worktreeFor(cwd);
    return {
      statusIsEstimated: hook === undefined,
      blockedReason: blocked ? hook?.blockedReason : undefined,
      blockedAsk: blocked ? hook?.blockedDetail : undefined,
      permissionRequestId: pending ? hook?.permissionRequestId : undefined,
      alwaysAllow:
        suggestions.length > 0
          ? { rules: suggestionLabels(suggestions), destination: suggestionDestination(suggestions) }
          : undefined,
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
      worktree: wt?.name,
      worktreePath: wt?.root,
      gitBranch: s?.gitBranch,
      model: s?.model,
      status,
      lastActivityAt: s?.mtimeMs ?? r.startedAt ?? now,
      startedAt: r.startedAt,
      kind: r.kind,
      entrypoint: r.entrypoint,
      transcriptPath: idx?.path,
      pid: r.pid,
      prLink: s?.prLink,
      // The transcript's birth time, not the registry's `startedAt`: this
      // process may be the third one to pick up a conversation that began
      // yesterday, and the age of the conversation is what the column is for.
      conversationStartedAt: s?.startedAtMs,
    };
  }

  /**
   * Waiting-on-you or Done for a hook-reporting session idle at its prompt.
   * A failed turn is always waiting: an error is for the human to read. The
   * reply text comes from the Stop event when we saw one, else from the
   * transcript — but only a transcript whose last line is a finished reply,
   * since a resumed mid-turn session has no reply to judge.
   */
  private idleStatus(hook: HookSessionState, s: TranscriptSummary | undefined): AgentSession['status'] {
    if (hook.turnFailed) return 'waiting';
    if (hook.lastReply !== undefined) return turnOver(hook.lastReply);
    const lm = s?.lastMeaningful;
    const finished = lm?.kind === 'assistant' && lm.stopReason != null && lm.stopReason !== 'tool_use';
    return turnOver(finished ? s?.lastAssistantText : undefined);
  }

  /**
   * Answer the permission prompt a session is blocked on. Resolves false when
   * there is no prompt left to answer (see `HookLog.decide`).
   */
  async decidePermission(sessionId: string, behavior: PermissionBehavior): Promise<boolean> {
    const sent = await this.hooks.decide(sessionId, behavior);
    if (sent) this.changeEmitter.fire();
    return sent;
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
    const wt = worktreeFor(s.cwd);
    return {
      provider: this.id,
      sessionId: t.sessionId,
      key: `${this.id}:${t.sessionId}`,
      title: this.title(s, undefined, t.sessionId),
      subtitle: s.lastPrompt,
      cwd: s.cwd,
      projectName: s.cwd ? path.basename(s.cwd) : undefined,
      worktree: wt?.name,
      worktreePath: wt?.root,
      gitBranch: s.gitBranch,
      model: s.model,
      status: 'ended',
      lastActivityAt: s.mtimeMs,
      transcriptPath: t.path,
      prLink: s.prLink,
      conversationStartedAt: s.startedAtMs,
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
          await this.refreshHookHealth(); // settings.json edited by hand, or by another window
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
    this.hookHealthEmitter.dispose();
  }
}
