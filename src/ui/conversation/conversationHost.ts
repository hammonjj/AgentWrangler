/**
 * The conversation pane's behaviour, independent of which webview shell holds
 * it. Owns one session's source, keeps the webview in step with the store, and
 * turns the webview's messages into source calls or extension actions.
 *
 * The shell (a reusable panel, or a pinned one) owns only a lifetime — the same
 * split the dashboard uses between `DashboardHost` and its two shells.
 */
import * as fs from 'node:fs/promises';
import { archivePage, archivedTool, subagentPath } from '../../claude/conversationArchive';
import { transcriptPathFor } from '../../claude/transcriptHistory';
import * as path from 'node:path';
import { projectNameFor } from '../../core/checkout';
import type { HostDialogs } from '../../host/hostServices';
import type { RunnerService } from '../../claude/runner/runnerService';
import { DictationSetupError, type DictationService } from '../../core/dictation';
import type { SessionHandle } from '../../core/session/sessionHandle';
import type { SessionExecutors } from '../../core/session/sessionExecutors';
import type { FileSuggestService } from '../../core/fileSuggest';
import type { AgentProvider } from '../../core/provider';
import type { SessionStore } from '../../core/sessionStore';
import { imageMediaType, mentionForPath } from '../../shared/attachments';
import type { ConversationCapabilities, ImageAttachment } from '../../shared/conversation';
import { MAX_IMAGE_BYTES, rememberFullText } from '../../shared/conversation';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import type { Disposable } from '../../core/events';
import type { TaskView, TaskViewAction } from '../../shared/orchestration/taskView';
import { displayTitle, type AgentSession, type SessionStatus } from '../../shared/model';
import type { SessionActions } from '../actions';
import type { PaneChannel } from '../paneChannel';
import { adoptActionFor } from '../openTarget';
import { LiveSessionSource } from './runnerSource';
import { CodexTranscriptSource } from './codexTranscriptSource';
import type { ConversationSource } from './source';
import { TranscriptSource } from './transcriptSource';

/**
 * Ceiling on one drop. A dragged selection is a handful of files; a number
 * beyond this is a folder's worth landing in the box by accident.
 */
const MAX_DROPPED_PATHS = 20;

/**
 * The two things the pane needs from the host and cannot get from a service:
 * somewhere to put a message, and what to do when dictation turns out not to be
 * installed. Neither belongs in a session service.
 */
export interface ConversationHostUi {
  dialogs: HostDialogs;
  /**
   * Dictation asked for a tool that is missing. The app offers the Homebrew
   * command and the model download; a host with nowhere to run a command can
   * simply report it.
   */
  offerDictationSetup(err: DictationSetupError): Promise<void>;
}

/**
 * The task strip above the conversation (#34), behind an interface so the pane
 * host never imports the orchestrator. Absent while orchestration is off, and
 * then no conversation has a strip.
 *
 * `viewFor` is keyed by session key because that is all the pane knows about
 * what it is showing; working out which mission and attempt that is belongs on
 * the other side of this interface.
 */
export interface TaskPaneSource {
  viewFor(sessionKey: string): TaskView | undefined;
  /** Run one of the strip's buttons. Rejects with a message the user should read. */
  run(missionId: string, action: TaskViewAction): Promise<void>;
  onDidChange(listener: () => void): Disposable;
}

/** Provider surface the pane needs: transcript growth, and answering a permission prompt. */
export interface ConversationProvider extends AgentProvider {
  decidePermission(sessionId: string, behavior: 'allow' | 'deny' | 'always'): Promise<boolean>;
}

/**
 * What the pane is showing: a session the store knows about, or a live
 * session we just started (Claude or Codex), whose id or store entry may not
 * exist yet.
 */
type Binding = { kind: 'store'; key: string } | { kind: 'live'; handle: SessionHandle };

