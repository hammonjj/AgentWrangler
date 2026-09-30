/**
 * Orchestration → Tiers: the tier list, weakest first (`orchestration.tiers`).
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import { el, tierLabel } from './orchCommon';

export function renderTiersTab(host: HTMLElement, view: OrchestrationPrefsView): void {
  host.appendChild(el('h3', 'pf-subhead', 'Tiers'));
  host.appendChild(
    el('p', 'pf-desc', 'Order is the strength ranking, weakest first. Stored in settings.json under orchestration.tiers; absent, the shipped tiers apply.'),
  );
  const list = el('ol', 'aw-orch-tierlist-ro');
  for (const t of view.catalog.tiers) list.appendChild(el('li', 'pf-label', tierLabel(t)));
  host.appendChild(list);
}
