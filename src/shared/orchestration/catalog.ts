/**
 * The capability catalog: every model Agent Wrangler can reach, described by
 * what it can do rather than by its name (`docs/plans/intelligent-orchestration.md`
 * §6.2–§6.4).
 *
 * Three rules shape it:
 * - **Every fact says where it came from**, or that nobody knows (`Known<T>`).
 *   A capability no harness reported stays unknown; nothing here guesses one.
 * - **Tier is AW policy, not a model property.** The defaults below are a
 *   starting point; the user's choice lives in settings (`orchestration.models`)
 *   and wins. A model no default matches is *unassigned* and is never routed to
 *   automatically until the user gives it a tier. That is how a new model, or a
 *   local one, joins the pool: one setting, no code.
 * - **`TIER_DEFAULTS` is the only place a model is named.** Nothing else in the
 *   codebase may decide anything from a model id.
 *
 * Pure and shared: the main process builds the catalog, Preferences renders it.
 * No Node or DOM here.
 */

import type { CostBasis, EffortLevel, HarnessId, Millis, ModelSourceId, TierName } from './types';
import { EFFORT_LEVELS } from './types';
import type { ModelChoice } from '../conversation';
import { harnessesFor, type HostedSource } from '../harness';
import { modelLabel, normalizeModelId } from '../modelName';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a capability value came from: `reported` by a harness, `probed` from a
 * local server (§19, not built), `declared` by the user, `measured` from
 * telemetry.
 */
export type FactSource = 'reported' | 'probed' | 'declared' | 'measured';

/** A capability value that always says where it came from, or that nobody knows. */
export type Known<T> = { value: T; from: FactSource } | { unknown: true };

export const UNKNOWN: { unknown: true } = { unknown: true };

export function known<T>(value: T, from: FactSource): Known<T> {
  return { value, from };
}

export function isKnown<T>(k: Known<T>): k is { value: T; from: FactSource } {
  return !('unknown' in k);
}

// ---------------------------------------------------------------------------
// Tiers (§6.3)
// ---------------------------------------------------------------------------

/**
 * One capability tier. `reachableBy: 'escalation'` means the router never asks
 * for it and the resolver never upgrades into it for availability: only the
 * escalation ladder (with the mission's permission) or an explicit pin reaches it.
 */
export interface TierDef {
  name: TierName;
  reachableBy: 'route' | 'escalation';
}

/** Weakest first. Ordered data, so a tier can be inserted later without touching any record. */
export const DEFAULT_TIERS: readonly TierDef[] = [
  { name: 'basic', reachableBy: 'route' },
  { name: 'standard', reachableBy: 'route' },
  { name: 'expert', reachableBy: 'route' },
  { name: 'frontier', reachableBy: 'escalation' },
];

/** Position in the order, weakest 0; -1 for a tier the list does not have. */
export function tierRank(tiers: readonly TierDef[], name: TierName | undefined): number {
  if (name === undefined) return -1;
  return tiers.findIndex((t) => t.name === name);
}

/**
 * The tier list from settings (`orchestration.tiers`), or the defaults when it
 * is absent or malformed. All or nothing: half a tier list would silently
 * re-order the rest.
 */
