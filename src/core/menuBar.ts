/**
 * The sessions as the app's ambient surfaces read them: whether to keep the
 * Mac awake, and what an OS notification says (playbook Stage 6). Named for
 * the menu-bar item they first served, which went with Electron (#142, D4:
 * the tab title carries the attention count now).
 *
 * Pure, so the wording is tested.
 */

import { displayTitle, type AgentSession, type SessionStatus } from '../shared/model';

/** The parts of the app `menuBarSessions` reads: structural, so core does not depend on `createApp`. */
export interface MenuBarSource {
  store: { readonly sessions: readonly AgentSession[] };
  archive: { isArchived(key: string): boolean };
  runners: { owns(sessionId: string): boolean };
  codexRunners: { owns(sessionId: string): boolean };
}

/**
 * The store's sessions as the power assertion reads them (#130).
 */
export function menuBarSessions(app: MenuBarSource): MenuBarSession[] {
  return app.store.sessions.map((s) => ({
    key: s.key,
    status: s.status,
    title: displayTitle(s),
    projectName: s.projectName,
    archived: app.archive.isArchived(s.key),
    owned: app.runners.owns(s.sessionId) || app.codexRunners.owns(s.sessionId),
    pid: s.pid,
    blockedReason: s.blockedReason,
  }));
}

/** The parts of a session read here. `owned`: Agent Wrangler runs it. */
export interface MenuBarSession {
  key: string;
  status: SessionStatus;
  /** `displayTitle`: the nickname when there is one. */
  title: string;
  projectName?: string;
  archived?: boolean;
  owned: boolean;
  pid?: number;
  blockedReason?: string;
}

/**
 * Whether to hold the daemon's power assertion (`caffeinate -i`, #130).
 *
 * Only while a session this app runs is working or holding a permission ask
 * (which Discord may answer, so the gateway heartbeat matters). The assertion
 * also stops idle system sleep (spike S2), so it is never held for an app
 * that is only watching.
 */
export function shouldPreventAppSuspension(sessions: readonly MenuBarSession[]): boolean {
  return sessions.some(
    (s) => s.owned && (s.status === 'busy' || s.status === 'stuck' || s.status === 'blocked'),
  );
}

/** An OS notification for a session that has just stopped for you, or `undefined` for none. */
export function attentionNotice(
  s: Pick<MenuBarSession, 'status' | 'title' | 'projectName' | 'blockedReason'>,
): { title: string; body: string } | undefined {
  const where = s.projectName ? ` · ${s.projectName}` : '';
  switch (s.status) {
    case 'blocked':
      return {
        title: 'Needs your permission',
        body: `${s.title}${s.blockedReason ? ` wants to use ${s.blockedReason}` : ''}${where}`,
      };
    case 'waiting':
      return { title: 'Waiting on you', body: `${s.title}${where}` };
    case 'done':
      return { title: 'Done', body: `${s.title}${where}` };
    default:
      return undefined;
  }
}
