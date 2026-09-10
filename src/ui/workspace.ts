import * as path from 'node:path';
import * as vscode from 'vscode';

/** True when the session cwd is one of this window's workspace folders (or inside one). */
export function isInThisWorkspace(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const target = path.resolve(cwd);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fp = path.resolve(folder.uri.fsPath);
    if (target === fp || target.startsWith(fp + path.sep)) return true;
  }
  return false;
}
