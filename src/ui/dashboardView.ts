import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { ColumnPrefsService } from '../core/columnPrefs';
import type { SessionStore } from '../core/sessionStore';
import type { SessionActions } from './actions';
import { DashboardHost, type HookHealthSource, type UsageSource } from './dashboardHost';
import type { SessionLocator } from './sessionLocator';

/** Dashboard docked in the bottom panel, next to Terminal. */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'agentWrangler.dashboard';

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

  resolveWebviewView(view: vscode.WebviewView): void {
    const host = new DashboardHost(
      view.webview,
      this.extensionUri,
      this.store,
      this.archive,
      this.actions,
      this.health,
      this.locator,
      this.usage,
      this.columns,
    );
    view.onDidDispose(() => host.dispose());
  }
}
