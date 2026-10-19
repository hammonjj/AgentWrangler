/**
 * The sub-tabs of Preferences → Orchestration, and the message that opens one.
 *
 * Shared because the host may open the window on a tab (and name a model to
 * focus), and the webview's cross-links send itself the same message: one
 * shape, checked in one place.
 *
 * Pure: no Node or DOM here.
 */

export type OrchestrationTabId = 'routing' | 'models' | 'tiers' | 'endpoints' | 'report';

export interface OrchestrationTab {
  id: OrchestrationTabId;
  /** The label at 400px of pane and wider. */
  label: string;
  /** The label below 400px, where the tab row scrolls. */
  short: string;
}

/** In the order the tab row shows them. */
export const ORCHESTRATION_TABS: readonly OrchestrationTab[] = [
  { id: 'routing', label: 'Routing', short: 'Routing' },
  { id: 'models', label: 'Models', short: 'Models' },
  { id: 'tiers', label: 'Tiers', short: 'Tiers' },
  { id: 'endpoints', label: 'Sources & endpoints', short: 'Sources' },
  { id: 'report', label: 'Shadow report', short: 'Report' },
];

/** The tab shown the first time, before anything was remembered. */
export const DEFAULT_ORCHESTRATION_TAB: OrchestrationTabId = 'models';

export function isOrchestrationTab(value: unknown): value is OrchestrationTabId {
  return typeof value === 'string' && ORCHESTRATION_TABS.some((t) => t.id === value);
}

/** Where a cross-link or the host wants the section to open. */
export interface OrchestrationTabTarget {
  tab: OrchestrationTabId;
  /** A catalog key (`<source>:<resolved id>`) to expand and focus on the Models tab. */
  focusModelKey?: string;
}

/** The type of the open-tab message, host → webview and webview → itself. */
export const OPEN_TAB_MESSAGE = 'orchestration.openTab';

/** An open-tab message's target, or nothing when it is not well formed. */
export function orchestrationTabTarget(message: unknown): OrchestrationTabTarget | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { type?: unknown; tab?: unknown; focusModelKey?: unknown };
  if (m.type !== OPEN_TAB_MESSAGE || !isOrchestrationTab(m.tab)) return undefined;
  if (m.focusModelKey !== undefined && (typeof m.focusModelKey !== 'string' || m.focusModelKey === '')) return undefined;
  return { tab: m.tab, ...(typeof m.focusModelKey === 'string' ? { focusModelKey: m.focusModelKey } : {}) };
}
