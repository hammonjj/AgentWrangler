import type { ArchiveService } from '../core/archive';
import type { ColumnPrefsService } from '../core/columnPrefs';
import type { Disposable } from '../core/events';
import type { PauseService } from '../core/pauseService';
import type { PinService } from '../core/pinService';
import type { SessionStore } from '../core/sessionStore';
import type { ModelCatalogService } from '../core/modelCatalog';
import type { HostDialogs, HostSettings } from '../host/hostServices';
import type { DashboardToHost, HostToDashboard } from '../shared/messages';
import type { HookHealth, ProjectDTO } from '../shared/model';
import type { UsageState } from '../shared/usage';
import type { SessionActions } from './actions';
import type { PaneChannel } from './paneChannel';
import { openTargetFor } from './openTarget';

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
/** Just enough of `RunnerService` for the dashboard: "are we running this one?" */
export interface RunnerOwnership {
  owns(sessionId: string | undefined): boolean;
  wasRunning?(sessionId: string): boolean;
  onDidChange(listener: () => void): Disposable;
}

/**
 * The launcher's folder list, behind an interface for the same reason as the
 * others: the dashboard must not know that it comes from `~/.claude.json`.
 */
export interface ProjectSource {
  readonly value: ProjectDTO[];
  refresh(opts?: { force?: boolean }): Promise<ProjectDTO[]>;
  /** Keep offering a folder the config has never heard of (one just browsed to). */
  add(dir: string): void;
  /** Stop offering a folder. Persisted, since the next scan would otherwise find it again. */
  remove(dir: string): void;
  onDidChange(listener: () => void): Disposable;
}

/** Starting a conversation is the extension's job, not the dashboard's; it only asks. */
export interface ConversationLauncher {
  newConversation(cwd: string, provider?: 'claude' | 'codex'): Promise<unknown>;
  /** Run the folder dialog. `undefined` = cancelled, and the dropdown keeps what it had. */
  browseForProject(): Promise<string | undefined>;
}

export class DashboardHost {
  private subs: { dispose(): void }[] = [];

