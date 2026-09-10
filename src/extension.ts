import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudeProvider } from './claude/claudeProvider';
import { ArchiveService } from './core/archive';
import { DEFAULT_CONFIG, type ConfigGetter, type WranglerConfig } from './core/config';
import { SessionStore } from './core/sessionStore';
import { STATUS_LABEL, type AgentSession, type SessionStatus } from './shared/model';
import type { SessionActions } from './ui/actions';
import { DashboardViewProvider } from './ui/dashboardView';
import { CrossWindowRelay } from './ui/relay';
import { createStatusBar } from './ui/statusBar';
import { resumeInTerminal } from './ui/terminal';
import { ViewerPanelManager } from './ui/viewerPanel';
import { isInThisWorkspace } from './ui/workspace';

const QUICKPICK_ICON: Record<SessionStatus, string> = {
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
  const provider = new ClaudeProvider(getConfig, log);
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardViewProvider.viewId,
      new DashboardViewProvider(context.extensionUri, store, archive, actions),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

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
        void vscode.window
          .showInformationMessage(`${s.title} is waiting on you`, 'Open Viewer', 'Dashboard')
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
    vscode.commands.registerCommand('agentWrangler.openDashboard', () =>
      vscode.commands.executeCommand('agentWrangler.dashboard.focus'),
    ),
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
  );

  void store.register(provider).catch((err) => log(`provider start failed: ${String(err)}`));
  log('Agent Wrangler activated');

  // Dev convenience: `touch .dev-auto-open` in the extension folder to have the
  // dashboard panel open itself on every launch of the dev host.
  if (fs.existsSync(path.join(context.extensionPath, '.dev-auto-open'))) {
    setTimeout(() => void vscode.commands.executeCommand('agentWrangler.dashboard.focus'), 1200);
  }
}

export function deactivate(): void {
  // everything is disposed via context.subscriptions
}
