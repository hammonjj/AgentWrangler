import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { Disposable } from '../core/events';
import type { SessionStore } from '../core/sessionStore';
import type { DashboardToHost, HostToDashboard } from '../shared/messages';
import type { HookHealth } from '../shared/model';
import type { SessionActions } from './actions';
import { buildWebviewHtml } from './html';
import { isInThisWorkspace } from './workspace';

/**
 * Where the banner's facts come from — the Claude provider, in practice. Kept
 * as an interface so the dashboard never imports provider internals.
 */
export interface HookHealthSource {
  readonly hookHealth: HookHealth | undefined;
  onDidChangeHookHealth(listener: () => void): Disposable;
}

/**
 * The dashboard's behavior, independent of where it is docked. VSCode has two
 * unrelated shells for a webview — WebviewView (bottom panel / sidebar) and
 * WebviewPanel (editor tab) — so the HTML, snapshot pushes and message
 * handling live here and each shell only owns a lifetime.
 */
export class DashboardHost {
  private subs: { dispose(): void }[] = [];

  constructor(
    private webview: vscode.Webview,
    extensionUri: vscode.Uri,
    private store: SessionStore,
    private archive: ArchiveService,
    private actions: SessionActions,
    private health: HookHealthSource,
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist'),
        vscode.Uri.joinPath(extensionUri, 'media'),
      ],
    };
    webview.html = buildWebviewHtml({
      webview,
      extensionUri,
      bundleName: 'dashboard',
      title: 'Agent Wrangler',
    });

    this.subs.push(
      webview.onDidReceiveMessage((m: DashboardToHost) => this.onMessage(m)),
      this.store.onDidUpdate(() => this.pushSnapshot()),
      this.archive.onDidChange(() => this.pushSnapshot()),
      // The store only fires on material session changes, so an install that
      // changes nothing about any session still has to reach the banner.
      this.health.onDidChangeHookHealth(() => this.pushSnapshot()),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  private pushSnapshot(): void {
    const sessions = this.store.sessions.map((s) => ({
      ...s,
      archived: this.archive.isArchived(s.key),
      inWorkspace: isInThisWorkspace(s.cwd),
    }));
    const msg: HostToDashboard = { type: 'snapshot', sessions, nowMs: Date.now(), hooks: this.health.hookHealth };
    void this.webview.postMessage(msg);
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
      case 'installHooks':
        this.actions.installHooks();
        break;
    }
  }
}
