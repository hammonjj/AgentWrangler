import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { ColumnPrefsService } from '../core/columnPrefs';
import type { SessionStore } from '../core/sessionStore';
import type { SessionActions } from './actions';
import { DashboardHost, type HookHealthSource, type UsageSource } from './dashboardHost';
import type { SessionLocator } from './sessionLocator';

/**
 * Panel view type. Deliberately distinct from the bottom-panel view id
 * (`agentWrangler.dashboard`) so the `activeWebviewPanelViewType` context key
 * and the `onWebviewPanel:` activation event refer to the editor tab alone.
 */
export const DASHBOARD_PANEL_TYPE = 'agentWrangler.dashboardPanel';

/**
 * Dashboard as an editor tab, for people who spend the day with agents rather
 * than files. Single instance: reveal-if-open, like the panel view it mirrors.
 */
export class DashboardPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private host?: DashboardHost;

  constructor(
    private extensionUri: vscode.Uri,
    private store: SessionStore,
    private archive: ArchiveService,
    private actions: SessionActions,
    private health: HookHealthSource,
    private locator: SessionLocator,
    private usage: UsageSource,
    private columns: ColumnPrefsService,
  ) {}

  /** True once a tab exists — created here, or restored by VSCode on reload. */
  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  open(opts?: { preserveFocus?: boolean }): void {
    const preserveFocus = opts?.preserveFocus ?? false;
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.adopt(
      vscode.window.createWebviewPanel(
        DASHBOARD_PANEL_TYPE,
        'Agent Wrangler',
        { viewColumn: vscode.ViewColumn.One, preserveFocus },
        // Rebuilding the table on every tab switch would drop scroll position
        // and section collapse state, so keep the webview alive when hidden.
        { retainContextWhenHidden: true },
      ),
    );
  }

  /**
   * Take ownership of a panel: one we just created, or one VSCode handed back
   * through the serializer after a window reload. Re-applying options and HTML
   * matters for the restored case — the extension may live at a new path.
   */
  adopt(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) {
      panel.dispose(); // a second tab would fight the first over one dashboard
      return;
    }
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    this.host = new DashboardHost(
      panel.webview,
      this.extensionUri,
      this.store,
      this.archive,
      this.actions,
      this.health,
      this.locator,
      this.usage,
      this.columns,
    );
    panel.onDidDispose(() => {
      this.host?.dispose();
      this.host = undefined;
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.panel?.dispose(); // triggers onDidDispose → host cleanup
  }
}

/** Lets VSCode restore the dashboard tab where it was after a reload. */
export class DashboardPanelSerializer implements vscode.WebviewPanelSerializer {
  constructor(private manager: DashboardPanelManager) {}

  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    this.manager.adopt(panel);
  }
}
