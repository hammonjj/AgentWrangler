/**
 * The daemon's own session list, for when the app is not there to give one (#74).
 *
 * The same pieces the app uses, minus everything that runs a session: the
 * Claude provider (registry, transcripts, the hook log), the store, and the
 * decorations the remote layer needs. Hosted sessions' asks come from
 * `HostedAsks`, the way the app's come from its runners. What it cannot see,
 * and so does not offer: Codex threads' questions (they live in the app's
 * app-server client) and in-process runners (which end with the app anyway).
 *
 * Answers go where the app's would: a hook-backed permission is a decision
 * file (`HookLog.decide`), which any process may write; a hosted ask is
 * `respondAsk` on the host's socket.
 *
 * It also raises the "done" notice while it is the feed being followed, on the
 * same `becameWaiting` edge and with the same cooldown as the app.
 */
import { ClaudeProvider } from '../../claude/claudeProvider';
import type { ConfigGetter } from '../../core/config';
import { Emitter, type Disposable } from '../../core/events';
import { PauseService } from '../../core/pauseService';
import { readStoppedPids } from '../../core/procTree';
import { isPidAlive } from '../../claude/registry';
import { SessionStore } from '../../core/sessionStore';
import { DecoratedSessions } from '../../core/sessionView';
import type { SessionDTO } from '../../shared/model';
import { doneNoticeFor, type RemoteNotice } from '../../shared/remote';
import type { PermissionDecisionOutcome } from '../../ui/actions';
import { HostedAsks } from './hostedAsks';
import type { FeedSource } from './sources';

export interface LocalFeedOptions {
  getConfig: ConfigGetter;
  runDir: string;
  build: string;
  log: (message: string) => void;
  /** The archive and nicknames as the app last reported them. */
  isArchived: (key: string) => boolean;
  nickname: (key: string) => string | undefined;
  /** Whether this feed is the one being followed: notices are raised only then. */
  isActive: () => boolean;
  onNotice: (notice: RemoteNotice) => void;
  /** Tests. */
  hosted?: HostedAsks;
}

const DONE_NOTICE_COOLDOWN_MS = 30_000;

export class LocalFeed implements FeedSource, Disposable {
  private store = new SessionStore();
  private provider: ClaudeProvider;
  private hosted: HostedAsks;
  private pause: PauseService;
  private view: DecoratedSessions;
  private subs: Disposable[] = [];
  private emitter = new Emitter<void>();
  private isReady = false;
  private lastDoneNoticeAt = new Map<string, number>();

  readonly onDidUpdate = (listener: () => void): Disposable => this.emitter.event(listener);

  constructor(private opts: LocalFeedOptions) {
    const log = opts.log;
    this.provider = new ClaudeProvider(opts.getConfig, log);
    this.hosted = opts.hosted ?? new HostedAsks({ runDir: opts.runDir, build: opts.build, log });
    this.pause = new PauseService({ signal: (pid, sig) => process.kill(pid, sig), isAlive: isPidAlive, stopped: readStoppedPids }, log);
    this.store.useNicknames((key) => opts.nickname(key));
    const hosted = this.hosted;
    this.view = new DecoratedSessions(
      this.store,
      {
        isArchived: (key) => opts.isArchived(key),
        isPaused: (pid) => this.pause.isPaused(pid),
        runnerOwned: (id) => hosted.owns(id),
        pendingQuestion: (id) => hosted.views(id).question,
        pendingPlan: (id) => hosted.views(id).plan,
        pendingPermission: (id) => hosted.views(id).permission,
      },
      [this.pause, hosted],
    );
    this.subs.push(
      this.view.onDidUpdate(() => this.emitter.fire()),
      this.store.onDidUpdate((u) => {
        void this.pause.refresh(this.store.sessions.map((s) => s.pid).filter((p): p is number => typeof p === 'number'));
        this.doneNotices(u.becameWaiting);
      }),
    );
  }

  /** First scan, then the hosts' catch-up; `ready` only after both. */
  async start(): Promise<void> {
    this.hosted.start();
    await this.store.register(this.provider);
    await this.hosted.whenSettled();
    this.isReady = true;
    this.opts.log(`own feed ready: ${this.store.sessions.length} session(s), ${this.hosted.count} host(s)`);
    this.emitter.fire();
  }

  get ready(): boolean {
    return this.isReady;
  }

  get sessions(): SessionDTO[] {
    return this.view.sessions;
  }

  get hostCount(): number {
    return this.hosted.count;
  }

  /** The app's archive or names changed: re-decorate. */
  redecorate(): void {
    this.store.renameApplied();
    this.emitter.fire();
  }

  async decidePermission(
    key: string,
    behavior: 'allow' | 'deny' | 'always',
    opts?: { expectedRequestId?: string },
  ): Promise<PermissionDecisionOutcome> {
    const s = this.store.get(key);
    if (!s || s.provider !== 'claude') return 'unsupported';
    const expected = opts?.expectedRequestId;
    // Hosted: the host is the only way in (the hook does not wait for it).
    if (this.hosted.owns(s.sessionId)) {
      const outcome = await this.hosted.decide(s.sessionId, behavior, expected);
      if (outcome === 'applied') this.opts.log(`permission ${behavior} sent to the host running ${s.sessionId}`);
      return outcome;
    }
    if (expected !== undefined && s.permissionRequestId !== expected) return 'stale';
    const sent = await this.provider.decidePermission(s.sessionId, behavior, expected);
    if (sent) this.opts.log(`permission ${behavior} written for ${s.sessionId}`);
    return sent ? 'applied' : 'gone';
  }

  async answerQuestion(key: string, requestId: string, answers: Record<string, string>): Promise<PermissionDecisionOutcome> {
    const s = this.store.get(key);
    if (!s || !this.hosted.owns(s.sessionId)) return 'unsupported';
    return this.hosted.answer(s.sessionId, requestId, answers);
  }

  async decidePlan(key: string, requestId: string, approve: boolean, feedback?: string): Promise<PermissionDecisionOutcome> {
    const s = this.store.get(key);
    if (!s || !this.hosted.owns(s.sessionId)) return 'unsupported';
    return this.hosted.decidePlan(s.sessionId, requestId, approve, feedback);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.view.dispose();
    this.hosted.dispose();
    this.store.dispose(); // disposes the provider
    this.emitter.dispose();
  }

  private doneNotices(becameWaiting: SessionDTO[]): void {
    if (becameWaiting.length === 0 || !this.opts.isActive()) return;
    const cfg = this.opts.getConfig();
    if (!cfg.remoteEnabled || !cfg.remoteNotifyOnDone) return;
    const now = Date.now();
    for (const s of becameWaiting) {
      if (this.opts.isArchived(s.key)) continue;
      const notice = doneNoticeFor(s);
      if (!notice) continue; // blocked: the permission card is already saying so
      if (now - (this.lastDoneNoticeAt.get(s.key) ?? 0) < DONE_NOTICE_COOLDOWN_MS) continue;
      this.lastDoneNoticeAt.set(s.key, now);
      this.opts.onNotice(notice);
    }
  }
}
