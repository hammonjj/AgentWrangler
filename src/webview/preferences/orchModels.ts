/**
 * Orchestration → Models: the tier board.
 *
 * Lanes by tier, weakest first, after a "Needs a tier" lane for models with
 * none. Everything shown is derived by `tierBoard.ts` from the catalog the
 * host sent — routability and its reasons are the catalog's and
 * `localModelStatus`'s, never worked out here. Each change is one
 * `modelPolicy` message; the host writes settings and sends the rebuilt
 * catalog, and the board redraws from what was stored.
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import { EFFORT_DEFAULT, type CatalogEntry } from '../../shared/orchestration/catalog';
import { sourceLabel } from '../../shared/harness';
import { DATA_LEAVES_MACHINE, isEndpointSource } from '../../shared/orchestration/localEndpoints';
import { PRICE_FIELDS, PRICE_KEY, parsePriceText, priceKeyFor, type PriceField } from '../../shared/orchestration/modelPrices';
import {
  buildBoard,
  effortEditor,
  localStatusFor,
  modelFacts,
  policyDiffText,
  priceNote,
  rowStatus,
  tierOptions,
  type BoardFilter,
  type BoardLane,
  type BoardRow,
} from '../../shared/orchestration/tierBoard';
import type { EffortLevel } from '../../shared/orchestration/types';
import { button, el, localContext, option, switchButton, tabHeader, type LocalContext, type Post } from './orchCommon';
import { ui, writeErrorKey } from './orchUi';

const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'routable', label: 'Routable' },
  { id: 'notRouted', label: 'Not routed' },
];

const PRICE_LABEL: Record<PriceField, string> = { input: 'Input', output: 'Output', cachedInput: 'Cached input' };

/** A stable, id-safe form of a catalog key (they carry `:` and `[`). */
function idPart(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

interface Ctx {
  view: OrchestrationPrefsView;
  post: Post;
  redraw: () => void;
  local: LocalContext;
}

function localOf(entry: CatalogEntry, ctx: Ctx) {
  return isEndpointSource(entry.descriptor.source)
    ? localStatusFor(entry, ctx.view.catalog.tiers, ctx.local.endpoints.get(entry.descriptor.source), ctx.local.harnessWarning)
    : undefined;
}

function tierSelect(entry: CatalogEntry, ctx: Ctx): HTMLSelectElement {
  const select = el('select', 'aw-orch-select aw-orch-tier');
  select.setAttribute('aria-label', `Tier for ${entry.descriptor.label}`);
  select.dataset.focus = `tier:${entry.key}`;
  const { options, value } = tierOptions(entry, ctx.view.catalog.tiers);
  for (const o of options) {
    const opt = option(select, o.value, o.label);
    if (o.disabled) opt.disabled = true;
  }
  select.value = value;
  select.addEventListener('change', () => {
    // Unassigned is `null`; the host stores it only where it differs from the default.
    ctx.post({ type: 'modelPolicy', change: { key: entry.key, tier: select.value === '' ? null : select.value } });
  });
  return select;
}

/** The host's refusal of a write to this control, as an inline alert; also marks the control. */
function writeError(entry: CatalogEntry, field: string, control?: HTMLElement): HTMLElement | undefined {
  const msg = ui.writeErrors[writeErrorKey(entry.key, field)];
  if (!msg) return undefined;
  const id = `aw-orch-err-${idPart(entry.key)}-${field.replace(/[^a-z]/gi, '')}`;
  const p = el('p', 'aw-orch-field-error', msg);
  p.id = id;
  p.setAttribute('role', 'alert');
  if (control) {
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', id);
  }
  return p;
}

function subhead(title: string, aside?: string): HTMLElement {
  const h = el('div', 'aw-orch-subhead');
  h.appendChild(el('h5', 'aw-orch-subhead-title', title));
  if (aside) h.appendChild(el('span', 'aw-orch-subhead-aside', aside));
  return h;
}

/** Local models: what it is ready for, its qualification, and the qualify message the Endpoints tab sends. */
function renderReadiness(entry: CatalogEntry, ctx: Ctx): HTMLElement | undefined {
  const local = localOf(entry, ctx);
  if (!local) return undefined;
  const s = local.status;
  const ready = s.completions.ready || s.planning.ready || s.agentic.ready;
  const box = el('div', 'aw-orch-readiness');
  const line = el('p', `aw-orch-readiness-line${ready ? ' ready' : ''}`, s.text);
  box.appendChild(line);
  const m = local.model;
  box.appendChild(el('p', 'aw-orch-muted', `Qualification: ${m?.qualification ?? 'stage 1 not run'}`));
  box.appendChild(el('p', 'aw-orch-muted', m?.tasksRunning ?? m?.tasks ?? 'Tasks: stage 2 not run'));
  const endpoint = ctx.local.endpoints.get(entry.descriptor.source);
  if (endpoint && m && (m.harnesses ?? []).includes('codex')) {
    const again = button(m.qualifying ? 'Qualifying…' : 'Re-run qualification', () => {
      ctx.post({ type: 'localEndpoint', change: { op: 'qualify', id: endpoint.id, model: m.id, harness: 'codex' } });
    }, 'aw-orch-btn');
    again.disabled = !!m.qualifying || !endpoint.enabled;
    again.dataset.focus = `qualify:${entry.key}`;
    box.appendChild(again);
  }
  return box;
}

function renderFacts(entry: CatalogEntry): HTMLElement {
  const grid = el('dl', 'aw-orch-facts');
  for (const f of modelFacts(entry)) {
    const cell = el('div', 'aw-orch-fact');
    const value = el('dd', 'aw-orch-fact-value', f.value);
    if (f.from) value.append(' ', el('span', 'aw-orch-provenance', f.from));
    cell.append(el('dt', 'aw-orch-fact-label', f.label), value);
    grid.appendChild(cell);
  }
  return grid;
}

function renderEffort(entry: CatalogEntry, ctx: Ctx): HTMLElement {
  const box = el('div', 'aw-orch-block');
  box.appendChild(subhead('Effort map', 'Agent Wrangler level → model level'));
  const editor = effortEditor(entry);
  if (editor.kind !== 'map') {
    box.appendChild(el('p', 'aw-orch-muted', editor.text));
    return box;
  }
  const send = (level: EffortLevel, native: string, isDefault: boolean) =>
    ctx.post({ type: 'modelPolicy', change: { key: entry.key, effort: { level, native: isDefault ? EFFORT_DEFAULT : native } } });
  for (const row of editor.rows) {
    const line = el('div', 'aw-orch-effort-row');
    const name = el('span', 'aw-orch-effort-level', row.level);
    name.id = `aw-orch-eff-${idPart(entry.key)}-${row.level}`;
    // Pills at 400px and wider; a select below, for the same choice.
    const pills = el('div', 'aw-orch-pills');
    pills.setAttribute('role', 'group');
    pills.setAttribute('aria-labelledby', name.id);
    const select = el('select', 'aw-orch-select aw-orch-effort-select');
    select.setAttribute('aria-label', `Effort ${row.level} maps to`);
    select.dataset.focus = `effortsel:${entry.key}:${row.level}`;
    for (const o of row.options) {
      const pill = button(o.native, () => {
        if (!o.selected && !o.pinOnly) send(row.level, o.native, o.isDefault);
      }, `aw-orch-pill${o.isDefault ? ' default' : ''}`);
      pill.setAttribute('aria-pressed', String(o.selected));
      pill.dataset.focus = `effort:${entry.key}:${row.level}:${o.native}`;
      if (o.pinOnly) {
        pill.disabled = true;
        pill.title = 'Reached only by a pin; set in settings.json';
      }
      if (o.isDefault) pill.setAttribute('aria-description', 'shipped default');
      pills.appendChild(pill);
      const opt = option(select, o.native, `${o.native}${o.isDefault ? ' — default' : ''}${o.pinOnly ? ' (pin only)' : ''}`);
      if (o.pinOnly) opt.disabled = true;
      if (o.selected) select.value = o.native;
    }
    select.addEventListener('change', () => {
      const o = row.options.find((x) => x.native === select.value);
      if (o) send(row.level, o.native, o.isDefault);
    });
    line.append(name, pills, select);
    box.appendChild(line);
    const err = writeError(entry, `effort:${row.level}`, pills);
    if (err) box.appendChild(err);
  }
  box.appendChild(el('p', 'aw-orch-caption', editor.note));
  return box;
}

function renderPrices(entry: CatalogEntry, ctx: Ctx): HTMLElement {
  const box = el('div', 'aw-orch-block');
  box.appendChild(subhead('Price', 'US$ per million tokens · telemetry.prices'));
  const table = ctx.view.prices ?? {};
  const stored = table[priceKeyFor(entry, table)];
  const grid = el('div', 'aw-orch-prices');
  const errors: HTMLElement[] = [];
  for (const field of PRICE_FIELDS) {
    const cell = el('div', 'aw-orch-price');
    const id = `aw-orch-price-${idPart(entry.key)}-${field}`;
    const label = el('label', 'aw-orch-price-label', PRICE_LABEL[field]);
    label.htmlFor = id;
    const input = el('input', 'aw-orch-input aw-orch-price-input');
    input.id = id;
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = 'none';
    input.dataset.focus = `price:${entry.key}:${field}`;
    const draftKey = writeErrorKey(entry.key, `price:${field}`);
    const saved = stored?.[PRICE_KEY[field]];
    input.value = ui.priceDrafts[draftKey] ?? (saved !== undefined ? String(saved) : '');
    const commit = () => {
      const parsed = parsePriceText(input.value);
      if (!parsed.ok) {
        ui.priceDrafts = { ...ui.priceDrafts, [draftKey]: input.value };
        ui.writeErrors = { ...ui.writeErrors, [draftKey]: parsed.error };
        ctx.redraw();
        return;
      }
      const hadDraft = draftKey in ui.priceDrafts;
      const drafts = { ...ui.priceDrafts };
      delete drafts[draftKey];
      ui.priceDrafts = drafts;
      const errs = { ...ui.writeErrors };
      delete errs[draftKey];
      ui.writeErrors = errs;
      // An unchanged value is not a write: tabbing through the fields must not rewrite them.
      if (parsed.value === (saved ?? null)) {
        if (hadDraft) ctx.redraw();
        return;
      }
      ctx.post({ type: 'modelPrice', change: { key: entry.key, field, usdPerMTok: parsed.value } });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    });
    cell.append(label, input);
    grid.appendChild(cell);
    const err = writeError(entry, `price:${field}`, input);
    if (err) errors.push(err);
  }
  box.appendChild(grid);
  for (const e of errors) box.appendChild(e);
  box.appendChild(el('p', 'aw-orch-caption', priceNote(entry, stored)));
  return box;
}

