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

import { routingPolicyUpdate, type PreferencesToHost, type OrchestrationPrefsView } from '../../shared/preferences';
import { effortMapText, isKnown, type CatalogEntry, type Known, type TierDef } from '../../shared/orchestration/catalog';
import { POLICY_FIELDS, fieldValue, withField, type PolicyFieldSpec, type PolicyValue } from '../../shared/orchestration/executionPolicy';
import { EFFORT_LEVELS, type ExecutionPolicy } from '../../shared/orchestration/types';
import type { SourceStatus } from '../../shared/orchestration/sourceHealth';
import { harnessLabel, sourceLabel } from '../../shared/harness';
import { formatTokens } from '../../shared/sessionUsage';

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
  for (const line of facts) row.appendChild(el('p', 'pf-desc pf-model-fact', line));
  if (!entry.routable) row.appendChild(el('p', 'pf-model-why', `Not routed: ${entry.notRoutableBecause ?? 'Unassigned'}`));
  return row;
}

function renderSource(s: SourceStatus): HTMLElement {
  const row = el('div', `pf-source ${s.health.state}`);
  row.append(el('span', 'pf-source-dot'), el('span', 'pf-label', sourceLabel(s.source)), el('span', 'pf-desc pf-source-text', `${s.health.state} · ${s.health.reason}`));
  return row;
}

// ---------------------------------------------------------------------------
// Routing defaults: the global scope of pins and caps (#40)
// ---------------------------------------------------------------------------

type RoutingDraft = { mode: 'manual' | 'assisted'; policy: ExecutionPolicy };

/** What the user set and has not had confirmed yet; kept across redraws so a refused value stays on screen. */
let routingDraft: RoutingDraft | undefined;
let routingErrors: string[] = [];
let routingStatus = '';

/** The host saved the defaults, or refused them. Call `renderOrchestration` after. */
export function onRoutingResult(ok: boolean, errors: string[]): void {
  if (ok) {
    routingDraft = undefined;
    routingErrors = [];
    routingStatus = 'Saved. Applies to tasks started from now on.';
  } else {
    routingErrors = errors;
    routingStatus = '';
  }
}

function option(select: HTMLSelectElement, value: string, label: string): void {
  const o = el('option', undefined, label);
  o.value = value;
  select.appendChild(o);
}

function renderRouting(host: HTMLElement, view: OrchestrationPrefsView, post: (m: PreferencesToHost) => void, redraw: () => void): void {
  const stored = view.routing;
  if (!stored) return;
  const current: RoutingDraft = routingDraft ?? { mode: stored.mode, policy: stored.policy };
  host.appendChild(el('h3', 'pf-subhead', 'Routing defaults'));
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'The global scope. A repository’s policy, a mission and a task can each override these: the more specific scope wins, but a cap can only be tightened, never loosened. A pin that breaks a cap is refused when it is set. Each task freezes these when it starts.',
    ),
  );

  const commit = (next: RoutingDraft) => {
    routingDraft = next;
    routingStatus = '';
    // The same check the host runs, so a pin above a cap is refused here and now.
    const r = routingPolicyUpdate({ type: 'routingPolicy', ...next }, view.catalog);
    if (!r.ok) {
      routingErrors = r.errors;
      redraw();
      return;
    }
    routingErrors = [];
    routingStatus = 'Saving…';
    post({ type: 'routingPolicy', mode: next.mode, policy: next.policy });
    redraw();
  };
  const set = (field: string, value: PolicyValue | undefined) => {
    let policy = withField(current.policy, field, value);
    if (field === 'pins.model' && typeof value === 'string' && !fieldValue(policy, 'pins.harness')) {
      const entry = view.catalog.entries.find((e) => e.aliases.includes(value));
      if (entry?.harnesses[0]) policy = withField(policy, 'pins.harness', entry.harnesses[0]);
    }
    commit({ mode: current.mode, policy });
  };

  const form = el('div', 'pf-policy');
  const modeRow = el('div', 'pf-policy-row');
  const modeSelect = el('select', 'pf-input pf-select');
  modeSelect.setAttribute('aria-label', 'Routing mode');
  option(modeSelect, 'manual', 'Manual — run on the launcher’s route');
  option(modeSelect, 'assisted', 'Assisted — propose a route, wait for a click');
  modeSelect.value = current.mode;
  modeSelect.addEventListener('change', () => commit({ mode: modeSelect.value === 'assisted' ? 'assisted' : 'manual', policy: current.policy }));
  modeRow.append(el('span', 'pf-label pf-policy-label', 'Mode'), modeSelect);
  form.appendChild(modeRow);

  let group = '';
  for (const spec of POLICY_FIELDS) {
    if (spec.group !== group) {
      group = spec.group;
      form.appendChild(el('div', 'pf-policy-group', group));
    }
    const row = el('div', 'pf-policy-row');
    const value = fieldValue(current.policy, spec.field);
    row.appendChild(el('span', 'pf-label pf-policy-label', spec.label));
    row.appendChild(policyControl(spec, value, view, set));
    row.appendChild(el('span', 'pf-desc pf-policy-help', spec.help));
    form.appendChild(row);
  }
  host.appendChild(form);

  for (const e of routingErrors) host.appendChild(el('p', 'pf-policy-error', e));
  for (const e of stored.ignored) host.appendChild(el('p', 'pf-policy-error', `Ignored in settings.json — ${e}`));
  if (routingStatus) host.appendChild(el('p', 'pf-desc pf-policy-status', routingStatus));
}

