/**
 * The conversation pane's behaviour, independent of which webview shell holds
 * it. Owns one session's source, keeps the webview in step with the store, and
 * turns the webview's messages into source calls or extension actions.
 *
 * The shell (a reusable panel, or a pinned one) owns only a lifetime — the same
 * split the dashboard uses between `DashboardHost` and its two shells.
 */
import * as vscode from 'vscode';
import type { AgentProvider } from '../../core/provider';
import type { SessionStore } from '../../core/sessionStore';
import type { ConversationCapabilities } from '../../shared/conversation';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import type { AgentSession } from '../../shared/model';
import type { SessionActions } from '../actions';
import { buildWebviewHtml } from '../html';
import { SECONDARY_LABEL, secondaryActionFor, type SecondaryAction } from '../openTarget';
import type { SessionLocator } from '../sessionLocator';
import { isInThisWorkspace } from '../workspace';
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
  decidePermission(sessionId: string, behavior: 'allow' | 'deny'): Promise<boolean>;
}

export class ConversationHost {
  private subs: { dispose(): void }[] = [];
  private source?: ConversationSource;
  private sourceSubs: { dispose(): void }[] = [];
  private session?: AgentSession;
  private ready = false;
  /** Only the newest capability computation may land; the locator read is async. */
  private capsSeq = 0;

  constructor(
    private webview: vscode.Webview,
    extensionUri: vscode.Uri,
    private store: SessionStore,
    private provider: ConversationProvider,
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
    );
  }

  get sessionKey(): string | undefined {
    return this.session?.key;
  }

  /** Point the pane at a session. Safe to call repeatedly with the same key. */
  show(key: string): void {
    if (this.session?.key === key) return;
    const session = this.store.get(key);
    if (!session) return;
    this.session = session;
    this.onTitle(session.title);
    this.swapSource(session);
    if (this.ready) void this.sendInit();
  }

  dispose(): void {
    this.disposeSource();
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  // ---- internals ----

  private post(msg: HostToConversation): void {
    void this.webview.postMessage(msg);
  }

  private disposeSource(): void {
    for (const s of this.sourceSubs) s.dispose();
    this.sourceSubs = [];
    this.source?.dispose();
    this.source = undefined;
  }

  private swapSource(session: AgentSession): void {
    this.disposeSource();
    // Phase 2 picks a runner source here when this extension owns the process.
    const source = new TranscriptSource(session, this.provider, (id, behavior) =>
      this.provider.decidePermission(id, behavior),
    );
    this.source = source;
    this.sourceSubs.push(
      source.onAppend((blocks) => this.post({ type: 'append', blocks })),
      source.onPatch((patch) => this.post({ type: 'patch', id: patch.id, block: patch.block })),
    );
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
    const key = this.session?.key;
    if (!key) return;
    const next = this.store.get(key);
    if (!next) {
      // Aged out of the store (ended and outside the window). Keep showing what
      // we have; the last status we sent stands.
      return;
    }
    const titleChanged = next.title !== this.session?.title;
    this.session = next;
    this.source?.setSession(next);
    if (titleChanged) this.onTitle(next.title);
    void this.pushSession(next);
  }

  private async pushSession(session: AgentSession): Promise<void> {
    const seq = ++this.capsSeq;
    const caps = await this.caps(session);
    if (seq !== this.capsSeq || this.session?.key !== session.key) return;
    this.post({ type: 'session', session, caps });
  }

  private async caps(session: AgentSession): Promise<ConversationCapabilities> {
    const loc = await this.locator.locate(session.pid);
    const action = secondaryActionFor(session, loc.kind, isInThisWorkspace(session.cwd));
    return {
      // Phase 2: true for sessions this extension drives.
      canSend: false,
      canInterrupt: false,
      canAdopt: false,
      canRelease: false,
      goTo: action ? { label: SECONDARY_LABEL[action], target: SECONDARY_TARGET[action] } : undefined,
      estimated: session.statusIsEstimated === true,
      readOnlyReason: readOnlyReason(session, action),
    };
  }

  private async onMessage(m: ConversationToHost): Promise<void> {
    const key = this.session?.key;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        return;
      case 'decide': {
        const sent = await this.source?.decide?.(m.requestId, m.decision, m.message);
        if (sent === false) {
          vscode.window.setStatusBarMessage(
            'Agent Wrangler: that prompt was already answered in Claude Code.',
            4000,
          );
        }
        return;
      }
      case 'goTo':
        if (key) this.actions.goTo(key);
        return;
      case 'pin':
        if (key) this.actions.pin(key);
        return;
      case 'resumeHere':
        // Phase 3 resumes into a runner here; until then, a terminal is the
        // honest way to continue an ended session.
        if (key) this.actions.resume(key);
        return;
      case 'requestToolResult': {
        const text = this.source?.fullToolResult?.(m.id);
        if (text !== undefined) this.post({ type: 'toolResult', id: m.id, text });
        return;
      }
      case 'openExternal':
        this.actions.openExternal(m.url);
        return;
      case 'openFile':
        this.actions.openFile(m.path);
        return;
      case 'send':
      case 'interrupt':
      case 'answer':
      case 'plan':
      case 'setPermissionMode':
      case 'setModel':
      case 'adopt':
      case 'release':
        // Phase 2 and 3. The webview does not offer these yet; ignore rather
        // than throw if an older bundle is still loaded in a restored panel.
        return;
    }
  }
}

/** One sentence saying why the composer is disabled. */
function readOnlyReason(session: AgentSession, action: SecondaryAction | undefined): string {
  if (session.status === 'ended') return 'This session has ended.';
  switch (action) {
    case 'reveal-panel':
      return 'This session runs in a Claude Code panel in this window.';
    case 'show-terminal':
      return 'This session runs in a terminal in this window.';
    case 'focus-window':
      return 'This session runs in another VSCode window.';
    default:
      return 'This session runs outside this VSCode window.';
  }
}
