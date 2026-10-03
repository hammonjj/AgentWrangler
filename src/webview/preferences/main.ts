/**
 * The Preferences window.
 *
 * Rendered entirely from `src/shared/settings.ts`, so adding a setting is one
 * edit there and nothing here: the sections, their order, and the sidebar that
 * navigates them all fall out of the declaration.
 *
 * Every edit is written immediately. There is no OK/Cancel, because there is
 * nothing to cancel: each setting takes effect where it is read, the reads are
 * live (the poll interval and the stuck threshold are deliberately not cached),
 * and a modal that batches changes would only add a way to lose them.
 */

import './preferences.css';
import { createWebviewBridge, type WebviewBridge } from '../../shared/webviewBridge';
import type { HostToPreferences, OrchestrationPrefsView, PreferencesToHost, SettingActionId, SettingStatus } from '../../shared/preferences';
import { settingGroups, SETTINGS, type SettingSpec } from '../../shared/settings';
import { ORCHESTRATION_GROUP, onRoutingResult, renderOrchestration, setLocalEndpointResult } from './orchestration';

declare function acquireVsCodeApi(): WebviewBridge<unknown>;

// See `paneApi.ts` for why this is a lambda and not the bare identifier.
const host = createWebviewBridge<unknown>(() => acquireVsCodeApi());

const post = (message: PreferencesToHost) => host.postMessage(message);

/** How long to let someone stop typing before the value is written. */
const TYPING_SETTLE_MS = 350;

/** Every setting's own spec by key, to name a `dependsOn` card after its switch. */
const specByKey = new Map(SETTINGS.map((s) => [s.key, s]));

const root = document.getElementById('prefsApp');
/** Section elements by group name, for the sidebar to scroll to. */
const sections = new Map<string, HTMLElement>();
/** Sidebar links by group name, so the current section can be marked. */
const navLinks = new Map<string, HTMLButtonElement>();
/** Wrappers holding the settings that only apply while a boolean is on. */
const dependents = new Map<string, HTMLElement>();
/** Action buttons by id, so one can be disabled while it runs. */
const actionButtons = new Map<SettingActionId, HTMLButtonElement>();
/** Where an action's result is written, per group. */
const actionResults = new Map<string, HTMLElement>();
let values: Record<string, string | boolean | number> = {};
/** The controls, so an external change can be reflected without a re-render. */
const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
const rows = new Map<string, HTMLElement>();
/** The last status the host sent, by setting key (#136): read-only lines under a row. */
let statuses: Record<string, SettingStatus> = {};
/** The last catalog the host sent, and where it is drawn. */
let orchestration: OrchestrationPrefsView | undefined;
let orchestrationBody: HTMLElement | undefined;
/** A newer view arrived while a dropdown in it had focus. */
let orchestrationStale = false;

function valueOf(spec: SettingSpec): string | boolean | number {
  const v = values[spec.key];
  return v === undefined ? spec.default : v;
}

function isDefault(spec: SettingSpec): boolean {
  return valueOf(spec) === spec.default;
}

/** Mirrors `[hidden]` on the reset link and the "changed" mark for one row. */
function markRow(spec: SettingSpec): void {
  const row = rows.get(spec.key);
  if (!row) return;
  row.classList.toggle('changed', !isDefault(spec));
}

/**
 * Persist a value — or, if it is the one the setting ships with, un-persist it.
 *
 * Two things this is careful about, both of which cost nothing here and are
 * invisible later if got wrong:
 *
 * - **An unchanged value is not a write.** Every text field commits on blur, so
 *   tabbing through the window would otherwise write all twenty-two settings
 *   without anyone changing anything.
 * - **The default is stored by absence.** Writing `600` because that is what
 *   `stuckThresholdSeconds` currently defaults to pins the user to today's
 *   number: if the default is ever revised, everyone who once touched the field
 *   keeps the old one, with nothing on screen to say so. Removing the key
 *   instead means the declaration stays the single answer — and it is the same
 *   rule `Reset` follows, which is why it sends the same message.
 */
function write(spec: SettingSpec, value: string | boolean | number): void {
  if (value === valueOf(spec)) return;
  values[spec.key] = value;
  markRow(spec);
  // Something may be nested under this one, waiting to be shown.
  if (spec.type === 'boolean') syncReveal(spec.key);
  if (value === spec.default) post({ type: 'reset', key: spec.key });
  else post({ type: 'set', key: spec.key, value });
}