export class ConversationHost {
  private subs: { dispose(): void }[] = [];
  private source?: ConversationSource;
  private sourceSubs: { dispose(): void }[] = [];
  private binding?: Binding;
  /** A key asked for before the store knew it; bound on the next update. */
  private pendingKey?: string;
  private session?: AgentSession;
  /**
   * Every key the current binding has been known by. One conversation can have
   * several: a runner is `claude:pending` until it reports an id, and the CLI
   * issues a new id on resume and after a compaction. A send carrying any of
   * them is a send for this conversation.
   */
  private boundKeys = new Set<string>();
  private ready = false;
  private pendingSend?: AbortController;
  private archiveText = new Map<string, string>();
  private subagentFiles = new Map<string, string>();
  /** Capability computation is async and can overlap; only the newest may land. */
  private capsSeq = 0;
  /** This pane started the recording the shared `DictationService` is making. */
  private ownsDictation = false;

  constructor(
    private webview: PaneChannel,
    private store: SessionStore,
    private provider: ConversationProvider,
    private codexProvider: AgentProvider,
    private sessions: SessionExecutors,
    /** Claude only: told which session the pane is showing, for restart-time resume. */
    private runners: Pick<RunnerService, 'touch'>,
    private actions: SessionActions,
    private dictation: DictationService,
    private files: FileSuggestService,
    private onTitle: (title: string) => void,
    private ui: ConversationHostUi,
    private tasks?: TaskPaneSource,
  ) {
    this.subs.push(
      webview.onDidReceiveMessage((m: ConversationToHost) => void this.onMessage(m)),
      this.store.onDidUpdate(() => this.onStoreUpdate()),
      // A live session's id arriving, or its lifecycle changing, changes what
      // the pane can offer even when the store has not moved.
      this.sessions.onDidChange(() => this.onStoreUpdate()),
    );
    // The strip moves on its own clock — a new attempt, a diff stat, an action
    // that stopped being offered — none of which the store or the executors
    // notice. Pushed on its own so the conversation is not re-initialised under
    // the user every time a task ticks.
    if (this.tasks) this.subs.push(this.tasks.onDidChange(() => this.pushTask()));
  }

  /** The strip for whatever the pane is showing now, or nothing. */
  private taskView(): TaskView | undefined {
    const key = this.session?.key;
    return key ? this.tasks?.viewFor(key) : undefined;
  }

  private pushTask(): void {
    if (!this.ready) return;
    this.post({ type: 'task', task: this.taskView() });
  }

  get sessionKey(): string | undefined {
    return this.session?.key;
  }

  /**
   * Point the pane at a session.
   *
   * The session may not be in the store yet: a window is restored before the
   * provider's first scan has run. So an unknown key is remembered and bound as
   * soon as it appears, rather than dropped — which is what made a restored
   * pane come back blank.
   */
  show(key: string): void {
    if (this.binding?.kind === 'store' && this.binding.key === key) return;
    const session = this.store.get(key);
    if (!session) {
      this.pendingKey = key;
      return;
    }
    this.pendingKey = undefined;
    this.bind({ kind: 'store', key }, session);
  }

  /** Point the pane at a session we are running, possibly before it has an id or a store entry. */
  showSession(handle: SessionHandle): void {
    if (this.binding?.kind === 'live' && this.binding.handle === handle) return;
    this.bind({ kind: 'live', handle }, liveSessionRow(handle, this.store));
  }

