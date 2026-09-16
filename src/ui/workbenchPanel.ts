/**
 * The workbench: one editor tab holding the agent table and the conversation,
 * with a divider between them.
 *
 * These were two panels in two editor groups, which meant two things that are
 * never used apart could be closed independently, shoved around by a file
 * opening into either group, and re-arranged by hand afterwards. One tab cannot
 * drift, and the whole surface moves as a unit.
 *
 * The two hosts are unchanged and still know nothing about each other: each
 * gets a `PaneChannel` that addresses its messages, and this class owns the one
 * thing they can no longer each own — the document.
 */

import * as vscode from 'vscode';
import type { RunnerService } from '../claude/runner/runnerService';
import type { RunnerSession } from '../claude/runner/runnerSession';
import type { ArchiveService } from '../core/archive';
import type { ColumnPrefsService } from '../core/columnPrefs';
import type { DictationService } from '../core/dictation';
import type { FileSuggestService } from '../core/fileSuggest';
import type { PauseService } from '../core/pauseService';
import type { PinService } from '../core/pinService';
import type { SessionStore } from '../core/sessionStore';
import type { SessionActions } from './actions';
import type { ConversationProvider } from './conversation/conversationHost';
import { ConversationHost } from './conversation/conversationHost';
import type { DiffContentProvider } from './conversation/diffView';
import {
  DashboardHost,
  type ConversationLauncher,
  type HookHealthSource,
  type ProjectSource,
  type UsageSource,
} from './dashboardHost';
import { buildWebviewHtml } from './html';
import { paneChannel } from './paneChannel';
import type { SessionLocator } from './sessionLocator';

export const WORKBENCH_PANEL_TYPE = 'agentWrangler.workbench';

/**
 * Seventeen dependencies between the two hosts, so they arrive named. The
 * positional form the single-pane shells used stopped being readable at about
 * half this.
 */
export interface WorkbenchDeps {
  extensionUri: vscode.Uri;
  store: SessionStore;
  provider: ConversationProvider;
  runners: RunnerService;
  actions: SessionActions;
  locator: SessionLocator;
  dictation: DictationService;
  diffs: DiffContentProvider;
  files: FileSuggestService;
  archive: ArchiveService;
  health: HookHealthSource;
  usage: UsageSource;
  columns: ColumnPrefsService;
  projects: ProjectSource;
  launcher: ConversationLauncher;
  pause: PauseService;
  pins: PinService;
}

/** What the webview saves, so a reload comes back on the same conversation. */
interface WorkbenchState {
  conversation?: { key?: string };
}

export class WorkbenchPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private dashboard?: DashboardHost;
  private conversation?: ConversationHost;

  constructor(private deps: WorkbenchDeps) {}

  /** True while a workbench tab exists — including one VSCode restored for us. */
  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Open the workbench, or bring the existing one forward. */
  open(opts?: { preserveFocus?: boolean }): void {
    const preserveFocus = opts?.preserveFocus ?? false;
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.adopt(
      vscode.window.createWebviewPanel(
        WORKBENCH_PANEL_TYPE,
        'Agent Wrangler',
        { viewColumn: vscode.ViewColumn.One, preserveFocus },
        { retainContextWhenHidden: true },
      ),
    );
  }

  /**
   * Show a session in the conversation half.
   *
   * `preserveFocus` by default: a click in the table should fill the pane
   * beside it, not move the cursor into it. Opening the workbench if it is
   * closed is deliberate — a row click has to land somewhere.
   */
  show(key: string, opts?: { preserveFocus?: boolean }): void {
    this.open({ preserveFocus: opts?.preserveFocus ?? true });
    this.conversation?.show(key);
  }

  /** A session this window has just started, which has no id or store entry yet. */
  showRunner(runner: RunnerSession, opts?: { preserveFocus?: boolean }): void {
    this.open({ preserveFocus: opts?.preserveFocus ?? false });
    this.conversation?.showRunner(runner);
  }

  /** Take back the panel VSCode restored after a reload. */
  restore(panel: vscode.WebviewPanel, state: unknown): void {
    if (this.panel) {
      panel.dispose(); // a second workbench would fight the first
      return;
    }
    this.adopt(panel);
    // The store is almost certainly empty here — VSCode restores panels during
    // activation, before the provider's first scan — so the key is handed over
    // and the host binds it when the session turns up.
    const key = (state as WorkbenchState | undefined)?.conversation?.key;
    if (key) this.conversation?.show(key);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private adopt(panel: vscode.WebviewPanel): void {
    const { extensionUri } = this.deps;
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist'),
        vscode.Uri.joinPath(extensionUri, 'media'),
      ],
    };
    // Set once, here. Two hosts each assigning `html` would have had the second
    // replace the document the first was already talking to.
    panel.webview.html = buildWebviewHtml({
      webview: panel.webview,
      extensionUri,
      bundleName: 'workbench',
      title: 'Agent Wrangler',
    });

    this.dashboard = new DashboardHost(
      paneChannel(panel.webview, 'dashboard'),
      this.deps.store,
      this.deps.archive,
      this.deps.actions,
      this.deps.health,
      this.deps.locator,
      this.deps.usage,
      this.deps.columns,
      this.deps.runners,
      this.deps.projects,
      this.deps.launcher,
      this.deps.pause,
      this.deps.pins,
    );
    this.conversation = new ConversationHost(
      paneChannel(panel.webview, 'conversation'),
      this.deps.store,
      this.deps.provider,
      this.deps.runners,
      this.deps.actions,
      this.deps.locator,
      this.deps.dictation,
      this.deps.diffs,
      this.deps.files,
      // The tab is the whole workbench, not one conversation, so its title does
      // not follow the session. The pane shows the name in its own header.
      () => undefined,
    );

    panel.onDidDispose(() => {
      this.dashboard?.dispose();
      this.conversation?.dispose();
      this.dashboard = undefined;
      this.conversation = undefined;
      this.panel = undefined;
    });
  }
}

/** Lets VSCode restore the workbench where it was after a reload. */
export class WorkbenchPanelSerializer implements vscode.WebviewPanelSerializer {
  constructor(private manager: WorkbenchPanelManager) {}

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    this.manager.restore(panel, state);
  }
}
