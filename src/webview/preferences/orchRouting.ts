/**
 * Orchestration → Routing: the routing mode, the global scope of pins and caps
 * (#40), and automatic routing's gate (#42).
 *
 * Restyled, not changed: every message it sends and every check it runs are
 * the ones it had. The mode is a radio group rather than a dropdown; picking
 * Automatic over an unmet gate still stops at "Enable anyway" with the numbers.
 */

import { routingPolicyUpdate, type OrchestrationPrefsView } from '../../shared/preferences';
import { POLICY_FIELDS, fieldValue, withField, type LauncherRoutingMode, type PolicyFieldSpec, type PolicyValue } from '../../shared/orchestration/executionPolicy';
import { effectiveMode } from '../../shared/orchestration/autoRouting';
import { EFFORT_LEVELS, type ExecutionPolicy } from '../../shared/orchestration/types';
import { harnessLabel } from '../../shared/harness';
import { button, crossLink, el, localContext, option, tabHeader, tierLabel, type Post } from './orchCommon';

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

/** The launcher's routing modes, in the words the code has always used for them. */
const MODES: { id: LauncherRoutingMode; label: string; desc: string }[] = [
  { id: 'manual', label: 'Manual', desc: 'Run on the launcher’s route. The router still records its pick as a shadow for the report.' },
  { id: 'assisted', label: 'Assisted', desc: 'Propose a route, and wait for a click to accept or change it.' },
  { id: 'auto', label: 'Automatic', desc: 'The router decides, within the caps, and starts the route on its own.' },
];

export function renderRoutingTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post, redraw: () => void, openReport: () => void): void {
  host.appendChild(tabHeader('Routing', 'How much the router decides on its own, and the limits every task starts from.'));
  renderRouting(host, view, post, redraw, openReport);
  host.appendChild(el('p', 'aw-orch-caption', 'Changes apply to tasks that start afterwards. A running task keeps the policy it started with.'));
}

