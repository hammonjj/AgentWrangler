/**
 * Orchestration's UI state: which tab, what is typed in the search box, which
 * row is open. Kept apart from the settings the host sends, so a redraw from a
 * fresh view — which arrives after every write and on every usage read — never
 * resets any of it.
 *
 * Only the tab outlives the window (through the bridge's state API); the rest
 * lasts as long as the document.
 */

import {
  DEFAULT_ORCHESTRATION_TAB,
  isOrchestrationTab,
  type OrchestrationTabId,
  type OrchestrationTabTarget,
} from '../../shared/orchestration/orchestrationTabs';

export type ModelFilter = 'all' | 'routable' | 'notRouted';

export interface OrchUiState {
  tab: OrchestrationTabId;
  /** Models tab: the search text, as typed. */
  query: string;
  filter: ModelFilter;
  /** The one expanded row, by catalog key. */
  expanded?: string;
  /** Per lane (tier name), whether its disabled rows are shown. */
  showDisabled: Record<string, boolean>;
  /** A model to scroll to and focus on the next draw of the Models tab. One-shot. */
  focusModelKey?: string;
}

export const ui: OrchUiState = {
  tab: DEFAULT_ORCHESTRATION_TAB,
  query: '',
  filter: 'all',
  showDisabled: {},
};

interface Persistence {
  load(): unknown;
  save(state: unknown): void;
}

let persistence: Persistence | undefined;

/** Read the remembered tab. Everything else the state holds for other keys is kept as it was. */
export function initUiPersistence(p: Persistence): void {
  persistence = p;
  const saved = p.load() as { orchestrationTab?: unknown } | undefined;
  if (saved && typeof saved === 'object' && isOrchestrationTab(saved.orchestrationTab)) ui.tab = saved.orchestrationTab;
}

function persistTab(): void {
  if (!persistence) return;
  const saved = persistence.load();
  const base = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  persistence.save({ ...base, orchestrationTab: ui.tab });
}

export function selectTab(tab: OrchestrationTabId): void {
  if (ui.tab === tab) return;
  ui.tab = tab;
  persistTab();
}

/** An open-tab message: switch, and on Models open and focus the named model. */
export function applyTabTarget(target: OrchestrationTabTarget): void {
  selectTab(target.tab);
  if (target.focusModelKey) {
    ui.focusModelKey = target.focusModelKey;
    ui.expanded = target.focusModelKey;
    // The row must not be filtered out from under the link that pointed at it.
    ui.query = '';
    ui.filter = 'all';
  }
}