  dispose(): void {
    this.pendingSend?.abort();
    // A pane closed mid-recording must not leave the microphone open, or a
    // transcription running for a composer that no longer exists.
    this.cancelDictation();
    this.disposeSource();
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  // ---- internals ----

  private bind(binding: Binding, session: AgentSession): void {
    if (this.session?.sessionId !== session.sessionId) this.pendingSend?.abort();
    this.archiveText.clear();
    this.subagentFiles.clear();
    this.binding = binding;
    this.session = session;
    this.boundKeys = new Set([session.key]);
    this.onTitle(displayTitle(session));
    this.swapSource(session);
    const live = this.source instanceof LiveSessionSource ? this.source.handle : undefined;
    if (live?.provider === 'claude') this.runners.touch(live);
    if (this.ready) void this.sendInit();
  }

  private post(msg: HostToConversation): void {
    void this.webview.postMessage(msg);
  }

  private disposeSource(): void {
    for (const s of this.sourceSubs) s.dispose();
    this.sourceSubs = [];
    // Disposing a runner source unsubscribes; the session keeps running.
    this.source?.dispose();
    this.source = undefined;
  }

  private swapSource(session: AgentSession): void {
    this.disposeSource();
    const live = this.binding?.kind === 'live' ? this.binding.handle : this.sessions.get(session.sessionId);
    const source: ConversationSource = live
      ? new LiveSessionSource(live)
      : session.provider === 'codex'
      ? new CodexTranscriptSource(session, this.codexProvider)
      : // Through the application action, not straight at the provider: the
        // dashboard row, this card and the palette are three renderings of one
        // interaction, and they should all answer it the same way and get the
        // same stale-prompt guard.
        new TranscriptSource(session, this.provider, (requestId, behavior) =>
          this.actions
            .decidePermission(session.key, behavior, { expectedRequestId: requestId })
            .then((outcome) => outcome === 'applied'),
        );
    this.source = source;
    // `/clear` replaces the conversation in the same process: a new id, no blocks.
    if (live) this.sourceSubs.push(live.onReset(() => {
      this.binding = { kind: 'live', handle: live };
      this.session = liveSessionRow(live, this.store);
      this.boundKeys.add(this.session.key);
      if (this.ready) void this.sendInit();
    }));
    this.sourceSubs.push(
      source.onAppend((blocks) => this.post({ type: 'append', blocks })),
      source.onPatch((patch) => this.post({ type: 'patch', id: patch.id, block: patch.block })),
    );
    if (source.onComposer) {
      this.sourceSubs.push(source.onComposer((composer) => this.post({ type: 'composer', composer })));
    }
  }

  private async sendInit(): Promise<void> {
    const session = this.session;
    const source = this.source;
    if (!session || !source) return;
    const init = await source.init();
    if (this.source !== source) return; // swapped while we read
    this.post({
      type: 'init',
      session,
      blocks: init.blocks,
      truncated: init.truncated,
      caps: await this.caps(session),
      composer: source.composer,
      task: this.taskView(),
    });
  }

  private onStoreUpdate(): void {
    if (this.pendingKey !== undefined) {
      const waiting = this.store.get(this.pendingKey);
      if (!waiting) return; // still not scanned, or gone for good
      const key = this.pendingKey;
      this.pendingKey = undefined;
      this.bind({ kind: 'store', key }, waiting);
      return;
    }
    const binding = this.binding;
    if (!binding) return;

    let next: AgentSession | undefined;
    if (binding.kind === 'store') {
      next = this.store.get(binding.key);
    } else {
      // A live session's real store entry appears once it has an id and a
      // transcript; until then the row built from the handle carries the pane.
      const row = liveSessionRow(binding.handle, this.store);
      next = this.store.get(row.key) ?? row;
    }
    if (!next) return; // aged out of the store; keep showing what we have

    // Compare what is actually shown: a rename changes the nickname, not the
    // title, so comparing titles would leave the tab on the old name.
    const titleChanged = this.session === undefined || displayTitle(next) !== displayTitle(this.session);
    this.session = next;
    this.boundKeys.add(next.key);

    // Adopting a session the pane is already showing swaps what feeds it: the
    // transcript it was reading becomes a live process we drive. Re-init so the
    // composer appears without the user having to reopen anything. (And the
    // reverse, when a session is released back to a terminal.)
    const shouldBeRunner = this.sessions.get(next.sessionId)?.provider === next.provider;
    const isRunner = this.source?.kind === 'runner';
    if (shouldBeRunner !== isRunner) {
      this.swapSource(next);
      if (titleChanged) this.onTitle(displayTitle(next));
      if (this.ready) void this.sendInit();
      return;
    }

    this.source?.setSession(next);
    if (titleChanged) this.onTitle(displayTitle(next));
    void this.pushSession(next);
  }

  private async pushSession(session: AgentSession): Promise<void> {
    const seq = ++this.capsSeq;
    const caps = await this.caps(session);
    if (seq !== this.capsSeq) return;
    this.post({ type: 'session', session, caps });
  }

  private async caps(session: AgentSession): Promise<ConversationCapabilities> {
    const source = this.source;
    const live = source instanceof LiveSessionSource ? source.handle : undefined;
    const runner = live?.provider === 'claude' ? live : undefined;
    const codexRunner = live?.provider === 'codex' ? live : undefined;
    const controlled = live !== undefined;
    const adoptOnSend = !runner && session.provider === 'claude' && !!session.cwd;
    const canSend = (live ? live.canSend : false) || adoptOnSend;

    const adopt = session.provider === 'claude' ? adoptActionFor(session, runner !== undefined) : undefined;
    const canAdoptCodex =
      session.provider === 'codex' &&
      // A thread shown read-only because another app holds it can be taken over again.
      (!codexRunner || !!codexRunner.readOnlyReason) &&
      !!session.cwd &&
      (session.status === 'waiting' || session.status === 'done');
    return {
      canSend,
      adoptOnSend,
      sendHint: adoptOnSend ? (session.statusIsEstimated ? 'Send asks you to confirm taking over this session.' : ['busy', 'stuck', 'blocked'].includes(session.status) ? 'Send queues this message until the session is idle, then takes over here.' : 'Send resumes this session here and ends its previous process.') : undefined,
      canInterrupt: canSend && (source?.composer?.busy ?? false),
      canAdopt: adopt === 'adopt' || canAdoptCodex,
      canResumeHere: adopt === 'resume-here',
      canRelease: controlled,
      estimated: !controlled && session.statusIsEstimated === true,
      readOnlyReason: canSend ? undefined : (live?.readOnlyReason ?? readOnlyReason(session, runner, canAdoptCodex)),
    };
  }

  private transcriptFile(): string | undefined {
    const s = this.session;
    if (s?.provider !== 'claude') return undefined;
    return s?.transcriptPath ?? (s?.cwd && s.sessionId ? transcriptPathFor(s.sessionId, s.cwd) : undefined);
  }

  private async onMessage(m: ConversationToHost): Promise<void> {
    const key = this.session?.key;
    const source = this.source;
    switch (m.type) {
      case 'ready':
        // A webview that says ready again has reloaded and forgotten it was
        // recording; nothing on screen could stop the microphone now.
        this.cancelDictation();
        this.ready = true;
        await this.sendInit();
        return;
      case 'cancelSend':
        this.pendingSend?.abort();
        return;
      case 'send': {
        // The guard exists so a draft typed for one conversation is never
        // delivered to another. It must not fire when the *same* conversation
        // has merely changed key underneath the pane — a runner's id goes from
        // `pending` to real, and Claude Code issues a new one on resume and
        // after a compaction — so every key this binding has worn counts as
        // this conversation. `bind` (a real switch) is what forgets them.
        if (m.sessionKey && m.sessionKey !== key && !this.boundKeys.has(m.sessionKey)) { this.post({ type: 'sendResult', requestId: m.requestId ?? '', error: 'Conversation changed; your draft was not sent.' }); return; }
        if (this.pendingSend) { this.post({ type: 'sendResult', requestId: m.requestId ?? '', error: 'Another send is pending.' }); return; }
        const controller = new AbortController();
        this.pendingSend = controller;
        try {
          if (source?.send) await source.send(m.text, m.images);
          else if (key) await this.actions.adoptAndSend(key, m.text, m.images, controller.signal);
          else throw new Error('No conversation selected.');
          this.post({ type: 'sendResult', requestId: m.requestId ?? '', adopted: source?.kind === 'transcript' });
        } catch (error) {
          this.post({ type: 'sendResult', requestId: m.requestId ?? '', error: error instanceof Error ? error.message : String(error) });
        } finally { this.pendingSend = undefined; }
        return;
      }
      case 'interrupt':
        await source?.interrupt?.();
        return;
      case 'decide': {
        const sent = await source?.decide?.(m.requestId, m.decision, m.message);
        if (sent === false) this.tooLate();
        return;
      }
      case 'answer': {
        const sent = await source?.answer?.(m.requestId, m.answers);
        if (sent === false) this.tooLate();
        return;
      }
      case 'plan': {
        const sent = await source?.decidePlan?.(m.requestId, m.decision === 'approve', m.feedback);
        if (sent === false) this.tooLate();
        return;
      }
      case 'setPermissionMode':
        await source?.setPermissionMode?.(m.mode);
        return;
      case 'setModel':
        await source?.setModel?.(m.model);
        return;
      case 'setEffort':
        await source?.setEffort?.(m.effort);
        return;
      case 'release':
        if (key) this.actions.release(key);
        return;
      case 'openInTab':
        if (key) this.actions.openInTab(key);
        return;
      case 'installHooks':
        this.actions.installHooks();
        return;
      case 'adopt':
      case 'resumeHere':
        // One action: adopting an idle session ends its process first, and an
        // ended one has nothing to end. `adopt` decides which it is.
        if (key) this.actions.adopt(key);
        return;
      case 'requestBlockText': {
        // Always answered, even with nothing: the pane has a button waiting on
        // this, and a silence would leave it saying "Loading…" for good.
        let text = source?.fullBlockText?.(m.id) ?? this.archiveText.get(m.id);
        const file = this.subagentFiles.get(m.id) ?? this.transcriptFile();
        try { if (text === undefined && m.toolUseId && file) text = (await archivedTool(file, m.toolUseId)).text; } catch { /* unavailable */ }
        if (this.source === source) this.post({ type: 'blockText', id: m.id, text });
        return;
      }
      case 'archive': {
        try {
          const file = this.transcriptFile();
          if (!file) throw new Error('No transcript is available yet.');
          const page = await archivePage(file, m.before, m.query?.slice(0, 300), false, m.beforeTime);
          if (this.source !== source) return;
          for (const [id, text] of page.overflow) rememberFullText(this.archiveText, id, text);
          this.post({ type: 'archive', requestId: m.requestId, blocks: page.blocks, more: page.more, query: m.query ?? '' });
        } catch (e) {
          if (this.source === source) this.post({ type: 'archive', requestId: m.requestId, blocks: [], more: false, query: m.query ?? '', error: String(e) });
        }
        return;
      }
      case 'subagent': {
        try {
          const file = this.transcriptFile();
          if (!file) throw new Error('No transcript is available yet.');
          const tool = await archivedTool(file, m.toolUseId);
          if (!tool.agentId) throw new Error('Subagent transcript is not linked yet. Try again after its result arrives.');
          const childFile = subagentPath(file, tool.agentId);
          const page = await archivePage(childFile, m.before, '', true);
          if (this.source !== source) return;
          for (const block of page.blocks) this.subagentFiles.set(block.id, childFile);
          for (const [id, text] of page.overflow) rememberFullText(this.archiveText, id, text);
          this.post({ type: 'subagent', id: m.id, blocks: page.blocks, more: page.more });
        } catch (e) {
          if (this.source === source) this.post({ type: 'subagent', id: m.id, blocks: [], more: false, error: String(e) });
        }
        return;
      }
      case 'dictate':
        await this.dictate(m.action);
        return;
      case 'openDiff':
        // No diff editor here means the card's own +/- block is all there is.
        // Saying so is better than a button that swallows the click.
        // No separate diff view yet. The card already renders the whole patch,
        // so this is a missing convenience rather than missing information.
        this.ui.dialogs.flash('Agent Wrangler: the card below shows the whole patch; a side-by-side view is not built yet.', 4000);
        return;
      case 'fileSuggest': {
        const cwd = this.session?.cwd;
        if (!cwd) return;
        const files = await this.files.suggest(cwd, m.query);
        // Discard if the pane moved on to another session while we listed.
        if (this.session?.cwd === cwd) this.post({ type: 'fileSuggestions', query: m.query, files });
        return;
      }
      case 'dropPaths':
        await this.dropPaths(m.paths);
        return;
      case 'openExternal':
        this.actions.openExternal(m.url);
        return;
      case 'openFile':
        this.actions.openFile(m.path);
        return;
      case 'taskAction':
        await this.runTaskAction(m.missionId, m.action);
        return;
      case 'openAttempt':
        // The same path a row click takes, so an attempt opens here rather
        // than anywhere else — a task's history must never cost a window.
        this.show(m.sessionKey);
        return;
    }
  }

  /**
   * A button on the task strip.
   *
   * Failures are shown rather than swallowed: these are the actions that end a
   * session or throw a worktree away, and "nothing happened" is the one
   * response that leaves the user unable to tell whether it worked. The strip
   * is re-pushed either way, because a refused action still proves what the
   * task's state actually is.
   */
  private async runTaskAction(missionId: string, action: TaskViewAction): Promise<void> {
    if (!this.tasks) return;
    try {
      await this.tasks.run(missionId, action);
    } catch (error) {
      this.ui.dialogs.error(`Agent Wrangler: ${(error as Error).message ?? String(error)}`);
    }
    this.pushTask();
  }

  /**
   * Files dropped on the composer, resolved into what the message will carry.
   *
   * An image is attached as an image — the same thing a paste does, and the
   * only way to send one the model can look at without a tool call. Everything
   * else is referred to by path, which is what dropping a file into the TUI
   * writes, and is the cheaper half of the bargain: Claude reads the ones it
   * actually needs rather than the whole of a dropped folder arriving in the
   * prompt.
   */
  private async dropPaths(paths: string[]): Promise<void> {
    const cwd = this.session?.cwd ?? '';
    const mentions: string[] = [];
    const images: ImageAttachment[] = [];
    const notes: string[] = [];

    const wanted = [...new Set(paths.filter((p) => p !== ''))];
    if (wanted.length > MAX_DROPPED_PATHS) {
      notes.push(`Only the first ${MAX_DROPPED_PATHS} of ${wanted.length} dropped files were taken.`);
      wanted.length = MAX_DROPPED_PATHS;
    }

    for (const file of wanted) {
      const name = path.basename(file);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(file);
      } catch {
        notes.push(`Could not read ${name}.`);
        continue;
      }
      const media = stat.isFile() ? imageMediaType(file) : undefined;
      if (media === undefined) {
        mentions.push(mentionForPath(cwd, file));
        continue;
      }
      // Too big to attach is not too big to talk about: the path still goes in,
      // and Claude's own Read opens it from disk if it needs to.
      if (stat.size > MAX_IMAGE_BYTES) {
        notes.push(`${name} is over ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB — sent as a path, not an image.`);
        mentions.push(mentionForPath(cwd, file));
        continue;
      }
      try {
        images.push({ mediaType: media, data: (await fs.readFile(file)).toString('base64') });
      } catch {
        notes.push(`Could not read ${name}.`);
      }
    }

    if (mentions.length === 0 && images.length === 0 && notes.length === 0) return;
    this.post({ type: 'dropped', mentions, images, notes });
  }

