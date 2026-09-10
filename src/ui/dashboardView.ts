import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { SessionStore } from '../core/sessionStore';
import type { SessionActions } from './actions';
import { DashboardHost, type HookHealthSource } from './dashboardHost';

/** Dashboard docked in the bottom panel, next to Terminal. */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'agentWrangler.dashboard';

  constructor(
    private extensionUri: vscode.Uri,
    private store: SessionStore,
    private archive: ArchiveService,
    private actions: SessionActions,
    private health: HookHealthSource,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const host = new DashboardHost(view.webview, this.extensionUri, this.store, this.archive, this.actions, this.health);
    view.onDidDispose(() => host.dispose());
  }
}