function numberInput(spec: SettingSpec): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'number';
  el.className = 'pf-input pf-number';
  if (spec.minimum !== undefined) el.min = String(spec.minimum);
  if (spec.maximum !== undefined) el.max = String(spec.maximum);
  el.value = String(valueOf(spec));

  const commit = () => {
    const n = Number(el.value);
    // An empty box, a stray letter, or a number outside the range is not a
    // setting — it is someone mid-edit. Put the last good value back rather
    // than persisting NaN and having the feature quietly stop working.
    if (el.value.trim() === '' || Number.isNaN(n)) {
      el.value = String(valueOf(spec));
      return;
    }
    const clamped = Math.min(spec.maximum ?? Infinity, Math.max(spec.minimum ?? -Infinity, n));
    if (clamped !== n) el.value = String(clamped);
    write(spec, clamped);
  };

  let timer: number | undefined;
  el.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(commit, TYPING_SETTLE_MS);
  });
  el.addEventListener('blur', () => {
    window.clearTimeout(timer);
    commit();
  });
  return el;
}

function textInput(spec: SettingSpec): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.className = 'pf-input';
  el.value = String(valueOf(spec));
  // The default is the placeholder when it is a real value ('claude'), because
  // seeing what you get by leaving it blank is the whole question these ask.
  if (typeof spec.default === 'string' && spec.default !== '') el.placeholder = spec.default;
  else el.placeholder = 'Leave blank for the default';

  let timer: number | undefined;
  el.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => write(spec, el.value), TYPING_SETTLE_MS);
  });
  el.addEventListener('blur', () => {
    window.clearTimeout(timer);
    write(spec, el.value);
  });
  return el;
}

function selectInput(spec: SettingSpec): HTMLSelectElement {
  const el = document.createElement('select');
  el.className = 'pf-input pf-select';
  for (const [i, choice] of (spec.enum ?? []).entries()) {
    const option = document.createElement('option');
    option.value = choice;
    option.textContent = choice;
    option.title = spec.enumDescriptions?.[i] ?? '';
    el.appendChild(option);
  }
  el.value = String(valueOf(spec));
  el.addEventListener('change', () => {
    write(spec, el.value);
    renderEnumHint(spec, el);
  });
  return el;
}

/** The chosen option's own sentence, under the dropdown. */
function renderEnumHint(spec: SettingSpec, el: HTMLSelectElement): void {
  const hint = rows.get(spec.key)?.querySelector('.pf-enumhint');
  if (!hint) return;
  const i = (spec.enum ?? []).indexOf(el.value);
  hint.textContent = spec.enumDescriptions?.[i] ?? '';
}

function checkbox(spec: SettingSpec): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.className = 'pf-check';
  el.checked = valueOf(spec) === true;
  el.addEventListener('change', () => write(spec, el.checked));
  return el;
}

function controlFor(spec: SettingSpec): HTMLInputElement | HTMLSelectElement {
  if (spec.type === 'boolean') return checkbox(spec);
  if (spec.enum) return selectInput(spec);
  if (spec.type === 'number') return numberInput(spec);
  return textInput(spec);
}

function renderRow(spec: SettingSpec): HTMLElement {
  const row = document.createElement('div');
  // `pf-type-…`, not `pf-…`: the control classes are `pf-number`, `pf-select`
  // and `pf-check`, and a row that shared a name with its own input inherited
  // the input's rules — `width: 11ch` on a number row collapsed its description
  // to one word a line.
  row.className = `pf-row pf-type-${spec.type}${spec.enum ? ' pf-haschoices' : ''}`;
  rows.set(spec.key, row);

  const label = document.createElement('label');
  label.className = 'pf-label';
  label.textContent = spec.label;
  const id = `pf-${spec.key.replace(/\./g, '-')}`;
  label.htmlFor = id;

  // The key rides along underneath. It is the name in `settings.json` and in
  // the documentation, so hiding it would leave two sets of words for one
  // setting and no way to get from one to the other.
  const key = document.createElement('code');
  key.className = 'pf-key';
  key.textContent = spec.key;

  const control = controlFor(spec);
  control.id = id;
  controls.set(spec.key, control);

  const description = document.createElement('p');
  description.className = 'pf-desc';
  description.textContent = spec.description;

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pf-reset';
  reset.textContent = 'Reset';
  reset.title = `Back to ${JSON.stringify(spec.default)}`;
  reset.addEventListener('click', () => {
    write(spec, spec.default);
    applyValue(spec);
  });

  const head = document.createElement('div');
  head.className = 'pf-head';
  head.append(label, key, reset);

  const body = document.createElement('div');
  body.className = 'pf-body';
  body.append(control);

  row.append(head, description, body);

  if (spec.enum) {
    const hint = document.createElement('p');
    hint.className = 'pf-enumhint';
    row.appendChild(hint);
    renderEnumHint(spec, control as HTMLSelectElement);
  }

  const status = document.createElement('pre');
  status.className = 'pf-status';
  status.setAttribute('aria-live', 'polite');
  row.appendChild(status);
  applyStatus(spec.key);

  markRow(spec);
  return row;
}

