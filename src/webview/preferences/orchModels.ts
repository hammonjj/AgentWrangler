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
import { effortMapText, type CatalogEntry } from '../../shared/orchestration/catalog';
import { harnessLabel, sourceLabel } from '../../shared/harness';
import { formatTokens } from '../../shared/sessionUsage';
import { DATA_LEAVES_MACHINE, isEndpointSource } from '../../shared/orchestration/localEndpoints';
import {
  buildBoard,
  localStatusFor,
  rowStatus,
  tierOptions,
  type BoardFilter,
  type BoardLane,
  type BoardRow,
} from '../../shared/orchestration/tierBoard';
import { button, el, fact, localContext, option, switchButton, tabHeader, type LocalContext, type Post } from './orchCommon';
import { ui } from './orchUi';

const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'routable', label: 'Routable' },
  { id: 'notRouted', label: 'Not routed' },
];

function costText(entry: CatalogEntry): string {
  const basis = entry.descriptor.costBasis === 'plan-window' ? 'plan window' : entry.descriptor.costBasis;
  switch (entry.costReporting) {
    case 'harness-estimate':
      return `${basis} · cost estimated by the agent`;
    case 'price-table': {
      const p = entry.descriptor.price!;
      return `${basis} · priced $${p.inPerMTok}/$${p.outPerMTok} per M tokens`;
    }
    default:
      return `${basis} · no price (add one to telemetry.prices)`;
  }
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

function renderDetail(entry: CatalogEntry, ctx: Ctx): HTMLElement {
  const d = entry.descriptor;
  const detail = el('div', 'aw-orch-row-detail');
  detail.id = `aw-orch-detail-${entry.key}`;
  const local = localOf(entry, ctx);
  if (local) {
    const ready = local.status.completions.ready || local.status.planning.ready || local.status.agentic.ready;
    detail.appendChild(el('p', `pf-model-status${ready ? ' ready' : ''}${local.status.agentic.completionOnly ? ' completion-only' : ''}`, local.status.text));
    detail.appendChild(el('p', 'pf-desc pf-model-fact', `Qualification: ${local.model?.qualification ?? 'stage 1 not run'}`));
    detail.appendChild(el('p', 'pf-desc pf-model-fact', local.model?.tasksRunning ?? local.model?.tasks ?? 'Tasks: stage 2 not run'));
  }
  const where = [
    sourceLabel(d.source),
    entry.harnesses.map(harnessLabel).join(', '),
    `called as ${entry.aliases.join(', ')}`,
  ].join(' · ');
  detail.appendChild(el('p', 'pf-desc pf-model-meta', where));
  if (entry.external) detail.appendChild(el('p', 'pf-endpoint-warning', `External endpoint: ${DATA_LEAVES_MACHINE}`));
  if (entry.completions && !entry.routable) detail.appendChild(el('p', 'pf-desc pf-model-fact', 'Serves structured completions directly (no harness).'));
  for (const line of [
    `Effort: ${effortMapText(entry)}`,
    `Context: ${fact(d.contextWindow, formatTokens)}`,
    `Max output: ${fact(d.maxOutputTokens, formatTokens)}`,
    `Vision: ${fact(d.vision, (v) => (v ? 'yes' : 'no'))}`,
    `Cost: ${costText(entry)}`,
  ]) {
    detail.appendChild(el('p', 'pf-desc pf-model-fact', line));
  }
  if (entry.stored) {
    const reset = button('Reset to default', () => ctx.post({ type: 'modelPolicy', change: { key: entry.key, reset: 'all' } }), 'aw-orch-btn');
    reset.dataset.focus = `reset:${entry.key}`;
    detail.appendChild(reset);
  }
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
  if (open) toggle.setAttribute('aria-controls', `aw-orch-detail-${entry.key}`);
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
