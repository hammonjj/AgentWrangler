/**
 * The Analytics view: the table pane's fourth view (§17, §29 P10; #49).
 *
 * Draws `AnalyticsView` and turns a filter change or a click into a message
 * for the host. It computes nothing: every number, label and "not reported by
 * <harness>" arrives worked out by `shared/orchestration/analyticsView.ts`.
 * A click on a metric, the hosted/local split or a calibration row asks the
 * host to open that item's breakdown and evidence in the conversation pane.
 *
 * It lives in a pane that may be 300 px wide, so it is laid out from
 * `#app.narrow` (the pane's own width), never a media query: filters and cards
 * go to two columns and then one, and every text wraps rather than overflows.
 * No inline styles: bars are `<progress>` elements, sized by their values.
 */
import type { AnalyticsRef, AnalyticsSelection, AnalyticsView, BarView, CandidateView, MetricCardView, SelectionField } from '../../shared/orchestration/analyticsView';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The ref a clickable item carries, as an attribute. */
function refAttr(ref: AnalyticsRef): string {
  return ` data-aref="${esc(JSON.stringify(ref))}"`;
}

function barsHtml(bars: readonly BarView[]): string {
  return `<span class="an-bars">${bars
    .map((b) => `<span class="an-barrow"><span class="an-barlabel">${esc(b.label)}</span><progress class="an-bar" value="${b.count}" max="${Math.max(1, b.total)}"></progress><span class="an-bartext">${esc(b.text)}</span></span>`)
    .join('')}</span>`;
}

function cardHtml(c: MetricCardView): string {
  return `<button type="button" class="an-card${c.notReported ? ' an-nr' : ''}"${refAttr(c.ref)} title="Show the breakdown and evidence">
<span class="an-label">${esc(c.label)}</span><span class="an-value">${esc(c.value)}</span><span class="an-sub">${esc(c.sub)}</span>${c.bars && c.bars.length > 0 ? barsHtml(c.bars) : ''}</button>`;
}

function candidateHtml(c: CandidateView, heuristicLabel: string): string {
  return `<button type="button" class="an-cand"${refAttr(c.ref)} title="Show the evidence">
<span class="an-candtop"><span class="an-candtitle">${esc(c.title)}</span>${c.heuristic ? `<span class="an-heuristic">${esc(heuristicLabel)}</span>` : ''}<span class="an-evcount">${esc(c.evidence)}</span></span>
<span class="an-reason">${esc(c.reason)}</span><span class="an-triggers">${esc(c.triggers)}</span></button>`;
}

function filtersHtml(view: AnalyticsView): string {
  return `<div class="an-filters">${view.filters
    .map(
      (f) =>
        `<label class="an-filter"><span class="an-flabel">${esc(f.label)}</span><select data-an-filter="${f.field}">${f.options
          .map((o) => `<option value="${esc(o.value)}"${o.value === f.selected ? ' selected' : ''}>${esc(o.label)}</option>`)
          .join('')}</select></label>`,
    )
    .join('')}</div>`;
}

export function analyticsHtml(view: AnalyticsView | undefined): string {
  if (!view) return '<div class="analytics"><div class="an-empty">Reading telemetry…</div></div>';
  const cal = view.calibration;
  const split = `<button type="button" class="an-split"${refAttr(view.split.ref)} title="Show the breakdown and evidence">${view.split.rows
    .map((r) => `<span class="an-splitrow"><span class="an-splitlabel">${esc(r.label)}</span><span>${esc(r.attempts)}</span><span>${esc(r.success)}</span><span>${esc(r.cost)}</span></span>`)
    .join('')}</button>${view.split.note ? `<div class="an-note">${esc(view.split.note)}</div>` : ''}`;
  const list = (items: CandidateView[], none: string) => (items.length > 0 ? `<div class="an-cands">${items.map((c) => candidateHtml(c, cal.heuristicLabel)).join('')}</div>` : `<div class="an-note">${esc(none)}</div>`);
  const agreement = `<div class="an-cards an-agree">${cal.agreement
    .map((a) => `<button type="button" class="an-card"${refAttr(a.ref)} title="Show the evidence"><span class="an-label">${esc(a.label)}</span><span class="an-value">${esc(a.value)}</span><span class="an-sub">${esc(a.sub)}</span></button>`)
    .join('')}</div>`;
  return `<div class="analytics">
${filtersHtml(view)}
<div class="an-counts">${esc(view.counts)}</div>
${view.empty ? `<div class="an-empty">${esc(view.empty)}</div>` : ''}
<section class="an-sec"><h3>Headline</h3><div class="an-cards">${view.headline.map(cardHtml).join('')}</div></section>
<section class="an-sec"><h3>Hosted vs local</h3>${split}</section>
<section class="an-sec"><h3>Calibration</h3>
<h4>Under-routing <span class="an-hnote">needed a step or a rescue</span></h4>${list(cal.under, 'No task needed a tier or effort step or a rescue.')}
<h4>Over-routing <span class="an-heuristic">${esc(cal.heuristicLabel)}</span></h4><div class="an-note">${esc(cal.heuristicNote)}</div>${list(cal.over, 'No candidates.')}
<h4>Assessor agreement</h4>${agreement}
</section>
<details class="an-sec an-more"><summary>More metrics</summary><div class="an-cards">${view.more.map(cardHtml).join('')}</div></details>
</div>`;
}

/** The item a click in the view is about, if it was on one. */
export function analyticsClickRef(target: HTMLElement): AnalyticsRef | undefined {
  const el = target.closest<HTMLElement>('.analytics [data-aref]');
  if (!el?.dataset.aref) return undefined;
  try {
    return JSON.parse(el.dataset.aref) as AnalyticsRef;
  } catch {
    return undefined;
  }
}

/** The selection after a filter changed, or undefined if the change was not a filter. */
export function analyticsFilterChange(target: HTMLElement, selection: AnalyticsSelection): AnalyticsSelection | undefined {
  if (!(target instanceof HTMLSelectElement) || !target.closest('.analytics')) return undefined;
  const field = target.dataset.anFilter as SelectionField | undefined;
  if (!field) return undefined;
  const next: AnalyticsSelection = { ...selection };
  if (target.value === '') delete next[field];
  else (next as Record<string, string>)[field] = target.value;
  return next;
}
