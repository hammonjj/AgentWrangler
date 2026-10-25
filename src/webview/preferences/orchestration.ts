/**
 * Preferences → Orchestration: five tabs over one view.
 *
 * Not rendered from `settings.ts`, because it is not a list of scalar
 * settings. The host sends the whole view (`OrchestrationPrefsView`) after
 * every write and whenever a usage read lands; each tab redraws from it. What
 * the user is doing — the tab, the search, the open row, focus and scroll — is
 * UI state (`orchUi.ts`) and survives every redraw.
 *
 * Every edit is one message to the host; nothing here writes settings.
 */

import './orchestration.css';
import type { OrchestrationPrefsView } from '../../shared/preferences';
import { ORCHESTRATION_TABS, type OrchestrationTabId, type OrchestrationTabTarget } from '../../shared/orchestration/orchestrationTabs';
import { needsTierBadge, needsTierCount } from '../../shared/orchestration/tierBoard';
import { el, type Post } from './orchCommon';
import { applyTabTarget, selectTab, ui } from './orchUi';
import { renderPanel, renderTabs, type TabBadge } from './orchTabs';
import { renderRoutingTab } from './orchRouting';
import { renderModelsTab } from './orchModels';
import { renderTiersTab } from './orchTiers';
import { renderEndpointsTab } from './orchEndpoints';
import { renderReportTab } from './orchReport';

export { onRoutingResult } from './orchRouting';
export { clearEndpointPending, setLocalEndpointResult } from './orchEndpoints';
export { onTierListResult } from './orchTiers';
export { initUiPersistence, onWriteResult } from './orchUi';

export const ORCHESTRATION_GROUP = 'Orchestration';

/** Where focus goes after the next draw, when it is not simply where it was (a tab picked by arrow key). */
let pendingFocus: string | undefined;

/** The last arguments, so a cross-link or the host can redraw without a new view. */
let last: { host: HTMLElement; view: OrchestrationPrefsView | undefined; post: Post } | undefined;

/**
 * A control here sent a write, and the view that answers it should be drawn
 * at once even though that control still has focus: the row has to move lanes
 * and show what was stored. (Other views wait for focus to leave a dropdown or
 * a text field, so a usage read never redraws under someone mid-edit.)
 */
let writePending = false;

/** Whether the view that just arrived answers a write from here; clears the flag. */
export function consumeWritePending(): boolean {
  const was = writePending;
  writePending = false;
  return was;
}

/** Switch tab (a cross-link, or the host's open-tab message) and redraw. */
export function openOrchestrationTab(target: OrchestrationTabTarget): void {
  applyTabTarget(target);
  pendingFocus = target.focusModelKey ? undefined : `tab:${target.tab}`;
  if (last) renderOrchestration(last.host, last.view, last.post);
}

function focusKeyOf(node: Element | null): string | undefined {
  return node instanceof HTMLElement ? node.dataset.focus : undefined;
}

function restoreFocus(host: HTMLElement, key: string | undefined, caret?: [number, number]): void {
  if (!key) return;
  const target = host.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  target?.focus({ preventScroll: true });
  if (caret && target instanceof HTMLInputElement) {
    try {
      target.setSelectionRange(caret[0], caret[1]);
    } catch {
      // Not a text input (number, checkbox): nothing to put back.
    }
  }
}

function caretOf(node: Element | null): [number, number] | undefined {
  if (!(node instanceof HTMLInputElement)) return undefined;
  try {
    return node.selectionStart !== null && node.selectionEnd !== null ? [node.selectionStart, node.selectionEnd] : undefined;
  } catch {
    return undefined;
  }
}

/** Fill `host` (the section's body) from the view, replacing what was there. */
export function renderOrchestration(host: HTMLElement, view: OrchestrationPrefsView | undefined, hostPost: Post): void {
  last = { host, view, post: hostPost };
  const post: Post = (m) => {
    writePending = true;
    hostPost(m);
  };
  const scroller = host.closest('.pf-main');
  const scrollTop = scroller?.scrollTop;
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const hadFocus = focusKeyOf(active);
  const caret = caretOf(active);

  host.textContent = '';
  if (!view) {
    host.appendChild(el('p', 'pf-desc pf-empty', 'Loading…'));
    return;
  }

  const root = el('div', 'aw-orch');
  const badges: Partial<Record<OrchestrationTabId, TabBadge>> = {};
  const models = needsTierBadge(needsTierCount(view.catalog.entries));
  if (models) badges.models = models;

  const redraw = () => renderOrchestration(host, view, hostPost);
  const select = (id: OrchestrationTabId) => {
    selectTab(id);
    pendingFocus = `tab:${id}`;
    redraw();
  };
  root.appendChild(renderTabs(ui.tab, badges, select));

  for (const t of ORCHESTRATION_TABS) {
    const panel = renderPanel(t.id, ui.tab);
    root.appendChild(panel);
    if (t.id !== ui.tab) continue;
    switch (t.id) {
      case 'routing':
        renderRoutingTab(panel, view, post, redraw, () => openOrchestrationTab({ tab: 'report' }));
        break;
      case 'models':
        renderModelsTab(panel, view, post, redraw);
        break;
      case 'tiers':
        renderTiersTab(panel, view, post, redraw, (key) => restoreFocus(host, key));
        break;
      case 'endpoints':
        renderEndpointsTab(panel, view, post, (key) => openOrchestrationTab({ tab: 'models', focusModelKey: key }));
        break;
      case 'report':
        renderReportTab(panel, view);
        break;
    }
  }
  host.appendChild(root);

  if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
  const focusModel = ui.tab === 'models' ? ui.focusModelKey : undefined;
  ui.focusModelKey = undefined;
  if (focusModel) {
    const row = host.querySelector<HTMLElement>(`[data-model-key="${CSS.escape(focusModel)}"]`);
    row?.scrollIntoView({ block: 'center' });
    restoreFocus(host, `tier:${focusModel}`);
  } else if (pendingFocus) restoreFocus(host, pendingFocus);
  else restoreFocus(host, hadFocus, caret);
  pendingFocus = undefined;
}
