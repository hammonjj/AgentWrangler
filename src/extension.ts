import * as vscode from 'vscode';
import { ClaudeProvider } from './claude/claudeProvider';
import {
  currentState,
  installHooks,
  settingsModifiedAtMs,
  settingsPath,
  uninstallHooks,
} from './claude/hookInstall';
import { hookLogDir } from './claude/hookLog';
import { ArchiveService } from './core/archive';
import { DEFAULT_CONFIG, type ConfigGetter, type WranglerConfig } from './core/config';
import { SessionStore } from './core/sessionStore';
import { TurnStats } from './core/turnStats';
import { STATUS_LABEL, type AgentSession, type SessionStatus } from './shared/model';
import type { SessionActions } from './ui/actions';
import { DASHBOARD_PANEL_TYPE, DashboardPanelManager, DashboardPanelSerializer } from './ui/dashboardPanel';
import { DashboardViewProvider } from './ui/dashboardView';
import { CrossWindowRelay } from './ui/relay';
import { createStatusBar } from './ui/statusBar';
import { resumeInTerminal } from './ui/terminal';
import { ViewerPanelManager } from './ui/viewerPanel';
import { isInThisWorkspace } from './ui/workspace';

/** How long to let a session emit its first hook event before calling hooks broken. */
const HOOK_HEALTH_GRACE_MS = 90_000;

/**
 * Grace period before the startup auto-open. VSCode restores editor tabs (and
 * hands ours back through the serializer) shortly after activation, so waiting
 * keeps us from opening a second dashboard next to the restored one.
 */
const STARTUP_OPEN_DELAY_MS = 1500;

