import type { AgentSession } from '../shared/model';
import { compareSessions, needsUser } from '../shared/model';
import { Emitter, type Disposable, type Listener } from './events';
import type { AgentProvider } from './provider';

export interface StoreUpdate {
  /** Full sorted snapshot. */
  sessions: AgentSession[];
  upserted: AgentSession[];
  removedKeys: string[];
  /**
   * Sessions that flipped from working (busy|stuck) to something worth telling
   * the human about: blocked, waiting, or done. Never populated on the first
   * snapshot.
   */
  becameWaiting: AgentSession[];
}

/** Worth a toast: the agent needs you, or has just finished. */
function notable(status: AgentSession['status']): boolean {
  return needsUser(status) || status === 'done';
}

function materialFingerprint(s: AgentSession): string {
  return [
    s.status,
    JSON.stringify(s.subagents ?? null),
    s.title,
    // A rename changes nothing a provider scan would see, so it has to be
    // material here or the new name would wait for the session to do something.
    s.nickname ?? '',
    s.subtitle ?? '',
    s.lastActivityAt,
    s.name ?? '',
    s.gitBranch ?? '',
    s.worktree ?? '',
    s.model ?? '',
    s.provider,
    s.client ?? '',
    s.pid ?? '',
    // Constant per conversation, but it arrives with the first transcript read
    // rather than with the row, so the change from absent to known has to be
    // material or the Age column would keep showing the fallback until
    // something else happened to the session.
    s.conversationStartedAt ?? '',
    s.transcriptPath ?? '',
    s.prLink?.prUrl ?? '',
    s.statusIsEstimated ? 'est' : '',
    s.blockedReason ?? '',
    s.blockedAsk?.summary ?? '',
    s.blockedAsk?.body ?? '',
    s.permissionRequestId ?? '',
    s.alwaysAllow?.rules.join(',') ?? '',
    s.activeTool?.name ?? '',
    // Turn progress, minus elapsed time: the webview ticks that locally, so
    // including it here would make every poll a material change for every row.
    s.progress?.startedAtMs ?? '',
    s.progress?.toolCalls ?? '',
    s.progress?.todo ? `${s.progress.todo.completed}/${s.progress.todo.total}` : '',
    s.progress?.todo?.active ?? '',
    s.progress?.pace?.band ?? '',
  ].join('\u0000');
}

export class SessionStore implements Disposable {
  private providers: AgentProvider[] = [];
  private byKey = new Map<string, AgentSession>();
  private emitter = new Emitter<StoreUpdate>();
  private subscriptions: Disposable[] = [];
  private firstSnapshotDone = false;
  private refreshing = false;
  private refreshQueued = false;
  private disposed = false;

  /**
   * The user's own name for a session, when they gave one.
   *
   * It is applied here rather than where each surface renders, because the
   * store is the one place every surface goes through. The dashboard decorates
   * its own snapshots, but the conversation pane, the status bar, the quick
   * picks, the toasts and the terminal label all read straight from here — a
   * nickname attached any further downstream would show up in some of those and
   * not others.
   */
  private nicknameFor: (key: string) => string | undefined = () => undefined;
  private liveSessionFor: (session: AgentSession) => AgentSession | undefined = () => undefined;

  readonly onDidUpdate = (listener: Listener<StoreUpdate>): Disposable => this.emitter.event(listener);

  /**
   * Supply the nickname lookup. Separate from the constructor so `core` keeps
   * knowing nothing about where the names are stored.
   */
  useNicknames(lookup: (key: string) => string | undefined): void {
    this.nicknameFor = lookup;
  }

  /** Overlay exact in-process runner state on provider discovery for every consumer, not only the dashboard. */
  useLiveSessions(lookup: (session: AgentSession) => AgentSession | undefined): void {
    this.liveSessionFor = lookup;
  }

  /**
   * The nickname for a key the store may not hold — the conversation pane
   * builds a session of its own for a runner that has not registered yet, and
   * it should not be the one surface that ignores a rename.
   */
  nicknameOf(key: string): string | undefined {
    return this.nicknameFor(key);
  }

  private decorate(s: AgentSession): AgentSession {
    const live = this.liveSessionFor(s);
    const current = live
      ? {
          ...s,
          status: live.status,
          lastActivityAt: live.lastActivityAt,
          blockedReason: live.blockedReason,
          blockedAsk: live.blockedAsk,
          permissionRequestId: live.permissionRequestId,
        }
      : s;
    const nickname = this.nicknameFor(s.key);
    return nickname === undefined ? current : { ...current, nickname };
  }

  /**
   * Re-apply nicknames to what is already held and fire if anything changed.
   * Renaming touches nothing a provider scan would notice, so without this the
   * new name would not appear until the session next did something.
   */
  renameApplied(): void {
    const changed: AgentSession[] = [];
    for (const [key, prev] of this.byKey) {
      const next = this.decorate({ ...prev, nickname: undefined });
      if (next.nickname === prev.nickname) continue;
      this.byKey.set(key, next);
      changed.push(next);
    }
    if (changed.length === 0) return;
    this.emitter.fire({ sessions: this.sessions, upserted: changed, removedKeys: [], becameWaiting: [] });
  }

  get sessions(): AgentSession[] {
    return [...this.byKey.values()].sort(compareSessions);
  }

  get(key: string): AgentSession | undefined {
    return this.byKey.get(key);
  }

  /** Sessions needing you: blocked on a prompt, or done and awaiting your reply. */
  get waitingCount(): number {
    let n = 0;
    for (const s of this.byKey.values()) if (needsUser(s.status)) n++;
    return n;
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.byKey.values()) if (s.status !== 'ended') n++;
    return n;
  }

  async register(provider: AgentProvider): Promise<void> {
    this.providers.push(provider);
    this.subscriptions.push(provider.onDidChange(() => void this.refresh()));
    await provider.start();
    await this.refresh();
  }

  async forceRefresh(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.refresh().catch(() => undefined)));
    await this.refresh();
  }

  /** Re-scan all providers, diff against current state, fire on material change. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        const results = await Promise.all(this.providers.map((p) => p.scan().catch(() => [] as AgentSession[])));
        this.applySnapshot(results.flat());
      } while (this.refreshQueued && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  private applySnapshot(all: AgentSession[]): void {
    const next = new Map<string, AgentSession>();
    for (const s of all) next.set(s.key, this.decorate(s)); // last write wins on (impossible) dup keys

    const upserted: AgentSession[] = [];
    const becameWaiting: AgentSession[] = [];
    const removedKeys: string[] = [];

    for (const [key, session] of next) {
      const prev = this.byKey.get(key);
      if (!prev || materialFingerprint(prev) !== materialFingerprint(session)) {
        upserted.push(session);
      }
      // Working → notable. `blocked` counts: a permission prompt is the most
      // urgent case there is, since the agent is frozen mid-task until you act.
      // `done` counts too — a finished agent is news, even if it asks nothing.
      if (prev && !notable(prev.status) && prev.status !== 'ended' && notable(session.status)) {
        becameWaiting.push(session);
      }
    }
    for (const key of this.byKey.keys()) {
      if (!next.has(key)) removedKeys.push(key);
    }

    this.byKey = next;

    const isFirst = !this.firstSnapshotDone;
    this.firstSnapshotDone = true;
    if (isFirst || upserted.length > 0 || removedKeys.length > 0) {
      this.emitter.fire({
        sessions: this.sessions,
        upserted,
        removedKeys,
        becameWaiting: isFirst ? [] : becameWaiting,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions) s.dispose();
    for (const p of this.providers) p.dispose();
    this.emitter.dispose();
    this.byKey.clear();
  }
}