/** What a setting is doing now, under its row; hidden when it has nothing to say. */
function applyStatus(key: string): void {
  const el = rows.get(key)?.querySelector<HTMLElement>('.pf-status');
  if (!el) return;
  const status = statuses[key];
  el.textContent = status ? status.lines.join('\n') : '';
  el.classList.toggle('bad', status ? !status.ok : false);
  el.hidden = !status || status.lines.length === 0;
}

/**
 * Show or hide what hangs off a boolean.
 *
 * The wrapper animates between `grid-template-rows: 0fr` and `1fr` rather than
 * a `max-height` guess, so the height it slides to is whatever the content
 * actually is — no magic number to be wrong when a description wraps to three
 * lines on a narrow window.
 *
 * `inert` as well as hidden: a collapsed field that is still tabbable is a
 * field someone can type into without being able to see it. If focus was
 * inside the card when it closed — an external change collapsed it out from
 * under someone — it goes back to the switch, rather than to whatever the
 * browser picks once its container turns inert.
 *
 * `animate: false` is for the first paint: the card must already be in its
 * final state — open for a setting that is on when the window opens — with
 * nothing sliding into view. Toggling the class straight into a transitioned
 * property would still animate that first frame, so the transition itself is
 * held off for one frame instead.
 */
function syncReveal(parentKey: string, opts?: { animate?: boolean }): void {
  const wrapper = dependents.get(parentKey);
  if (!wrapper) return;
  const on = values[parentKey] === true;
  if (!on && wrapper.contains(document.activeElement)) controls.get(parentKey)?.focus();
  if (opts?.animate === false) wrapper.classList.add('pf-no-anim');
  wrapper.classList.toggle('open', on);
  wrapper.inert = !on;
  wrapper.setAttribute('aria-hidden', String(!on));
  const control = controls.get(parentKey);
  if (control instanceof HTMLInputElement && control.type === 'checkbox') control.setAttribute('aria-expanded', String(on));
  if (opts?.animate === false) {
    // Force layout with the transition suppressed, then drop the class next
    // frame so a change from here on animates normally.
    void wrapper.offsetHeight;
    requestAnimationFrame(() => wrapper.classList.remove('pf-no-anim'));
  }
}

/**
 * The card a boolean's dependent fields live in, created once per parent key
 * and reused by whichever setting reaches it first.
 *
 * `role="group"` plus an `aria-label` naming the switch it follows, because a
 * screen reader landing inside it otherwise has no idea what it is a group
 * of — the visual answer ("it's indented under Discord integration") does not
 * reach it. The switch itself gets `aria-controls`/`aria-expanded` pointing
 * at it, the standard disclosure-widget pair, wired here rather than left to
 * the caller so every card gets it the same way.
 */
function createDependents(parentKey: string, label: string): HTMLElement {
  let wrapper = dependents.get(parentKey);
  if (wrapper) return wrapper;
  wrapper = document.createElement('div');
  wrapper.className = 'pf-dependents';
  wrapper.id = `pf-dependents-${parentKey.replace(/\./g, '-')}`;
  wrapper.setAttribute('role', 'group');
  wrapper.setAttribute('aria-label', `${label} settings`);
  const inner = document.createElement('div');
  inner.className = 'pf-dependents-inner';
  wrapper.appendChild(inner);
  dependents.set(parentKey, wrapper);
  const control = controls.get(parentKey);
  if (control instanceof HTMLInputElement && control.type === 'checkbox') control.setAttribute('aria-controls', wrapper.id);
  return wrapper;
}

/** Push the current value into an existing control. */
function applyValue(spec: SettingSpec): void {
  const control = controls.get(spec.key);
  if (!control) return;
  const v = valueOf(spec);
  if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = v === true;
  else control.value = String(v);
  if (spec.enum && control instanceof HTMLSelectElement) renderEnumHint(spec, control);
}