const QUICKPICK_ICON: Record<SessionStatus, string> = {
  blocked: '$(shield)',
  waiting: '$(bell)',
  busy: '$(play)',
  stuck: '$(warning)',
  ended: '$(circle-slash)',
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Wrangler');
  context.subscriptions.push(output);
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const getConfig: ConfigGetter = () => {
    const c = vscode.workspace.getConfiguration('agentWrangler');
    const cfg: WranglerConfig = {
      claudeBinaryPath: c.get('claudeBinaryPath', DEFAULT_CONFIG.claudeBinaryPath),
      stuckThresholdSeconds: c.get('stuckThresholdSeconds', DEFAULT_CONFIG.stuckThresholdSeconds),
      endedWindowHours: c.get('endedWindowHours', DEFAULT_CONFIG.endedWindowHours),
      maxEndedSessions: c.get('maxEndedSessions', DEFAULT_CONFIG.maxEndedSessions),
      notifyOnWaiting: c.get('notifyOnWaiting', DEFAULT_CONFIG.notifyOnWaiting),
      pollIntervalSeconds: c.get('pollIntervalSeconds', DEFAULT_CONFIG.pollIntervalSeconds),
    };
    return cfg;
  };

  const store = new SessionStore();
  // Turn durations are a property of how this person works, not of one folder,
  // so the baseline is global state shared across windows.
  const turnStats = new TurnStats(context.globalState);
  const provider = new ClaudeProvider(getConfig, log, turnStats);
  const archive = new ArchiveService(context.globalState);
  context.subscriptions.push({ dispose: () => store.dispose() }); // store disposes providers

  const openViewerFor = (session: AgentSession) => viewers.open(session);

  const relay = new CrossWindowRelay(
    vscode.Uri.joinPath(context.globalStorageUri, 'relay').fsPath,
    (sessionId) => {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId).then(undefined, (err) => {
        log(`relay: claude-vscode.editor.open failed (${String(err)})`);
        const s = store.get(`claude:${sessionId.toLowerCase()}`);
        if (s) openViewerFor(s);
      });
    },
    log,
  );
  context.subscriptions.push(relay);
  void relay.start();

  const fallbackOpen = (s: AgentSession) => {
    if (s.status === 'ended') resumeInTerminal(s, getConfig);
    else openViewerFor(s);
  };

  const actions: SessionActions = {
    smartOpen(key) {
      const s = store.get(key);
      if (!s) return;
      // In this window's workspace → open straight into the Claude Code panel
      // (reveals the existing panel for that session, or starts one with
      // --resume=<id>) so the user can talk to the agent immediately.
      if (s.provider === 'claude' && isInThisWorkspace(s.cwd)) {
        vscode.commands.executeCommand('claude-vscode.editor.open', s.sessionId).then(undefined, (err) => {
          log(`claude-vscode.editor.open failed (${String(err)}); falling back`);
          fallbackOpen(s);
        });
        return;
      }
      // Live panel session owned by another window → relay: focus that window
      // and have its Agent Wrangler instance open the conversation there.
      if (s.provider === 'claude' && s.status !== 'ended' && s.entrypoint === 'claude-vscode' && s.cwd) {
        void relay.request(s.sessionId, s.cwd);
        vscode.window.setStatusBarMessage(`Agent Wrangler: opening ${s.name ?? s.title} in its window…`, 4000);
        return;
      }
      // Everything else: ended → terminal resume; live terminal/unknown → viewer.
      fallbackOpen(s);
    },
    openViewer(key) {
      const s = store.get(key);
      if (s) openViewerFor(s);
    },
    resume(key) {
      const s = store.get(key);
      if (s) resumeInTerminal(s, getConfig);
    },
    copyId(key) {
      const s = store.get(key);
      if (!s) return;
      void vscode.env.clipboard.writeText(s.sessionId).then(() => {
        vscode.window.setStatusBarMessage(`Copied session id ${s.sessionId}`, 2500);
      });
    },
    reveal(key) {
      const s = store.get(key);
      if (!s?.transcriptPath) {
        void vscode.window.showWarningMessage('Agent Wrangler: no transcript file for this session.');
        return;
      }
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.transcriptPath));
    },
    refreshAll() {
      void store.forceRefresh();
    },
    openExternal(url) {
      if (/^https?:\/\//i.test(url)) void vscode.env.openExternal(vscode.Uri.parse(url));
    },
  };

  const viewers = new ViewerPanelManager(context.extensionUri, store, provider, actions);
  context.subscriptions.push(viewers);

  // The dashboard has two homes: an editor tab (default) and the bottom panel.
  // Both are always registered; the setting only decides where opening it goes.
  const dashboardPanel = new DashboardPanelManager(context.extensionUri, store, archive, actions);
  context.subscriptions.push(
    dashboardPanel,
    vscode.window.registerWebviewPanelSerializer(DASHBOARD_PANEL_TYPE, new DashboardPanelSerializer(dashboardPanel)),
    vscode.window.registerWebviewViewProvider(
      DashboardViewProvider.viewId,
      new DashboardViewProvider(context.extensionUri, store, archive, actions),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const dashboardInEditor = () =>
    vscode.workspace.getConfiguration('agentWrangler').get<string>('dashboardLocation', 'editor') !== 'panel';

  const openDashboard = (opts?: { preserveFocus?: boolean }) => {
    if (dashboardInEditor()) dashboardPanel.open(opts);
    else void vscode.commands.executeCommand('agentWrangler.dashboard.focus');
  };

  createStatusBar(store, archive, context);

  // Opt-in "waiting on you" toasts, with a per-session cooldown.
  const lastToastAt = new Map<string, number>();
  context.subscriptions.push(
    store.onDidUpdate((u) => {
      if (u.becameWaiting.length === 0 || !getConfig().notifyOnWaiting) return;
      const now = Date.now();
      for (const s of u.becameWaiting) {
        if (archive.isArchived(s.key)) continue; // archived sessions stay quiet
        if (now - (lastToastAt.get(s.key) ?? 0) < 30_000) continue;
        lastToastAt.set(s.key, now);
        const msg =
          s.status === 'blocked'
            ? `${s.title} needs your permission${s.blockedReason ? ` for ${s.blockedReason}` : ''}`
            : `${s.title} is waiting on you`;
        void vscode.window
          .showInformationMessage(msg, 'Open Viewer', 'Dashboard')
          .then((choice) => {
            if (choice === 'Open Viewer') actions.openViewer(s.key);
            else if (choice === 'Dashboard') void vscode.commands.executeCommand('agentWrangler.openDashboard');
          });
      }
    }),
  );

  // ---- commands ----

  const pickSession = async (filter?: (s: AgentSession) => boolean): Promise<AgentSession | undefined> => {
    const candidates = store.sessions.filter(filter ?? (() => true));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('Agent Wrangler: no matching sessions.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((s) => ({
        label: `${QUICKPICK_ICON[s.status]} ${s.title}`,
        description: [s.projectName, STATUS_LABEL[s.status]].filter(Boolean).join(' · '),
        detail: s.subtitle,
        key: s.key,
      })),
      { placeHolder: 'Select an agent session', matchOnDescription: true, matchOnDetail: true },
    );
    return picked ? store.get(picked.key) : undefined;
  };

  const withSession =
    (fn: (key: string) => void, filter?: (s: AgentSession) => boolean) => async (key?: unknown) => {
      if (typeof key === 'string' && store.get(key)) {
        fn(key);
        return;
      }
      const s = await pickSession(filter);
      if (s) fn(s.key);
    };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentWrangler.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('agentWrangler.refresh', () => actions.refreshAll()),
    vscode.commands.registerCommand(
      'agentWrangler.openViewer',
      withSession((k) => actions.openViewer(k), (s) => s.transcriptPath !== undefined),
    ),
    vscode.commands.registerCommand(
      'agentWrangler.resumeInTerminal',
      withSession((k) => actions.resume(k), (s) => s.status === 'ended'),
    ),
    vscode.commands.registerCommand('agentWrangler.copySessionId', withSession((k) => actions.copyId(k))),
    vscode.commands.registerCommand(
      'agentWrangler.revealTranscript',
      withSession((k) => actions.reveal(k), (s) => s.transcriptPath !== undefined),
    ),
    vscode.commands.registerCommand('agentWrangler.installHooks', async () => {
      const dir = hookLogDir();
      const choice = await vscode.window.showWarningMessage(
        'Install Agent Wrangler status hooks?',
        {
          modal: true,
          detail:
            `This adds an Agent Wrangler block to ${settingsPath()} so Claude Code reports exact status ` +
            `(a permission prompt becomes "Blocked" instead of a guess). Your existing hooks and settings ` +
            `are preserved and the file is backed up first.\n\n` +
            `Claude Code reads hook config when a session starts, so only sessions you start afterwards will report.`,
        },
        'Install',
      );
      if (choice !== 'Install') return;
      const res = await installHooks(dir);
      log(`installHooks: ${res.message}`);
      if (res.ok) void vscode.window.showInformationMessage(`Agent Wrangler: ${res.message}`);
      else void vscode.window.showErrorMessage(`Agent Wrangler: ${res.message}`);
      void store.forceRefresh();
    }),
    vscode.commands.registerCommand('agentWrangler.uninstallHooks', async () => {
      const res = await uninstallHooks();
      log(`uninstallHooks: ${res.message}`);
      if (res.ok) void vscode.window.showInformationMessage(`Agent Wrangler: ${res.message}`);
      else void vscode.window.showErrorMessage(`Agent Wrangler: ${res.message}`);
      void store.forceRefresh();
    }),
  );

  void store.register(provider).catch((err) => log(`provider start failed: ${String(err)}`));
  log('Agent Wrangler activated');

  // Hooks can be suppressed with no error we'd ever see: `disableAllHooks`,
  // safe mode, an org policy allowing only managed hooks, or unaccepted
  // workspace trust. Left undetected that looks exactly like a broken feature,
  // so say so instead of showing every session as estimated forever.
  void (async () => {
    const state = await currentState(hookLogDir());
    log(`hook install state: ${state.kind}${'why' in state ? ` (${state.why})` : ''}`);
    if (state.kind === 'disabled') {
      void vscode.window.showWarningMessage(`Agent Wrangler: hooks cannot run — ${state.why}.`);
      return;
    }
    if (state.kind !== 'installed') return;

    const installedAt = await settingsModifiedAtMs();
    setTimeout(() => {
      if (provider.hooksReporting) return;
      // Only complain about sessions that started after the hooks were written;
      // older ones are expected to be silent, since hook config is snapshotted
      // when a session starts.
      const shouldReport = store.sessions.filter(
        (s) => s.status !== 'ended' && installedAt !== undefined && (s.startedAt ?? 0) > installedAt,
      );
      if (shouldReport.length === 0) return;
      log(`hooks installed but ${shouldReport.length} newer session(s) have reported nothing`);
      void vscode.window.showWarningMessage(
        'Agent Wrangler: status hooks are installed but no session is reporting. Check safe mode, workspace trust, and `disableAllHooks` in settings.json.',
      );
    }, HOOK_HEALTH_GRACE_MS);
  })();

  // Open the dashboard for the window, so a day spent with agents starts on
  // the agents. A tab VSCode restored for us already counts: leave it exactly
  // where and how it came back rather than adding a second one.
  if (vscode.workspace.getConfiguration('agentWrangler').get<boolean>('openOnStartup', true)) {
    setTimeout(() => {
      if (dashboardInEditor() && dashboardPanel.isOpen) return;
      openDashboard();
    }, STARTUP_OPEN_DELAY_MS);
  }
}

export function deactivate(): void {
  // everything is disposed via context.subscriptions
}
