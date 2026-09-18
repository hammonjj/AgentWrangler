/**
 * `HostServices` over the VSCode API.
 *
 * Nothing here decides anything — every method is a one-line translation of an
 * interface method into the editor's version of it. That is the test of whether
 * the seam is in the right place: if something in this file had to make a
 * judgement about sessions, the judgement belongs in `createApp` instead.
 */

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Disposable } from '../../core/events';
import type {
  HostDialogs,
  HostServices,
  HostSettings,
  HostShell,
  HostStorage,
  InputOptions,
  MessageOptions,
  PickItem,
  PickOptions,
} from '../hostServices';

const SECTION = 'agentWrangler';

function settingsFor(context: vscode.ExtensionContext): HostSettings {
  return {
    get: <T>(key: string, defaultValue: T) =>
      vscode.workspace.getConfiguration(SECTION).get<T>(key, defaultValue),
    update: async (key, value) => {
      // Global, not workspace: every setting here is about the machine's agents
      // rather than about one project, and the app that is coming has no
      // workspace to scope them to.
      await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
    },
    onDidChange: (listener) => {
      const sub = vscode.workspace.onDidChangeConfiguration((e) =>
        listener((key) => e.affectsConfiguration(`${SECTION}.${key}`)),
      );
      context.subscriptions.push(sub);
      return sub;
    },
  };
}

/** `vscode.Memento` already has this shape; the cast is only to drop `keys()`. */
function storageFor(memento: vscode.Memento): HostStorage {
  return {
    get: <T>(key: string, defaultValue: T) => memento.get<T>(key, defaultValue),
    update: (key, value) => memento.update(key, value),
  };
}

function dialogsFor(): HostDialogs {
  return {
    info: (message, ...items) => Promise.resolve(vscode.window.showInformationMessage(message, ...items)),
    warn: (message, options: MessageOptions, ...items) =>
      Promise.resolve(vscode.window.showWarningMessage(message, options, ...items)),
    error: (message) => {
      void vscode.window.showErrorMessage(message);
    },
    flash: (message, timeoutMs = 4000) => {
      vscode.window.setStatusBarMessage(message, timeoutMs);
    },
    input: (options: InputOptions) =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: options.title,
          prompt: options.prompt,
          value: options.value,
          placeHolder: options.placeHolder,
          validateInput: options.validateInput,
        }),
      ),
    pick: <T extends PickItem>(items: T[], options?: PickOptions) =>
      Promise.resolve(vscode.window.showQuickPick<T & vscode.QuickPickItem>(items as (T & vscode.QuickPickItem)[], options)),
    pickFolder: async (options) => {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: options?.openLabel,
      });
      return chosen?.[0]?.fsPath;
    },
  };
}

function shellFor(): HostShell {
  return {
    openExternal: (url) => {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    },
    revealInFileManager: (target) => {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    },
    openFile: (target) => {
      void vscode.workspace.openTextDocument(vscode.Uri.file(target)).then(
        (doc) => vscode.window.showTextDocument(doc, { preview: true }),
        () => vscode.window.setStatusBarMessage(`Agent Wrangler: cannot open ${target}`, 4000),
      );
    },
    // The one host that has a real one. Everything reached through this is
    // offered only when it is present — see `HostShell.runInTerminal`.
    runInTerminal: (command, { cwd, name }) => {
      const terminal = vscode.window.createTerminal({ name, cwd });
      terminal.show();
      terminal.sendText(command, true);
    },
  };
}

export function createVscodeHost(context: vscode.ExtensionContext, log: (message: string) => void): HostServices {
  // `FileUsageCache` writes into this and VSCode does not promise it exists
  // until something asks for it.
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  return {
    appName: 'Agent Wrangler',
    log,
    settings: settingsFor(context),
    globalState: storageFor(context.globalState),
    // Per window, deliberately: two windows sharing one runner record would
    // both resume the same session id, and two processes on one id corrupt its
    // transcript. See the header of `runnerRegistry.ts`.
    workspaceState: storageFor(context.workspaceState),
    storageDir: context.globalStorageUri.fsPath,
    dialogs: dialogsFor(),
    shell: shellFor(),
    clipboard: { writeText: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)) },
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    subscribe: (disposable: Disposable) => context.subscriptions.push(disposable),
  };
}
