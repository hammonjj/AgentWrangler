/**
 * Preferences → Orchestration: the tier map (#29).
 *
 * Not rendered from `settings.ts`, because it is not a list of scalar
 * settings: it is one row per model the CLIs have reported, and the policy it
 * edits (`orchestration.models`) is keyed by model. Each change goes to the
 * host as one `modelPolicy` message; the host writes settings and sends the
 * rebuilt catalog back, so what is on screen is always what was stored.
 *
 * Unassigned models are listed first: they are the ones routing cannot use
 * until someone decides what they are for.
 */

import type { PreferencesToHost, OrchestrationPrefsView } from '../../shared/preferences';
import { effortMapText, isKnown, type CatalogEntry, type Known, type TierDef } from '../../shared/orchestration/catalog';
import type { SourceStatus } from '../../shared/orchestration/sourceHealth';
import { harnessLabel, sourceLabel } from '../../shared/harness';
import { formatTokens } from '../../shared/sessionUsage';
import { DATA_LEAVES_MACHINE, type LocalEndpointView } from '../../shared/orchestration/localEndpoints';
import { localSummaryText, type LocalModelSummary } from '../../shared/orchestration/localMetrics';

export const ORCHESTRATION_GROUP = 'Orchestration';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "200k (reported)", or "unknown": a fact never appears without where it came from. */
function fact<T>(k: Known<T>, format: (v: T) => string): string {
  return isKnown(k) ? `${format(k.value)} (${k.from})` : 'unknown';
}

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

function tierLabel(tier: TierDef): string {
  return tier.reachableBy === 'escalation' ? `${tier.name} (escalation only)` : tier.name;
}

function tierSelect(entry: CatalogEntry, tiers: TierDef[], post: (m: PreferencesToHost) => void): HTMLSelectElement {
  const select = el('select', 'pf-input pf-select pf-tier');
  select.setAttribute('aria-label', `Tier for ${entry.descriptor.label}`);
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

function renderEntry(entry: CatalogEntry, tiers: TierDef[], post: (m: PreferencesToHost) => void): HTMLElement {
  const d = entry.descriptor;
  const declared = entry.tierDeclared || entry.enabledDeclared;
  const row = el('div', `pf-model${entry.routable ? '' : ' notroutable'}${declared ? ' changed' : ''}`);

  const head = el('div', 'pf-model-head');
  const name = el('span', 'pf-label pf-model-name', d.label);
  const id = el('code', 'pf-key', d.resolvedId ?? d.modelId);
  id.title = d.description ?? '';

  const enabled = el('label', 'pf-model-enabled');
  const check = el('input', 'pf-check');
  check.type = 'checkbox';
  check.checked = entry.enabled;
  check.setAttribute('aria-label', `Route to ${d.label}`);
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

  row.append(head, controls, el('p', 'pf-desc pf-model-meta', where));
  if (entry.external) row.appendChild(el('p', 'pf-endpoint-warning', `External endpoint: ${DATA_LEAVES_MACHINE}`));
  if (entry.completions && !entry.routable) row.appendChild(el('p', 'pf-desc pf-model-fact', 'Serves structured completions directly (no harness).'));
  for (const line of facts) row.appendChild(el('p', 'pf-desc pf-model-fact', line));
  if (!entry.routable) row.appendChild(el('p', 'pf-model-why', `Not routed: ${entry.notRoutableBecause ?? 'Unassigned'}`));
  return row;
}

// ---------------------------------------------------------------------------
// Local endpoints (#51)
// ---------------------------------------------------------------------------

/** The last thing a local endpoint change said, kept across redraws until the next one. */
let localResult: { ok: boolean; lines: string[] } | undefined;

export function setLocalEndpointResult(result: { ok: boolean; lines: string[] }): void {
  localResult = result.lines.length > 0 ? result : undefined;
}

function button(label: string, onClick: () => void, className = 'pf-action'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderEndpoint(
  e: LocalEndpointView,
  summaries: LocalModelSummary[],
  secretsAvailable: boolean,
  post: (m: PreferencesToHost) => void,
): HTMLElement {
  const card = el('div', `pf-endpoint ${e.enabled ? e.health.state : 'off'}${e.warning ? ' external' : ''}`);
  const head = el('div', 'pf-model-head');
  head.append(el('span', 'pf-source-dot'), el('span', 'pf-label pf-model-name', e.name), el('code', 'pf-key', e.url));
  if (e.warning) head.appendChild(el('span', 'pf-endpoint-warning', `External: ${e.warning}`));
  card.appendChild(head);

  const controls = el('div', 'pf-model-controls');
  const enabled = el('label', 'pf-model-enabled');
  const check = el('input', 'pf-check');
  check.type = 'checkbox';
  check.checked = e.enabled;
  check.setAttribute('aria-label', `Use ${e.name}`);
  check.addEventListener('change', () => post({ type: 'localEndpoint', change: { op: 'enable', id: e.id, enabled: check.checked } }));
  enabled.append(check, document.createTextNode(e.warning ? `On (${e.warning})` : 'On'));
  controls.appendChild(enabled);
  const probe = button(e.busy ? 'Probing…' : 'Probe', () => post({ type: 'localEndpoint', change: { op: 'probe', id: e.id } }));
  probe.disabled = !!e.busy || !e.enabled;
  controls.appendChild(probe);
  if (e.hasKey) controls.appendChild(button('Remove key', () => post({ type: 'localEndpoint', change: { op: 'clearKey', id: e.id } })));
  else {
    const key = button('Set key…', () => post({ type: 'localEndpoint', change: { op: 'setKey', id: e.id } }));
    key.disabled = !secretsAvailable;
    if (!secretsAvailable) key.title = 'This system cannot encrypt secrets, so no key can be stored.';
    controls.appendChild(key);
  }
  controls.appendChild(button('Remove', () => post({ type: 'localEndpoint', change: { op: 'remove', id: e.id } }), 'pf-action danger'));
  card.appendChild(controls);

  const facts = [
    `${e.enabled ? e.health.state : 'off'} · ${e.health.reason}`,
    `Runtime: ${e.runtime ?? 'unknown'} · Slots: ${e.slots ?? 'unknown'} · Key: ${e.hasKey ? 'in the keychain' : 'none'}`,
    `Harness endpoints: ${e.routes}`,
  ];
  for (const line of facts) card.appendChild(el('p', 'pf-desc pf-model-fact', line));

  for (const m of e.models) {
    const row = el('div', 'pf-endpoint-model');
    row.append(el('span', 'pf-label', m.label), el('code', 'pf-key', m.id));
    const q = button(m.qualifying ? 'Qualifying…' : 'Qualify', () => post({ type: 'localEndpoint', change: { op: 'qualify', id: e.id, model: m.id } }));
    q.disabled = !!m.qualifying || !e.enabled;
    q.title = 'Runs 10 tool calls, 10 tool-result round trips and 20 JSON replies against this model (synthetic prompts). Sets tool calling and structured output to measured.';
    row.appendChild(q);
    card.appendChild(row);
    card.appendChild(el('p', 'pf-desc pf-model-fact', m.qualification ?? 'Not qualified: tool calling unknown, so it is not given agentic work.'));
    const s = summaries.find((x) => x.source === e.source && x.model === m.id);
    if (s) card.appendChild(el('p', 'pf-desc pf-model-fact', localSummaryText(s)));
  }
  if (e.enabled && e.models.length === 0) card.appendChild(el('p', 'pf-desc pf-empty', e.error ? `Not probed: ${e.error}` : 'No models listed yet.'));
  return card;
}

function renderLocal(
  host: HTMLElement,
  local: NonNullable<OrchestrationPrefsView['local']>,
  post: (m: PreferencesToHost) => void,
): void {
  host.appendChild(el('h3', 'pf-subhead', 'Local endpoints'));
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'OpenAI-compatible servers (Ollama, llama.cpp, vLLM, LM Studio, MLX). Their models appear in the tier map unassigned and are routed to only once you give them a tier. Agentic work goes through Codex and needs a server that serves /v1/responses and a model whose tool calls passed qualification; any model can answer structured completions once it has the weakest tier. An endpoint that is not on this machine is off by default: turning it on means data leaves this machine. Keys go in the system keychain, never in settings.json.',
    ),
  );
  const form = el('div', 'pf-endpoint-add');
  const url = el('input', 'pf-input pf-endpoint-url');
  url.type = 'text';
  url.placeholder = 'http://127.0.0.1:11434';
  url.setAttribute('aria-label', 'Endpoint URL');
  const name = el('input', 'pf-input pf-endpoint-name');
  name.type = 'text';
  name.placeholder = 'Name (optional)';
  name.setAttribute('aria-label', 'Endpoint name');
  const add = button('Add endpoint', () => {
    if (!url.value.trim()) return;
    post({ type: 'localEndpoint', change: { op: 'add', url: url.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) } });
  }, 'pf-action primary');
  form.append(url, name, add);
  host.appendChild(form);
  if (localResult) host.appendChild(el('pre', `pf-actionresult${localResult.ok ? '' : ' bad'}`, localResult.lines.join('\n')));
  const list = el('div', 'pf-endpoints');
  for (const e of local.endpoints) list.appendChild(renderEndpoint(e, local.summaries, local.secretsAvailable, post));
  if (local.endpoints.length === 0) list.appendChild(el('p', 'pf-desc pf-empty', 'No local endpoints registered.'));
  host.appendChild(list);
}

