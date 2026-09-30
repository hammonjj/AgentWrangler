/**
 * Orchestration → Shadow report (#42): what the router predicted, what ran,
 * and how it went. Read-only; it sends nothing.
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import type { ComparisonReport } from '../../shared/orchestration/autoRouting';
import { el } from './orchCommon';

function tallyText(t: { decisions: number; disagreements: number; routerCheaper: number; routerDearer: number; sideways: number; passedFirst: number; neededEscalation: number }): string {
  if (t.disagreements === 0) return `${t.decisions} decided · no disagreement`;
  return `${t.decisions} decided · ${t.disagreements} disagreed (router cheaper ${t.routerCheaper}, dearer ${t.routerDearer}, sideways ${t.sideways}) · of those ${t.passedFirst} passed first time, ${t.neededEscalation} needed escalation`;
}

export function renderReportTab(host: HTMLElement, view: OrchestrationPrefsView): void {
  const report = view.routing?.report;
  if (!report) {
    host.appendChild(el('h3', 'pf-subhead', 'Shadow comparison'));
    host.appendChild(el('p', 'pf-desc pf-empty', 'The shadow report is not available.'));
    return;
  }
  renderReport(host, report);
}

function renderReport(host: HTMLElement, report: ComparisonReport): void {
  host.appendChild(el('h3', 'pf-subhead', 'Shadow comparison'));
  host.appendChild(
    el('p', 'pf-desc', 'What the router predicted, what ran, and how it went, for every task with a recommendation. In manual mode the prediction is the shadow; in assisted mode it is the proposal.'),
  );
  if (report.rows.length === 0) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'No routed tasks on record yet.'));
    return;
  }
  host.appendChild(el('p', 'pf-desc', tallyText(report.total)));
  const patterns = el('div', 'pf-report');
  for (const p of report.patterns) {
    const row = el('div', 'pf-report-row');
    row.append(el('span', 'pf-label', p.label), el('span', 'pf-desc pf-report-value', p.count === 0 ? 'none' : `${p.count} · ${p.passedFirst} passed first time · ${p.neededEscalation} needed escalation · ${p.other} other`));
    patterns.appendChild(row);
    if (p.count > 0) patterns.appendChild(el('p', 'pf-desc pf-gate-detail', p.reading));
  }
  host.appendChild(patterns);

  host.appendChild(el('div', 'pf-policy-group', 'By kind'));
  const kinds = el('div', 'pf-report');
  for (const k of report.byKind) {
    const row = el('div', 'pf-report-row');
    row.append(el('span', 'pf-label', k.kind), el('span', 'pf-desc pf-report-value', tallyText(k)));
    kinds.appendChild(row);
  }
  host.appendChild(kinds);

  host.appendChild(el('div', 'pf-policy-group', 'By dimension changed'));
  const dims = el('div', 'pf-report');
  if (report.byDimension.length === 0) dims.appendChild(el('p', 'pf-desc pf-empty', 'No route was changed from the recommendation.'));
  for (const d of report.byDimension) {
    const row = el('div', 'pf-report-row');
    row.append(el('span', 'pf-label', d.dimension), el('span', 'pf-desc pf-report-value', `${d.count} changed · ${d.passedFirst} passed first time · ${d.neededEscalation} needed escalation`));
    dims.appendChild(row);
  }
  host.appendChild(dims);
}
