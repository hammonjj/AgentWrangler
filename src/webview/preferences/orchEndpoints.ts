/**
 * Orchestration → Sources & endpoints: each source's health, and the local
 * endpoints (#51) with their probe, key and qualification actions.
 *
 * Every action is the `localEndpoint` message it always was; the host answers
 * with `localEndpointResult`, shown here until the next one.
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import type { SourceStatus } from '../../shared/orchestration/sourceHealth';
import { sourceLabel } from '../../shared/harness';
import type { LocalEndpointView } from '../../shared/orchestration/localEndpoints';
import { localSummaryText, type LocalModelSummary } from '../../shared/orchestration/localMetrics';
import { button, crossLink, el, localContext, type Post } from './orchCommon';

/** The last thing a local endpoint change said, kept across redraws until the next one. */
let localResult: { ok: boolean; lines: string[] } | undefined;

export function setLocalEndpointResult(result: { ok: boolean; lines: string[] }): void {
  localResult = result.lines.length > 0 ? result : undefined;
}

export function renderEndpointsTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post, openModel: (key: string) => void): void {
  host.appendChild(el('h3', 'pf-subhead', 'Sources'));
  const sources = el('div', 'pf-sources');
  for (const s of view.sources) sources.appendChild(renderSource(s));
  if (view.sources.length === 0) sources.appendChild(el('p', 'pf-desc pf-empty', 'No sources reported yet.'));
  host.appendChild(sources);
  if (view.local) renderLocal(host, view.local, post, localContext(view).harnessWarning, openModel);
}

function renderSource(s: SourceStatus): HTMLElement {
  const row = el('div', `pf-source ${s.health.state}`);
  row.append(el('span', 'pf-source-dot'), el('span', 'pf-label', sourceLabel(s.source)), el('span', 'pf-desc pf-source-text', `${s.health.state} · ${s.health.reason}`));
  return row;
}

function renderLocal(
  host: HTMLElement,
  local: NonNullable<OrchestrationPrefsView['local']>,
  post: Post,
  harnessWarning: string | undefined,
  openModel: (key: string) => void,
): void {
  host.appendChild(el('h3', 'pf-subhead', 'Local endpoints'));
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'OpenAI-compatible servers (Ollama, llama.cpp, vLLM, LM Studio, MLX). Their models appear in the tier map unassigned and are routed to only once you give them a tier. Agentic work goes through Codex (needs /v1/responses) or Claude Code (needs /v1/messages), with a model whose tool calls passed qualification; any model can answer structured completions once it has the weakest tier. An endpoint that is not on this machine is off by default: turning it on means data leaves this machine, unless it is on a private address and you mark it as your own machine, which treats it as local. Keys go in the system keychain, never in settings.json.',
    ),
  );
  const form = el('div', 'pf-endpoint-add');
  const url = el('input', 'pf-input pf-endpoint-url');
  url.type = 'text';
  url.placeholder = 'http://127.0.0.1:11434';
  url.setAttribute('aria-label', 'Endpoint URL');
  url.dataset.focus = 'endpoint:url';
  const name = el('input', 'pf-input pf-endpoint-name');
  name.type = 'text';
  name.placeholder = 'Name (optional)';
  name.setAttribute('aria-label', 'Endpoint name');
  name.dataset.focus = 'endpoint:name';
  const add = button('Add endpoint', () => {
    if (!url.value.trim()) return;
    post({ type: 'localEndpoint', change: { op: 'add', url: url.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) } });
  }, 'pf-action primary');
  form.append(url, name, add);
  host.appendChild(form);
  if (harnessWarning) host.appendChild(el('p', 'pf-policy-error pf-harness-warning', harnessWarning));
  if (localResult) host.appendChild(el('pre', `pf-actionresult${localResult.ok ? '' : ' bad'}`, localResult.lines.join('\n')));
  const list = el('div', 'pf-endpoints');
  for (const e of local.endpoints) list.appendChild(renderEndpoint(e, local.summaries, local.secretsAvailable, post, openModel));
  if (local.endpoints.length === 0) list.appendChild(el('p', 'pf-desc pf-empty', 'No local endpoints registered.'));
  host.appendChild(list);
}

function renderEndpoint(
  e: LocalEndpointView,
  summaries: LocalModelSummary[],
  secretsAvailable: boolean,
  post: Post,
  openModel: (key: string) => void,
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
  check.dataset.focus = `endpoint:${e.id}:on`;
  check.addEventListener('change', () => post({ type: 'localEndpoint', change: { op: 'enable', id: e.id, enabled: check.checked } }));
  enabled.append(check, document.createTextNode(e.warning ? `On (${e.warning})` : 'On'));
  controls.appendChild(enabled);
  if (e.trustable) {
    const mine = el('label', 'pf-model-enabled');
    const own = el('input', 'pf-check');
    own.type = 'checkbox';
    own.checked = !!e.trustedLocal;
    own.setAttribute('aria-label', `${e.name} is my own machine`);
    own.title = 'This is a machine you own on your network: treat it as local for routing, caps and labels.';
    own.addEventListener('change', () => post({ type: 'localEndpoint', change: { op: 'setLocal', id: e.id, local: own.checked } }));
    mine.append(own, document.createTextNode('My own machine on this network: treat as local'));
    controls.appendChild(mine);
  }
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
    for (const harness of m.harnesses ?? []) {
      const label = harness === 'codex' ? 'Codex' : 'Claude Code';
      if (harness === 'codex') {
        const q = button(m.qualifying ? 'Qualifying…' : `Qualify ${label}`, () => post({ type: 'localEndpoint', change: { op: 'qualify', id: e.id, model: m.id, harness } }));
        q.disabled = !!m.qualifying || !e.enabled;
        q.title = `Runs synthetic tool and JSON probes for ${label}.`;
        row.appendChild(q);
      }
      const t = button(m.tasksRunning ? 'Running tasks…' : `Qualify tasks (${label})`, () => post({ type: 'localEndpoint', change: { op: 'qualifyTasks', id: e.id, model: m.id, harness } }));
      t.disabled = !!m.tasksRunning || !!m.qualifying || !e.enabled;
      t.title = `Runs synthetic scratch repositories through ${label} on this endpoint.`;
      row.appendChild(t);
    }
    row.appendChild(crossLink('Tier and qualification in Models', () => openModel(m.key)));
    card.appendChild(row);
    for (const harness of m.harnesses ?? []) {
      card.appendChild(el('p', 'pf-desc pf-model-fact', `${harness}: ${m.qualifications?.[harness] ?? 'not qualified'}`));
      card.appendChild(el('p', 'pf-desc pf-model-fact', `${harness} tasks: ${m.taskQualifications?.[harness] ?? 'not run'}`));
    }
    if (m.tasksRunning) card.appendChild(el('p', 'pf-desc pf-model-fact', m.tasksRunning));
    const s = summaries.find((x) => x.source === e.source && x.model === m.id);
    if (s) card.appendChild(el('p', 'pf-desc pf-model-fact', localSummaryText(s)));
  }
  if (e.enabled && e.models.length === 0) card.appendChild(el('p', 'pf-desc pf-empty', e.error ? `Not probed: ${e.error}` : 'No models listed yet.'));
  return card;
}
