import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Touched by `npm run install-local:reload` (opt-in) once the new build is installed. */
const RELOAD_MARKER = '.dev-reload';

/**
 * Development convenience: when this window has the Agent Wrangler repo itself
 * open, reload it when the marker is touched, so the change just made is on
 * screen without a trip through the command palette.
 *
 * Opt-in: the plain `install-local` never touches the marker. A reload ends
 * every Claude Code session running in the window, and the dev window usually
 * has several going, so an automatic reload cost more than it saved.
 *
 * Scoped to that one window on purpose. Every window runs this extension, and
 * reloading all of them on each build would tear down whatever else is going
 * on in them.
 *
 * Detection is by the folder's package.json name — nothing to configure, and
 * a clone at any path qualifies.
 */
export function watchForDevReload(context: vscode.ExtensionContext, log: (msg: string) => void): void {
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => isThisExtensionRepo(f.uri.fsPath));
  if (!folder) return;

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, RELOAD_MARKER));
  const reload = () => {
    log('install-local finished; reloading this window to load the new build');
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  context.subscriptions.push(watcher);
  log(`dev reload armed: touch ${path.join(folder.uri.fsPath, RELOAD_MARKER)} to reload this window`);
}

function isThisExtensionRepo(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === 'agent-wrangler';
  } catch {
    return false;
  }
}
