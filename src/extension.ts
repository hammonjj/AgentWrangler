/**
 * The VSCode front end.
 *
 * Everything about sessions moved to `src/app/createApp.ts` when the desktop
 * app needed the same thousand lines; what is left here is the part that is
 * genuinely about being an extension. Four things, in order: build a
 * `HostServices` over the editor's APIs, build the application on it, give it
 * the workbench tab to draw in, and register the commands that call it.
 *
 * The test of whether something belongs in this file is whether an Electron
 * window would need it. A command id, a panel serializer and the status bar
 * would not; taking a session over would.
 */

import * as vscode from 'vscode';
import { createApp } from './app/createApp';
import { createVscodeHost } from './host/vscode/vscodeHost';
import type { WorkbenchSurface } from './host/hostServices';
import type { RunnerSession } from './claude/runner/runnerSession';
import type { CodexRunner } from './codex/runner';
import { DiffContentProvider } from './ui/conversation/diffView';
import {
  CONVERSATION_PINNED_TYPE,
  ConversationPanelManager,
  ConversationPanelSerializer,
} from './ui/conversation/conversationPanel';
import type { ConversationHostUi } from './ui/conversation/conversationHost';
import { WORKBENCH_PANEL_TYPE, WorkbenchPanelManager, WorkbenchPanelSerializer } from './ui/workbenchPanel';
import { watchForDevReload } from './ui/devReload';
import { offerDictationSetup } from './ui/dictationSetup';
import { createStatusBar } from './ui/statusBar';

/**
 * Grace period before the startup auto-open. VSCode restores editor tabs (and
 * hands ours back through the serializer) shortly after activation, so waiting
 * keeps us from opening a second dashboard next to the restored one.
 */
const STARTUP_OPEN_DELAY_MS = 1500;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Wrangler');
  context.subscriptions.push(output);
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const host = createVscodeHost(context, log);
  const app = createApp(host);

  // Serves the two sides of an edit's diff to VSCode's diff editor. The one
  // capability the app cannot have yet, so it is constructed here rather than
  // by `createApp`.
  const diffs = new DiffContentProvider();
  context.subscriptions.push(diffs);

  const ui: ConversationHostUi = { dialogs: host.dialogs, offerDictationSetup };

  // Pinned conversations only: a session given a tab of its own, which row
  // clicks never swap away. The reusable pane lives in the workbench.
  const conversations = new ConversationPanelManager(
    context.extensionUri,
    app.store,
    app.provider,
    app.codexProvider,
    app.runners,
    app.codexRunners,
    app.actions,
    app.dictation,
    diffs,
    app.files,
    ui,
  );
  context.subscriptions.push(
    conversations,
    vscode.window.registerWebviewPanelSerializer(
      CONVERSATION_PINNED_TYPE,
      new ConversationPanelSerializer(conversations),
    ),
  );

  // The workbench: the table and the conversation in one tab.
  const workbench = new WorkbenchPanelManager({
    extensionUri: context.extensionUri,
    store: app.store,
    provider: app.provider,
    codexProvider: app.codexProvider,
    runners: app.runners,
    codexRunners: app.codexRunners,
    actions: app.actions,
    dictation: app.dictation,
    diffs,
    files: app.files,
    archive: app.archive,
    health: app.provider,
    usage: app.usage,
    codexUsage: app.codexUsage,
    runnerOwnership: app.runnerOwnership,
    columns: app.columns,
    projects: app.projects,
    launcher: app.launcher,
    pause: app.pause,
    pins: app.pins,
    settings: host.settings,
    ui,
  });
  context.subscriptions.push(
    workbench,
    vscode.window.registerWebviewPanelSerializer(WORKBENCH_PANEL_TYPE, new WorkbenchPanelSerializer(workbench)),
  );

  /**
   * Two shells, one surface. The workbench tab is where a conversation
   * normally goes; `openInTab` is the escape hatch that gives one a tab of its
   * own, which is a different object here and would be a second window in the
   * app. `createApp` is not told which.
   */
  const surface: WorkbenchSurface = {
    get isOpen() {
      return workbench.isOpen;
    },
    open: (opts) => workbench.open(opts),
    show: (key, opts) => workbench.show(key, opts),
    showRunner: (runner, opts) => workbench.showRunner(runner as RunnerSession, opts),
    showCodexRunner: (runner) => workbench.showCodexRunner(runner as CodexRunner),
    openInTab: (key) => conversations.pin(key),
  };
  app.attachSurface(surface);

  createStatusBar(app.store, app.archive, app.pause, context);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentWrangler.newConversation', () => void app.newConversation()),
    vscode.commands.registerCommand('agentWrangler.openDashboard', () => workbench.open()),
    vscode.commands.registerCommand('agentWrangler.refresh', () => app.refresh()),
    vscode.commands.registerCommand(
      'agentWrangler.openConversation',
      app.withSession((k) => app.actions.smartOpen(k)),
    ),
    // The command id still says "pin" because ids are the stable thing a
    // keybinding points at; only what it is called changed, when pinning a row
    // took the word.
    vscode.commands.registerCommand(
      'agentWrangler.pinConversation',
      app.withSession((k) => app.actions.openInTab(k)),
    ),
    vscode.commands.registerCommand('agentWrangler.renameConversation', app.withSession((k) => app.actions.rename(k))),
    vscode.commands.registerCommand('agentWrangler.pinToTop', app.withSession((k) => app.actions.togglePinned(k))),
    vscode.commands.registerCommand(
      'agentWrangler.resumeInTerminal',
      app.withSession((k) => app.actions.resume(k), (s) => s.status === 'ended'),
    ),
    vscode.commands.registerCommand('agentWrangler.copySessionId', app.withSession((k) => app.actions.copyId(k))),
    vscode.commands.registerCommand('agentWrangler.pauseAll', () => app.pauseAll(true)),
    vscode.commands.registerCommand('agentWrangler.resumeAll', () => app.pauseAll(false)),
    vscode.commands.registerCommand(
      'agentWrangler.pauseSession',
      app.withSession(
        (k) => app.actions.pauseSession(k, !app.pause.isPaused(app.store.get(k)?.pid)),
        (s) => s.status !== 'ended' && s.pid !== undefined,
      ),
    ),
    vscode.commands.registerCommand(
      'agentWrangler.revealTranscript',
      app.withSession((k) => app.actions.reveal(k), (s) => s.transcriptPath !== undefined),
    ),
    vscode.commands.registerCommand('agentWrangler.installHooks', () => void app.installHooks()),
    vscode.commands.registerCommand('agentWrangler.uninstallHooks', () => void app.uninstallHooks()),
  );

  app.start();
  watchForDevReload(context, log);

  // Open the dashboard for the window, so a day spent with agents starts on
  // the agents. A tab VSCode restored for us already counts: leave it exactly
  // where and how it came back rather than adding a second one.
  if (host.settings.get<boolean>('openOnStartup', true)) {
    setTimeout(() => {
      if (workbench.isOpen) return;
      workbench.open();
    }, STARTUP_OPEN_DELAY_MS);
  }
}

export function deactivate(): void {
  // everything is disposed via context.subscriptions
}