  private tooLate(): void {
    this.ui.dialogs.flash('Agent Wrangler: that prompt has already been answered.', 4000);
  }

  /**
   * Drive the microphone. Every path ends by telling the webview what state it
   * is in, because the button cannot un-stick itself: it went red on a click
   * and only a message from here turns it back.
   *
   * The recorder is shared by every pane, so each host only stops or cancels a
   * recording it started itself — Escape in one pane must not throw away what
   * is being dictated into another.
   */
  private async dictate(action: 'start' | 'stop' | 'cancel'): Promise<void> {
    if (action === 'cancel') {
      this.cancelDictation();
      this.post({ type: 'dictation', state: 'idle' });
      return;
    }

    if (action === 'start') {
      try {
        const began = this.dictation.start({
          preview: (p) => {
            if (this.ownsDictation) this.post({ type: 'dictationPreview', ...p });
          },
          ended: (reason) => {
            if (!this.ownsDictation) return;
            if (reason.kind === 'limit') {
              void this.finishDictation('Recording reached its five-minute limit and stopped.');
              return;
            }
            this.ownsDictation = false;
            this.post({ type: 'dictation', state: 'idle', message: reason.message });
          },
        });
        this.ownsDictation = began;
        this.post(
          began
            ? { type: 'dictation', state: 'recording', livePreview: this.dictation.previewing }
            : { type: 'dictation', state: 'idle', message: 'Already recording in another conversation.' },
        );
      } catch (e) {
        this.post({ type: 'dictation', state: 'idle', message: 'Dictation is not set up.' });
        if (e instanceof DictationSetupError) await this.ui.offerDictationSetup(e);
        else this.ui.dialogs.error(`Agent Wrangler: dictation failed — ${(e as Error).message}`);
      }
      return;
    }

    if (!this.ownsDictation) {
      // A stop racing a start that failed, or a pane reloaded mid-recording.
      this.post({ type: 'dictation', state: 'idle' });
      return;
    }
    await this.finishDictation();
  }

