/**
 * Every Claude Code session this app is running itself.
 *
 * Two jobs. It starts them, and it answers "is this session ours?" — which the
 * rest of the app has to ask constantly, because a runner session looks from
 * the outside like any other: it is in Claude's registry, it writes a
 * transcript, and (being a child of this process, or of one of its hosts) the
 * process tree says nothing useful about who drives it. Ownership is therefore
 * decided here, by session id, and never by pid.
 *
 * It is the Claude `SessionExecutor`. Its handles are `RunnerView`s, over an
 * in-process `ClaudeSdkSession` or, with session hosts on (Stage 3), over a
 * `HostClient` talking to a detached host that outlives the app.
 */
import { randomUUID } from 'node:crypto';
import { Emitter, type Disposable } from '../../core/events';
import type { HostSupervisor } from '../../core/session/hostSupervisor';
import { createLocalClaudeHandle } from '../../core/session/localClaudeHandle';
import { HOST_LOST } from '../../core/session/recovery';
import { adoptHostedClaude, spawnHostedClaude } from '../../core/session/remoteClaudeHandle';
import type { LaunchRequest, SessionExecutor } from '../../core/session/sessionHandle';
import type { ExecutorRegistry, SessionRecord } from '../../core/session/sessionRegistry';
import type { ModelChoice, PermissionModeName } from '../../shared/conversation';
import { parseLaunchPolicy } from '../../shared/launchPolicy';
import type { HostManifest } from '../../shared/sessionProtocol';
import { loadResumeHistory, type ConversationHistory } from '../transcriptHistory';
import type { QueryFn } from './claudeSdkSession';
import type { RunnerView } from './runnerView';

export interface RunnerServiceDeps {
  query: QueryFn;
  /** Re-read per start, so changing the setting does not need a reload. */
  binary: () => string;
  log: (msg: string) => void;
  /** Records every session and what became of it, so a restart can offer them back. */
  registry?: ExecutorRegistry;
  /** Where a folder's checkout is (repo root, worktree, branch), captured at launch. */
  locate?: (cwd: string) => { repoRoot?: string; worktree?: string; branch?: string };
  /** Overridden only by tests; the default reads the session's transcript. */
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
  /**
   * Told the model list each time a session reports one. The launcher has no
   * running CLI to ask, so the last answer is kept for it — see
   * `CapabilityCatalog`.
   */
  rememberModels?: (models: ModelChoice[] | undefined) => void;
  /** Session hosts: where new sessions run when `enabled()` says so, and how surviving ones are adopted. */
  hosts?: { supervisor: HostSupervisor; enabled: () => boolean };
  /**
   * The orphan sweep (§7.3): resolves once nothing else runs the id, rejects
   * (with a sentence for the user) when something still does. Awaited before
   * every resume, and before a version migration.
   */
  beforeResume?: (sessionId: string) => Promise<void>;
  /** A host died under a live session without an exit record; its agent may be orphaned. */
  onHostLost?: (sessionId: string) => void;
}

/** What starting a Claude session takes. The `LaunchRequest` minus the provider. */
export type RunnerStartOptions = Omit<LaunchRequest, 'provider' | 'initialBlocks'>;

export class RunnerService implements SessionExecutor, Disposable {
  readonly provider = 'claude' as const;
  private sessions = new Set<RunnerView>();
  /** Being ended on purpose or for quit: their exit is not "ended on its own". */
  private ending = new Set<RunnerView>();
  private changeEmitter = new Emitter<void>();

  readonly onDidChange = (listener: () => void): Disposable => this.changeEmitter.event(listener);

  constructor(private deps: RunnerServiceDeps) {}

  /** Start a session and return its handle straight away. */
  start(opts: RunnerStartOptions): RunnerView {
    const binary = this.deps.binary();
    const loadHistory = this.deps.loadHistory ?? loadResumeHistory;
    const hosts = this.deps.hosts?.enabled() ? this.deps.hosts : undefined;
    // A hosted session's id is chosen here, so its manifest, the registry and
    // the pane all know it before the first turn.
    const launch = hosts && !opts.resume && !opts.sessionId ? { ...opts, sessionId: randomUUID() } : opts;
    const session = hosts
      ? spawnHostedClaude(launch, { supervisor: hosts.supervisor, binary, log: this.deps.log, loadHistory, beforeResume: this.deps.beforeResume })
      : createLocalClaudeHandle(launch, { query: this.deps.query, binary, log: this.deps.log, loadHistory });
    const place = this.deps.locate?.(opts.cwd) ?? {};
    this.track(session, (id) =>
      this.deps.registry?.live({
        sessionId: id,
        provider: 'claude',
        cwd: opts.cwd,
        repoRoot: place.repoRoot,
        worktree: place.worktree,
        branchAtStart: place.branch,
        launch: { model: opts.model, permissionMode: opts.permissionMode, effort: opts.effort, binary, policy: opts.policy },
        origin: opts.origin,
      }),
    );
    this.deps.log(`runner started in ${opts.cwd}${opts.resume ? ` (resuming ${opts.resume})` : ''}${hosts ? ' in a session host' : ''}`);
    if (opts.initialPrompt) void session.send(opts.initialPrompt);
    return session;
  }

