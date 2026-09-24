/**
 * What the menu-bar item and the OS notifications say (playbook Stage 6).
 *
 * Pure, so the wording and the ordering are tested; `src/electron/tray.ts`
 * only turns these into a `Tray` and a `Menu`.
 */

import type { SessionStatus } from '../shared/model';

/** The parts of a session the menu bar reads. `owned`: Agent Wrangler runs it. */
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

export interface MenuBarCounts {
  /** Working, including possibly stuck. */
  busy: number;
  /** Finished a turn with a question for you. */
  waiting: number;
  /** Held on a permission prompt. */
  blocked: number;
}

export interface MenuBarAgent {
  key: string;
  label: string;
  /** Status and project, for the line under the title. */
  detail: string;
  /** Agent Wrangler can end it: it runs it, or it knows the process. */
  stoppable: boolean;
}

/** Live and not shoved out of the way: the sessions the menu bar is about. */
function live(s: MenuBarSession): boolean {
  return s.status !== 'ended' && !s.archived;
}

export function menuBarCounts(sessions: readonly MenuBarSession[]): MenuBarCounts {
  const counts: MenuBarCounts = { busy: 0, waiting: 0, blocked: 0 };
  for (const s of sessions) {
    if (!live(s)) continue;
    if (s.status === 'busy' || s.status === 'stuck') counts.busy++;
    else if (s.status === 'waiting') counts.waiting++;
    else if (s.status === 'blocked') counts.blocked++;
  }
  return counts;
}

/**
 * The text beside the icon: how many agents need you, or nothing. Busy agents
 * are not counted — a number that is never zero is a number nobody reads.
 */
export function menuBarBadge(counts: MenuBarCounts): string {
  const n = counts.waiting + counts.blocked;
  return n > 0 ? String(n) : '';
}

/** "2 busy · 1 waiting · 1 needs permission", or "No agents running". */
export function menuBarSummary(counts: MenuBarCounts): string {
  const parts: string[] = [];
  if (counts.busy) parts.push(`${counts.busy} busy`);
  if (counts.waiting) parts.push(`${counts.waiting} waiting`);
  if (counts.blocked) parts.push(`${counts.blocked} ${counts.blocked === 1 ? 'needs' : 'need'} permission`);
  return parts.length ? parts.join(' · ') : 'No agents running';
}

const STATUS_WORD: Record<SessionStatus, string> = {
  blocked: 'Needs permission',
  waiting: 'Waiting on you',
  stuck: 'Possibly stuck',
  busy: 'Busy',
  done: 'Done',
  ended: 'Ended',
};

/** Needs you first, then working, then idle; newest-first order is kept within each. */
const ORDER: Record<SessionStatus, number> = { blocked: 0, waiting: 1, stuck: 2, busy: 2, done: 3, ended: 4 };

/** Past this the list is a scroll, and the window is the better place. */
export const MENU_BAR_AGENT_LIMIT = 15;

/** Every live session, in the order the menu lists them, and how many did not fit. */
export function menuBarAgents(
  sessions: readonly MenuBarSession[],
  limit = MENU_BAR_AGENT_LIMIT,
): { agents: MenuBarAgent[]; more: number } {
  const all = sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => live(s))
    .sort((a, b) => ORDER[a.s.status] - ORDER[b.s.status] || a.i - b.i)
    .map(({ s }) => ({
      key: s.key,
      label: s.title,
      detail: [
        s.status === 'blocked' && s.blockedReason ? `Needs permission for ${s.blockedReason}` : STATUS_WORD[s.status],
        s.projectName,
      ]
        .filter(Boolean)
        .join(' · '),
      stoppable: s.owned || s.pid !== undefined,
    }));
  return { agents: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/**
 * Whether to hold `powerSaveBlocker('prevent-app-suspension')`.
 *
 * Only while a session this app runs is working or holding a permission ask
 * (which Discord may answer, so the gateway heartbeat matters). The blocker
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
