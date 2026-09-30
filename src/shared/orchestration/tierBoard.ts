/**
 * Preferences → Orchestration → Models: what the tier board shows, derived
 * from the catalog and nothing else.
 *
 * Nothing here decides whether a model is routable. `buildCatalog` does
 * (`routable`, `notRoutableBecause`), and `localModelStatus` says what a local
 * model still needs; this file only arranges and words their answers.
 *
 * Pure and shared: no Node or DOM here.
 */

import {
  defaultEffortMap,
  isKnown,
  mappableEffortLevels,
  PIN_ONLY_EFFORT,
  type CatalogEntry,
  type FactSource,
  type Known,
  type ModelDescriptor,
  type TierDef,
} from './catalog';
import { EFFORT_LEVELS, type EffortLevel } from './types';
import { harnessLabel } from '../harness';
import { formatTokens } from '../sessionUsage';
import type { StoredPrice } from './modelPrices';
import type { LocalEndpointModelView, LocalEndpointView } from './localEndpoints';
import { localModelStatus, type LocalModelStatus } from './localReadiness';
import { laneSubline, tierRoles } from './tierRoles';

// ---------------------------------------------------------------------------
// The Models tab's badge
// ---------------------------------------------------------------------------

/**
 * Enabled models that have no tier because nothing ever gave them one: no
 * shipped default names them and the user has not chosen. A model set to
 * `tier: null` on purpose was given an answer, so it does not count; nor does
 * one whose chosen tier the list no longer has (that one says why elsewhere).
 */
export function needsTierCount(entries: readonly Pick<CatalogEntry, 'enabled' | 'tier' | 'tierDeclared'>[]): number {
  return entries.filter((e) => e.enabled && e.tier === undefined && !e.tierDeclared).length;
}

/** The badge beside "Models": hidden at 0, with its screen-reader wording. */
export function needsTierBadge(count: number): { text: string; srText: string } | undefined {
  if (count <= 0) return undefined;
  return { text: String(count), srText: `${count} need${count === 1 ? 's' : ''} a tier` };
}

// ---------------------------------------------------------------------------
// One row's status: a dot and the words beside it
// ---------------------------------------------------------------------------

/**
 * `ok`: routable, nothing to say. `note`: routable, with something worth
 * knowing (grey). `caution`: routable, but something may stop it (amber).
 * `off`: disabled. `warn`: enabled and not routed.
 */
export type RowTone = 'ok' | 'note' | 'caution' | 'off' | 'warn';

export interface RowStatus {
  routable: boolean;
  tone: RowTone;
  /** The line under the id. Absent for a routable model with nothing to say. */
  reason?: string;
}

type StatusEntry = Pick<CatalogEntry, 'routable' | 'enabled' | 'notRoutableBecause' | 'tierDeclared'>;