export function parseTiers(raw: unknown): TierDef[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TIERS.map((t) => ({ ...t }));
  const out: TierDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = item as Partial<TierDef> | null;
    if (!t || typeof t.name !== 'string' || t.name.trim() === '' || seen.has(t.name)) {
      return DEFAULT_TIERS.map((d) => ({ ...d }));
    }
    seen.add(t.name);
    out.push({ name: t.name, reachableBy: t.reachableBy === 'escalation' ? 'escalation' : 'route' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shipped defaults: the one place a model is named (§6.3, decided 2026-09-24)
// ---------------------------------------------------------------------------

export interface TierDefault {
  source: HostedSource;
  /**
   * Claude: a family word in the *resolved* id, so `default` and `opus[1m]`
   * tier as the Opus they resolve to and a new Sonnet is still a Sonnet.
   */
  family?: string;
  /**
   * Codex: the exact model id. Only the newest generation is assigned: when a
   * newer generation covers a tier, the older one is not routed to.
   */
  model?: string;
  tier?: TierName;
  /** Not a model to route coding work to at all. Starts disabled and unassigned. */
  excluded?: string;
}

export const TIER_DEFAULTS: readonly TierDefault[] = [
  { source: 'anthropic', family: 'haiku', tier: 'basic' },
  { source: 'anthropic', family: 'sonnet', tier: 'standard' },
  { source: 'anthropic', family: 'opus', tier: 'expert' },
  { source: 'anthropic', family: 'fable', tier: 'frontier' },
  // Codex's own `model/list` descriptions: "fast and affordable" → basic,
  // "workhorse for coding" → standard, "frontier intelligence" → expert.
  { source: 'openai', model: 'gpt-6-luna', tier: 'basic' },
  { source: 'openai', model: 'gpt-reserve', tier: 'basic' },
  { source: 'openai', model: 'gpt-6-sol', tier: 'standard' },
  { source: 'openai', model: 'gpt-6-astra', tier: 'expert' },
  { source: 'openai', model: 'codex-auto-review', excluded: 'Not a coding model' },
];

/** The shipped default for a model, matched on the id it resolves to, or undefined (unassigned). */
export function defaultFor(source: ModelSourceId, resolvedId: string): TierDefault | undefined {
  const id = resolvedId.trim().toLowerCase();
  const parts = source === 'anthropic' ? (normalizeModelId(id) ?? '').split(/[-.]/) : [];
  return TIER_DEFAULTS.find((d) => {
    if (d.source !== source) return false;
    if (d.model !== undefined) return d.model === id;
    if (d.family !== undefined) return parts.includes(d.family);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Effort (§6.4)
// ---------------------------------------------------------------------------

/** AW level → the model's own level. */
export type EffortMap = Partial<Record<EffortLevel, string>>;

/** Native levels in strength order, across both harnesses. A level not listed is never mapped automatically. */
const NATIVE_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * Native levels only an explicit pin reaches: below the everyday range
 * (`none`, Codex's `minimal`), or session-scoped / extra-cost at the top
 * (Claude's `max`, Codex's `max` and `ultra`).
 */
export const PIN_ONLY_EFFORT: readonly string[] = ['none', 'minimal', 'max', 'ultra'];

function nativeRank(level: string): number {
  return NATIVE_ORDER.indexOf(level);
}

/**
 * The default map: `low`, `medium` and `high` to the level of the same name
 * (or the nearest stronger one the model has), and `max` to the strongest
 * level below the pin-only ones (`xhigh` where offered).
 *
 * Undefined for a model with no effort control. An empty map for a model whose
 * only levels are pin-only or unrecognised: it has effort, but nothing is sent
 * without a pin.
 */
export function defaultEffortMap(native: readonly string[]): EffortMap | undefined {
  if (native.length === 0) return undefined;
  const usable = native
    .filter((l) => nativeRank(l) >= 0 && !PIN_ONLY_EFFORT.includes(l))
    .sort((a, b) => nativeRank(a) - nativeRank(b));
  const map: EffortMap = {};
  if (usable.length === 0) return map;
  const strongest = usable[usable.length - 1];
  for (const level of EFFORT_LEVELS) {
    if (level === 'max') {
      map.max = strongest;
      continue;
    }
    const want = nativeRank(level);
    map[level] = usable.find((l) => nativeRank(l) >= want) ?? strongest;
  }
  return map;
}

/** A user's effort map, kept only where it names a level the model actually has. */
function declaredEffortMap(raw: EffortMap | undefined, native: readonly string[]): EffortMap | undefined {
  if (!raw) return undefined;
  const out: EffortMap = {};
  for (const level of EFFORT_LEVELS) {
    const v = raw[level];
    if (typeof v === 'string' && native.includes(v)) out[level] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What to send for an AW level: a native level, or `none` for a model without effort control. */
export function nativeEffortFor(entry: Pick<CatalogEntry, 'effortMap'>, level: EffortLevel): string {
  return entry.effortMap?.[level] ?? 'none';
}

// ---------------------------------------------------------------------------
// Policy: what the user declared, in settings
// ---------------------------------------------------------------------------

/** Settings key for per-model policy: `{ "<source>:<model>": { tier, enabled, effort } }`. */
export const MODEL_POLICY_KEY = 'orchestration.models';
/** Settings key for the tier list. Absent means `DEFAULT_TIERS`. */
export const TIERS_KEY = 'orchestration.tiers';

/**
 * One model's declared policy. A field that is absent follows the default;
 * `tier: null` is an explicit "unassigned", overriding a default tier.
 */
export interface ModelPolicyEntry {
  tier?: TierName | null;
  enabled?: boolean;
  effort?: EffortMap;
}

export type ModelPolicy = Record<string, ModelPolicyEntry>;

/** Trust nothing in `settings.json`: a person may have typed it. */
export function parseModelPolicy(raw: unknown): ModelPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ModelPolicy = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const entry: ModelPolicyEntry = {};
    if (v.tier === null || (typeof v.tier === 'string' && v.tier !== '')) entry.tier = v.tier as TierName | null;
    if (typeof v.enabled === 'boolean') entry.enabled = v.enabled;
    if (v.effort && typeof v.effort === 'object') {
      const effort: EffortMap = {};
      for (const level of EFFORT_LEVELS) {
        const n = (v.effort as Record<string, unknown>)[level];
        if (typeof n === 'string' && n !== '') effort[level] = n;
      }
      if (Object.keys(effort).length > 0) entry.effort = effort;
    }
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return out;
}

/** A change from Preferences: the value the user picked for one field. */
export interface ModelPolicyChange {
  key: string;
  /** A tier name, or null for unassigned. */
  tier?: TierName | null;
  enabled?: boolean;
  /** Put this field back to its default. */
  reset?: 'tier' | 'enabled' | 'all';
}

/**
 * The policy after one change. A value equal to the default is stored by
 * absence, as every other setting is, so a revised default reaches someone who
 * once picked the same thing; an entry left empty is removed.
 */
export function applyPolicyChange(
  policy: ModelPolicy,
  change: ModelPolicyChange,
  defaults: { tier?: TierName; enabled: boolean },
): ModelPolicy {
  const next: ModelPolicy = { ...policy };
  const entry: ModelPolicyEntry = { ...(next[change.key] ?? {}) };
  if (change.reset === 'all') {
    delete next[change.key];
    return next;
  }
  if (change.reset === 'tier') delete entry.tier;
  if (change.reset === 'enabled') delete entry.enabled;
  if (change.tier !== undefined) {
    if ((change.tier ?? undefined) === defaults.tier) delete entry.tier;
    else entry.tier = change.tier;
  }
  if (change.enabled !== undefined) {
    if (change.enabled === defaults.enabled) delete entry.enabled;
    else entry.enabled = change.enabled;
  }
  if (Object.keys(entry).length === 0) delete next[change.key];
  else next[change.key] = entry;
  return next;
}

// ---------------------------------------------------------------------------
// Descriptors and the catalog
// ---------------------------------------------------------------------------

/** One model at one source, by capability (§6.2). */
export interface ModelDescriptor {
  source: ModelSourceId;
  /** What the harness is called with (often an alias). */
  modelId: string;
  /** The wire id it resolves to. */
  resolvedId?: string;
  label: string;
  description?: string;
  location: 'hosted' | 'local';
  contextWindow: Known<number>;
  maxOutputTokens: Known<number>;
  toolCalling: Known<'reliable' | 'basic' | 'none'>;
  structuredOutput: Known<'schema' | 'json' | 'none'>;
  vision: Known<boolean>;
  streaming: Known<boolean>;
  /** Native effort levels, or `[]` for a model with no effort control. */
  nativeEffort: Known<string[]>;
  /** Local servers: slots. Hosted: unknown. */
  maxConcurrency: Known<number>;
  /** Measured from telemetry (later). */
  throughput: Known<{ outTokPerSec: number; ttftMs: number }>;
  costBasis: 'plan-window' | 'api-price' | 'none';
  /** For estimates only. */
  price?: { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number };
  /** Local only, optional. */
  hardware?: { device?: string; memoryGb?: number };
}

export interface CatalogEntry {
  /** `<source>:<resolved id>`: the policy key. Aliases of one model share it, and its tier. */
  key: string;
  descriptor: ModelDescriptor;
  /** Every id the harness accepts for this model, `descriptor.modelId` first. */
  aliases: string[];
  harnesses: HarnessId[];
  /** Absent: unassigned, and not routable automatically. */
  tier?: TierName;
  /** What the shipped defaults say, for Preferences to show beside the choice. */
  defaultTier?: TierName;
  /** The user chose the tier (including "unassigned"). */
  tierDeclared: boolean;
  /** The shipped defaults exclude it outright, and why. */
  excluded?: string;
  enabled: boolean;
  enabledDeclared: boolean;
  /** AW level → native level. Absent for a model with no effort control, or one whose levels are unknown. */
  effortMap?: EffortMap;
  effortMapFrom?: 'default' | 'declared';
  /** How this model's turns get a cost (§16.4). */
  costReporting: CostBasis;
  /** In the pool the router picks from: enabled and assigned a defined tier. */
  routable: boolean;
  notRoutableBecause?: string;
  /** When its harness last reported it. Absent for a list carried over from before the catalog. */
  reportedAt?: Millis;
}

export interface CapabilityCatalogView {
  /** Changes whenever anything that affects resolution does. Routing decisions record it. */
  version: string;
  tiers: TierDef[];
  /** Unassigned first, then weakest tier first. */
  entries: CatalogEntry[];
}

/** One source's last reported model list. */
export interface ReportedModels {
  source: HostedSource;
  models: ModelChoice[];
  /** Absent for a list carried over from the old model-catalog storage. */
  at?: Millis;
}

/** Limits a harness reports for a model once it has been used (Claude's `modelUsage`). */
export interface ObservedLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
  at: Millis;
}

export type PriceTable = Record<string, { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number }>;

export interface CatalogInputs {
  reported: ReportedModels[];
  /** Keyed by `modelKey`. */
  observed?: Record<string, ObservedLimits>;
  policy?: ModelPolicy;
  tiers?: readonly TierDef[];
  prices?: PriceTable;
}

export function modelKey(source: ModelSourceId, id: string): string {
  return `${source}:${id}`;
}

/** The id to call the harness with: a stable alias over `default`, which may move. */
function primaryOf(group: ModelChoice[]): ModelChoice {
  return group.find((m) => m.value !== 'default') ?? group[0];
}

function labelFor(source: ModelSourceId, primary: ModelChoice): string {
  if (source !== 'anthropic') return primary.label;
  const id = primary.resolved ?? primary.value;
  const name = modelLabel(id) ?? primary.label;
  // `opus[1m]` is the same model with a larger window, and needs telling apart.
  const window = /\[(\d+)m\]/i.exec(id);
  return window ? `${name} (${window[1]}M context)` : name;
}

function descriptorFor(
  source: HostedSource,
  primary: ModelChoice,
  observed: ObservedLimits | undefined,
  prices: PriceTable | undefined,
): ModelDescriptor {
  const resolvedId = primary.resolved;
  const price = prices?.[resolvedId ?? primary.value] ?? prices?.[primary.value];
  return {
    source,
    modelId: primary.value,
    resolvedId,
    label: labelFor(source, primary),
    description: primary.description,
    location: 'hosted',
    contextWindow: observed?.contextWindow !== undefined ? known(observed.contextWindow, 'reported') : UNKNOWN,
    maxOutputTokens: observed?.maxOutputTokens !== undefined ? known(observed.maxOutputTokens, 'reported') : UNKNOWN,
    toolCalling: UNKNOWN,
    structuredOutput: UNKNOWN,
    vision: primary.inputModalities ? known(primary.inputModalities.includes('image'), 'reported') : UNKNOWN,
    streaming: UNKNOWN,
    // A reported model with no levels has no effort control: that is what the
    // harness said (Claude: `supportsEffort` false; Haiku), not a gap.
    nativeEffort: known([...(primary.effortLevels ?? [])], 'reported'),
    maxConcurrency: UNKNOWN,
    throughput: UNKNOWN,
    costBasis: 'plan-window',
    price: price ? { ...price } : undefined,
  };
}

/** Build the catalog from what the harnesses reported and what the user declared. */
export function buildCatalog(input: CatalogInputs): CapabilityCatalogView {
  const tiers = (input.tiers ?? DEFAULT_TIERS).map((t) => ({ ...t }));
  const policy = input.policy ?? {};
  const entries: CatalogEntry[] = [];

  for (const { source, models, at } of input.reported) {
    const groups = new Map<string, ModelChoice[]>();
    for (const m of models) {
      const key = modelKey(source, m.resolved ?? m.value);
      const group = groups.get(key);
      if (group) group.push(m);
      else groups.set(key, [m]);
    }
    for (const [key, group] of groups) {
      const primary = primaryOf(group);
      const descriptor = descriptorFor(source, primary, input.observed?.[key], input.prices);
      const declared = policy[key] ?? {};
      const def = defaultFor(source, primary.resolved ?? primary.value);
      const defaultTier = def?.tier !== undefined && tierRank(tiers, def.tier) >= 0 ? def.tier : undefined;

      const tierDeclared = 'tier' in declared;
      let tier = tierDeclared ? (declared.tier ?? undefined) : defaultTier;
      let undefinedTier: string | undefined;
      if (tier !== undefined && tierRank(tiers, tier) < 0) {
        undefinedTier = tier;
        tier = undefined;
      }

      const enabledDeclared = declared.enabled !== undefined;
      const enabled = declared.enabled ?? def?.excluded === undefined;

      const native = isKnown(descriptor.nativeEffort) ? descriptor.nativeEffort.value : [];
      const declaredMap = declaredEffortMap(declared.effort, native);
      const effortMap = declaredMap ?? defaultEffortMap(native);

      let notRoutableBecause: string | undefined;
      if (!enabled) notRoutableBecause = def?.excluded && !enabledDeclared ? def.excluded : 'Disabled';
      else if (undefinedTier !== undefined) notRoutableBecause = `Tier "${undefinedTier}" is not defined`;
      else if (tier === undefined) notRoutableBecause = 'Unassigned';

      entries.push({
        key,
        descriptor,
        aliases: [primary.value, ...group.map((m) => m.value).filter((v) => v !== primary.value)],
        harnesses: harnessesFor(source),
        tier,
        defaultTier,
        tierDeclared,
        excluded: def?.excluded,
        enabled,
        enabledDeclared,
        effortMap,
        effortMapFrom: effortMap ? (declaredMap ? 'declared' : 'default') : undefined,
        costReporting: source === 'anthropic' ? 'harness-estimate' : descriptor.price ? 'price-table' : 'none',
        routable: notRoutableBecause === undefined,
        notRoutableBecause,
        reportedAt: at,
      });
    }
  }

  entries.sort((a, b) => {
    const ra = tierRank(tiers, a.tier);
    const rb = tierRank(tiers, b.tier);
    if (ra !== rb) return ra - rb; // unassigned (-1) first
    if (a.descriptor.source !== b.descriptor.source) return a.descriptor.source < b.descriptor.source ? -1 : 1;
    return a.descriptor.label.localeCompare(b.descriptor.label);
  });

  return { version: catalogVersion(tiers, entries), tiers, entries };
}

/**
 * The routable models whose tier lies in `[minTier, maxTier]`. Escalation-only
 * tiers are left out unless `allowEscalation` says the caller is the escalation
 * ladder or a pin. The router and resolver (#38) build on this; it is here so
 * that "a tier change changes resolution" is testable now.
 */
export function modelsInTierRange(
  catalog: CapabilityCatalogView,
  minTier: TierName,
  maxTier: TierName,
  opts: { allowEscalation?: boolean } = {},
): CatalogEntry[] {
  const lo = tierRank(catalog.tiers, minTier);
  const hi = tierRank(catalog.tiers, maxTier);
  if (lo < 0 || hi < 0 || lo > hi) return [];
  return catalog.entries.filter((e) => {
    if (!e.routable) return false;
    const r = tierRank(catalog.tiers, e.tier);
    if (r < lo || r > hi) return false;
    return opts.allowEscalation === true || catalog.tiers[r].reachableBy === 'route';
  });
}

/** FNV-1a over what affects resolution: the tiers and each model's tier, enablement and effort map. */
function catalogVersion(tiers: TierDef[], entries: CatalogEntry[]): string {
  const basis = JSON.stringify({
    tiers,
    models: entries
      .map((e) => [e.key, e.tier ?? null, e.enabled, e.effortMap ?? null, e.aliases])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `cat-${h.toString(16).padStart(8, '0')}`;
}

/** "low→low · medium→medium · high→high · max→xhigh", or why there is none. */
export function effortMapText(entry: Pick<CatalogEntry, 'effortMap' | 'descriptor'>): string {
  if (!isKnown(entry.descriptor.nativeEffort)) return 'Effort levels unknown';
  if (!entry.effortMap) return 'No effort control';
  const parts = EFFORT_LEVELS.filter((l) => entry.effortMap![l] !== undefined).map((l) => `${l}→${entry.effortMap![l]}`);
  return parts.length > 0 ? parts.join(' · ') : 'Effort only by pin';
}
