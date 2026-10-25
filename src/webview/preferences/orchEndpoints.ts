/**
 * Orchestration → Sources & endpoints: each source's health, and the local
 * endpoints (#51) with their probe, key and qualification actions.
 *
 * Every action is the `localEndpoint` message it always was; the host answers
 * with `localEndpointResult`, shown here until the next one. The add form
 * checks what it always checked (a URL is required); the host does the rest.
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import type { SourceStatus } from '../../shared/orchestration/sourceHealth';
import { sourceLabel } from '../../shared/harness';
import type { LocalEndpointChange, LocalEndpointModelView, LocalEndpointView } from '../../shared/orchestration/localEndpoints';
import { localSummaryText, type LocalModelSummary } from '../../shared/orchestration/localMetrics';
import { button, crossLink, el, localContext, switchButton, tabHeader, type Post } from './orchCommon';

/** The last thing a local endpoint change said, kept across redraws until the next one. */
let localResult: { ok: boolean; lines: string[] } | undefined;

export function setLocalEndpointResult(result: { ok: boolean; lines: string[]; requestId?: string }): void {
  localResult = result.lines.length > 0 ? result : undefined;
  // The host answers every request once, so this frees the control that sent it (#152).
  for (const [key, id] of pending) if (id === result.requestId) pending.delete(key);
}

/** Controls waiting on the host, by key (`add`, `<id>:enable`, `<id>:mine`), with the request each sent. */
const pending = new Map<string, string>();
let requestCounter = 0;

/** Forget what was waiting: the pane was drawn afresh and any answer is for a page that is gone. */
export function clearEndpointPending(): void {
  pending.clear();
}

/** Send a change under a key; a second send under the same key while one is out does nothing. */
function sendOnce(post: Post, key: string, change: LocalEndpointChange): boolean {
  if (pending.has(key)) return false;
  const requestId = `ep${++requestCounter}`;
  pending.set(key, requestId);
  post({ type: 'localEndpoint', change, requestId });
  return true;
}

/** Mark a control as waiting, without disabling it: it stays focusable and `aria-busy` says why it does nothing. */
function markBusy(node: HTMLElement, key: string): void {
  if (!pending.has(key)) return;
  node.setAttribute('aria-disabled', 'true');
  node.setAttribute('aria-busy', 'true');
}

const HEALTH_WORD: Record<string, string> = { reachable: 'Reachable', degraded: 'Degraded', down: 'Down', unknown: 'Unknown', off: 'Off' };

function dot(state: string): HTMLElement {
  const d = el('span', 'aw-orch-health-dot');
  d.dataset.state = state;
  d.setAttribute('aria-hidden', 'true');
  return d;
}

export function renderEndpointsTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post, openModel: (key: string) => void): void {
  host.appendChild(tabHeader('Sources & endpoints', 'Where models come from, whether they’re reachable right now, and the local servers you’ve added.'));

  const sources = el('section', 'aw-orch-section');
  sources.appendChild(el('h4', 'aw-orch-h', 'Sources'));
  const list = el('ul', 'aw-orch-sources');
  for (const s of view.sources) list.appendChild(renderSource(s));
  sources.appendChild(list);
  if (view.sources.length === 0) sources.appendChild(el('p', 'aw-orch-muted', 'No sources reported yet.'));
  host.appendChild(sources);

  if (view.local) renderLocal(host, view.local, post, localContext(view).harnessWarning, openModel);
}

function renderSource(s: SourceStatus): HTMLElement {
  const row = el('li', 'aw-orch-source');
  row.dataset.state = s.health.state;
  row.append(dot(s.health.state), el('span', 'aw-orch-source-name', sourceLabel(s.source)), el('span', 'aw-orch-source-detail', s.health.reason));
  row.appendChild(el('span', 'aw-orch-source-word', HEALTH_WORD[s.health.state] ?? s.health.state));
  return row;
}