/** The sidebar: one entry per group, in declaration order. */
function renderNav(groups: { group: string }[]): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'pf-nav';
  nav.setAttribute('aria-label', 'Preferences sections');

  const title = document.createElement('h1');
  title.className = 'pf-navtitle';
  title.textContent = 'Preferences';
  nav.appendChild(title);

  const list = document.createElement('div');
  list.className = 'pf-navlist';
  for (const { group } of groups) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'pf-navlink';
    link.textContent = group;
    link.addEventListener('click', () => {
      sections.get(group)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      markCurrent(group);
    });
    navLinks.set(group, link);
    list.appendChild(link);
  }
  nav.appendChild(list);
  return nav;
}

function markCurrent(group: string): void {
  for (const [name, link] of navLinks) link.classList.toggle('current', name === group);
}

/**
 * Keep the sidebar in step with the scroll position.
 *
 * The topmost section still intersecting the reading area wins, rather than
 * whichever crossed a line most recently — otherwise scrolling up through a
 * short section skips its entry entirely.
 */
function watchScroll(scroller: HTMLElement): void {
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const group = (entry.target as HTMLElement).dataset.group ?? '';
        if (entry.isIntersecting) visible.add(group);
        else visible.delete(group);
      }
      const order = [...sections.keys()];
      const first = order.find((g) => visible.has(g));
      if (first) markCurrent(first);
    },
    { root: scroller, rootMargin: '0px 0px -65% 0px', threshold: 0 },
  );
  for (const section of sections.values()) observer.observe(section);
}

/**
 * The buttons a feature needs that are not settings.
 *
 * Connecting a credential and checking that it works are actions, not values,
 * and they belong beside the fields they are about — a token typed from a menu
 * while the settings sit in another window is two places to look for one job.
 */
const ACTIONS: { id: SettingActionId; label: string; tone?: 'primary' | 'danger'; title: string }[] = [
  {
    id: 'connectDiscord',
    label: 'Connect Discord…',
    tone: 'primary',
    title: 'Paste a bot token. It is checked against Discord, then kept in the system keychain.',
  },
  { id: 'testRemote', label: 'Test connection', title: 'Check the token, server, channel, authorised users and gateway.' },
  { id: 'disconnectDiscord', label: 'Disconnect', tone: 'danger', title: 'Forget the token and close the connection.' },
];

