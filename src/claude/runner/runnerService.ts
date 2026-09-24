/**
 * Every Claude Code session this window is running itself.
 *
 * Two jobs. It starts them, and it answers "is this session ours?" — which the
 * rest of the app has to ask constantly, because a runner session looks from
 * the outside like any other: it is in Claude's registry, it writes a
 * transcript, and (being a child of this process) the process tree says it
 * lives in "a Claude Code panel in this window", which is exactly wrong.
 * Ownership is therefore decided here, by session id, and never by pid.
 *
 * It is the Claude `SessionExecutor`: callers get `SessionHandle`s, which today
 * are `RunnerView`s over an in-process `ClaudeSdkSession`.
 */
import { Emitter, type Disposable } from '../../core/events';
import { createLocalClaudeHandle } from '../../core/session/localClaudeHandle';
import type { LaunchRequest, SessionExecutor } from '../../core/session/sessionHandle';
import type { ModelChoice, PermissionModeName } from '../../shared/conversation';
import { loadResumeHistory, type ConversationHistory } from '../transcriptHistory';
import type { QueryFn } from './claudeSdkSession';
import type { RunnerRegistry } from './runnerRegistry';
import type { RunnerView } from './runnerView';

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

/** What starting a Claude session takes. The `LaunchRequest` minus the provider. */
export type RunnerStartOptions = Omit<LaunchRequest, 'provider' | 'initialBlocks'>;

export class RunnerService implements SessionExecutor, Disposable {
  readonly provider = 'claude' as const;
  private sessions = new Set<RunnerView>();
  private changeEmitter = new Emitter<void>();

  readonly onDidChange = (listener: () => void): Disposable => this.changeEmitter.event(listener);

  constructor(private deps: RunnerServiceDeps) {}

  /** Start a session and return its handle straight away (it reports its id once the CLI does). */
  start(opts: RunnerStartOptions): RunnerView {
    const session = createLocalClaudeHandle(opts, {
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
    if (opts.initialPrompt) void session.send(opts.initialPrompt);
    return session;
  }

  async launch(request: LaunchRequest): Promise<RunnerView> {
    if (request.provider !== 'claude') throw new Error(`RunnerService cannot launch a ${request.provider} session`);
    const { provider: _provider, initialBlocks: _blocks, ...opts } = request;
    return this.start(opts);
  }

  get(sessionId: string | undefined): RunnerView | undefined {
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

  list(): RunnerView[] {
    return [...this.sessions];
  }

  /**
   * Note that the pane is showing this session now. `lastShownAt` is what
   * decides which session a reloaded window offers to bring back, and the one
   * you were looking at is the one you meant.
   */
  touch(session: { sessionId: string | undefined; cwd: string }): void {
    if (session.sessionId) this.deps.registry?.remember(session.sessionId, session.cwd);
  }

  /** Stop one session and forget it — a deliberate end, so nothing to resume. */
  async end(session: RunnerView): Promise<void> {
    if (session.sessionId) this.deps.registry?.forget(session.sessionId);
    await session.end();
    if (session.sessionId) this.deps.registry?.forget(session.sessionId);
    this.sessions.delete(session);
    this.changeEmitter.fire();
  }

  dispose(): void {
    // Quitting kills these children anyway; ending them first gives the CLI
    // its chance to flush the transcript rather than being cut off. Not
    // awaited: this is the characterised behaviour until Stage 2 makes quit
    // an awaited, bounded end. The registry is deliberately left alone: this
    // is exactly the case the next startup wants to know about.
    for (const s of this.sessions) void s.end();
    this.sessions.clear();
    this.changeEmitter.dispose();
  }
}

export type { PermissionModeName };
