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
import { POLICY_FIELDS, fieldValue, withField, type LauncherRoutingMode, type PolicyFieldSpec, type PolicyValue } from '../../shared/orchestration/executionPolicy';
import { effectiveMode, type ComparisonReport } from '../../shared/orchestration/autoRouting';
import { EFFORT_LEVELS, type ExecutionPolicy } from '../../shared/orchestration/types';
import type { SourceStatus } from '../../shared/orchestration/sourceHealth';
import { harnessLabel, sourceLabel } from '../../shared/harness';
import { formatTokens } from '../../shared/sessionUsage';
import { DATA_LEAVES_MACHINE, isEndpointSource, type LocalEndpointView } from '../../shared/orchestration/localEndpoints';
import { localHarnessWarning, localModelStatus } from '../../shared/orchestration/localReadiness';
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

/** What the tier map needs to know about local models: each endpoint by source, and the harness-pin warning. */
interface LocalContext {
  endpoints: Map<string, LocalEndpointView>;
  harnessWarning?: string;
}

function localContext(view: OrchestrationPrefsView): LocalContext {
  const endpoints = new Map((view.local?.endpoints ?? []).map((e) => [e.source as string, e]));
  const enabled = view.catalog.entries.some((e) => e.enabled && endpoints.get(e.descriptor.source)?.enabled === true);
  const harnessWarning = localHarnessWarning(view.routing?.policy, enabled);
  return { endpoints, ...(harnessWarning ? { harnessWarning } : {}) };
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

function renderEntry(entry: CatalogEntry, tiers: TierDef[], post: (m: PreferencesToHost) => void, local: LocalContext): HTMLElement {
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

  row.append(head, controls);
  if (isEndpointSource(d.source)) renderLocalStatus(row, entry, tiers, local);
  row.appendChild(el('p', 'pf-desc pf-model-meta', where));
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
    const t = button(m.tasksRunning ? 'Running tasks…' : 'Qualify tasks', () => post({ type: 'localEndpoint', change: { op: 'qualifyTasks', id: e.id, model: m.id } }));
    t.disabled = !!m.tasksRunning || !!m.qualifying || !e.enabled;
    t.title =
      e.responses === false
        ? 'Stage 2 needs /v1/responses, which this server does not serve: it will report not runnable.'
        : 'Stage 2: small scratch repos with seeded bugs, each run 3 times as a Codex thread on this endpoint, in the attempt sandbox. A run passes when the tests pass, the tests are untouched and the diff stays inside the allowed paths. Takes minutes. Does not set a tier.';
    row.appendChild(t);
    card.appendChild(row);
    card.appendChild(el('p', 'pf-desc pf-model-fact', m.qualification ?? 'Not qualified: tool calling unknown, so it is not given agentic work.'));
    if (m.tasksRunning || m.tasks) card.appendChild(el('p', 'pf-desc pf-model-fact', m.tasksRunning ?? m.tasks!));
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
  harnessWarning: string | undefined,
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
  if (harnessWarning) host.appendChild(el('p', 'pf-policy-error pf-harness-warning', harnessWarning));
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

// ---------------------------------------------------------------------------
// Routing defaults: the global scope of pins and caps (#40)
// ---------------------------------------------------------------------------

type RoutingDraft = { mode: LauncherRoutingMode; policy: ExecutionPolicy };

/** What the user set and has not had confirmed yet; kept across redraws so a refused value stays on screen. */
let routingDraft: RoutingDraft | undefined;
let routingErrors: string[] = [];
let routingStatus = '';
/** `auto` was asked for over an unmet gate: the numbers and "Enable anyway" are on screen (#42). */
let overridePending: string[] | undefined;

/** The host saved the defaults, or refused them. Call `renderOrchestration` after. */
export function onRoutingResult(ok: boolean, errors: string[], needsOverride = false): void {
  if (ok) {
    routingDraft = undefined;
    routingErrors = [];
    overridePending = undefined;
    routingStatus = 'Saved. Applies to tasks started from now on.';
  } else if (needsOverride) {
    overridePending = errors.slice(1);
    routingErrors = [];
    routingStatus = '';
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

  const commit = (next: RoutingDraft, overrideGate = false) => {
    routingDraft = next;
    routingStatus = '';
    // The same check the host runs, so a pin above a cap is refused here and
    // now, and `auto` over an unmet gate stops at its numbers (#42).
    const r = routingPolicyUpdate({ type: 'routingPolicy', ...next, overrideGate }, view.catalog, {
      gate: stored.gate,
      stored: { mode: stored.mode, autoOverride: stored.autoOverride },
      now: Date.now(),
    });
    if (!r.ok) {
      if (r.needsOverride) {
        overridePending = r.errors.slice(1);
        routingErrors = [];
      } else routingErrors = r.errors;
      redraw();
      return;
    }
    routingErrors = [];
    overridePending = undefined;
    routingStatus = 'Saving…';
    post({ type: 'routingPolicy', mode: next.mode, policy: next.policy, ...(overrideGate ? { overrideGate: true } : {}) });
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
  option(modeSelect, 'auto', `Automatic — the router decides, within the caps${stored.gate && !stored.gate.met ? ' (gate not met)' : ''}`);
  // A pending override shows what was asked for, not what is stored.
  modeSelect.value = current.mode;
  modeSelect.addEventListener('change', () => {
    const v = modeSelect.value;
    commit({ mode: v === 'assisted' || v === 'auto' ? v : 'manual', policy: current.policy });
  });
  modeRow.append(el('span', 'pf-label pf-policy-label', 'Mode'), modeSelect);
  form.appendChild(modeRow);
  if (overridePending) form.appendChild(renderOverridePrompt(overridePending, () => commit({ mode: 'auto', policy: current.policy }, true), () => {
    overridePending = undefined;
    routingDraft = undefined;
    redraw();
  }));

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

  const harnessWarning = localContext(view).harnessWarning;
  if (harnessWarning) host.appendChild(el('p', 'pf-policy-error pf-harness-warning', harnessWarning));
  for (const e of routingErrors) host.appendChild(el('p', 'pf-policy-error', e));
  for (const e of stored.ignored) host.appendChild(el('p', 'pf-policy-error', `Ignored in settings.json — ${e}`));
  if (routingStatus) host.appendChild(el('p', 'pf-desc pf-policy-status', routingStatus));
  renderAutoRouting(host, stored);
}

// ---------------------------------------------------------------------------
// Automatic routing: the gate and the shadow comparison report (#42)
// ---------------------------------------------------------------------------

/** "Enable anyway" with the numbers in front of the user: the only way to turn `auto` on over an unmet gate. */
function renderOverridePrompt(lines: string[], confirm: () => void, cancel: () => void): HTMLElement {
  const box = el('div', 'pf-gate-override');
  box.appendChild(el('p', 'pf-policy-error', 'Automatic routing’s gate is not met. The record so far:'));
  for (const l of lines) box.appendChild(el('p', 'pf-desc pf-gate-line', l));
  box.appendChild(
    el(
      'p',
      'pf-desc',
      'Enabling it anyway lets the router pick every new launcher task’s route, within your caps, without asking. Each decision still records its reasons, and escalation may raise the tier within the caps. The numbers above are saved with the override.',
    ),
  );
  const row = el('div', 'pf-model-controls');
  row.append(button('Enable anyway', confirm, 'pf-action danger'), button('Keep the current mode', cancel));
  box.appendChild(row);
  return box;
}

function renderAutoRouting(host: HTMLElement, stored: NonNullable<OrchestrationPrefsView['routing']>): void {
  const gate = stored.gate;
  const report = stored.report;
  if (!gate && !report) return;
  host.appendChild(el('h3', 'pf-subhead', 'Automatic routing'));
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'Automatic routing can be switched on once the record supports it: the routing corpus is green, the router has been shadowed or proposed for enough tasks, its proposals are mostly taken without a tier change, and no kind of task shows it under-routing. Counted from the telemetry log, one decision per task.',
    ),
  );
  if (gate) {
    const checks = el('div', `pf-gate ${gate.met ? 'met' : 'unmet'}`);
    checks.appendChild(el('p', 'pf-label pf-gate-verdict', gate.met ? 'Gate met' : 'Gate not met'));
    for (const c of gate.checks) {
      const row = el('div', `pf-gate-check ${c.met ? 'met' : 'unmet'}`);
      row.append(el('span', 'pf-gate-mark', c.met ? '✓' : '✗'), el('span', 'pf-label', c.label), el('span', 'pf-desc pf-gate-value', c.value));
      checks.appendChild(row);
      if (c.detail) checks.appendChild(el('p', 'pf-desc pf-gate-detail', c.detail));
    }
    host.appendChild(checks);
    const eff = effectiveMode(stored.mode, gate, stored.autoOverride);
    if (stored.mode === 'auto' && stored.autoOverride) {
      host.appendChild(el('p', 'pf-policy-error', `On by override since ${new Date(stored.autoOverride.at).toLocaleString()}. Shown then:`));
      for (const l of stored.autoOverride.shown) host.appendChild(el('p', 'pf-desc pf-gate-line', l));
    } else if (eff.note) host.appendChild(el('p', 'pf-policy-error', eff.note));
  }
  if (report) renderReport(host, report);
}

function tallyText(t: { decisions: number; disagreements: number; routerCheaper: number; routerDearer: number; sideways: number; passedFirst: number; neededEscalation: number }): string {
  if (t.disagreements === 0) return `${t.decisions} decided · no disagreement`;
  return `${t.decisions} decided · ${t.disagreements} disagreed (router cheaper ${t.routerCheaper}, dearer ${t.routerDearer}, sideways ${t.sideways}) · of those ${t.passedFirst} passed first time, ${t.neededEscalation} needed escalation`;
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

  const local = localContext(view);
  if (view.local) renderLocal(host, view.local, post, local.harnessWarning);

  host.appendChild(el('h3', 'pf-subhead', 'Tier map'));
  if (view.catalog.entries.length === 0) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'No models reported yet. Start a Claude or Codex conversation and its models appear here.'));
    return;
  }
  const list = el('div', 'pf-models');
  for (const entry of view.catalog.entries) list.appendChild(renderEntry(entry, view.catalog.tiers, post, local));
  host.appendChild(list);
  host.appendChild(el('p', 'pf-desc pf-version', `Catalog version ${view.catalog.version}`));
}
