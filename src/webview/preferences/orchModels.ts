/**
 * Orchestration → Models: the tier map (#29).
 *
 * One row per model the CLIs have reported. Each change goes to the host as
 * one `modelPolicy` message; the host writes settings and sends the rebuilt
 * catalog back, so what is on screen is always what was stored.
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import { effortMapText, type CatalogEntry, type TierDef } from '../../shared/orchestration/catalog';
import { harnessLabel, sourceLabel } from '../../shared/harness';
import { formatTokens } from '../../shared/sessionUsage';
import { DATA_LEAVES_MACHINE, isEndpointSource } from '../../shared/orchestration/localEndpoints';
import { localModelStatus } from '../../shared/orchestration/localReadiness';
import { el, fact, localContext, tierLabel, type LocalContext, type Post } from './orchCommon';

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

function tierSelect(entry: CatalogEntry, tiers: TierDef[], post: Post): HTMLSelectElement {
  const select = el('select', 'pf-input pf-select pf-tier');
  select.setAttribute('aria-label', `Tier for ${entry.descriptor.label}`);
  select.dataset.focus = `tier:${entry.key}`;
  const options: { value: string; label: string }[] = [
    { value: '', label: 'Unassigned' },
    ...tiers.map((t) => ({ value: t.name, label: tierLabel(t) })),
  ];
  const defaultValue = entry.defaultTier ?? '';
  for (const o of options) {
    const option = el('option', undefined, o.value === defaultValue ? `${o.label} — default` : o.label);
    option.value = o.value;
    select.appendChild(option);
  }
  select.value = entry.tier ?? '';
  select.addEventListener('change', () => {
    post({ type: 'modelPolicy', change: { key: entry.key, tier: select.value === '' ? null : select.value } });
  });
  return select;
}

/**
 * Beside a local model's tier picker: what it still needs for completions,
 * planning and agentic work (`localModelStatus`), then both qualification
 * stages' results. They inform the choice; nothing sets a tier from them.
 */
function renderLocalStatus(row: HTMLElement, entry: CatalogEntry, tiers: TierDef[], local: LocalContext): void {
  const endpoint = local.endpoints.get(entry.descriptor.source);
  if (!endpoint) return;
  const model = endpoint.models.find((m) => m.key === entry.key);
  const status = localModelStatus({
    entry,
    tiers,
    facts: {
      endpointOn: endpoint.enabled,
      health: endpoint.health.state,
      ...(endpoint.responses !== undefined ? { responses: endpoint.responses } : {}),
      ...(endpoint.messages !== undefined ? { messages: endpoint.messages } : {}),
      ...(model?.stage1 ? { stage1: model.stage1 } : {}),
      ...(model?.plannerWindowFits !== undefined ? { plannerWindowFits: model.plannerWindowFits } : {}),
    },
    ...(local.harnessWarning ? { harnessBlocked: local.harnessWarning } : {}),
  });
  const ready = status.completions.ready || status.planning.ready || status.agentic.ready;
  row.appendChild(el('p', `pf-model-status${ready ? ' ready' : ''}${status.agentic.completionOnly ? ' completion-only' : ''}`, status.text));
  row.appendChild(el('p', 'pf-desc pf-model-fact', `Qualification: ${model?.qualification ?? 'stage 1 not run'}`));
  row.appendChild(el('p', 'pf-desc pf-model-fact', model?.tasksRunning ?? model?.tasks ?? 'Tasks: stage 2 not run'));
}

function renderEntry(entry: CatalogEntry, tiers: TierDef[], post: Post, local: LocalContext): HTMLElement {
  const d = entry.descriptor;
  const declared = entry.tierDeclared || entry.enabledDeclared;
  const row = el('div', `pf-model${entry.routable ? '' : ' notroutable'}${declared ? ' changed' : ''}`);
  row.dataset.modelKey = entry.key;

  const head = el('div', 'pf-model-head');
  const name = el('span', 'pf-label pf-model-name', d.label);
  const id = el('code', 'pf-key', d.resolvedId ?? d.modelId);
  id.title = d.description ?? '';

  const enabled = el('label', 'pf-model-enabled');
  const check = el('input', 'pf-check');
  check.type = 'checkbox';
  check.checked = entry.enabled;
  check.setAttribute('aria-label', `Route to ${d.label}`);
  check.dataset.focus = `enabled:${entry.key}`;
  check.addEventListener('change', () => post({ type: 'modelPolicy', change: { key: entry.key, enabled: check.checked } }));
  enabled.append(check, document.createTextNode('Enabled'));

  const reset = el('button', 'pf-reset', 'Reset');
  reset.type = 'button';
  reset.title = `Back to ${entry.defaultTier ?? 'unassigned'}${entry.excluded ? ', disabled' : ''}`;
  reset.addEventListener('click', () => post({ type: 'modelPolicy', change: { key: entry.key, reset: 'all' } }));

  head.append(name, id, reset);

  const controls = el('div', 'pf-model-controls');
  controls.append(tierSelect(entry, tiers, post), enabled);

  const where = [
    sourceLabel(d.source),
    entry.harnesses.map(harnessLabel).join(', '),
    entry.aliases.length > 1 ? `called as ${entry.aliases.join(', ')}` : `called as ${entry.aliases[0]}`,
  ].join(' · ');

  const facts = [
    `Effort: ${effortMapText(entry)}`,
    `Context: ${fact(d.contextWindow, formatTokens)}`,
    `Max output: ${fact(d.maxOutputTokens, formatTokens)}`,
    `Vision: ${fact(d.vision, (v) => (v ? 'yes' : 'no'))}`,
    `Cost: ${costText(entry)}`,
  ];

  row.append(head, controls);
  if (isEndpointSource(d.source)) renderLocalStatus(row, entry, tiers, local);
  row.appendChild(el('p', 'pf-desc pf-model-meta', where));
  if (entry.external) row.appendChild(el('p', 'pf-endpoint-warning', `External endpoint: ${DATA_LEAVES_MACHINE}`));
  if (entry.completions && !entry.routable) row.appendChild(el('p', 'pf-desc pf-model-fact', 'Serves structured completions directly (no harness).'));
  for (const line of facts) row.appendChild(el('p', 'pf-desc pf-model-fact', line));
  if (!entry.routable) row.appendChild(el('p', 'pf-model-why', `Not routed: ${entry.notRoutableBecause ?? 'Unassigned'}`));
  return row;
}

export function renderModelsTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post): void {
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'Every model the agents have reported, the capability tier Agent Wrangler gives it, and how its effort levels map. Routing only ever picks an enabled model with a tier; an unassigned one is never picked automatically. A tier is your policy, stored in settings.json under orchestration.models: changing it affects future routing only.',
    ),
  );
  host.appendChild(el('h3', 'pf-subhead', 'Tier map'));
  if (view.catalog.entries.length === 0) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'No models reported yet. Start a Claude or Codex conversation and its models appear here.'));
    return;
  }
  const local = localContext(view);
  const list = el('div', 'pf-models');
  for (const entry of view.catalog.entries) list.appendChild(renderEntry(entry, view.catalog.tiers, post, local));
  host.appendChild(list);
  host.appendChild(el('p', 'pf-desc pf-version', `Catalog version ${view.catalog.version}`));
}
