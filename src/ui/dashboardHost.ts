import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { ColumnPrefsService } from '../core/columnPrefs';
import type { Disposable } from '../core/events';
import type { SessionStore } from '../core/sessionStore';
import type { DashboardToHost, HostToDashboard } from '../shared/messages';
import type { HookHealth } from '../shared/model';
import type { UsageState } from '../shared/usage';
import type { SessionActions } from './actions';
import { buildWebviewHtml } from './html';
import { openTargetFor } from './openTarget';
import type { SessionLocator } from './sessionLocator';
import { isInThisWorkspace } from './workspace';

/**
 * Where the banner's facts come from — the Claude provider, in practice. Kept
 * as an interface so the dashboard never imports provider internals.
 */
export interface HookHealthSource {
  readonly hookHealth: HookHealth | undefined;
  onDidChangeHookHealth(listener: () => void): Disposable;
}

/** Where the usage cards' numbers come from — `UsageService`, behind an interface for the same reason. */
export interface UsageSource {
  readonly usage: UsageState;
  readonly enabled: boolean;
  onDidChange(listener: () => void): Disposable;
  /** Plain: a cached read within the interval will do. `force`: the user asked, go to Claude. */
  refresh(opts?: { force?: boolean }): Promise<void>;
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
    private locator: SessionLocator,
    private usage: UsageSource,
    private columns: ColumnPrefsService,
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
      this.usage.onDidChange(() => this.pushSnapshot()),
      // Columns are shared across dashboards: a drag in the editor tab reaches
      // the docked one, and neither is the owner of the layout.
      this.columns.onDidChange(() => this.pushSnapshot()),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  /** Snapshots race the locator's process-table read; only the newest one lands. */
  private snapshotSeq = 0;

  private pushSnapshot(): void {
    void this.pushSnapshotAsync();
  }

  private async pushSnapshotAsync(): Promise<void> {
    const seq = ++this.snapshotSeq;
    const raw = this.store.sessions;
    const livePids = raw
      .filter((s) => s.provider === 'claude' && s.status !== 'ended' && s.pid !== undefined)
      .map((s) => s.pid as number);
    const locations = await this.locator.locateMany(livePids);
    if (seq !== this.snapshotSeq) return; // superseded while we waited

    const sessions = raw.map((s) => ({
      ...s,
      archived: this.archive.isArchived(s.key),
      openTarget: openTargetFor(
        s,
        s.pid === undefined ? 'unavailable' : (locations.get(s.pid) ?? 'unavailable'),
        isInThisWorkspace(s.cwd),
      ),
    }));
    const msg: HostToDashboard = {
      type: 'snapshot',
      sessions,
      nowMs: Date.now(),
      hooks: this.health.hookHealth,
      usage: this.usage.enabled ? this.usage.usage : undefined,
      columns: this.columns.value,
    };
    void this.webview.postMessage(msg);
  }

  private onMessage(m: DashboardToHost): void {
    switch (m.type) {
      case 'ready':
        this.pushSnapshot();
        // A dashboard just opened wants today's numbers, not last minute's.
        void this.usage.refresh();
        break;
      case 'rowClick':
        this.actions.smartOpen(m.key);
        break;
      case 'action':
        if (m.action === 'viewer') this.actions.openViewer(m.key);
        else if (m.action === 'resume') this.actions.resume(m.key);
        else if (m.action === 'archive') this.archive.toggle(m.key);
        else if (m.action === 'allow' || m.action === 'deny' || m.action === 'always') {
          this.actions.decidePermission(m.key, m.action);
        }
        break;
      case 'openExternal':
        this.actions.openExternal(m.url);
        break;
      case 'refresh':
        this.actions.refreshAll();
        void this.usage.refresh({ force: true });
        break;
      case 'installHooks':
        this.actions.installHooks();
        break;
      case 'setColumns':
        this.columns.set(m.prefs);
        break;
    }
  }
}
