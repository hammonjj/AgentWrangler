/**
 * Small pieces every Orchestration tab uses: element builders, the switch,
 * and the facts about local models that more than one tab shows.
 *
 * No inline styles anywhere: every state is a class or an ARIA attribute the
 * stylesheet selects on (the CSP drops a `style` attribute silently).
 */

import type { OrchestrationPrefsView, PreferencesToHost } from '../../shared/preferences';
import { isKnown, type Known, type TierDef } from '../../shared/orchestration/catalog';
import { localHarnessWarning } from '../../shared/orchestration/localReadiness';
import type { LocalEndpointView } from '../../shared/orchestration/localEndpoints';

export type Post = (m: PreferencesToHost) => void;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, onClick: () => void, className = 'pf-action'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function option(select: HTMLSelectElement, value: string, label: string): HTMLOptionElement {
  const o = el('option', undefined, label);
  o.value = value;
  select.appendChild(o);
  return o;
}

/**
 * An on/off switch: a real button with `aria-pressed`, so Space and Enter
 * work and a screen reader says "toggle button, pressed". The knob is drawn by
 * `.aw-orch-switch[aria-pressed="true"]`, never by a style write.
 */
export function switchButton(opts: { label: string; pressed: boolean; onToggle: () => void; focusKey?: string; disabled?: boolean }): HTMLButtonElement {
  const b = el('button', 'aw-orch-switch');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(opts.pressed));
  b.setAttribute('aria-label', opts.label);
  if (opts.focusKey) b.dataset.focus = opts.focusKey;
  if (opts.disabled) b.disabled = true;
  b.appendChild(el('span', 'aw-orch-switch-knob'));
  b.addEventListener('click', opts.onToggle);
  return b;
}

/** Visually hidden, still read: the badge's "N need a tier", a search box's label. */
export function srOnly(text: string): HTMLSpanElement {
  return el('span', 'aw-orch-sr', text);
}

/** "200k (reported)", or "unknown": a fact never appears without where it came from. */
export function fact<T>(k: Known<T>, format: (v: T) => string): string {
  return isKnown(k) ? `${format(k.value)} (${k.from})` : 'unknown';
}

export function tierLabel(tier: TierDef): string {
  return tier.reachableBy === 'escalation' ? `${tier.name} (escalation only)` : tier.name;
}

/** What more than one tab needs to know about local models: each endpoint by source, and the harness-pin warning. */
export interface LocalContext {
  endpoints: Map<string, LocalEndpointView>;
  harnessWarning?: string;
}

export function localContext(view: OrchestrationPrefsView): LocalContext {
  const endpoints = new Map((view.local?.endpoints ?? []).map((e) => [e.source as string, e]));
  const enabled = view.catalog.entries.some((e) => e.enabled && endpoints.get(e.descriptor.source)?.enabled === true);
  const harnessWarning = localHarnessWarning(view.routing?.policy, enabled);
  return { endpoints, ...(harnessWarning ? { harnessWarning } : {}) };
}

/** A tab's heading and its one line of copy. */
export function tabHeader(title: string, copy: string): HTMLElement {
  const header = el('header', 'aw-orch-header');
  header.append(el('h3', 'aw-orch-title', title), el('p', 'aw-orch-lede', copy));
  return header;
}

/** A link-styled button that sends the open-tab message to this document. */
export function crossLink(label: string, onClick: () => void): HTMLButtonElement {
  return button(label, onClick, 'aw-orch-link');
}