function renderActions(group: string): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'pf-actions';

  const buttons = document.createElement('div');
  buttons.className = 'pf-actionrow';
  for (const action of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pf-action${action.tone ? ` ${action.tone}` : ''}`;
    button.textContent = action.label;
    button.title = action.title;
    button.addEventListener('click', () => {
      // The host answers with `actionBusy` then `actionResult`; nothing is
      // assumed here about how long it takes or whether it worked.
      post({ type: 'action', id: action.id });
    });
    actionButtons.set(action.id, button);
    buttons.appendChild(button);
  }

  const result = document.createElement('pre');
  result.className = 'pf-actionresult';
  result.hidden = true;
  actionResults.set(group, result);

  bar.append(buttons, result);
  return bar;
}

function showActionResult(ok: boolean, lines: string[]): void {
  for (const result of actionResults.values()) {
    result.textContent = lines.join('\n');
    result.classList.toggle('bad', !ok);
    result.hidden = lines.length === 0;
  }
}

function setActionsBusy(busy: boolean, running?: SettingActionId): void {
  for (const [id, button] of actionButtons) {
    button.disabled = busy;
    if (id === running) button.classList.toggle('running', busy);
  }
}

function render(): void {
  if (!root) return;
  root.textContent = '';
  controls.clear();
  rows.clear();
  sections.clear();
  navLinks.clear();
  dependents.clear();
  actionButtons.clear();
  actionResults.clear();

  const groups = settingGroups();
  root.appendChild(renderNav([...groups, { group: ORCHESTRATION_GROUP }]));

  const main = document.createElement('div');
  main.className = 'pf-main';

  const note = document.createElement('p');
  note.className = 'pf-desc pf-intro';
  note.textContent = 'Saved as you type. Everything takes effect without restarting.';
  main.appendChild(note);

  for (const { group, settings } of groups) {
    const section = document.createElement('section');
    section.className = 'pf-group';
    section.dataset.group = group;
    sections.set(group, section);

    const heading = document.createElement('h2');
    heading.textContent = group;
    section.appendChild(heading);

    // A setting that depends on a boolean is rendered inside a wrapper that
    // follows it, so the group reads as "the switch, and what it governs"
    // rather than as a flat list where three of five fields do nothing.
    for (const spec of settings) {
      if (spec.dependsOn) {
        const firstOfThisParent = !dependents.has(spec.dependsOn);
        const wrapper = createDependents(spec.dependsOn, specByKey.get(spec.dependsOn)?.label ?? spec.dependsOn);
        if (firstOfThisParent) section.appendChild(wrapper);
        wrapper.firstElementChild!.appendChild(renderRow(spec));
        continue;
      }
      section.appendChild(renderRow(spec));
    }
    // The Discord buttons live inside the reveal, under the fields they act on.
    const wrapper = dependents.get('remote.enabled');
    if (group === 'Experimental' && wrapper) wrapper.firstElementChild!.appendChild(renderActions(group));
    main.appendChild(section);
  }

  // Not a settings group: one row per model, from the catalog the host sends.
  // Everything in it exists to configure tasks, so it collapses with the same
  // switch that turns tasks on ('orchestration.enabled', in Conversations) —
  // its own row is rendered above, in that loop, before this runs.
  const orch = document.createElement('section');
  orch.className = 'pf-group pf-orchestration';
  orch.dataset.group = ORCHESTRATION_GROUP;
  sections.set(ORCHESTRATION_GROUP, orch);
  const orchHeading = document.createElement('h2');
  orchHeading.textContent = ORCHESTRATION_GROUP;
  const orchIntro = document.createElement('p');
  orchIntro.className = 'pf-desc pf-intro';
  orchIntro.textContent = 'Configures tasks. Turn on “Run tasks in worktrees of their own” under Conversations to see it.';
  const orchWrapper = createDependents('orchestration.enabled', ORCHESTRATION_GROUP);
  const body = document.createElement('div');
  orchestrationBody = body;
  body.addEventListener('focusout', () => {
    if (!orchestrationStale) return;
    orchestrationStale = false;
    renderOrchestration(body, orchestration, post);
  });
  orchWrapper.firstElementChild!.appendChild(body);
  orch.append(orchHeading, orchIntro, orchWrapper);
  renderOrchestration(orchestrationBody, orchestration, post);
  main.appendChild(orch);

  root.appendChild(main);
  for (const parentKey of dependents.keys()) syncReveal(parentKey, { animate: false });
  markCurrent(groups[0]?.group ?? '');
  watchScroll(main);
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToPreferences | undefined;
  if (!message) return;
  if (message.type === 'actionBusy') {
    setActionsBusy(true, message.id);
    showActionResult(true, ['Working…']);
    return;
  }
  if (message.type === 'actionResult') {
    setActionsBusy(false);
    showActionResult(message.ok, message.lines);
    return;
  }
  if (message.type === 'status') {
    const before = Object.keys(statuses);
    statuses = message.status ?? {};
    for (const key of new Set([...before, ...Object.keys(statuses)])) applyStatus(key);
    return;
  }
  if (message.type === 'localEndpointResult') {
    setLocalEndpointResult(message);
    if (orchestrationBody) renderOrchestration(orchestrationBody, orchestration, post);
    return;
  }
  if (message.type === 'routingResult') {
    onRoutingResult(message.ok, message.errors, message.needsOverride === true);
    if (orchestrationBody) renderOrchestration(orchestrationBody, orchestration, post);
    return;
  }
  if (message.type === 'orchestration') {
    orchestration = message.view;
    // A usage read re-sends the view every minute or so. Redrawing under an
    // open tier dropdown, or a URL being typed, would lose it, so wait until focus leaves.
    const active = document.activeElement;
    const editing =
      active instanceof HTMLSelectElement || (active instanceof HTMLInputElement && active.type !== 'checkbox' && active.type !== 'radio');
    if (orchestrationBody?.contains(active) && editing) {
      orchestrationStale = true;
      return;
    }
    if (orchestrationBody) renderOrchestration(orchestrationBody, orchestration, post);
    return;
  }
  if (message.type !== 'values') return;
  values = message.values ?? {};
  if (controls.size === 0) render();
  else {
    for (const { settings } of settingGroups()) for (const spec of settings) {
      applyValue(spec);
      markRow(spec);
    }
    for (const parentKey of dependents.keys()) syncReveal(parentKey);
  }
});

// Escape closes, the way every preferences sheet on this platform does.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') post({ type: 'close' });
});

render();
post({ type: 'ready' });