function renderLocal(
  host: HTMLElement,
  local: NonNullable<OrchestrationPrefsView['local']>,
  post: Post,
  harnessWarning: string | undefined,
  openModel: (key: string) => void,
): void {
  const section = el('section', 'aw-orch-section');
  section.appendChild(el('h4', 'aw-orch-h', 'Local endpoints'));
  section.appendChild(
    el(
      'p',
      'aw-orch-muted',
      'OpenAI-compatible servers (Ollama, llama.cpp, vLLM, LM Studio, MLX). Their models appear in the tier map unassigned and are routed to only once you give them a tier. Agentic work goes through Codex (needs /v1/responses) or Claude Code (needs /v1/messages), with a model whose tool calls passed qualification; any model can answer structured completions once it has the weakest tier. An endpoint that is not on this machine is off by default: turning it on means data leaves this machine, unless it is on a private address and you mark it as your own machine, which treats it as local. Keys go in the system keychain, never in settings.json.',
    ),
  );

  const form = el('div', 'aw-orch-addform');
  const urlLabel = el('label', 'aw-orch-sr', 'Endpoint URL');
  urlLabel.htmlFor = 'aw-orch-ep-url';
  const url = el('input', 'aw-orch-input aw-orch-ep-url');
  url.id = 'aw-orch-ep-url';
  url.type = 'text';
  url.placeholder = 'http://127.0.0.1:11434';
  url.dataset.focus = 'endpoint:url';
  const nameLabel = el('label', 'aw-orch-sr', 'Endpoint name');
  nameLabel.htmlFor = 'aw-orch-ep-name';
  const name = el('input', 'aw-orch-input aw-orch-ep-name');
  name.id = 'aw-orch-ep-name';
  name.type = 'text';
  name.placeholder = 'Name (optional)';
  name.dataset.focus = 'endpoint:name';
  const add = button(pending.has('add') ? 'Adding…' : 'Add endpoint', () => {
    if (!url.value.trim()) return;
    if (!sendOnce(post, 'add', { op: 'add', url: url.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) })) return;
    add.textContent = 'Adding…';
    markBusy(add, 'add');
  }, 'aw-orch-btn primary');
  add.dataset.focus = 'endpoint:add';
  markBusy(add, 'add');
  form.append(urlLabel, url, nameLabel, name, add);
  section.appendChild(form);
  section.appendChild(el('p', 'aw-orch-caption', 'An endpoint not on this machine starts off. Turning it on sends task data off this machine.'));
  if (harnessWarning) section.appendChild(el('p', 'aw-orch-field-error', harnessWarning));
  if (localResult) section.appendChild(el('pre', `pf-actionresult${localResult.ok ? '' : ' bad'}`, localResult.lines.join('\n')));

  const cards = el('div', 'aw-orch-cards');
  for (const e of local.endpoints) cards.appendChild(renderEndpoint(e, local.summaries, local.secretsAvailable, post, openModel));
  if (local.endpoints.length === 0) cards.appendChild(el('p', 'aw-orch-muted', 'No local endpoints registered.'));
  section.appendChild(cards);
  host.appendChild(section);
}

function routeFact(label: string, route: string, probed: boolean | undefined): HTMLElement {
  const cell = el('div', 'aw-orch-fact');
  const value = el('dd', 'aw-orch-fact-value', probed === undefined ? 'Not probed' : probed ? route : `No ${route}`);
  value.dataset.tone = probed === undefined ? 'faint' : probed ? 'ok' : 'warn';
  cell.append(el('dt', 'aw-orch-fact-label', label), value);
  return cell;
}

function plainFact(label: string, value: string): HTMLElement {
  const cell = el('div', 'aw-orch-fact');
  cell.append(el('dt', 'aw-orch-fact-label', label), el('dd', 'aw-orch-fact-value', value));
  return cell;
}

/** Runs and speed across the endpoint's models, from the same summaries the model lines show. */
function endpointTotals(e: LocalEndpointView, summaries: LocalModelSummary[]): { runs: string; speed: string } {
  const mine = summaries.filter((s) => s.source === e.source);
  const runs = mine.reduce((n, s) => n + s.executions, 0);
  const ok = mine.reduce((n, s) => n + s.succeeded, 0);
  const fast = mine.find((s) => s.avgTokPerSec !== undefined);
  return {
    runs: runs === 0 ? 'None yet' : `${runs} · ${Math.round((ok / runs) * 100)}% succeeded`,
    speed: fast ? `${fast.avgTokPerSec} tok/s${fast.avgTtftMs !== undefined ? ` · TTFT ${(fast.avgTtftMs / 1000).toFixed(1)} s` : ''}` : 'Not measured',
  };
}

