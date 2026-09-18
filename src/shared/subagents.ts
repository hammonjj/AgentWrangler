import type { SubagentSummary } from './model';

export function subagentText(counts: SubagentSummary | undefined): string {
  if (!counts) return '';
  return [
    counts.attention ? `${counts.attention} needs attention` : '',
    counts.working ? `${counts.working} working` : '',
    counts.done ? `${counts.done} done` : '',
  ].filter(Boolean).join(' · ');
}