  /**
   * Take back a session a previous run of the app left running in a host.
   * Its registry record is already `live` (startup left it so), and says how
   * it was launched.
   */
  adopt(manifest: HostManifest, record?: SessionRecord): RunnerView | undefined {
    const supervisor = this.deps.hosts?.supervisor;
    if (!supervisor || !manifest.sessionId) return undefined;
    const session = adoptHostedClaude(
      manifest,
      {
        permissionMode: record?.launch.permissionMode as PermissionModeName | undefined,
        model: record?.launch.model,
        effort: record?.launch.effort,
        origin: record?.origin,
        // The registry's, or the host's own copy when the registry lost the record.
        policy: record?.launch.policy ?? parseLaunchPolicy(manifest.launch?.policy),
      },
      {
        supervisor,
        // Only used if it moves to a new host (§7.4), which is a fresh start: today's binary.
        binary: this.deps.binary(),
        log: this.deps.log,
        loadHistory: this.deps.loadHistory ?? loadResumeHistory,
        beforeResume: this.deps.beforeResume,
      },
    );
    // Its record is already live. A `/clear` later gives it a new id, whose
    // record keeps how it was launched and who started it, as `start` does (#72).
    const adoptedId = manifest.sessionId.toLowerCase();
    const origin = record?.origin ?? manifest.origin;
    this.track(session, (id) => {
      if (id.toLowerCase() === adoptedId) return;
      const { applied: _applied, ...launch } = record?.launch ?? {};
      this.deps.registry?.live({
        sessionId: id,
        provider: 'claude',
        cwd: session.cwd,
        repoRoot: record?.repoRoot,
        worktree: record?.worktree,
        branchAtStart: record?.branchAtStart,
        // The view's policy: the record's, or the manifest's copy (#71).
        launch: { ...launch, ...(session.policy ? { policy: session.policy } : {}) },
        origin,
      });
    });
    this.deps.log(`adopted session ${manifest.sessionId} from host ${manifest.hostId}`);
    return session;
  }

  /**
   * Resume an existing id here: the only way any caller should. The sweep
   * runs first (§7.3), and only once it says nothing else runs the id does
   * the history get read and the new process start, so the orphan's last
   * words are in the history and there is never a second process on the id.
   */
  async resume(opts: RunnerStartOptions & { resume: string }): Promise<RunnerView> {
    await this.deps.beforeResume?.(opts.resume);
    return this.start(opts);
  }

  /** The machine woke from sleep: every hosted session rechecks its link. */
  wakeAll(): void {
    for (const s of this.sessions) s.wake();
  }

  /** A setting hosts apply themselves changed (the idle-orphan rule): tell them. */
  reconfigureAll(): void {
    for (const s of this.sessions) if (s.hosted) s.reconfigure();
  }