function renderDetail(entry: CatalogEntry, ctx: Ctx): HTMLElement {
  const detail = el('div', 'aw-orch-row-detail');
  detail.id = `aw-orch-detail-${idPart(entry.key)}`;
  const readiness = renderReadiness(entry, ctx);
  if (readiness) detail.appendChild(readiness);
  if (entry.external) detail.appendChild(el('p', 'aw-orch-field-error', `External endpoint: ${DATA_LEAVES_MACHINE}`));
  for (const field of ['tier', 'enabled', 'reset']) {
    const err = writeError(entry, field);
    if (err) detail.appendChild(err);
  }
  detail.appendChild(renderFacts(entry));
  detail.appendChild(renderEffort(entry, ctx));
  detail.appendChild(renderPrices(entry, ctx));

  const footer = el('div', 'aw-orch-diff');
  footer.appendChild(el('span', 'aw-orch-diff-text', policyDiffText(entry)));
  if (entry.stored) {
    // Removes this model's orchestration.models entry; its prices stay.
    const reset = button('Reset to default', () => ctx.post({ type: 'modelPolicy', change: { key: entry.key, reset: 'all' } }), 'aw-orch-btn');
    reset.dataset.focus = `reset:${entry.key}`;
    footer.appendChild(reset);
  }
  detail.appendChild(footer);
  return detail;
}

