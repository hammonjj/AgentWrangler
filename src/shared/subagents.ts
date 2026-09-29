import type { SubagentInfo, SubagentSummary } from './model';

export function subagentText(counts: SubagentSummary | undefined): string {
  if (!counts) return '';
  return [
    counts.attention ? `${counts.attention} needs attention` : '',
    counts.working ? `${counts.working} working` : '',
    counts.done ? `${counts.done} done` : '',
  ].filter(Boolean).join(' · ');
}

/** Build a summary from a list of subagents, counting status. */
export function summaryFromList(list: SubagentInfo[] | undefined): SubagentSummary | undefined {
  if (!list || list.length === 0) return undefined;
  const summary: SubagentSummary = { working: 0, attention: 0, done: 0 };
  for (const item of list) {
    if (item.status === 'working') summary.working++;
    else if (item.status === 'attention') summary.attention++;
    else if (item.status === 'done') summary.done++;
  }
  return summary;
}

/** Sort subagents: attention first, then working, then done, then by activity (newest first). */
export function sortSubagents(list: SubagentInfo[]): SubagentInfo[] {
  const statusOrder = { attention: 0, working: 1, done: 2 };
  return [...list].sort((a, b) => {
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    // Within same status, sort by activity (newest first)
    const aActivity = a.lastActivityAt ?? 0;
    const bActivity = b.lastActivityAt ?? 0;
    return bActivity - aActivity;
  });
}
