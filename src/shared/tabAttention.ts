/**
 * What the browser tab says about agents that need you (#144): the count in
 * the title and the badge on the favicon. Pure, so the wording is tested.
 */

import type { SessionStatus } from './model';

/**
 * Agents that need you: sessions blocked on a prompt or waiting on you
 * (archived ones excluded, as `aw status` excludes them), plus the missions
 * the host counts as asking for you.
 */
export function attentionTotal(sessions: readonly { status: SessionStatus; archived?: boolean }[], missionAttention = 0): number {
  const rows = sessions.filter((s) => !s.archived && (s.status === 'blocked' || s.status === 'waiting')).length;
  return rows + missionAttention;
}

/** `(2) Agents · Agent Wrangler`, or without the count when nothing needs you. */
export function tabTitle(routeTitle: string, count: number): string {
  return `${count > 0 ? `(${count}) ` : ''}${routeTitle} · Agent Wrangler`;
}

/** What the badge draws: the number, `9+` past nine, nothing at zero. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}