function qualificationBlock(m: LocalEndpointModelView): HTMLElement | undefined {
  const lines: { label: string; text: string; tone: string }[] = [];
  if (m.qualification) lines.push({ label: 'Stage 1', text: m.qualification, tone: m.stage1 ? (m.stage1.verdict === 'agentic' ? 'ok' : 'warn') : 'plain' });
  for (const h of m.harnesses ?? []) {
    const name = h === 'codex' ? 'Codex' : 'Claude Code';
    const q = m.qualifications?.[h];
    lines.push({ label: name, text: q ?? 'Not qualified', tone: q ? 'plain' : 'faint' });
    const t = m.taskQualifications?.[h];
    lines.push({ label: `${name}, tasks`, text: t ?? 'Not run', tone: t ? 'plain' : 'faint' });
  }
  if (m.tasksRunning) lines.push({ label: 'Running', text: m.tasksRunning, tone: 'plain' });
  if (lines.length === 0) return undefined;
  const box = el('dl', 'aw-orch-qual');
  for (const l of lines) {
    const v = el('dd', 'aw-orch-qual-text', l.text);
    v.dataset.tone = l.tone;
    box.append(el('dt', 'aw-orch-qual-label', l.label), v);
  }
  return box;
}

function renderEndpoint(
  e: LocalEndpointView,
  summaries: LocalModelSummary[],
  secretsAvailable: boolean,
  post: Post,
  openModel: (key: string) => void,
): HTMLElement {
  const state = e.enabled ? e.health.state : 'off';
  const card = el('article', 'aw-orch-card');
  card.dataset.state = state;
  const head = el('div', 'aw-orch-card-head');
  const titles = el('div', 'aw-orch-card-titles');
  titles.appendChild(el('h5', 'aw-orch-card-title', e.name));
  const meta = [e.url, e.runtime ?? 'runtime unknown', e.slots ? `${e.slots} slot${e.slots === '1' ? '' : 's'}` : 'slots unknown', e.hasKey ? 'key in the keychain' : 'no key'];
  titles.appendChild(el('span', 'aw-orch-card-meta', meta.join(' · ')));
  const onKey = `${e.id}:enable`;
  const power = switchButton({
    label: `Endpoint on: ${e.name}${e.warning ? ` (${e.warning})` : ''}`,
    pressed: e.enabled,
    focusKey: `endpoint:${e.id}:on`,
    onToggle: () => {
      if (sendOnce(post, onKey, { op: 'enable', id: e.id, enabled: !e.enabled })) markBusy(power, onKey);
    },
  });
  markBusy(power, onKey);
  head.append(dot(state), titles, power);
  card.appendChild(head);
  if (e.warning) card.appendChild(el('p', 'aw-orch-field-error', `External: ${e.warning}`));
  card.appendChild(el('p', 'aw-orch-caption', `${HEALTH_WORD[state] ?? state} · ${e.health.reason} · harness endpoints: ${e.routes}`));

  if (e.trustable) {
    const mine = el('label', 'aw-orch-check');
    const own = el('input', 'pf-check');
    own.type = 'checkbox';
    own.checked = !!e.trustedLocal;
    own.dataset.focus = `endpoint:${e.id}:mine`;
    own.title = 'This is a machine you own on your network: treat it as local for routing, caps and labels.';
    const mineKey = `${e.id}:mine`;
    if (pending.has(mineKey)) own.disabled = true;
    own.addEventListener('change', () => {
      // A checkbox has already flipped by now: put it back if the send is refused.
      if (sendOnce(post, mineKey, { op: 'setLocal', id: e.id, local: own.checked })) own.disabled = true;
      else own.checked = !own.checked;
    });
    mine.append(own, document.createTextNode('My own machine on this network: treat as local'));
    card.appendChild(mine);
  }

  const totals = endpointTotals(e, summaries);
  const facts = el('dl', 'aw-orch-card-facts');
  facts.append(routeFact('Codex harness', '/v1/responses', e.responses), routeFact('Claude Code harness', '/v1/messages', e.messages), plainFact('Runs', totals.runs), plainFact('Speed', totals.speed));
  card.appendChild(facts);

  for (const m of e.models) {
    const block = el('div', 'aw-orch-card-model');
    const title = el('div', 'aw-orch-card-model-title');
    title.append(el('span', 'aw-orch-row-label', m.label), el('code', 'aw-orch-row-id', m.id));
    block.appendChild(title);
    const q = qualificationBlock(m);
    if (q) block.appendChild(q);
    const s = summaries.find((x) => x.source === e.source && x.model === m.id);
    if (s) block.appendChild(el('p', 'aw-orch-caption', localSummaryText(s)));
    const actions = el('div', 'aw-orch-card-actions');
    for (const harness of m.harnesses ?? []) {
      const label = harness === 'codex' ? 'Codex' : 'Claude Code';
      if (harness === 'codex') {
        const qb = button(m.qualifying ? 'Qualifying…' : `Qualify ${label}`, () => post({ type: 'localEndpoint', change: { op: 'qualify', id: e.id, model: m.id, harness } }), 'aw-orch-btn');
        qb.disabled = !!m.qualifying || !e.enabled;
        qb.title = `Runs synthetic tool and JSON probes for ${label}.`;
        actions.appendChild(qb);
      }
      const t = button(m.tasksRunning ? 'Running tasks…' : `Qualify tasks (${label})`, () => post({ type: 'localEndpoint', change: { op: 'qualifyTasks', id: e.id, model: m.id, harness } }), 'aw-orch-btn');
      t.disabled = !!m.tasksRunning || !!m.qualifying || !e.enabled;
      t.title = `Runs synthetic scratch repositories through ${label} on this endpoint.`;
      actions.appendChild(t);
    }
    if (m.tasksRunning) {
      const c = button('Cancel', () => post({ type: 'localEndpoint', change: { op: 'cancelQualifyTasks', id: e.id, model: m.id } }), 'aw-orch-btn danger');
      c.title = 'Ends the run in progress and starts no more. The last result stands.';
      actions.appendChild(c);
    }
    actions.appendChild(crossLink('Tier and qualification in Models', () => openModel(m.key)));
    block.appendChild(actions);
    card.appendChild(block);
  }
  if (e.enabled && e.models.length === 0) card.appendChild(el('p', 'aw-orch-muted', e.error ? `Not probed: ${e.error}` : 'No models listed yet.'));

  const actions = el('div', 'aw-orch-card-actions aw-orch-card-footer');
  const probe = button(e.busy ? 'Probing…' : 'Probe', () => post({ type: 'localEndpoint', change: { op: 'probe', id: e.id } }), 'aw-orch-btn');
  probe.disabled = !!e.busy || !e.enabled;
  actions.appendChild(probe);
  if (e.hasKey) actions.appendChild(button('Remove key', () => post({ type: 'localEndpoint', change: { op: 'clearKey', id: e.id } }), 'aw-orch-btn'));
  else {
    const key = button('Set key…', () => post({ type: 'localEndpoint', change: { op: 'setKey', id: e.id } }), 'aw-orch-btn');
    key.disabled = !secretsAvailable;
    if (!secretsAvailable) key.title = 'This system cannot encrypt secrets, so no key can be stored.';
    actions.appendChild(key);
  }
  actions.append(el('span', 'aw-orch-spacer'), button('Remove', () => {
    const keyNote = e.hasKey ? ' Its key in the keychain is deleted too.' : '';
    if (!window.confirm(`Remove the endpoint “${e.name}”?${keyNote}`)) return;
    post({ type: 'localEndpoint', change: { op: 'remove', id: e.id } });
  }, 'aw-orch-btn danger'));
  card.appendChild(actions);
  return card;
}
