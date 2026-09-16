import * as vscode from 'vscode';
import type { ArchiveService } from '../core/archive';
import type { PauseService } from '../core/pauseService';
import type { SessionStore } from '../core/sessionStore';
import { etaText, formatDuration, workingElapsedMs, type AgentSession } from '../shared/model';

/** How far into its turn a busy agent is, for the "nothing needs you" tooltip. */
function progressNote(s: AgentSession): string {
  const p = s.progress;
  if (!p) return '';
  const elapsed = workingElapsedMs(p, Date.now());
  const parts = [`${formatDuration(elapsed)} in`];
  if (p.todo) parts.push(`${p.todo.completed}/${p.todo.total} done`);
  if (p.pace) {
    // Same figure as the dashboard's ETA column.
    parts.push(`ETA ${etaText(elapsed, p.pace.p50Ms, p.pace.p90Ms)}`);
  }
  return ` *(${parts.join(', ')})*`;
}

function appendDone(md: vscode.MarkdownString, done: AgentSession[], line: (s: AgentSession) => string): void {
  if (done.length === 0) return;
  md.appendMarkdown('\n**Done:**\n\n');
  for (const s of done.slice(0, 10)) md.appendMarkdown(`${line(s)}\n`);
}

export function createStatusBar(
  store: SessionStore,
  archive: ArchiveService,
  pause: PauseService,
  context: vscode.ExtensionContext,
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'agentWrangler.openDashboard';
  context.subscriptions.push(item);

  const render = () => {
    // Archived sessions are out of sight — they don't count toward the bell.
    // Paused ones are excluded for a different reason: a frozen agent's status
    // is a snapshot of the moment it was stopped, so a paused *blocked* session
    // would ring a bell for a prompt that nothing can act on until it is
    // resumed, and a paused *busy* one would be counted as work in progress.
    const visible = store.sessions.filter((s) => !archive.isArchived(s.key) && !pause.isPaused(s.key));
    const blocked = visible.filter((s) => s.status === 'blocked');
    const waiting = visible.filter((s) => s.status === 'waiting');
    const done = visible.filter((s) => s.status === 'done');
    const live = visible.filter((s) => s.status !== 'ended').length;
    if (live === 0) {
      item.hide();
      return;
    }
    if (blocked.length + waiting.length > 0) {
      // Blocked leads the label: those agents are frozen mid-task, whereas a
      // waiting one has finished its turn and is merely idle.
      item.text =
        blocked.length > 0
          ? `$(bell-dot) ${blocked.length} blocked${waiting.length > 0 ? `, ${waiting.length} waiting` : ''}`
          : `$(bell-dot) ${waiting.length} waiting`;
      item.backgroundColor = new vscode.ThemeColor(
        blocked.length > 0 ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground',
      );
      const md = new vscode.MarkdownString();
      const line = (s: (typeof visible)[number]) =>
        `- ${s.name ?? s.title}${s.name && s.title !== s.name ? ` — ${s.title}` : ''}`;
      if (blocked.length > 0) {
        md.appendMarkdown('**Blocked on you:**\n\n');
        for (const s of blocked.slice(0, 10)) {
          md.appendMarkdown(`${line(s)}${s.blockedReason ? ` *(${s.blockedReason})*` : ''}\n`);
        }
        if (waiting.length > 0) md.appendMarkdown('\n');
      }
      if (waiting.length > 0) {
        md.appendMarkdown('**Waiting:**\n\n');
        for (const s of waiting.slice(0, 10)) md.appendMarkdown(`${line(s)}\n`);
      }
      appendDone(md, done, line);
      item.tooltip = md;
    } else {
      // Done sessions are not "waiting on you" — a finished report needs
      // reading, not answering — so they never light the bell, but the tooltip
      // still says they are there.
      item.text = `$(bell) 0`;
      item.backgroundColor = undefined;
      const md = new vscode.MarkdownString();
      const busy = visible.filter((x) => x.status === 'busy');
      md.appendMarkdown(
        `**${busy.length} agent${busy.length === 1 ? '' : 's'} busy** — none waiting on you\n\n`,
      );
      for (const s of busy.slice(0, 10)) {
        md.appendMarkdown(`- ${s.name ?? s.title}${progressNote(s)}\n`);
      }
      appendDone(md, done, (s) => `- ${s.name ?? s.title}${s.name && s.title !== s.name ? ` — ${s.title}` : ''}`);
      item.tooltip = md;
    }
    item.show();
  };

  context.subscriptions.push(store.onDidUpdate(render));
  context.subscriptions.push(archive.onDidChange(render));
  context.subscriptions.push(pause.onDidChange(render));
  render();
}
