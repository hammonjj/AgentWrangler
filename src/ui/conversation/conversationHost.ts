/**
 * The conversation pane's behaviour, independent of which webview shell holds
 * it. Owns one session's source, keeps the webview in step with the store, and
 * turns the webview's messages into source calls or extension actions.
 *
 * The shell (a reusable panel, or a pinned one) owns only a lifetime — the same
 * split the dashboard uses between `DashboardHost` and its two shells.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RunnerService } from '../../claude/runner/runnerService';
import type { RunnerSession } from '../../claude/runner/runnerSession';
import type { AgentProvider } from '../../core/provider';
import type { SessionStore } from '../../core/sessionStore';
import type { ConversationCapabilities } from '../../shared/conversation';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import type { AgentSession, SessionStatus } from '../../shared/model';
import type { SessionActions } from '../actions';
import { buildWebviewHtml } from '../html';
import { adoptActionFor, SECONDARY_LABEL, secondaryActionFor, type SecondaryAction } from '../openTarget';
import type { SessionLocator } from '../sessionLocator';
import { isInThisWorkspace } from '../workspace';
import { RunnerSource } from './runnerSource';
import type { ConversationSource } from './source';
import { TranscriptSource } from './transcriptSource';

/** Where the pane's secondary button sends you, for the webview's label. */
const SECONDARY_TARGET: Record<SecondaryAction, NonNullable<ConversationCapabilities['goTo']>['target']> = {
  'reveal-panel': 'panel',
  'show-terminal': 'terminal',
  'focus-window': 'window',
  'resume-terminal': 'resume',
};

/** Provider surface the pane needs: transcript growth, and answering a permission prompt. */
export interface ConversationProvider extends AgentProvider {
  decidePermission(sessionId: string, behavior: 'allow' | 'deny' | 'always'): Promise<boolean>;
}

/**
 * What the pane is showing: a session the store knows about, or a runner we
 * just started, whose id and store entry do not exist yet.
 */
type Binding = { kind: 'store'; key: string } | { kind: 'runner'; runner: RunnerSession };

export class ConversationHost {
  private subs: { dispose(): void }[] = [];
  private source?: ConversationSource;
  private sourceSubs: { dispose(): void }[] = [];
  private binding?: Binding;
  /** A key asked for before the store knew it; bound on the next update. */
  private pendingKey?: string;
  private session?: AgentSession;
  private ready = false;
  /** Only the newest capability computation may land; the locator read is async. */
  private capsSeq = 0;