function renderRouting(host: HTMLElement, view: OrchestrationPrefsView, post: Post, redraw: () => void, openReport: () => void): void {
  const stored = view.routing;
  if (!stored) {
    host.appendChild(el('p', 'aw-orch-muted', 'Routing defaults are not available.'));
    return;
  }
  const current: RoutingDraft = routingDraft ?? { mode: stored.mode, policy: stored.policy };

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

  // ---- Mode: radio cards. Automatic is locked while its gate is unmet, but
  // picking it still opens the "Enable anyway" prompt with the numbers (#42).
  const modes = el('section', 'aw-orch-section');
  modes.appendChild(el('h4', 'aw-orch-h', 'Mode'));
  const group = el('div', 'aw-orch-modes');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Routing mode');
  const gate = stored.gate;
  const overrideStands = stored.mode === 'auto' && stored.autoOverride !== undefined;
  const cards: HTMLElement[] = [];
  const pick = (mode: LauncherRoutingMode) => {
    if (mode !== current.mode) commit({ mode, policy: current.policy });
  };
  for (const m of MODES) {
    const locked = m.id === 'auto' && gate !== undefined && !gate.met && !overrideStands;
    const checked = current.mode === m.id;
    const card = el('div', `aw-orch-mode${locked ? ' locked' : ''}`);
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(checked));
    if (locked) card.setAttribute('aria-disabled', 'true');
    card.tabIndex = checked ? 0 : -1;
    card.dataset.focus = `routing:mode:${m.id}`;
    const title = el('span', 'aw-orch-mode-title');
    title.append(el('span', 'aw-orch-radio'), el('span', 'aw-orch-mode-name', m.label));
    card.append(title, el('span', 'aw-orch-mode-desc', m.desc));
    if (locked && gate) {
      const met = gate.checks.filter((c) => c.met).length;
      card.append(el('span', 'aw-orch-mode-lock', 'Locked until the auto-routing gate passes'), el('span', 'aw-orch-mode-gate', `${met} of ${gate.checks.length} gate checks met`));
    }
    card.addEventListener('click', () => pick(m.id));
    card.addEventListener('keydown', (e) => {
      const i = MODES.indexOf(m);
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % MODES.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + MODES.length) % MODES.length;
      else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        pick(m.id);
        return;
      }
      if (next < 0) return;
      // Arrows move focus; Space or Enter picks. Each pick is a settings write, so arrowing past a mode must not make one.
      e.preventDefault();
      cards.forEach((c, j) => (c.tabIndex = j === next ? 0 : -1));
      cards[next].focus();
    });
    cards.push(card);
    group.appendChild(card);
  }
  // If the checked mode is the locked one (asked for, awaiting the override), keep one card tabbable.
  if (!cards.some((c) => c.tabIndex === 0)) cards[0].tabIndex = 0;
  modes.appendChild(group);
  if (overridePending) modes.appendChild(renderOverridePrompt(overridePending, () => commit({ mode: 'auto', policy: current.policy }, true), () => {
    overridePending = undefined;
    routingDraft = undefined;
    redraw();
  }));
  modes.appendChild(crossLink('See how the router’s picks compare in the shadow report', openReport));
  host.appendChild(modes);

  // ---- Global defaults: the same fields and checks as before, in a card.
  const card = el('section', 'aw-orch-panelcard');
  const head = el('div', 'aw-orch-panelcard-head');
  head.append(el('h4', 'aw-orch-h', 'Global defaults'), el('span', 'aw-orch-muted', 'The widest scope. Repos, missions and tasks can only tighten these.'));
  card.appendChild(head);
  card.appendChild(
    el(
      'p',
      'aw-orch-muted',
      'A repository’s policy, a mission and a task can each override these: the more specific scope wins, but a cap can only be tightened, never loosened. Each task freezes these when it starts.',
    ),
  );
  let groupName = '';
  let grid: HTMLElement | undefined;
  for (const spec of POLICY_FIELDS) {
    if (spec.group !== groupName || !grid) {
      groupName = spec.group;
      card.appendChild(el('h5', 'aw-orch-fieldgroup', groupName));
      grid = el('div', 'aw-orch-fields');
      card.appendChild(grid);
    }
    const id = `aw-orch-policy-${spec.field.replace(/\./g, '-')}`;
    const value = fieldValue(current.policy, spec.field);
    const cell = el('div', 'aw-orch-field');
    const control = policyControl(spec, value, view, set, id);
    if (spec.kind === 'harnesses') {
      const fs = el('fieldset', 'aw-orch-fieldset');
      fs.append(el('legend', 'aw-orch-field-label', spec.label), control);
      cell.appendChild(fs);
    } else if (spec.kind === 'flag') {
      const label = el('label', 'aw-orch-check');
      label.htmlFor = id;
      label.append(control, document.createTextNode(spec.label));
      cell.appendChild(label);
    } else {
      const label = el('label', 'aw-orch-field-label', spec.label);
      label.htmlFor = id;
      cell.append(label, control);
    }
    cell.appendChild(el('span', 'aw-orch-caption', spec.help));
    grid.appendChild(cell);
  }
  card.appendChild(el('p', 'aw-orch-muted', 'A pin above the cap is refused. Pinned models are never raised by escalation.'));
  const harnessWarning = localContext(view).harnessWarning;
  if (harnessWarning) card.appendChild(el('p', 'aw-orch-field-error', harnessWarning));
  for (const e of routingErrors) card.appendChild(el('p', 'aw-orch-field-error', e));
  for (const e of stored.ignored) card.appendChild(el('p', 'aw-orch-field-error', `Ignored in settings.json — ${e}`));
  if (routingStatus) {
    const status = el('p', 'aw-orch-muted', routingStatus);
    status.setAttribute('role', 'status');
    card.appendChild(status);
  }
  host.appendChild(card);
  host.appendChild(el('p', 'aw-orch-caption', 'Scopes apply global → repo → mission → task. Repo limits come from the repository’s policy; mission and task limits are set where the mission or task is created.'));

  renderGate(host, stored);
}

/** "Enable anyway" with the numbers in front of the user: the only way to turn `auto` on over an unmet gate. */
function renderOverridePrompt(lines: string[], confirm: () => void, cancel: () => void): HTMLElement {
  const box = el('div', 'aw-orch-alert');
  box.setAttribute('role', 'alert');
  box.appendChild(el('strong', undefined, 'Automatic routing’s gate is not met. The record so far:'));
  for (const l of lines) box.appendChild(el('span', 'aw-orch-gate-line', l));
  box.appendChild(
    el(
      'span',
      undefined,
      'Enabling it anyway lets the router pick every new launcher task’s route, within your caps, without asking. Each decision still records its reasons, and escalation may raise the tier within the caps. The numbers above are saved with the override.',
    ),
  );
  const row = el('div', 'aw-orch-card-actions');
  const yes = button('Enable anyway', confirm, 'aw-orch-btn danger');
  yes.dataset.focus = 'routing:override';
  row.append(yes, button('Keep the current mode', cancel, 'aw-orch-btn'));
  box.appendChild(row);
  return box;
}