  constructor(
    private webview: PaneChannel,
    private store: SessionStore,
    private archive: ArchiveService,
    private actions: SessionActions,
    private health: HookHealthSource,
    private usage: UsageSource,
    private codexUsage: UsageSource,
    private columns: ColumnPrefsService,
    private runners: RunnerOwnership,
    private projects: ProjectSource,
    private launcher: ConversationLauncher,
    private pause: PauseService,
    private pins: PinService,
    private settings: HostSettings,
    private dialogs: HostDialogs,
    private models: ModelCatalogService,
  ) {
    this.subs.push(
      webview.onDidReceiveMessage((m: DashboardToHost) => this.onMessage(m)),
      this.store.onDidUpdate(() => this.pushSnapshot()),
      // The launcher's two dropdowns are settings, so a change from anywhere —
      // the Preferences window, VSCode's settings UI, the other dashboard —
      // has to reach them or they show a default that is no longer the default.
      this.models.onDidChange(() => void this.pushSnapshot()),
      this.settings.onDidChange((affects) => {
        if (affects('runner.model') || affects('runner.effort')) void this.pushSnapshot();
        if (affects('showCodexSubagents')) {
          this.actions.refreshAll();
          void this.pushSnapshot();
        }
      }),
      this.archive.onDidChange(() => this.pushSnapshot()),
      // The store only fires on material session changes, so an install that
      // changes nothing about any session still has to reach the banner.
      this.health.onDidChangeHookHealth(() => this.pushSnapshot()),
      this.usage.onDidChange(() => this.pushSnapshot()),
      this.codexUsage.onDidChange(() => this.pushSnapshot()),
      // Columns are shared across dashboards: a drag in the editor tab reaches
      // the docked one, and neither is the owner of the layout.
      this.columns.onDidChange(() => this.pushSnapshot()),
      // Taking a session over (or handing it back) changes what its row says
      // without changing anything the store tracks.
      this.runners.onDidChange(() => this.pushSnapshot()),
      // A folder removed from one dashboard's dropdown is removed from both.
      this.projects.onDidChange(() => this.pushSnapshot()),
      // Pausing is machine-wide and its record is global state, so a pause from
      // any window has to reach every dashboard's rows and its bar button.
      this.pause.onDidChange(() => this.pushSnapshot()),
      // Pinning moves a row between sections without changing anything the
      // store tracks, so the push has to come from here.
      this.pins.onDidChange(() => this.pushSnapshot()),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  /**
   * Write one setting and say so if it fails. The snapshot is re-pushed on the
   * way out either way: on success the settings change event brings the new
   * value, and on failure the dropdown has to be put back to what is actually
   * stored rather than left showing a choice that did not take.
   */
  private async writeSetting(key: string, value: string): Promise<void> {
    try {
      await this.settings.update(key, value);
    } catch (error) {
      this.dialogs.error(`Could not change ${key}: ${String(error)}`);
      void this.pushSnapshot();
    }
  }

  /** Snapshots are built asynchronously and can overlap; only the newest lands. */
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
    // Both ask the OS about the same pids and neither depends on the other:
    // where each process lives, and which of them are stopped.
    await this.pause.refresh(livePids);
    if (seq !== this.snapshotSeq) return; // superseded while we waited

    const sessions = raw.map((s) => {
      // Ask the runner first: its child processes are descendants of this
      // extension host, so the process table would call them panel sessions.
      const runnerOwned = this.runners.owns(s.sessionId);
      return {
        ...s,
        archived: this.archive.isArchived(s.key),
        pinned: this.pins.isPinned(s.key) || undefined,
        pinnedAt: this.pins.pinnedAt(s.key),
        paused: this.pause.isPaused(s.pid) || undefined,
        runnerOwned: runnerOwned || undefined,
        wasRunningHere: this.runners.wasRunning?.(s.sessionId) || undefined,
        openTarget: openTargetFor(),
      };
    });
    const msg: HostToDashboard = {
      type: 'snapshot',
      sessions,
      nowMs: Date.now(),
      hooks: this.health.hookHealth,
      usage: this.usage.enabled ? this.usage.usage : undefined,
      codexUsage: this.codexUsage.enabled ? this.codexUsage.usage : undefined,
      columns: this.columns.value,
      showCodexSubagents: this.settings.get('showCodexSubagents', false),
      launcher: {
        models: this.models.value,
        model: this.settings.get<string>('runner.model', ''),
        effort: this.settings.get<string>('runner.effort', ''),
      },
      projects: this.projects.value.length > 0 ? this.projects.value : undefined,
    };
    void this.webview.postMessage(msg);
  }

  private onMessage(m: DashboardToHost): void {
    switch (m.type) {
      case 'ready':
        this.pushSnapshot();
        // A dashboard just opened wants today's numbers, not last minute's.
        void this.usage.refresh();
        void this.codexUsage.refresh();
        // And a launcher with no folders in it is not a launcher.
        void this.refreshProjects();
        break;
      case 'rowClick':
        this.actions.smartOpen(m.key);
        break;
      case 'action':
        if (m.action === 'openInTab') this.actions.openInTab(m.key);
        else if (m.action === 'pin') this.actions.togglePinned(m.key);
        else if (m.action === 'rename') this.actions.rename(m.key);
        else if (m.action === 'resume') this.actions.resume(m.key);
        else if (m.action === 'archive') {
          this.archive.toggle(m.key);
          // The mirror of what pinning does to archiving: the two are opposite
          // instructions and cannot both be in force.
          if (this.archive.isArchived(m.key)) this.pins.set(m.key, false);
        }
        else if (m.action === 'copyId') this.actions.copyId(m.key);
        else if (m.action === 'close') this.actions.closeSession(m.key);
        else if (m.action === 'pause') this.actions.pauseSession(m.key, true);
        else if (m.action === 'unpause') this.actions.pauseSession(m.key, false);
        else if (m.action === 'allow' || m.action === 'deny' || m.action === 'always') {
          // The id the card was drawn from, so an answer cannot land on the
          // prompt that replaced the one the button was offered for.
          void this.actions.decidePermission(m.key, m.action, { expectedRequestId: m.requestId });
        }
        break;
      case 'openExternal':
        this.actions.openExternal(m.url);
        break;
      case 'refresh':
        this.actions.refreshAll();
        void this.usage.refresh({ force: true });
        void this.codexUsage.refresh({ force: true });
        break;
      case 'installHooks':
        this.actions.installHooks();
        break;
      case 'setShowCodexSubagents':
        if (typeof m.value === 'boolean') {
          void this.settings.update('showCodexSubagents', m.value).catch((error: unknown) => {
            this.dialogs.error(`Could not change Codex session visibility: ${String(error)}`);
            void this.pushSnapshot();
          });
        }
        break;
      case 'setRunnerModel':
        if (typeof m.model === 'string') void this.writeSetting('runner.model', m.model);
        return;
      case 'setRunnerEffort':
        if (typeof m.effort === 'string') void this.writeSetting('runner.effort', m.effort);
        return;
      case 'setColumns':
        this.columns.set(m.prefs);
        break;
      case 'newConversation':
        void this.launcher.newConversation(m.cwd, m.provider);
        break;
      case 'browseProject':
        void this.browseProject();
        break;
      case 'removeProject':
        // Drops it from the cache synchronously and fires, which is what pushes
        // the new list — here and to every other dashboard.
        this.projects.remove(m.dir);
        break;
      case 'refreshProjects':
        void this.refreshProjects();
        break;
      case 'pauseAll':
        this.actions.pauseAll(m.pause);
        break;
    }
  }

  /** Re-scan, then push only if the scan actually changed the list. */
  private async refreshProjects(opts: { force?: boolean } = {}): Promise<void> {
    const before = this.projects.value;
    const after = await this.projects.refresh(opts);
    if (after !== before) this.pushSnapshot();
  }

  /**
   * A browsed folder may be one Claude Code has never been used in, so it is
   * not in the config and a plain re-scan would not find it. Tell the dashboard
   * to select it first, then force the scan that puts it in the list.
   */
  private async browseProject(): Promise<void> {
    const dir = await this.launcher.browseForProject();
    if (!dir) return;
    this.projects.add(dir);
    void this.webview.postMessage({ type: 'projectPicked', dir } satisfies HostToDashboard);
    await this.refreshProjects({ force: true });
  }
}
