import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { SessionStore } from '../core/sessionStore';
import type { DashboardToHost, HostToDashboard } from '../shared/messages';
import type { SessionActions } from './actions';
import { buildWebviewHtml } from './html';
import { isInThisWorkspace } from './workspace';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'agentWrangler.dashboard';

  private view?: vscode.WebviewView;

  constructor(
    private extensionUri: vscode.Uri,
    private store: SessionStore,
    private archive: ArchiveService,
    private actions: SessionActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.extensionUri,
      bundleName: 'dashboard',
      title: 'Agent Wrangler',
    });

    const msgSub = view.webview.onDidReceiveMessage((m: DashboardToHost) => this.onMessage(m));
    const storeSub = this.store.onDidUpdate(() => this.pushSnapshot());
    const archiveSub = this.archive.onDidChange(() => this.pushSnapshot());
    view.onDidDispose(() => {
      msgSub.dispose();
      storeSub.dispose();
      archiveSub.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  private pushSnapshot(): void {
    if (!this.view) return;
    const sessions = this.store.sessions.map((s) => ({
      ...s,
      archived: this.archive.isArchived(s.key),
      inWorkspace: isInThisWorkspace(s.cwd),
    }));
    const msg: HostToDashboard = { type: 'snapshot', sessions, nowMs: Date.now() };
    void this.view.webview.postMessage(msg);
  }

  private onMessage(m: DashboardToHost): void {
    switch (m.type) {
      case 'ready':
        this.pushSnapshot();
        break;
      case 'rowClick':
        this.actions.smartOpen(m.key);
        break;
      case 'action':
        if (m.action === 'viewer') this.actions.openViewer(m.key);
        else if (m.action === 'resume') this.actions.resume(m.key);
        else if (m.action === 'archive') this.archive.toggle(m.key);
        break;
      case 'openExternal':
        this.actions.openExternal(m.url);
        break;
      case 'refresh':
        this.actions.refreshAll();
        break;
    }
  }
}
