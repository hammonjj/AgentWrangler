/**
 * Every Claude Code session this window is running itself.
 *
 * Two jobs. It starts them, and it answers "is this session ours?" — which the
 * rest of the extension has to ask constantly, because a runner session looks
 * from the outside like any other: it is in Claude's registry, it writes a
 * transcript, and (being a child of this extension host) the process tree says
 * it lives in "a Claude Code panel in this window", which is exactly wrong.
 * Ownership is therefore decided here, by session id, and never by pid.
 */
import { Emitter, type Disposable } from '../../core/events';
import type { ModelChoice, PermissionModeName } from '../../shared/conversation';
import { loadResumeHistory, type ConversationHistory } from '../transcriptHistory';
import type { RunnerRegistry } from './runnerRegistry';
import { RunnerSession, type QueryFn, type RunnerStartOptions } from './runnerSession';

export interface RunnerServiceDeps {
  query: QueryFn;
  /** Re-read per start, so changing the setting does not need a reload. */
  binary: () => string;
  log: (msg: string) => void;
  /** Remembers what this window was running, so a reload can offer it back. */
  registry?: RunnerRegistry;
  /** Overridden only by tests; the default reads the session's transcript. */
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
  /**
   * Told the model list each time a session reports one. The launcher has no
   * running CLI to ask, so the last answer is kept for it — see
   * `ModelCatalogService`.
   */
  rememberModels?: (models: ModelChoice[] | undefined) => void;
}

export class RunnerService implements Disposable {
  private sessions = new Set<RunnerSession>();
  private changeEmitter = new Emitter<void>();

  readonly onDidChange = (listener: () => void): Disposable => this.changeEmitter.event(listener);

  constructor(private deps: RunnerServiceDeps) {}

  start(opts: RunnerStartOptions): RunnerSession {
    const session = new RunnerSession(opts, {
      query: this.deps.query,
      binary: this.deps.binary(),
      log: this.deps.log,
      loadHistory: this.deps.loadHistory ?? loadResumeHistory,
    });
    this.sessions.add(session);
    // The id is unknown until the CLI's first init, and ownership answers
    // change the moment it arrives — as does what is worth remembering.
    let rememberedId = session.sessionId;
    session.onLifecycle(() => {
      if (rememberedId && rememberedId !== session.sessionId) this.deps.registry?.forget(rememberedId);
      rememberedId = session.sessionId;
      if (session.sessionId) this.deps.registry?.remember(session.sessionId, session.cwd);
      this.changeEmitter.fire();
    });
    // The model list arrives a moment after start, and is the only place it is
    // ever published; the launcher needs it too. See `ModelCatalogService`.
    if (this.deps.rememberModels) {
      const remember = this.deps.rememberModels;
      session.onComposer((composer) => remember(composer.models));
    }
    session.start();
    this.deps.log(`runner started in ${opts.cwd}${opts.resume ? ` (resuming ${opts.resume})` : ''}`);
    this.changeEmitter.fire();
    return session;
  }

  get(sessionId: string | undefined): RunnerSession | undefined {
    if (!sessionId) return undefined;
    const id = sessionId.toLowerCase();
    for (const s of this.sessions) {
      if (s.sessionId?.toLowerCase() === id && s.lifecycle !== 'ended' && s.lifecycle !== 'error') return s;
    }
    return undefined;
  }

  owns(sessionId: string | undefined): boolean {
    return this.get(sessionId) !== undefined;
  }

  wasRunning(sessionId: string): boolean {
    return !this.owns(sessionId) && (this.deps.registry?.wasRunning(sessionId) ?? false);
  }

  list(): RunnerSession[] {
    return [...this.sessions];
  }

  /**
   * Note that the pane is showing this session now. `lastShownAt` is what
   * decides which session a reloaded window offers to bring back, and the one
   * you were looking at is the one you meant.
   */
  touch(session: RunnerSession): void {
    if (session.sessionId) this.deps.registry?.remember(session.sessionId, session.cwd);
  }

  /** Stop one session and forget it — a deliberate end, so nothing to resume. */
  async end(session: RunnerSession): Promise<void> {
    if (session.sessionId) this.deps.registry?.forget(session.sessionId);
    await session.end();
    if (session.sessionId) this.deps.registry?.forget(session.sessionId);
    this.sessions.delete(session);
    this.changeEmitter.fire();
  }

  dispose(): void {
    // Closing the window kills these children anyway; ending them first gives
    // the CLI its chance to flush the transcript rather than being cut off.
    // The registry is deliberately left alone: this is exactly the case the
    // next startup wants to know about.
    for (const s of this.sessions) void s.end();
    this.sessions.clear();
    this.changeEmitter.dispose();
  }
}

export type { PermissionModeName, RunnerStartOptions };
