/**
 * Orchestration → Routing: the routing mode, the global scope of pins and caps
 * (#40), and automatic routing's gate (#42).
 *
 * Moved here unchanged from the single long section; every message it sends
 * and every check it runs are the ones it had.
 */

import { routingPolicyUpdate, type OrchestrationPrefsView } from '../../shared/preferences';
import { POLICY_FIELDS, fieldValue, withField, type LauncherRoutingMode, type PolicyFieldSpec, type PolicyValue } from '../../shared/orchestration/executionPolicy';
import { effectiveMode } from '../../shared/orchestration/autoRouting';
import { EFFORT_LEVELS, type ExecutionPolicy } from '../../shared/orchestration/types';
import { harnessLabel } from '../../shared/harness';
import { button, crossLink, el, localContext, option, tierLabel, type Post } from './orchCommon';

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

export function renderRoutingTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post, redraw: () => void, openReport: () => void): void {
  renderRouting(host, view, post, redraw);
  host.appendChild(crossLink('See how the router’s picks compare in the shadow report', openReport));
}

function renderRouting(host: HTMLElement, view: OrchestrationPrefsView, post: Post, redraw: () => void): void {
  const stored = view.routing;
  if (!stored) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'Routing defaults are not available.'));
    return;
  }
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
  modeSelect.dataset.focus = 'routing:mode';
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
  renderGate(host, stored);
}

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

function renderGate(host: HTMLElement, stored: NonNullable<OrchestrationPrefsView['routing']>): void {
  const gate = stored.gate;
  if (!gate) return;
  host.appendChild(el('h3', 'pf-subhead', 'Automatic routing'));
  host.appendChild(
    el(
      'p',
      'pf-desc',
      'Automatic routing can be switched on once the record supports it: the routing corpus is green, the router has been shadowed or proposed for enough tasks, its proposals are mostly taken without a tier change, and no kind of task shows it under-routing. Counted from the telemetry log, one decision per task.',
    ),
  );
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

const POLICY_HARNESSES = ['claude-code', 'codex'] as const;

function policyControl(spec: PolicyFieldSpec, value: PolicyValue | undefined, view: OrchestrationPrefsView, set: (field: string, v: PolicyValue | undefined) => void): HTMLElement {
  const label = `${spec.group}: ${spec.label}`;
  const select = (options: [string, string][]) => {
    const s = el('select', 'pf-input pf-select');
    s.setAttribute('aria-label', label);
    s.dataset.focus = `routing:${spec.field}`;
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
      c.dataset.focus = `routing:${spec.field}`;
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
        c.dataset.focus = `routing:${spec.field}:${h}`;
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
      input.dataset.focus = `routing:${spec.field}`;
      input.addEventListener('change', () => {
        const t = input.value.trim();
        set(spec.field, t === '' ? undefined : Number(t));
      });
      return input;
    }
  }
}