  /** Close the microphone and hand the webview the final text. Never sends it. */
  private async finishDictation(notice?: string): Promise<void> {
    // The limit and a click can arrive together; only one of them finishes.
    if (this.dictation.current !== 'recording') return;
    this.post({ type: 'dictation', state: 'transcribing' });
    try {
      const text = await this.dictation.stop();
      this.post({ type: 'dictation', state: 'idle', text, notice });
    } catch (e) {
      this.post({ type: 'dictation', state: 'idle', message: `Could not transcribe: ${(e as Error).message}` });
    } finally {
      this.ownsDictation = false;
    }
  }

  /** Throw away a recording this pane started, if there is one. Harmless otherwise. */
  private cancelDictation(): void {
    if (!this.ownsDictation) return;
    this.ownsDictation = false;
    this.dictation.cancel();
  }
}

/**
 * The row for a live session the store has not registered yet. A Claude
 * runner has no transcript until the first prompt, and the dashboard hides
 * sessions that have none. The nickname is looked up rather than read off a
 * store entry for the same reason: there is no entry to read it from, and a
 * renamed session being adopted here should not briefly go back to its old name.
 * A handle that can describe itself (Codex) does.
 */
function liveSessionRow(handle: SessionHandle, store: SessionStore): AgentSession {
  if (handle.liveSession) return handle.liveSession;
  const id = handle.sessionId ?? 'pending';
  const key = `${handle.provider}:${id.toLowerCase()}`;
  const status: SessionStatus =
    handle.lifecycle === 'running'
      ? 'busy'
      : handle.lifecycle === 'ended' || handle.lifecycle === 'ending'
        ? 'ended'
        : handle.lifecycle === 'error' || handle.lifecycle === 'unreachable'
          ? 'stuck'
          : 'waiting';
  return {
    provider: handle.provider,
    sessionId: id,
    key,
    title: path.basename(handle.cwd) || 'New conversation',
    nickname: store.nicknameOf(key),
    cwd: handle.cwd,
    projectName: projectNameFor(handle.cwd),
    status,
    lastActivityAt: Date.now(),
    startedAt: handle.startedAt,
  };
}

/**
 * One sentence saying why the composer is disabled, or nothing when the reason
 * is already on screen.
 *
 * An ended session says so twice over — the header pill reads "Ended" and the
 * button next to this note reads "Resume here" — so spelling it out a third
 * time is just noise on the state the pane sits in most often. An error is
 * different: nothing else reports it, so it keeps its sentence.
 */
function readOnlyReason(
  session: AgentSession,
  runner: SessionHandle | undefined,
  canAdoptCodex = false,
): string | undefined {
  if (runner) {
    if (runner.lifecycle === 'error') return 'This session stopped with an error.';
    // A hosted session keeps running while the link is down; only typing waits.
    if (runner.lifecycle === 'connecting') return 'Reconnecting to the background process running this session…';
    if (runner.lifecycle === 'unreachable') {
      return 'The background process running this session is not responding. Close the session to stop it; the conversation is kept and can be resumed.';
    }
    return undefined;
  }
  if (canAdoptCodex) return 'Take over this Codex conversation to type here.';
  if (session.status === 'ended') return undefined;
  return 'This session is not currently available for typing here.';
}
