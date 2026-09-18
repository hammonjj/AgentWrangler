import type { SubagentSummary } from '../shared/model';
import { rolloutStatus, type CodexRolloutSummary } from './rollout';

/** Follow explicit spawn ancestry only. Orphans and malformed cycles are never guessed. */
export function summarizeSubagents(
  summaries: CodexRolloutSummary[], now: number, stuckThresholdMs: number,
): Map<string, SubagentSummary> {
  const byId = new Map(summaries.map((s) => [s.sessionId.toLowerCase(), s]));
  const result = new Map<string, SubagentSummary>();
  for (const child of byId.values()) {
    if (!child.isSubagent || child.isGuardian) continue;
    const visited = new Set([child.sessionId.toLowerCase()]);
    let parentId = child.parentThreadId?.toLowerCase();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || parent.isGuardian) break;
      if (!parent.isSubagent) {
        const counts = result.get(parentId) ?? { working: 0, attention: 0, done: 0 };
        const status = rolloutStatus(child, now, stuckThresholdMs);
        if (status === 'busy') counts.working++;
        else if (status === 'done') counts.done++;
        else counts.attention++;
        result.set(parentId, counts);
        break;
      }
      parentId = parent.parentThreadId?.toLowerCase();
    }
  }
  return result;
}

export function visibleCodexSummaries(summaries: CodexRolloutSummary[], showSubagents: boolean): CodexRolloutSummary[] {
  return summaries.filter((s) => showSubagents || !s.isSubagent);
}
