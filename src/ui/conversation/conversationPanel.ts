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
import type { CodexRunnerService } from '../../codex/runner';
import type { RunnerService } from '../../claude/runner/runnerService';
import { displayTitle } from '../../shared/model';
import type { DictationService } from '../../core/dictation';
import type { SessionStore } from '../../core/sessionStore';
import type { AgentProvider } from '../../core/provider';
import type { SessionActions } from '../actions';
import type { FileSuggestService } from '../../core/fileSuggest';
import type { DiffViewer } from './diffViewer';
import { buildWebviewHtml } from '../vscodeHtml';
import { paneChannel } from '../paneChannel';
import { ConversationHost, type ConversationHostUi, type ConversationProvider } from './conversationHost';

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
  private pinned = new Map<string, Shell>();

  constructor(
    private extensionUri: vscode.Uri,
    private store: SessionStore,
    private provider: ConversationProvider,
    private codexProvider: AgentProvider,
    private runners: RunnerService,
    private codexRunners: CodexRunnerService,
    private actions: SessionActions,
    private dictation: DictationService,
    private diffs: DiffViewer | undefined,
    private files: FileSuggestService,
    private ui: ConversationHostUi,
  ) {}

  /** Give this session a panel of its own, which `show` will never swap. */
  pin(key: string): void {
    const existing = this.pinned.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const session = this.store.get(key);
    if (!session) return;
    const shell = this.adoptShell(
      vscode.window.createWebviewPanel(CONVERSATION_PINNED_TYPE, displayTitle(session), vscode.ViewColumn.Active, {
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
  restore(panel: vscode.WebviewPanel, state: unknown): void {
    const key = (state as PanelState | undefined)?.key;
    if (!key || this.pinned.has(key)) {
      // Nothing to show, no way to find out what it was, or already open.
      panel.dispose();
      return;
    }
    // The store is very likely empty at this point — VSCode restores panels
    // during activation, before the first scan — so the key is handed over and
    // the host binds it when the session turns up.
    const shell = this.adoptShell(panel, key);
    this.pinned.set(key, shell);
    panel.onDidDispose(() => this.pinned.delete(key));
    shell.host.show(key);
  }

  dispose(): void {
    for (const shell of [...this.pinned.values()]) shell.panel.dispose();
    this.pinned.clear();
  }

  private adoptShell(panel: vscode.WebviewPanel, pinnedKey: string): Shell {
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    panel.webview.html = buildWebviewHtml({
      webview: panel.webview,
      extensionUri: this.extensionUri,
      bundleName: 'conversation',
      title: 'Conversation',
    });
    const host = new ConversationHost(
      paneChannel(panel.webview, 'conversation'),
      this.store,
      this.provider,
      this.codexProvider,
      this.runners,
      this.codexRunners,
      this.actions,
      this.dictation,
      this.diffs,
      this.files,
      (title) => {
        panel.title = `📌 ${title}`;
      },
      this.ui,
    );
    panel.onDidDispose(() => host.dispose());
    return { panel, host };
  }
}

/** Lets VSCode restore conversation panes where they were after a reload. */
export class ConversationPanelSerializer implements vscode.WebviewPanelSerializer {
  constructor(private manager: ConversationPanelManager) {}

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    this.manager.restore(panel, state);
  }
}
