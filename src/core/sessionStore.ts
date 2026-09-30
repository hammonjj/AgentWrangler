import type { AgentSession } from '../shared/model';
import { compareSessions, needsUser } from '../shared/model';
import { toastAllowed, withDerivedState } from '../shared/orchestration/delegatedState';
import type { Mission } from '../shared/orchestration/types';
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
  // Serialize subagent list, excluding timestamps that move on every poll
  const subagentListStr = s.subagentList
    ? JSON.stringify(s.subagentList.map((sa) => ({ id: sa.id, label: sa.label, status: sa.status, agentType: sa.agentType })))
    : 'null';
  return [
    s.status,
    JSON.stringify(s.subagents ?? null),
    subagentListStr,
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
    s.backgroundTasks ? `${s.backgroundTasks.subagents}/${s.backgroundTasks.shells}/${s.backgroundTasks.other}` : '',
    // Turn progress, minus elapsed time: the webview ticks that locally, so
    // including it here would make every poll a material change for every row.
    s.progress?.startedAtMs ?? '',
    s.progress?.toolCalls ?? '',
    s.progress?.todo ? `${s.progress.todo.completed}/${s.progress.todo.total}` : '',
    s.progress?.todo?.active ?? '',
    s.progress?.pace?.band ?? '',
    // Usage grows with every turn record, which a provider scan never sees.
    s.usage ? `${s.usage.turns}:${s.usage.lastAt}` : '',
    // Derived orchestration state (#101): a mission moving changes nothing a
    // provider scan sees, so it has to be material here or the row, the tray
    // and the conversation would keep showing the old phase.
    s.turnStartedAt ?? '',
    s.statusUncertain ?? '',
    s.wait ? `${s.wait.reason}:${s.wait.certainty}:${s.wait.source}:${s.wait.ref?.missionId ?? ''}:${s.wait.ref?.planRunId ?? ''}:${s.wait.ref?.taskId ?? ''}:${s.wait.detail ?? ''}` : '',
    s.linked ? s.linked.map((w) => `${w.missionId}:${w.phase}:${w.text}:${w.keyed ? 1 : 0}:${w.updatedAt}`).join(',') : '',
    s.rateLimit ? `${s.rateLimit.category}:${s.rateLimit.resetAtMs ?? ''}` : '',
    s.pendingQuestion?.requestId ?? '',
    s.pendingPlan?.requestId ?? '',
  ].join('\u0000');
}

/**
 * Working → notable, and worth telling the human about given what the row is
 * waiting for (#101): a Done whose delegated work is still going is not news
 * yet, and an approval the mission already announced is not announced twice.
 */
function becameNotable(prev: AgentSession, next: AgentSession): boolean {
  return !notable(prev.status) && prev.status !== 'ended' && notable(next.status) && toastAllowed(next);
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
  private usageFor: (sessionId: string) => AgentSession['usage'] = () => undefined;
  /** The missions a session delegated (by origin key), for the derived orchestration state (#101). */
  private missionsFor: (key: string) => readonly Mission[] = () => [];
  /** What each provider last said, before decoration: every re-derivation starts from this, never from its own output. */
  private raw = new Map<string, AgentSession>();

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
   * Per-session usage from telemetry (#28), applied here for the same reason
   * nicknames are: every surface reads the store.
   */
  useUsage(lookup: (sessionId: string) => AgentSession['usage']): void {
    this.usageFor = lookup;
  }

  /**
   * The missions each conversation delegated, by its session key (#101). The
   * store is where the derived status, wait reason and linked-work summary
   * are applied (`shared/orchestration/delegatedState.ts`), for the same
   * reason nicknames are: the table, the tray, the toasts and the
   * conversation all read from here, so there is one derivation, not one per
   * surface.
   */
  useLinkedWork(lookup: (key: string) => readonly Mission[]): void {
    this.missionsFor = lookup;
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
          statusIsEstimated: live.statusIsEstimated,
          lastActivityAt: live.lastActivityAt,
          progress: live.progress,
          blockedReason: live.blockedReason,
          blockedAsk: live.blockedAsk,
          permissionRequestId: live.permissionRequestId,
          ...(live.turnStartedAt !== undefined ? { turnStartedAt: live.turnStartedAt } : {}),
        }
      : s;
    const nickname = this.nicknameFor(s.key);
    const usage = this.usageFor(s.sessionId);
    const named = nickname === undefined && usage === undefined
      ? current
      : { ...current, ...(nickname === undefined ? {} : { nickname }), ...(usage === undefined ? {} : { usage }) };
    // Last, over the provider's own reading of the turn: §5.1 of the status contract.
    return withDerivedState(named, this.missionsFor(s.key), Date.now());
  }

  /**
   * Re-decorate every held row from its raw provider reading and fire for the
   * rows that changed. `edge` also reports working → notable transitions, for
   * a change that can move a status (a mission resolving a wait).
   */
  private redecorate(edge = false): void {
    const changed: AgentSession[] = [];
    const becameWaiting: AgentSession[] = [];
    for (const [key, prev] of this.byKey) {
      const next = this.decorate(this.raw.get(key) ?? prev);
      if (materialFingerprint(next) === materialFingerprint(prev)) continue;
      this.byKey.set(key, next);
      changed.push(next);
      if (edge && becameNotable(prev, next)) becameWaiting.push(next);
    }
    if (changed.length === 0) return;
    this.emitter.fire({ sessions: this.sessions, upserted: changed, removedKeys: [], becameWaiting });
  }

  /**
   * Re-apply usage to what is already held and fire for the rows it changed. A
   * turn record touches nothing a provider scan would notice.
   */
  usageApplied(): void {
    this.redecorate();
  }

  /**
   * Re-apply nicknames to what is already held and fire if anything changed.
   * Renaming touches nothing a provider scan would notice, so without this the
   * new name would not appear until the session next did something.
   */
  renameApplied(): void {
    this.redecorate();
  }

  /**
   * Re-derive after a mission changed (#101): an approval, a launch, a merge.
   * Nothing a provider scan sees moved, but a wait may have resolved or a
   * summary moved on.
   */
  linkedWorkApplied(): void {
    this.redecorate(true);
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
    const raw = new Map<string, AgentSession>();
    for (const s of all) {
      // last write wins on (impossible) dup keys
      raw.set(s.key, s);
      next.set(s.key, this.decorate(s));
    }
    this.raw = raw;

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
      if (prev && becameNotable(prev, session)) becameWaiting.push(session);
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