  constructor(
    private webview: vscode.Webview,
    extensionUri: vscode.Uri,
    private store: SessionStore,
    private provider: ConversationProvider,
    private runners: RunnerService,
    private actions: SessionActions,
    private locator: SessionLocator,
    private onTitle: (title: string) => void,
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    webview.html = buildWebviewHtml({
      webview,
      extensionUri,
      bundleName: 'conversation',
      title: 'Conversation',
    });

    this.subs.push(
      webview.onDidReceiveMessage((m: ConversationToHost) => void this.onMessage(m)),
      this.store.onDidUpdate(() => this.onStoreUpdate()),
      // A runner's id arriving, or its lifecycle changing, changes what the
      // pane can offer even when the store has not moved.
      this.runners.onDidChange(() => this.onStoreUpdate()),
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
    this.bind({ kind: 'runner', runner }, syntheticSession(runner));
  }

  dispose(): void {
    this.disposeSource();
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  // ---- internals ----

  private bind(binding: Binding, session: AgentSession): void {
    this.binding = binding;
    this.session = session;
    this.onTitle(session.title);
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
    const runner =
      this.binding?.kind === 'runner' ? this.binding.runner : this.runners.get(session.sessionId);
    const source: ConversationSource = runner
      ? new RunnerSource(runner)
      : new TranscriptSource(session, this.provider, (id, behavior) =>
          this.provider.decidePermission(id, behavior),
        );
    this.source = source;
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
    } else {
      // A runner's real store entry appears once it has an id and a transcript;
      // until then the synthetic one carries the pane.
      next =
        this.store.get(`claude:${(binding.runner.sessionId ?? '').toLowerCase()}`) ??
        syntheticSession(binding.runner);
    }
    if (!next) return; // aged out of the store; keep showing what we have

    const titleChanged = next.title !== this.session?.title;
    this.session = next;

    // Adopting a session the pane is already showing swaps what feeds it: the
    // transcript it was reading becomes a live process we drive. Re-init so the
    // composer appears without the user having to reopen anything. (And the
    // reverse, when a session is released back to a terminal.)
    const shouldBeRunner = this.runners.owns(next.sessionId);
    const isRunner = this.source instanceof RunnerSource;
    if (shouldBeRunner !== isRunner) {
      this.swapSource(next);
      if (titleChanged) this.onTitle(next.title);
      if (this.ready) void this.sendInit();
      return;
    }

    this.source?.setSession(next);
    if (titleChanged) this.onTitle(next.title);
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
    const canSend = runner !== undefined && runner.canSend;

    // A runner session's process is a child of this extension host, so the
    // locator would call it "a Claude Code panel in this window". It is not:
    // this pane is the only place it exists.
    const action = runner
      ? undefined
      : secondaryActionFor(session, (await this.locator.locate(session.pid)).kind, isInThisWorkspace(session.cwd));

    const adopt = adoptActionFor(session, runner !== undefined);
    return {
      canSend,
      canInterrupt: canSend && (runner?.composer.busy ?? false),
      canAdopt: adopt === 'adopt',
      canResumeHere: adopt === 'resume-here',
      canRelease: runner !== undefined,
      goTo: action ? { label: SECONDARY_LABEL[action], target: SECONDARY_TARGET[action] } : undefined,
      estimated: runner === undefined && session.statusIsEstimated === true,
      readOnlyReason: canSend ? undefined : readOnlyReason(session, runner, action),
    };
  }

  private async onMessage(m: ConversationToHost): Promise<void> {
    const key = this.session?.key;
    const source = this.source;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        return;
      case 'send':
        await source?.send?.(m.text);
        return;
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
      case 'goTo':
        if (key) this.actions.goTo(key);
        return;
      case 'pin':
        if (key) this.actions.pin(key);
        return;
      case 'adopt':
      case 'resumeHere':
        // One action: adopting an idle session ends its process first, and an
        // ended one has nothing to end. `adopt` decides which it is.
        if (key) this.actions.adopt(key);
        return;
      case 'requestToolResult': {
        const text = source?.fullToolResult?.(m.id);
        if (text !== undefined) this.post({ type: 'toolResult', id: m.id, text });
        return;
      }
      case 'openExternal':
        this.actions.openExternal(m.url);
        return;
      case 'openFile':
        this.actions.openFile(m.path);
        return;
    }
  }

  private tooLate(): void {
    vscode.window.setStatusBarMessage('Agent Wrangler: that prompt has already been answered.', 4000);
  }
}

/** A session that exists only as a runner so far: started here, no id yet. */
function syntheticSession(runner: RunnerSession): AgentSession {
  const id = runner.sessionId ?? 'pending';
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
    key: `claude:${id.toLowerCase()}`,
    title: path.basename(runner.cwd) || 'New conversation',
    cwd: runner.cwd,
    projectName: path.basename(runner.cwd),
    status,
    lastActivityAt: Date.now(),
    startedAt: runner.startedAt,
  };
}

/** One sentence saying why the composer is disabled. */
function readOnlyReason(
  session: AgentSession,
  runner: RunnerSession | undefined,
  action: SecondaryAction | undefined,
): string {
  if (runner) {
    return runner.lifecycle === 'error'
      ? 'This session stopped with an error.'
      : 'This session has ended.';
  }
  if (session.status === 'ended') return 'This session has ended.';
  const where =
    action === 'reveal-panel'
      ? 'a Claude Code panel in this window'
      : action === 'show-terminal'
        ? 'a terminal in this window'
        : action === 'focus-window'
          ? 'another VSCode window'
          : 'outside this VSCode window';
  // Say why Take over is missing rather than leaving its absence a mystery.
  const busy =
    session.status === 'waiting' || session.status === 'done'
      ? ''
      : ' Taking it over here has to wait for the turn in flight to finish.';
  return `This session runs in ${where}.${busy}`;
}
