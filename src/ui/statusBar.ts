import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { SessionStore } from '../core/sessionStore';

export function createStatusBar(store: SessionStore, archive: ArchiveService, context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'agentWrangler.openDashboard';
  context.subscriptions.push(item);

  const render = () => {
    // Archived sessions are out of sight — they don't count toward the bell.
    const visible = store.sessions.filter((s) => !archive.isArchived(s.key));
    const waiting = visible.filter((s) => s.status === 'waiting');
    const live = visible.filter((s) => s.status !== 'ended').length;
    if (live === 0) {
      item.hide();
      return;
    }
    if (waiting.length > 0) {
      item.text = `$(bell-dot) ${waiting.length} waiting`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      const md = new vscode.MarkdownString();
      md.appendMarkdown('**Waiting on you:**\n\n');
      for (const s of waiting.slice(0, 10)) {
        md.appendMarkdown(`- ${s.name ?? s.title}${s.name && s.title !== s.name ? ` — ${s.title}` : ''}\n`);
      }
      item.tooltip = md;
    } else {
      item.text = `$(bell) 0`;
      item.backgroundColor = undefined;
      item.tooltip = `${live} agent${live === 1 ? '' : 's'} busy — none waiting on you`;
    }
    item.show();
  };

  context.subscriptions.push(store.onDidUpdate(render));
  context.subscriptions.push(archive.onDidChange(render));
  render();
}
