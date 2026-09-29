/**
 * The conversation pane's one non-session mode (#49): an Analytics item's
 * breakdown and evidence, drawn over the conversation after a click in the
 * table pane. Everything shown arrives worked out in `AnalyticsDetail`
 * (`shared/orchestration/analyticsView.ts`); this only lays it out, with
 * `textContent`, never HTML from the message.
 */
import type { AnalyticsDetail } from '../../shared/orchestration/analyticsView';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Fill `root` with the detail. `onClose`: the Back button, shown when there is a conversation to go back to. */
export function renderAnalyticsDetail(root: HTMLElement, detail: AnalyticsDetail, onClose: (() => void) | undefined): void {
  root.replaceChildren();
  const head = el('div', 'ad-head');
  const titleRow = el('div', 'ad-titlerow');
  titleRow.appendChild(el('span', 'ad-title', detail.title));
  if (detail.heuristic) titleRow.appendChild(el('span', 'ad-heuristic', detail.heuristic));
  if (onClose) {
    const back = el('button', 'ad-back', 'Back to the conversation');
    back.type = 'button';
    back.addEventListener('click', onClose);
    titleRow.appendChild(back);
  }
  head.appendChild(titleRow);
  head.appendChild(el('div', 'ad-subtitle', detail.subtitle));
  root.appendChild(head);

  const body = el('div', 'ad-body');
  if (detail.facts.length > 0) {
    const facts = el('dl', 'ad-facts');
    for (const f of detail.facts) {
      facts.appendChild(el('dt', 'ad-fact', f.label));
      facts.appendChild(el('dd', 'ad-factvalue', f.value));
    }
    body.appendChild(facts);
  }
  for (const b of detail.breakdowns) {
    const sec = el('section', 'ad-sec');
    sec.appendChild(el('h3', 'ad-h', b.title));
    const table = el('table', 'ad-table');
    for (const r of b.rows) {
      const tr = el('tr', 'ad-row');
      tr.appendChild(el('td', 'ad-key', r.key));
      tr.appendChild(el('td', 'ad-val', r.value));
      tr.appendChild(el('td', 'ad-sub', r.sub));
      table.appendChild(tr);
    }
    sec.appendChild(table);
    body.appendChild(sec);
  }
  const ev = el('section', 'ad-sec');
  ev.appendChild(
    el('h3', 'ad-h', detail.evidenceTotal > detail.evidence.length ? `Evidence (first ${detail.evidence.length} of ${detail.evidenceTotal})` : `Evidence (${detail.evidenceTotal})`),
  );
  if (detail.evidence.length === 0) ev.appendChild(el('div', 'ad-none', 'No records.'));
  const list = el('ul', 'ad-evidence');
  for (const e of detail.evidence) {
    const li = el('li', 'ad-ev');
    li.appendChild(el('span', 'ad-evsummary', e.summary));
    li.appendChild(el('span', 'ad-evmeta', `${e.type} · ${e.when} · ${e.id}`));
    list.appendChild(li);
  }
  ev.appendChild(list);
  body.appendChild(ev);
  root.appendChild(body);
}