  async launch(request: LaunchRequest): Promise<RunnerView> {
    if (request.provider !== 'claude') throw new Error(`RunnerService cannot launch a ${request.provider} session`);
    const { provider: _provider, initialBlocks: _blocks, ...opts } = request;
    // A resume goes through the sweep like every other (§7.3).
    return opts.resume ? this.resume({ ...opts, resume: opts.resume }) : this.start(opts);
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

  /** Interrupted by the last restart, and not running here now: its row offers Resume. */
  wasRunning(sessionId: string): boolean {
    return !this.owns(sessionId) && (this.deps.registry?.isInterrupted(sessionId) ?? false);
  }

  list(): RunnerView[] {
    return [...this.sessions];
  }

  /** Live sessions, split by whether they survive the app quitting. */
  counts(): { hosted: number; local: number } {
    let hosted = 0;
    let local = 0;
    for (const s of this.sessions) {
      if (s.lifecycle === 'ended' || s.lifecycle === 'error') continue;
      if (s.hosted) hosted++;
      else local++;
    }
    return { hosted, local };
  }

  /**
   * Note that the pane is showing this session now. `lastShownAt` is what
   * decides which session a restarted app brings back, and the one you were
   * looking at is the one you meant.
   */
  touch(session: { sessionId: string | undefined; cwd: string }): void {
    if (session.sessionId) this.deps.registry?.touch(session.sessionId);
  }

  /** Stop one session on purpose — Close, Release — so it is `stopped`, not interrupted. */
  async end(session: RunnerView): Promise<void> {
    this.ending.add(session);
    if (session.sessionId) this.deps.registry?.setState(session.sessionId, 'stopped');
    await session.end();
    if (session.sessionId) this.deps.registry?.setState(session.sessionId, 'stopped');
    this.ending.delete(session);
    this.sessions.delete(session);
    this.changeEmitter.fire();
  }

  /**
   * The app is quitting. In-process sessions cannot survive it, so they are
   * ended, awaited and bounded. Hosted ones are left running and merely let go
   * of, unless `includeHosted` (Quit and Stop All Agents). Either way the
   * registry keeps them `live`: a hosted one is adopted on the next start, an
   * ended one comes back as interrupted.
   */
  async endAllForQuit(withinMs: number, opts: { includeHosted?: boolean } = {}): Promise<void> {
    const toEnd = [...this.sessions].filter((s) => !s.hosted || opts.includeHosted);
    for (const s of toEnd) this.ending.add(s);
    await Promise.race([
      Promise.allSettled(toEnd.map((s) => s.end())),
      new Promise<void>((resolve) => setTimeout(resolve, withinMs)),
    ]);
  }

  dispose(): void {
    // In-process sessions die with the app anyway; ending them first gives the
    // CLI its chance to flush the transcript. Hosted ones are only let go of:
    // they keep running and the next start adopts them. The registry is left
    // alone either way; this is exactly what the next startup wants to know.
    for (const s of this.sessions) {
      if (s.hosted) s.detach();
      else void s.end();
    }
    this.sessions.clear();
    this.changeEmitter.dispose();
  }

  // ---- internals ----

  private track(session: RunnerView, record?: (id: string) => void): void {
    this.sessions.add(session);
    // The id is unknown until the CLI's first init (unless the launch chose
    // one), and ownership answers change the moment it arrives. A new id mid-
    // life is `/clear`: the old conversation ended here and a new one began.
    let recordedId = session.sessionId;
    if (recordedId) record?.(recordedId);
    session.onLifecycle((lifecycle) => {
      const id = session.sessionId;
      if (id && id !== recordedId) {
        if (recordedId) this.deps.registry?.setState(recordedId, 'ended', 'cleared');
        recordedId = id;
        if (record) record(id);
        // Adopted: the new id inherits the policy and origin, or a Resume of it would run without them.
        else {
          this.deps.registry?.live({
            sessionId: id,
            provider: 'claude',
            cwd: session.cwd,
            ...(session.policy ? { launch: { policy: session.policy } } : {}),
            origin: session.origin,
          });
        }
      }
      // Ended on its own. A deliberate `end` has already said `stopped`.
      if (id && this.sessions.has(session) && !this.ending.has(session)) {
        if (lifecycle === 'ended') this.deps.registry?.setState(id, 'ended');
        if (lifecycle === 'error') {
          // A host that died without an exit record may have left its agent
          // running mid-turn: the conversation is resumable, so say interrupted.
          if (session.lastExit?.reason === 'lost') {
            this.deps.registry?.setState(id, 'interrupted', HOST_LOST);
            // Sweep now, while the orphan's turn is still fresh, rather than
            // leave it running headless until someone resumes (§7.3, S1).
            this.deps.onHostLost?.(id);
          } else this.deps.registry?.setState(id, 'failed', 'agent error');
        }
      }
      this.changeEmitter.fire();
    });
    // An ask opening or settling changes what the row and the remote offer
    // (a hosted session's permission reaches them only from here), without
    // any lifecycle change to announce it.
    const askKinds = new Set(['permission', 'question', 'plan']);
    session.onAppend((blocks) => {
      if (blocks.some((b) => askKinds.has(b.kind))) this.changeEmitter.fire();
    });
    session.onPatch((p) => {
      if ('state' in p.block) this.changeEmitter.fire();
    });
    // The model list arrives a moment after start, and is the only place it is
    // ever published; the launcher needs it too. See `CapabilityCatalog`.
    if (this.deps.rememberModels) {
      const remember = this.deps.rememberModels;
      session.onComposer((composer) => remember(composer.models));
    }
    session.start();
    this.changeEmitter.fire();
  }
}

export type { PermissionModeName };