function renderGate(host: HTMLElement, stored: NonNullable<OrchestrationPrefsView['routing']>): void {
  const gate = stored.gate;
  if (!gate) return;
  const section = el('section', 'aw-orch-panelcard');
  const head = el('div', 'aw-orch-panelcard-head');
  head.append(el('h4', 'aw-orch-h', 'Automatic routing gate'), el('span', `aw-orch-gate-verdict${gate.met ? ' met' : ''}`, gate.met ? 'Gate met' : 'Gate not met'));
  section.appendChild(head);
  section.appendChild(
    el(
      'p',
      'aw-orch-muted',
      'Automatic routing can be switched on once the record supports it: the routing corpus is green, the router has been shadowed or proposed for enough tasks, its proposals are mostly taken without a tier change, and no kind of task shows it under-routing. Counted from the telemetry log, one decision per task.',
    ),
  );
  const list = el('ul', 'aw-orch-gate');
  for (const c of gate.checks) {
    const row = el('li', `aw-orch-gate-check${c.met ? ' met' : ''}`);
    row.append(el('span', 'aw-orch-gate-mark', c.met ? '✓' : '✗'), el('span', 'aw-orch-gate-label', c.label), el('span', 'aw-orch-gate-value', c.value));
    row.firstElementChild?.setAttribute('aria-label', c.met ? 'met' : 'not met');
    if (c.detail) row.appendChild(el('span', 'aw-orch-caption aw-orch-gate-detail', c.detail));
    list.appendChild(row);
  }
  section.appendChild(list);
  const eff = effectiveMode(stored.mode, gate, stored.autoOverride);
  if (stored.mode === 'auto' && stored.autoOverride) {
    section.appendChild(el('p', 'aw-orch-field-error', `On by override since ${new Date(stored.autoOverride.at).toLocaleString()}. Shown then:`));
    for (const l of stored.autoOverride.shown) section.appendChild(el('p', 'aw-orch-caption', l));
  } else if (eff.note) section.appendChild(el('p', 'aw-orch-field-error', eff.note));
  host.appendChild(section);
}

const POLICY_HARNESSES = ['claude-code', 'codex'] as const;

/** What an empty choice says, per kind of field. */
function unsetLabel(spec: PolicyFieldSpec): string {
  if (spec.kind === 'tier') return 'No cap';
  if (spec.kind === 'model') return 'No pin: let the router choose';
  return '— not set';
}

/** One field's control, with `id` for the `<label>` beside it. The values and writes are the ones it always had. */
function policyControl(spec: PolicyFieldSpec, value: PolicyValue | undefined, view: OrchestrationPrefsView, set: (field: string, v: PolicyValue | undefined) => void, id: string): HTMLElement {
  const select = (options: [string, string][]) => {
    const s = el('select', 'aw-orch-select aw-orch-field-control');
    s.id = id;
    s.dataset.focus = `routing:${spec.field}`;
    option(s, '', unsetLabel(spec));
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
      c.id = id;
      c.checked = value === true;
      c.dataset.focus = `routing:${spec.field}`;
      c.addEventListener('change', () => set(spec.field, c.checked ? true : undefined));
      return c;
    }
    case 'harnesses': {
      const box = el('span', 'aw-orch-checks');
      box.id = id;
      const now = Array.isArray(value) ? value.map(String) : [];
      for (const h of POLICY_HARNESSES) {
        const item = el('label', 'aw-orch-check');
        const c = el('input', 'pf-check');
        c.type = 'checkbox';
        c.checked = now.includes(h);
        c.setAttribute('aria-label', `Exclude ${harnessLabel(h)}`);
        c.dataset.focus = `routing:${spec.field}:${h}`;
        c.addEventListener('change', () => set(spec.field, c.checked ? [...now, h] : now.filter((x) => x !== h)));
        item.append(c, document.createTextNode(harnessLabel(h)));
        box.appendChild(item);
      }
      return box;
    }
    default: {
      const input = el('input', 'aw-orch-input aw-orch-field-control');
      input.id = id;
      input.type = 'number';
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      input.step = spec.kind === 'usd' ? '0.01' : '1';
      input.placeholder = 'not set';
      input.value = value === undefined ? '' : String(value);
      input.dataset.focus = `routing:${spec.field}`;
      input.addEventListener('change', () => {
        const t = input.value.trim();
        set(spec.field, t === '' ? undefined : Number(t));
      });
      return input;
    }
  }
}
