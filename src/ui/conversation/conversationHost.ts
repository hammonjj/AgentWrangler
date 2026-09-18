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
import * as vscode from 'vscode';
import type { RunnerService } from '../../claude/runner/runnerService';
import type { RunnerSession } from '../../claude/runner/runnerSession';
import type { CodexRunner, CodexRunnerService } from '../../codex/runner';
import { DictationSetupError, type DictationService } from '../../core/dictation';
import type { FileSuggestService } from '../../core/fileSuggest';
import type { AgentProvider } from '../../core/provider';
import type { SessionStore } from '../../core/sessionStore';
import { imageMediaType, mentionForPath } from '../../shared/attachments';
import type { ConversationCapabilities, ImageAttachment } from '../../shared/conversation';
import { MAX_IMAGE_BYTES, rememberFullText } from '../../shared/conversation';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import { displayTitle, type AgentSession, type SessionStatus } from '../../shared/model';
import type { SessionActions } from '../actions';
import type { PaneChannel } from '../paneChannel';
import { offerDictationSetup } from '../dictationSetup';
import { adoptActionFor } from '../openTarget';
import { DiffContentProvider } from './diffView';
import { RunnerSource } from './runnerSource';
import { CodexTranscriptSource } from './codexTranscriptSource';
import type { ConversationSource } from './source';
import { TranscriptSource } from './transcriptSource';

/**
 * Ceiling on one drop. A dragged selection is a handful of files; a number
 * beyond this is a folder's worth landing in the box by accident.
 */
const MAX_DROPPED_PATHS = 20;

/** Provider surface the pane needs: transcript growth, and answering a permission prompt. */
export interface ConversationProvider extends AgentProvider {
  decidePermission(sessionId: string, behavior: 'allow' | 'deny' | 'always'): Promise<boolean>;
}

/**
 * What the pane is showing: a session the store knows about, or a runner we
 * just started, whose id and store entry do not exist yet.
 */
type Binding = { kind: 'store'; key: string } | { kind: 'runner'; runner: RunnerSession } | { kind: 'codex-runner'; runner: CodexRunner };

export class ConversationHost {
  private subs: { dispose(): void }[] = [];
  private source?: ConversationSource;
  private sourceSubs: { dispose(): void }[] = [];
  private binding?: Binding;
  /** A key asked for before the store knew it; bound on the next update. */
  private pendingKey?: string;
  private session?: AgentSession;
  private ready = false;
  private pendingSend?: AbortController;
  private archiveText = new Map<string, string>();
  private subagentFiles = new Map<string, string>();
  /** Capability computation is async and can overlap; only the newest may land. */
  private capsSeq = 0;

  constructor(
    private webview: PaneChannel,
    private store: SessionStore,
    private provider: ConversationProvider,
    private codexProvider: AgentProvider,
    private runners: RunnerService,
    private codexRunners: CodexRunnerService,
    private actions: SessionActions,
    private dictation: DictationService,
    private diffs: DiffContentProvider,
    private files: FileSuggestService,
    private onTitle: (title: string) => void,
  ) {
    this.subs.push(
      webview.onDidReceiveMessage((m: ConversationToHost) => void this.onMessage(m)),
      this.store.onDidUpdate(() => this.onStoreUpdate()),
      // A runner's id arriving, or its lifecycle changing, changes what the
      // pane can offer even when the store has not moved.
      this.runners.onDidChange(() => this.onStoreUpdate()),
      this.codexRunners.onDidChange(() => this.onStoreUpdate()),
    );
  }

  get sessionKey(): string | undefined {
    return this.session?.key;
  }

  /**
   * Point the pane at a session.
   *
   * The session may not be in the store yet: VSCode restores panels during
   * activation, before the provider's first scan has run. So an unknown key is
   * remembered and bound as soon as it appears, rather than dropped — which is
   * what made a restored pane come back blank.
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

  /** Point the pane at a session we have just started, before it has an id. */
  showRunner(runner: RunnerSession): void {
    if (this.binding?.kind === 'runner' && this.binding.runner === runner) return;
    this.bind({ kind: 'runner', runner }, syntheticSession(runner, this.store));
  }

  showCodexRunner(runner: CodexRunner): void {
    this.bind({ kind: 'codex-runner', runner }, runner.session);
  }

