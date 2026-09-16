import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { UUID_RE } from '../claude/paths';
import type { ConfigGetter } from '../core/config';
import { displayLabel, type AgentSession } from '../shared/model';

function quoteIfNeeded(bin: string): string {
  return /\s/.test(bin) ? `"${bin}"` : bin;
}

/** Open a terminal at the session's cwd running `claude --resume <id>`. */
export function resumeInTerminal(session: AgentSession, getConfig: ConfigGetter): void {
  if (!UUID_RE.test(session.sessionId)) {
    void vscode.window.showErrorMessage(`Agent Wrangler: invalid session id ${session.sessionId}`);
    return;
  }
  const cwd = session.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    void vscode.window.showErrorMessage(`Agent Wrangler: project folder no longer exists: ${cwd ?? '(unknown)'}`);
    return;
  }
  const label = displayLabel(session).slice(0, 30);
  const terminal = vscode.window.createTerminal({ name: `claude: ${label}`, cwd });
  terminal.show();
  terminal.sendText(`${quoteIfNeeded(getConfig().claudeBinaryPath)} --resume ${session.sessionId}`, true);
}