function renderRow(row: BoardRow, ctx: Ctx): HTMLElement {
  const { entry, status } = row;
  const d = entry.descriptor;
  const open = ui.expanded === entry.key;
  const wrap = el('div', 'aw-orch-row');
  wrap.dataset.modelKey = entry.key;
  wrap.dataset.expanded = String(open);
  wrap.dataset.enabled = String(entry.enabled);

  const main = el('div', 'aw-orch-row-main');
  const toggle = el('button', 'aw-orch-row-toggle');
  toggle.type = 'button';
  toggle.dataset.focus = `expand:${entry.key}`;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) toggle.setAttribute('aria-controls', `aw-orch-detail-${idPart(entry.key)}`);
  toggle.addEventListener('click', () => {
    ui.expanded = open ? undefined : entry.key;
    ctx.redraw();
  });
  const dot = el('span', 'aw-orch-dot');
  dot.dataset.tone = status.tone;
  dot.setAttribute('aria-hidden', 'true');
  const text = el('span', 'aw-orch-row-text');
  const line1 = el('span', 'aw-orch-row-line1');
  line1.append(el('span', 'aw-orch-row-label', d.label), el('span', 'aw-orch-chip', sourceLabel(d.source)));
  if (row.changed) line1.appendChild(el('span', 'aw-orch-chip aw-orch-chip-changed', 'Changed'));
  text.append(line1, el('span', 'aw-orch-row-id', d.resolvedId ?? d.modelId));
  if (status.reason) {
    const reason = el('span', 'aw-orch-row-reason', status.reason);
    reason.dataset.tone = status.tone;
    text.appendChild(reason);
  }
  toggle.append(el('span', 'aw-orch-chevron'), dot, text);

  const controls = el('div', 'aw-orch-row-controls');
  controls.append(
    tierSelect(entry, ctx),
    switchButton({
      label: `Enabled: ${d.label}`,
      pressed: entry.enabled,
      focusKey: `enabled:${entry.key}`,
      onToggle: () => ctx.post({ type: 'modelPolicy', change: { key: entry.key, enabled: !entry.enabled } }),
    }),
  );
  main.append(toggle, controls);
  wrap.appendChild(main);
  if (open) wrap.appendChild(renderDetail(entry, ctx));
  return wrap;
}