function lowerFirst(s: string): string {
  // "Disabled" → "disabled", but an acronym ("GPU …") keeps its case.
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * "Not routed: …", from the catalog's own reason. The catalog says
 * `Unassigned` for both kinds; the row says which one it is, because the fix
 * differs (give it a tier, or undo a choice someone made).
 */
export function notRoutedText(entry: StatusEntry): string {
  const why = entry.notRoutableBecause ?? 'Unassigned';
  if (why === 'Unassigned') return `Not routed: ${entry.tierDeclared ? 'unassigned on purpose' : 'unassigned'}`;
  return `Not routed: ${lowerFirst(why)}`;
}

/**
 * The status of one row. `local` is `localModelStatus` for a model on a local
 * endpoint: a routable one it says still needs something gets a note (planning
 * or completions) or a caution (agentic work, which is what routing does).
 */
export function rowStatus(entry: StatusEntry, local?: LocalModelStatus): RowStatus {
  if (!entry.routable) return { routable: false, tone: entry.enabled ? 'warn' : 'off', reason: notRoutedText(entry) };
  if (local) {
    if (local.agentic.completionOnly) return { routable: true, tone: 'caution', reason: `Completion only: ${local.agentic.completionOnly}` };
    if (!local.agentic.ready && local.agentic.needs.length > 0) {
      return { routable: true, tone: 'caution', reason: `Agentic work needs ${local.agentic.needs.join(', ')}` };
    }
    if (!local.planning.ready && local.planning.needs.length > 0) return { routable: true, tone: 'note', reason: `Planning needs ${local.planning.needs.join(', ')}` };
    if (!local.completions.ready && local.completions.needs.length > 0) {
      return { routable: true, tone: 'note', reason: `Completions need ${local.completions.needs.join(', ')}` };
    }
  }
  return { routable: true, tone: 'ok' };
}

/**
 * `localModelStatus` for a model on a local endpoint, from what the endpoint
 * view reports; undefined for any other model.
 */
export function localStatusFor(
  entry: Pick<CatalogEntry, 'key' | 'enabled' | 'tier' | 'descriptor'>,
  tiers: readonly TierDef[],
  endpoint: LocalEndpointView | undefined,
  harnessBlocked?: string,
): { status: LocalModelStatus; model?: LocalEndpointModelView } | undefined {
  if (!endpoint || endpoint.source !== entry.descriptor.source) return undefined;
  const model = endpoint.models.find((m) => m.key === entry.key);
  const status = localModelStatus({
    entry,
    tiers,
    facts: {
      endpointOn: endpoint.enabled,
      health: endpoint.health.state,
      ...(endpoint.responses !== undefined ? { responses: endpoint.responses } : {}),
      ...(endpoint.messages !== undefined ? { messages: endpoint.messages } : {}),
      ...(model?.stage1 ? { stage1: model.stage1 } : {}),
      ...(model?.plannerWindowFits !== undefined ? { plannerWindowFits: model.plannerWindowFits } : {}),
    },
    ...(harnessBlocked ? { harnessBlocked } : {}),
  });
  return { status, ...(model ? { model } : {}) };
}

// ---------------------------------------------------------------------------
// The tier select
// ---------------------------------------------------------------------------

export interface TierOption {
  /** `''` is Unassigned. */
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * `Unassigned`, then each tier weakest first, the model's default marked.
 * A stored tier the list does not have is shown, disabled, so the control
 * says what settings.json says rather than pretending it is unassigned.
 */
export function tierOptions(entry: Pick<CatalogEntry, 'defaultTier' | 'tier' | 'stored'>, tiers: readonly TierDef[]): { options: TierOption[]; value: string } {
  const def = entry.defaultTier;
  const options: TierOption[] = [{ value: '', label: def === undefined ? 'Unassigned — default' : 'Unassigned' }];
  for (const t of tiers) {
    options.push({ value: t.name, label: `${t.name}${t.reachableBy === 'escalation' ? ' (escalation only)' : ''}${t.name === def ? ' — default' : ''}` });
  }
  const storedTier = entry.stored?.tier;
  if (entry.tier === undefined && typeof storedTier === 'string' && !tiers.some((t) => t.name === storedTier)) {
    options.push({ value: storedTier, label: `${storedTier} (not defined)`, disabled: true });
    return { options, value: storedTier };
  }
  return { options, value: entry.tier ?? '' };
}

// ---------------------------------------------------------------------------
// The expanded row
// ---------------------------------------------------------------------------

export interface ModelFact {
  label: string;
  value: string;
  /** `reported`, `declared`, `measured`, `probed`; absent when unknown or not a fact with a source. */
  from?: FactSource;
}

function knownFact<T>(label: string, k: Known<T>, format: (v: T) => string): ModelFact {
  return isKnown(k) ? { label, value: format(k.value), from: k.from } : { label, value: 'unknown' };
}

const COST_BASIS: Record<ModelDescriptor['costBasis'], string> = { 'plan-window': 'plan window', 'api-price': 'API price', none: 'none' };

/** Harness, Called as, Context, Max output, Vision, Cost basis. */
export function modelFacts(entry: Pick<CatalogEntry, 'descriptor' | 'harnesses' | 'aliases' | 'completions'>): ModelFact[] {
  const d = entry.descriptor;
  const harness = entry.harnesses.length > 0 ? entry.harnesses.map(harnessLabel).join(', ') : entry.completions ? 'none (structured completions)' : 'none';
  return [
    { label: 'Harness', value: harness },
    { label: 'Called as', value: entry.aliases.join(', ') },
    knownFact('Context', d.contextWindow, formatTokens),
    knownFact('Max output', d.maxOutputTokens, formatTokens),
    knownFact('Vision', d.vision, (v) => (v ? 'yes' : 'no')),
    { label: 'Cost basis', value: COST_BASIS[d.costBasis] },
  ];
}

export interface EffortOption {
  native: string;
  selected: boolean;
  /** The shipped default for this AW level: drawn dashed. */
  isDefault: boolean;
  /** Reached only by a pin: never offered, shown only when settings.json already maps to it. */
  pinOnly?: boolean;
}

export type EffortEditor =
  | { kind: 'unknown'; text: string }
  | { kind: 'none'; text: string }
  | { kind: 'map'; rows: { level: EffortLevel; options: EffortOption[] }[]; note: string };

/**
 * The effort map as the editor shows it: one row per AW level, one option per
 * native level the model has, pin-only levels left out. The default mapping
 * is marked; a stored mapping to a pin-only level (hand-edited) is shown, so
 * the control tells the truth, but is not offered.
 */
export function effortEditor(entry: Pick<CatalogEntry, 'descriptor' | 'effortMap'>): EffortEditor {
  const n = entry.descriptor.nativeEffort;
  if (!isKnown(n)) return { kind: 'unknown', text: 'Effort levels are unknown until the agent reports this model.' };
  const def = defaultEffortMap(n.value);
  if (!def) return { kind: 'none', text: 'This model has no effort control. Every level runs the same.' };
  const levels = mappableEffortLevels(n.value);
  const pinOnly = n.value.filter((l) => PIN_ONLY_EFFORT.includes(l));
  if (levels.length === 0) return { kind: 'none', text: `Effort only by pin: ${pinOnly.join(', ')} can only be reached by pinning this model.` };
  const rows = EFFORT_LEVELS.map((level) => {
    const current = entry.effortMap?.[level];
    const options: EffortOption[] = levels.map((native) => ({ native, selected: native === current, isDefault: native === def[level] }));
    if (current !== undefined && !levels.includes(current)) options.push({ native: current, selected: true, isDefault: false, pinOnly: true });
    return { level, options };
  });
  const note = `Dashed outline = shipped default.${pinOnly.length > 0 ? ` ${pinOnly.join(', ')} can only be reached by pinning this model.` : ''}`;
  return { kind: 'map', rows, note };
}

/**
 * "Differs from defaults: tier frontier (default expert) · disabled (default
 * on) · effort max→high", or that nothing is stored. Read from what
 * `orchestration.models` stores, so it names exactly what Reset removes.
 */
export function policyDiffText(entry: Pick<CatalogEntry, 'stored' | 'defaultTier' | 'excluded' | 'descriptor'>): string {
  const s = entry.stored;
  if (!s) return 'Following shipped defaults. Nothing is stored for this model.';
  const parts: string[] = [];
  if ('tier' in s) parts.push(`tier ${s.tier ?? 'unassigned'} (default ${entry.defaultTier ?? 'unassigned'})`);
  if (s.enabled !== undefined) parts.push(s.enabled ? `enabled (default ${entry.excluded ? 'off' : 'on'})` : `disabled (default ${entry.excluded ? 'off' : 'on'})`);
  if (s.effort) {
    const n = entry.descriptor.nativeEffort;
    const has = (v: string) => isKnown(n) && n.value.includes(v);
    const mapped = EFFORT_LEVELS.filter((l) => s.effort?.[l] !== undefined).map((l) => `${l}→${s.effort![l]}${has(s.effort![l]!) ? '' : ' (ignored: not a level it has)'}`);
    if (mapped.length > 0) parts.push(`effort ${mapped.join(', ')}`);
  }
  return parts.length > 0 ? `Differs from defaults: ${parts.join(' · ')}` : 'Stored, but nothing in it differs from the defaults.';
}

/** The line under the price fields: what the fields do for this model today. */
export function priceNote(entry: Pick<CatalogEntry, 'costReporting' | 'descriptor'>, stored: StoredPrice | undefined): string {
  const has = stored && Object.keys(stored).length > 0;
  if (entry.descriptor.location === 'local' && !has) return 'Local: no API cost. A price here only sets what running it would have cost.';
  if (has && (stored.inPerMTok === undefined || stored.outPerMTok === undefined)) return 'Input and output are both needed before a price counts.';
  if (entry.costReporting === 'harness-estimate') {
    return has ? 'The agent reports its own cost; these prices rank models of one tier by price.' : 'No price set: cost is estimated by the agent.';
  }
  return has ? 'Cost is worked out from these prices.' : 'No price set: cost shows as plan window only.';
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export type BoardFilter = 'all' | 'routable' | 'notRouted';

export interface BoardQuery {
  query: string;
  filter: BoardFilter;
  /** Per tier lane, whether its disabled rows are shown. */
  showDisabled: Readonly<Record<string, boolean>>;
  /** The expanded row is never collapsed away. */
  expanded?: string;
}

export interface BoardRow {
  entry: CatalogEntry;
  status: RowStatus;
  /** `orchestration.models` has an entry for it. */
  changed: boolean;
}

export interface BoardLane {
  /** `''` for "Needs a tier"; otherwise the tier's name. */
  key: string;
  kind: 'inbox' | 'tier';
  title: string;
  sub: string;
  escalation: boolean;
  /** The strength meter, four bars, lit or not. Tier lanes only. */
  bars?: boolean[];
  total: number;
  routable: number;
  countText: string;
  /** Nothing in the lane can be routed, and what that means for tasks. */
  warn?: string;
  rows: BoardRow[];
  /** Disabled rows folded behind the lane's footer button. */
  hidden: BoardRow[];
  hiddenOpen: boolean;
  /** The footer button's text, when the lane has disabled rows to fold. */
  toggleText?: string;
}

export interface Board {
  /** Over every model, ignoring the search text. */
  counts: Record<BoardFilter, number>;
  lanes: BoardLane[];
}

/** Four bars, `0…pos` lit, where `pos` is the tier's place scaled onto four. */
export function meterBars(index: number, count: number): boolean[] {
  const pos = count <= 1 ? 0 : Math.round((index * 3) / (count - 1));
  return [0, 1, 2, 3].map((b) => b <= pos);
}

/** Label, resolved id, the id it is called by and its aliases; case-insensitive. */
export function matchesQuery(entry: Pick<CatalogEntry, 'descriptor' | 'aliases'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const d = entry.descriptor;
  return [d.label, d.resolvedId ?? '', d.modelId, ...entry.aliases].some((s) => s.toLowerCase().includes(q));
}

function passesFilter(status: RowStatus, filter: BoardFilter): boolean {
  if (filter === 'routable') return status.routable;
  if (filter === 'notRouted') return !status.routable;
  return true;
}

/**
 * The warning a lane with nothing routable carries. Checked against the
 * resolver (`resolver.ts`: with nothing available at `minTier` it moves to the
 * lowest routable tier above it, within the cap, never into escalation-only)
 * and escalation (`escalation.ts`: "raise tier" tries the next tier only, and
 * is blocked when nothing there can run).
 */
function laneWarning(tier: TierDef): string {
  return tier.reachableBy === 'escalation'
    ? 'Nothing routable here, so escalation stops at the tier below.'
    : `Nothing routable. Tasks that need ${tier.name} move up to the next tier with a routable model, within their cap, never into escalation-only.`;
}

function namesList(rows: BoardRow[]): string {
  const names = rows.map((r) => r.entry.descriptor.label);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')}…` : names.join(', ');
}

/**
 * Lanes in order: "Needs a tier" (only when something is in it), then one per
 * tier, weakest first. Within a lane, enabled first, then catalog order. With
 * the filter on All and no search, a tier lane folds its disabled rows (never
 * the expanded one); "Needs a tier" never folds. With a filter or a search, a
 * lane with nothing to show is left out.
 */
export function buildBoard(entries: readonly CatalogEntry[], tiers: readonly TierDef[], statusOf: (e: CatalogEntry) => RowStatus, q: BoardQuery): Board {
  const rows: BoardRow[] = entries.map((entry) => ({ entry, status: statusOf(entry), changed: entry.stored !== undefined }));
  const routable = rows.filter((r) => r.status.routable).length;
  const counts: Record<BoardFilter, number> = { all: rows.length, routable, notRouted: rows.length - routable };
  const narrowed = q.filter !== 'all' || q.query.trim() !== '';
  const order = new Map(entries.map((e, i) => [e.key, i]));
  const sort = (list: BoardRow[]) =>
    [...list].sort((a, b) => Number(b.entry.enabled) - Number(a.entry.enabled) || (order.get(a.entry.key) ?? 0) - (order.get(b.entry.key) ?? 0));

  const lanes: BoardLane[] = [];
  const shown = (r: BoardRow) => passesFilter(r.status, q.filter) && matchesQuery(r.entry, q.query);

  const inbox = sort(rows.filter((r) => r.entry.tier === undefined));
  const inboxShown = inbox.filter(shown);
  if (inbox.length > 0 && !(narrowed && inboxShown.length === 0)) {
    lanes.push({
      key: '',
      kind: 'inbox',
      title: 'Needs a tier',
      sub: 'Never picked automatically. Give a model a tier to add it to the pool.',
      escalation: false,
      total: inbox.length,
      routable: 0,
      countText: `${inbox.length} waiting`,
      rows: inboxShown,
      hidden: [],
      hiddenOpen: false,
    });
  }

  for (const role of tierRoles(tiers)) {
    const tier = role.tier;
    const members = sort(rows.filter((r) => r.entry.tier === tier.name));
    const visible = members.filter(shown);
    if (narrowed && visible.length === 0) continue;
    const r = members.filter((m) => m.status.routable).length;
    const fold = !narrowed ? visible.filter((m) => !m.entry.enabled && m.entry.key !== q.expanded) : [];
    const open = q.showDisabled[tier.name] === true;
    lanes.push({
      key: tier.name,
      kind: 'tier',
      title: tier.name,
      sub: laneSubline(role),
      escalation: tier.reachableBy === 'escalation',
      bars: meterBars(role.index, tiers.length),
      total: members.length,
      routable: r,
      countText: `${r} of ${members.length} routable`,
      ...(r === 0 ? { warn: laneWarning(tier) } : {}),
      rows: fold.length > 0 && !open ? visible.filter((m) => !fold.includes(m)) : visible,
      hidden: fold,
      hiddenOpen: open,
      ...(fold.length > 0 ? { toggleText: open ? `Hide ${fold.length} disabled` : `Show ${fold.length} disabled: ${namesList(fold)}` } : {}),
    });
  }
  return { counts, lanes };
}