function renderSource(s: SourceStatus): HTMLElement {
  const row = el('div', `pf-source ${s.health.state}`);
  row.append(el('span', 'pf-source-dot'), el('span', 'pf-label', sourceLabel(s.source)), el('span', 'pf-desc pf-source-text', `${s.health.state} · ${s.health.reason}`));
  return row;
}

/** Fill `host` (the section's body) from the view, replacing what was there. */
export function renderOrchestration(host: HTMLElement, view: OrchestrationPrefsView | undefined, post: (m: PreferencesToHost) => void): void {
  host.textContent = '';
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'Every model the agents have reported, the capability tier Agent Wrangler gives it, and how its effort levels map. Routing only ever picks an enabled model with a tier; an unassigned one is never picked automatically. A tier is your policy, stored in settings.json under orchestration.models: changing it affects future routing only.',
    ),
  );
  if (!view) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'Loading…'));
    return;
  }

  host.appendChild(el('h3', 'pf-subhead', 'Sources'));
  const sources = el('div', 'pf-sources');
  for (const s of view.sources) sources.appendChild(renderSource(s));
  host.appendChild(sources);

  if (view.local) renderLocal(host, view.local, post);

  host.appendChild(el('h3', 'pf-subhead', 'Tier map'));
  if (view.catalog.entries.length === 0) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'No models reported yet. Start a Claude or Codex conversation and its models appear here.'));
    return;
  }
  const list = el('div', 'pf-models');
  for (const entry of view.catalog.entries) list.appendChild(renderEntry(entry, view.catalog.tiers, post));
  host.appendChild(list);
  host.appendChild(el('p', 'pf-desc pf-version', `Catalog version ${view.catalog.version}`));
}
