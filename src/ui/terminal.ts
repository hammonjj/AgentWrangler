import * as fs from 'node:fs';
import { UUID_RE } from '../claude/paths';
import type { ConfigGetter } from '../core/config';
import type { HostShell } from '../host/hostServices';
import type { HostDialogs } from '../host/hostServices';
import { displayLabel, type AgentSession } from '../shared/model';

function quoteIfNeeded(bin: string): string {
  return /\s/.test(bin) ? `"${bin}"` : bin;
}

/**
 * Work out the `claude --resume` invocation for a session, or say why there
 * isn't one.
 *
 * Split from running it because running it is the part no host but VSCode can
 * do today: there is no `sendText` for a desktop shell, so `HostShell.
 * runInTerminal` is optional and this half stays useful either way — the
 * command is also what a "copy the command" fallback would offer.
 */
export function resumeCommand(
  session: AgentSession,
  getConfig: ConfigGetter,
): { command: string; cwd: string; name: string } | { error: string } {
  if (!UUID_RE.test(session.sessionId)) {
    return { error: `Agent Wrangler: invalid session id ${session.sessionId}` };
  }
  const cwd = session.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return { error: `Agent Wrangler: project folder no longer exists: ${cwd ?? '(unknown)'}` };
  }
  return {
    command: `${quoteIfNeeded(getConfig().claudeBinaryPath)} --resume ${session.sessionId}`,
    cwd,
    name: `claude: ${displayLabel(session).slice(0, 30)}`,
  };
}

/** Open a terminal at the session's cwd running `claude --resume <id>`. */
export function resumeInTerminal(
  session: AgentSession,
  getConfig: ConfigGetter,
  shell: HostShell,
  dialogs: HostDialogs,
): void {
  const plan = resumeCommand(session, getConfig);
  if ('error' in plan) {
    dialogs.error(plan.error);
    return;
  }
  if (!shell.runInTerminal) {
    dialogs.error('Agent Wrangler: this host has no terminal to hand the session to.');
    return;
  }
  shell.runInTerminal(plan.command, { cwd: plan.cwd, name: plan.name });
}