function policyControl(spec: PolicyFieldSpec, value: PolicyValue | undefined, view: OrchestrationPrefsView, set: (field: string, v: PolicyValue | undefined) => void): HTMLElement {
  const label = `${spec.group}: ${spec.label}`;
  const select = (options: [string, string][]) => {
    const s = el('select', 'pf-input pf-select');
    s.setAttribute('aria-label', label);
    option(s, '', '— not set');
    for (const [v, text] of options) option(s, v, text);
    s.value = value === undefined ? '' : String(value);
    s.addEventListener('change', () => set(spec.field, s.value === '' ? undefined : s.value));
    return s;
  };
  switch (spec.kind) {
    case 'tier':
      return select(view.catalog.tiers.map((t) => [t.name, tierLabel(t)]));
    case 'effort':
      return select(EFFORT_LEVELS.map((l) => [l, l]));
    case 'location':
      return select([
        ['local-only', 'Local only'],
        ['hosted-only', 'Hosted only'],
      ]);
    case 'harness':
      return select(POLICY_HARNESSES.map((h) => [h, harnessLabel(h)]));
    case 'model': {
      const entries = view.catalog.entries.filter((e) => e.enabled);
      const options: [string, string][] = entries.map((e) => [e.aliases[0] ?? e.descriptor.modelId, `${e.descriptor.label} (${e.tier ?? 'unassigned'})`]);
      // A pinned model the catalog no longer lists is still shown, so it can be cleared.
      if (typeof value === 'string' && !options.some(([v]) => v === value)) options.push([value, `${value} (not reported)`]);
      return select(options);
    }
    case 'flag': {
      const c = el('input', 'pf-check');
      c.type = 'checkbox';
      c.checked = value === true;
      c.setAttribute('aria-label', label);
      c.addEventListener('change', () => set(spec.field, c.checked ? true : undefined));
      return c;
    }
    case 'harnesses': {
      const box = el('span', 'pf-policy-checks');
      const now = Array.isArray(value) ? value.map(String) : [];
      for (const h of POLICY_HARNESSES) {
        const item = el('label', 'pf-model-enabled');
        const c = el('input', 'pf-check');
        c.type = 'checkbox';
        c.checked = now.includes(h);
        c.setAttribute('aria-label', `Exclude ${harnessLabel(h)}`);
        c.addEventListener('change', () => set(spec.field, c.checked ? [...now, h] : now.filter((x) => x !== h)));
        item.append(c, document.createTextNode(harnessLabel(h)));
        box.appendChild(item);
      }
      return box;
    }
    default: {
      const input = el('input', 'pf-input pf-number');
      input.type = 'number';
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      input.step = spec.kind === 'usd' ? '0.01' : '1';
      input.placeholder = 'not set';
      input.value = value === undefined ? '' : String(value);
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => {
        const t = input.value.trim();
        set(spec.field, t === '' ? undefined : Number(t));
      });
      return input;
    }
  }
}

const POLICY_HARNESSES = ['claude-code', 'codex'] as const;

/** Fill `host` (the section's body) from the view, replacing what was there. */
export function renderOrchestration(host: HTMLElement, view: OrchestrationPrefsView | undefined, post: (m: PreferencesToHost) => void): void {
  host.textContent = '';
  if (view) renderRouting(host, view, post, () => renderOrchestration(host, view, post));
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
