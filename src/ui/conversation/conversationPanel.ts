/**
 * The conversation pane's shells.
 *
 * One **reusable** panel is the point of the feature: clicking rows in the
 * dashboard swaps what it shows without opening a tab per session and without
 * taking focus, so a sweep through five agents costs one tab and no attention.
 * **Pinned** panels are the escape hatch — a session you want to keep on screen
 * while you browse others gets one of its own, and it is never swapped.
 */
import * as vscode from 'vscode';
import type { RunnerService } from '../../claude/runner/runnerService';
import type { RunnerSession } from '../../claude/runner/runnerSession';
import type { SessionStore } from '../../core/sessionStore';
import type { SessionActions } from '../actions';
import type { SessionLocator } from '../sessionLocator';
import { ConversationHost, type ConversationProvider } from './conversationHost';

export const CONVERSATION_PANEL_TYPE = 'agentWrangler.conversation';
export const CONVERSATION_PINNED_TYPE = 'agentWrangler.conversationPinned';

/** What the webview stores so VSCode can restore the same session after a reload. */
interface PanelState {
  key?: string;
}

interface Shell {
  panel: vscode.WebviewPanel;
  host: ConversationHost;
}

export class ConversationPanelManager implements vscode.Disposable {
  private shared?: Shell;
  private pinned = new Map<string, Shell>();

  constructor(
    private extensionUri: vscode.Uri,
    private store: SessionStore,
    private provider: ConversationProvider,
    private runners: RunnerService,
    private actions: SessionActions,
    private locator: SessionLocator,
  ) {}

  /**
   * Show a session in the reusable pane, creating it if needed.
   *
   * `preserveFocus` is the default on purpose: a click in the dashboard should
   * update the pane beside it, not move the cursor into it.
   */
  show(key: string, opts?: { preserveFocus?: boolean }): void {
    const preserveFocus = opts?.preserveFocus ?? true;
    const pinnedShell = this.pinned.get(key);
    if (pinnedShell) {
      pinnedShell.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.ensureShared(preserveFocus).host.show(key);
  }

  /**
   * Show a session this window has just started, which has no id and no store
   * entry yet. Takes focus, unlike a row click: the user asked for this one and
   * will want to type into it.
   */
  showRunner(runner: RunnerSession, opts?: { preserveFocus?: boolean }): void {
    this.ensureShared(opts?.preserveFocus ?? false).host.showRunner(runner);
  }

  private ensureShared(preserveFocus: boolean): Shell {
    if (this.shared) {
      this.shared.panel.reveal(undefined, preserveFocus);
      return this.shared;
    }
    const beside = vscode.workspace
      .getConfiguration('agentWrangler')
      .get<boolean>('conversation.openBeside', true);
    this.shared = this.adoptShell(
      vscode.window.createWebviewPanel(
        CONVERSATION_PANEL_TYPE,
        'Conversation',
        { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus },
        { retainContextWhenHidden: true },
      ),
      undefined,
    );
    return this.shared;
  }

  /** Give this session a panel of its own, which `show` will never swap. */
  pin(key: string): void {
    const existing = this.pinned.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const session = this.store.get(key);
    if (!session) return;
    // Hand the reusable pane off to nothing: if it is already showing this
    // session, the pinned copy replaces it as the place it lives.
    const shell = this.adoptShell(
      vscode.window.createWebviewPanel(CONVERSATION_PINNED_TYPE, session.title, vscode.ViewColumn.Active, {
        retainContextWhenHidden: true,
      }),
      key,
    );
    this.pinned.set(key, shell);
    shell.panel.onDidDispose(() => this.pinned.delete(key));
    shell.host.show(key);
  }

  /**
   * Take ownership of a panel VSCode restored after a window reload. The
   * webview saved its session key, so the pane comes back on the same
   * conversation rather than blank.
   */
  restore(panel: vscode.WebviewPanel, state: unknown, pinnedPanel: boolean): void {
    const key = (state as PanelState | undefined)?.key;
    if (!key) {
      // Nothing to show and no way to find out what it was.
      panel.dispose();
      return;
    }
    // The store is very likely empty at this point — VSCode restores panels
    // during activation, before the first scan — so the key is handed over and
    // the host binds it when the session turns up.
    if (pinnedPanel) {
      if (this.pinned.has(key)) {
        panel.dispose();
        return;
      }
      const shell = this.adoptShell(panel, key);
      this.pinned.set(key, shell);
      panel.onDidDispose(() => this.pinned.delete(key));
      shell.host.show(key);
      return;
    }
    if (this.shared) {
      panel.dispose(); // a second reusable pane would fight the first
      return;
    }
    this.shared = this.adoptShell(panel, undefined);
    this.shared.host.show(key);
  }

  dispose(): void {
    this.shared?.panel.dispose();
    for (const shell of [...this.pinned.values()]) shell.panel.dispose();
    this.pinned.clear();
  }

  private adoptShell(panel: vscode.WebviewPanel, pinnedKey: string | undefined): Shell {
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    const host = new ConversationHost(
      panel.webview,
      this.extensionUri,
      this.store,
      this.provider,
      this.runners,
      this.actions,
      this.locator,
      (title) => {
        panel.title = pinnedKey === undefined ? title : `📌 ${title}`;
      },
    );
    panel.onDidDispose(() => {
      host.dispose();
      if (this.shared?.panel === panel) this.shared = undefined;
    });
    return { panel, host };
  }
}

/** Lets VSCode restore conversation panes where they were after a reload. */
export class ConversationPanelSerializer implements vscode.WebviewPanelSerializer {
  constructor(
    private manager: ConversationPanelManager,
    private pinned: boolean,
  ) {}

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    this.manager.restore(panel, state, this.pinned);
  }
}
