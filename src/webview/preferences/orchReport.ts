/**
 * Orchestration → Shadow report (#42): what the router predicted, what ran,
 * and how it went. Read-only; it sends nothing. The same `ComparisonReport`
 * as before, laid out as stat tiles and real tables.
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import type { ComparisonReport, ComparisonTally } from '../../shared/orchestration/autoRouting';
import { el, tabHeader } from './orchCommon';

const DASH = '—';

function tile(value: string, label: string, mono = false): HTMLElement {
  const t = el('div', 'aw-orch-tile');
  t.append(el('span', mono ? 'aw-orch-tile-name' : 'aw-orch-tile-value', value), el('span', 'aw-orch-tile-label', label));
  return t;
}

/** A table with a caption, `<th scope="col">` headers and a scroll wrapper so a narrow pane scrolls the table, not the page. */
function table(caption: string, headers: string[], rows: (string | HTMLElement)[][], numericFrom = 1): HTMLElement {
  const wrap = el('div', 'aw-orch-tablewrap');
  const t = el('table', 'aw-orch-table');
  t.appendChild(el('caption', 'aw-orch-sr', caption));
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, i) => {
    const th = el('th', i >= numericFrom ? 'num' : undefined, h);
    th.scope = 'col';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((cell, i) => {
      const c = i === 0 ? el('th') : el('td', i >= numericFrom ? 'num' : undefined);
      if (i === 0) (c as HTMLTableCellElement).scope = 'row';
      if (typeof cell === 'string') {
        c.textContent = cell;
        if (cell === DASH) c.classList.add('none');
      } else c.appendChild(cell);
      tr.appendChild(c);
    });
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  return wrap;
}

function labelled(label: string, reading?: string): HTMLElement {
  const s = el('span', 'aw-orch-cell-stack');
  s.appendChild(el('span', undefined, label));
  if (reading) s.appendChild(el('span', 'aw-orch-cell-note', reading));
  return s;
}

export function renderReportTab(host: HTMLElement, view: OrchestrationPrefsView): void {
  host.appendChild(
    tabHeader(
      'Shadow report',
      'What the router predicted, what ran, and how it went, for every task with a recommendation. In manual mode the prediction is the shadow; in assisted mode it is the proposal.',
    ),
  );
  const report = view.routing?.report;
  if (!report) {
    host.appendChild(el('p', 'aw-orch-muted', 'The shadow report is not available.'));
    return;
  }
  if (report.rows.length === 0) {
    host.appendChild(el('p', 'aw-orch-empty', 'No routed tasks on record yet.'));
    return;
  }
  renderReport(host, report);
}

function renderReport(host: HTMLElement, report: ComparisonReport): void {
  const t = report.total;
  const tiles = el('div', 'aw-orch-tiles');
  tiles.append(
    tile(String(t.decisions), 'Decided'),
    tile(String(t.disagreements), 'Disagreed with what ran'),
    tile(String(t.passedFirst), 'Of those passed first time'),
    tile(String(t.neededEscalation), 'Needed escalation'),
  );
  host.appendChild(tiles);

  const where = el('section', 'aw-orch-section');
  where.appendChild(el('h4', 'aw-orch-h', 'Where they disagreed'));
  const patternRows = report.patterns.map((p) => [
    labelled(p.label, p.count > 0 ? p.reading : undefined),
    String(p.count),
    p.count === 0 ? DASH : String(p.passedFirst),
    p.count === 0 ? DASH : String(p.neededEscalation),
    p.count === 0 ? DASH : String(p.other),
  ]);
  patternRows.push([labelled('Sideways, same cost'), String(t.sideways), DASH, DASH, DASH]);
  where.appendChild(table('Where the router and what ran disagreed', ['Router wanted', 'Tasks', 'Passed 1st', 'Escalated', 'Other'], patternRows));
  host.appendChild(where);

  const kinds = el('section', 'aw-orch-section');
  kinds.appendChild(el('h4', 'aw-orch-h', 'By task kind'));
  const kindRow = (k: { kind: string } & ComparisonTally) => {
    const none = k.disagreements === 0;
    const v = (n: number) => (none ? DASH : String(n));
    return [k.kind, String(k.decisions), String(k.disagreements), v(k.routerCheaper), v(k.routerDearer), v(k.sideways), v(k.passedFirst), v(k.neededEscalation)];
  };
  kinds.appendChild(
    table('By task kind', ['Kind', 'Decided', 'Disagreed', 'Cheaper', 'Dearer', 'Sideways', 'Passed 1st', 'Escalated'], report.byKind.map(kindRow)),
  );
  kinds.appendChild(
    el('p', 'aw-orch-caption', 'Cheaper, dearer and sideways describe the router’s pick compared with the route that ran. Passed and escalated count the disagreements only.'),
  );
  host.appendChild(kinds);

  const dims = el('section', 'aw-orch-section');
  dims.appendChild(el('h4', 'aw-orch-h', 'By what changed'));
  if (report.byDimension.length === 0) dims.appendChild(el('p', 'aw-orch-muted', 'No route was changed from the recommendation.'));
  else {
    const grid = el('div', 'aw-orch-tiles');
    for (const d of report.byDimension) grid.appendChild(tile(d.dimension, `${d.count} changed · ${d.passedFirst} passed · ${d.neededEscalation} escalated`, true));
    dims.appendChild(grid);
  }
  host.appendChild(dims);
}
