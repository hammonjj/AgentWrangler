/**
 * The Orchestration tab row: a real tablist (WAI-ARIA "tabs with automatic
 * activation"). Arrow keys move between tabs and select them, Home and End go
 * to the ends, and only the selected tab is in the Tab order.
 *
 * Every tab carries both labels; a container query on the pane shows the short
 * one below 400px, where the row scrolls sideways instead of wrapping.
 */

import { ORCHESTRATION_TABS, type OrchestrationTabId } from '../../shared/orchestration/orchestrationTabs';
import { el, srOnly } from './orchCommon';

export const tabId = (id: OrchestrationTabId) => `aw-orch-tab-${id}`;
export const panelId = (id: OrchestrationTabId) => `aw-orch-panel-${id}`;

export interface TabBadge {
  text: string;
  srText: string;
}

export function renderTabs(active: OrchestrationTabId, badges: Partial<Record<OrchestrationTabId, TabBadge>>, select: (id: OrchestrationTabId) => void): HTMLElement {
  const list = el('div', 'aw-orch-tabs');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Orchestration sections');
  const tabs: HTMLButtonElement[] = [];
  for (const t of ORCHESTRATION_TABS) {
    const tab = el('button', 'aw-orch-tab');
    tab.type = 'button';
    tab.id = tabId(t.id);
    tab.dataset.focus = `tab:${t.id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panelId(t.id));
    const selected = t.id === active;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.append(el('span', 'aw-orch-tab-long', t.label), el('span', 'aw-orch-tab-short', t.short));
    const badge = badges[t.id];
    if (badge) {
      const b = el('span', 'aw-orch-badge');
      b.append(el('span', undefined, badge.text));
      b.firstElementChild?.setAttribute('aria-hidden', 'true');
      b.append(srOnly(badge.srText));
      tab.append(b);
    }
    tab.addEventListener('click', () => select(t.id));
    tabs.push(tab);
    list.appendChild(tab);
  }
  list.addEventListener('keydown', (event) => {
    const i = tabs.findIndex((t) => t === document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    select(ORCHESTRATION_TABS[next].id);
  });
  return list;
}

/** One panel per tab, all present so every `aria-controls` names an element; only the selected one is shown. */
export function renderPanel(id: OrchestrationTabId, active: OrchestrationTabId): HTMLElement {
  const panel = el('div', 'aw-orch-panel');
  panel.id = panelId(id);
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', tabId(id));
  panel.hidden = id !== active;
  panel.tabIndex = 0;
  return panel;
}