function renderLane(lane: BoardLane, ctx: Ctx): HTMLElement {
  const section = el('section', `aw-orch-lane${lane.kind === 'inbox' ? ' aw-orch-lane-inbox' : ''}${lane.escalation ? ' aw-orch-lane-escalation' : ''}`);
  section.setAttribute('aria-label', lane.kind === 'inbox' ? 'Needs a tier' : `Tier ${lane.title}`);
  const head = el('div', 'aw-orch-lane-head');
  if (lane.bars) {
    const meter = el('span', 'aw-orch-meter');
    meter.setAttribute('aria-hidden', 'true');
    lane.bars.forEach((lit, i) => {
      const bar = el('span', 'aw-orch-meter-bar');
      bar.dataset.bar = String(i);
      bar.dataset.lit = String(lit);
      meter.appendChild(bar);
    });
    head.appendChild(meter);
  } else {
    const inbox = el('span', 'aw-orch-inbox-icon');
    inbox.setAttribute('aria-hidden', 'true');
    head.appendChild(inbox);
  }
  const titles = el('div', 'aw-orch-lane-titles');
  const titleRow = el('div', 'aw-orch-lane-titlerow');
  titleRow.appendChild(el('h4', 'aw-orch-lane-title', lane.title));
  if (lane.escalation) titleRow.appendChild(el('span', 'aw-orch-tag', 'escalation only'));
  titles.append(titleRow, el('div', 'aw-orch-lane-sub', lane.sub));
  const count = el('div', `aw-orch-lane-count${lane.warn ? ' aw-orch-warn-text' : ''}`, lane.countText);
  head.append(titles, count);
  section.appendChild(head);
  if (lane.warn) section.appendChild(el('div', 'aw-orch-lane-warn', lane.warn));

  const rows = el('div', 'aw-orch-rows');
  for (const r of lane.rows) rows.appendChild(renderRow(r, ctx));
  section.appendChild(rows);
  if (lane.toggleText) {
    const more = button(lane.toggleText, () => {
      ui.showDisabled = { ...ui.showDisabled, [lane.key]: !lane.hiddenOpen };
      ctx.redraw();
    }, 'aw-orch-lane-more');
    more.setAttribute('aria-expanded', String(lane.hiddenOpen));
    more.dataset.focus = `more:${lane.key}`;
    section.appendChild(more);
  }
  return section;
}

function renderToolbar(counts: Record<BoardFilter, number>, redraw: () => void): HTMLElement {
  const bar = el('div', 'aw-orch-toolbar');
  const label = el('label', 'aw-orch-sr', 'Filter models');
  label.htmlFor = 'aw-orch-search';
  const search = el('input', 'aw-orch-input aw-orch-search');
  search.id = 'aw-orch-search';
  search.type = 'search';
  search.placeholder = 'Filter by name, id or alias';
  search.value = ui.query;
  search.dataset.focus = 'models:search';
  search.addEventListener('input', () => {
    ui.query = search.value;
    redraw();
  });
  const seg = el('div', 'aw-orch-segmented');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Show');
  for (const f of FILTERS) {
    const b = button(`${f.label} ${counts[f.id]}`, () => {
      ui.filter = f.id;
      redraw();
    }, 'aw-orch-seg');
    b.setAttribute('aria-pressed', String(ui.filter === f.id));
    b.dataset.focus = `filter:${f.id}`;
    seg.appendChild(b);
  }
  bar.append(label, search, seg);
  return bar;
}

export function renderModelsTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post, redraw: () => void): void {
  host.appendChild(
    tabHeader(
      'Models by tier',
      'A tier is your policy, not a fact about the model. The router works out the tier a task needs, then picks an enabled model in it. Changes apply to tasks that start afterwards.',
    ),
  );
  if (view.catalog.entries.length === 0) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'No models reported yet. Start a Claude or Codex conversation and its models appear here.'));
    return;
  }
  const ctx: Ctx = { view, post, redraw, local: localContext(view) };
  const board = buildBoard(view.catalog.entries, view.catalog.tiers, (e) => rowStatus(e, localOf(e, ctx)?.status), {
    query: ui.query,
    filter: ui.filter,
    showDisabled: ui.showDisabled,
    expanded: ui.expanded,
  });
  host.appendChild(renderToolbar(board.counts, redraw));
  const lanes = el('div', 'aw-orch-lanes');
  for (const lane of board.lanes) lanes.appendChild(renderLane(lane, ctx));
  if (board.lanes.length === 0) lanes.appendChild(el('p', 'aw-orch-empty', 'No models match this filter.'));
  host.appendChild(lanes);
  host.appendChild(el('p', 'aw-orch-version', `Catalog version ${view.catalog.version}`));
}
