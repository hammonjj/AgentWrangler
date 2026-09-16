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
    s.title,
    s.subtitle ?? '',
    s.lastActivityAt,
    s.name ?? '',
    s.gitBranch ?? '',
    s.worktree ?? '',
    s.model ?? '',
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

  readonly onDidUpdate = (listener: Listener<StoreUpdate>): Disposable => this.emitter.event(listener);

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
    for (const s of all) next.set(s.key, s); // last write wins on (impossible) dup keys

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