  dispose(): void {
    this.pendingSend?.abort();
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
    this.onTitle(displayTitle(session));
    this.swapSource(session);
    const runner = this.source instanceof RunnerSource ? this.source.runner : undefined;
    if (runner) this.runners.touch(runner);
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
    const runner = this.binding?.kind === 'runner' ? this.binding.runner : this.runners.get(session.sessionId);
    const codexRunner = this.binding?.kind === 'codex-runner' ? this.binding.runner : this.codexRunners.get(session.sessionId);
    const source: ConversationSource = codexRunner
      ? codexRunner
      : session.provider === 'codex'
      ? new CodexTranscriptSource(session, this.codexProvider)
      : runner
      ? new RunnerSource(runner)
      : new TranscriptSource(session, this.provider, (id, behavior) =>
          this.provider.decidePermission(id, behavior),
        );
    this.source = source;
    if (runner) this.sourceSubs.push(runner.onReset(() => {
      this.binding = { kind: 'runner', runner };
      this.session = syntheticSession(runner, this.store);
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
    } else if (binding.kind === 'runner') {
      // A runner's real store entry appears once it has an id and a transcript;
      // until then the synthetic one carries the pane.
      next =
        this.store.get(`claude:${(binding.runner.sessionId ?? '').toLowerCase()}`) ??
        syntheticSession(binding.runner, this.store);
    } else {
      next = this.store.get(binding.runner.session.key) ?? binding.runner.session;
    }
    if (!next) return; // aged out of the store; keep showing what we have

    // Compare what is actually shown: a rename changes the nickname, not the
    // title, so comparing titles would leave the tab on the old name.
    const titleChanged = this.session === undefined || displayTitle(next) !== displayTitle(this.session);
    this.session = next;

    // Adopting a session the pane is already showing swaps what feeds it: the
    // transcript it was reading becomes a live process we drive. Re-init so the
    // composer appears without the user having to reopen anything. (And the
    // reverse, when a session is released back to a terminal.)
    const shouldBeRunner = next.provider === 'codex' ? this.codexRunners.owns(next.sessionId) : this.runners.owns(next.sessionId);
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
    const runner = source instanceof RunnerSource ? source.runner : undefined;
    const adoptOnSend = !runner && session.provider === 'claude' && !!session.cwd;
    const canSend = (runner ? runner.canSend : source?.kind === 'runner' && source.send !== undefined) || adoptOnSend;

    const adopt = session.provider === 'claude' ? adoptActionFor(session, runner !== undefined) : undefined;
    return {
      canSend,
      adoptOnSend,
      sendHint: adoptOnSend ? (session.statusIsEstimated ? 'Send asks you to confirm taking over this session.' : ['busy', 'stuck', 'blocked'].includes(session.status) ? 'Send queues this message until the session is idle, then takes over here.' : 'Send resumes this session here and ends its previous process.') : undefined,
      canInterrupt: canSend && (source?.composer?.busy ?? false),
      canAdopt: adopt === 'adopt',
      canResumeHere: adopt === 'resume-here',
      canRelease: runner !== undefined,
      estimated: runner === undefined && session.statusIsEstimated === true,
      readOnlyReason: canSend ? undefined : readOnlyReason(session, runner),
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
        this.ready = true;
        await this.sendInit();
        return;
      case 'cancelSend':
        this.pendingSend?.abort();
        return;
      case 'send': {
        if (m.sessionKey && m.sessionKey !== key) { this.post({ type: 'sendResult', requestId: m.requestId ?? '', error: 'Conversation changed; your draft was not sent.' }); return; }
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
      case 'release':
        if (key) this.actions.release(key);
        return;
      case 'openInTab':
        if (key) this.actions.openInTab(key);
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
        await this.diffs.open(m.file, m.patch);
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
    }
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
    vscode.window.setStatusBarMessage('Agent Wrangler: that prompt has already been answered.', 4000);
  }

  /**
   * Drive the microphone. Every path ends by telling the webview what state it
   * is in, because the button cannot un-stick itself: it went red on a click
   * and only a message from here turns it back.
   */
  private async dictate(action: 'start' | 'stop' | 'cancel'): Promise<void> {
    if (action === 'cancel') {
      this.dictation.cancel();
      this.post({ type: 'dictation', state: 'idle' });
      return;
    }

    if (action === 'start') {
      try {
        const began = this.dictation.start();
        this.post(
          began
            ? { type: 'dictation', state: 'recording' }
            : { type: 'dictation', state: 'idle', message: 'Already recording in another conversation.' },
        );
      } catch (e) {
        this.post({ type: 'dictation', state: 'idle', message: 'Dictation is not set up.' });
        if (e instanceof DictationSetupError) await offerDictationSetup(e);
        else void vscode.window.showErrorMessage(`Agent Wrangler: dictation failed — ${(e as Error).message}`);
      }
      return;
    }

    this.post({ type: 'dictation', state: 'transcribing' });
    try {
      const text = await this.dictation.stop();
      this.post({ type: 'dictation', state: 'idle', text });
    } catch (e) {
      this.post({ type: 'dictation', state: 'idle', message: 'Could not transcribe.' });
      void vscode.window.showErrorMessage(`Agent Wrangler: dictation failed — ${(e as Error).message}`);
    }
  }
}

/** A session that exists only as a runner so far: started here, no id yet. */
/**
 * A session for a runner the store has not registered yet — it has no
 * transcript until the first prompt, and the dashboard hides sessions that have
 * none. The nickname is looked up rather than read off a store entry for the
 * same reason: there is no entry to read it from, and a renamed session being
 * adopted here should not briefly go back to its old name.
 */
function syntheticSession(runner: RunnerSession, store: SessionStore): AgentSession {
  const id = runner.sessionId ?? 'pending';
  const key = `claude:${id.toLowerCase()}`;
  const status: SessionStatus =
    runner.lifecycle === 'running'
      ? 'busy'
      : runner.lifecycle === 'ended' || runner.lifecycle === 'ending'
        ? 'ended'
        : runner.lifecycle === 'error'
          ? 'stuck'
          : 'waiting';
  return {
    provider: 'claude',
    sessionId: id,
    key,
    title: path.basename(runner.cwd) || 'New conversation',
    nickname: store.nicknameOf(key),
    cwd: runner.cwd,
    projectName: path.basename(runner.cwd),
    status,
    lastActivityAt: Date.now(),
    startedAt: runner.startedAt,
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
  runner: RunnerSession | undefined,
): string | undefined {
  if (runner) {
    return runner.lifecycle === 'error' ? 'This session stopped with an error.' : undefined;
  }
  if (session.status === 'ended') return undefined;
  return 'This session is not currently available for typing here.';
}
