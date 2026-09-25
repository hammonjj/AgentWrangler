/**
 * Every model the CLIs have reported, what each can do, and the tier AW gives
 * it (`docs/plans/intelligent-orchestration.md` §6.3). Grew out of
 * `ModelCatalogService`, which only remembered the last model list.
 *
 * Two kinds of state, kept in two places on purpose:
 * - **Facts** the harnesses reported (the model lists, and the limits Claude
 *   reports after a model is used) live in global state. They are allowed to
 *   be a little old: a model added since the last conversation appears after
 *   the next one, which is why the launcher always keeps a "Default" row.
 * - **Policy** the user declared (tier, enabled, effort map) lives in settings
 *   (`orchestration.models`), and the tier list in `orchestration.tiers`.
 *   Tier is never a property of the stored model: changing it is one settings
 *   write, it changes future resolution and nothing else, and there is nothing
 *   to migrate.
 *
 * The launcher still reads `value` (the flat model list), exactly as before.
 *
 * Storage upgrade: the old `agentWrangler.modelCatalog` list is read once, when
 * the new key does not exist yet, and carried over whole. The old key is left
 * where it is (an older build reading it still works) and is never read again.
 */

import { Emitter, type Disposable, type Listener } from './events';
import type { KeyValueStorage } from './archive';
import type { ModelChoice } from '../shared/conversation';
import { HOSTED_SOURCES, type HostedSource } from '../shared/harness';
import {
  applyPolicyChange,
  buildCatalog,
  modelKey,
  MODEL_POLICY_KEY,
  parseModelPolicy,
  parseTiers,
  tierRank,
  TIERS_KEY,
  type CapabilityCatalogView,
  type ModelPolicyChange,
  type ObservedLimits,
  type PriceTable,
  type ReportedModels,
} from '../shared/orchestration/catalog';

const LEGACY_KEY = 'agentWrangler.modelCatalog';
const STORAGE_KEY = 'agentWrangler.capabilityCatalog';
/** Same key telemetry prices Codex turns from: one price table, not two. */
export const PRICES_KEY = 'telemetry.prices';

interface Stored {
  v: 1;
  reported: ReportedModels[];
  /** Keyed by `modelKey`. */
  observed: Record<string, ObservedLimits>;
}

/** The subset of `HostSettings` the catalog reads and writes. */
export interface CatalogSettings {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
  onDidChange(listener: (affects: (key: string) => boolean) => void): Disposable;
}

export class CapabilityCatalog implements Disposable {
  private state: Stored;
  private emitter = new Emitter<void>();
  private cached?: CapabilityCatalogView;
  private sub?: Disposable;

  constructor(
    private storage: KeyValueStorage,
    private settings?: CatalogSettings,
    private now: () => number = Date.now,
  ) {
    const stored = parseStored(storage.get<unknown>(STORAGE_KEY, undefined));
    if (stored) {
      this.state = stored;
    } else {
      this.state = { v: 1, reported: fromLegacy(storage.get<unknown>(LEGACY_KEY, [])), observed: {} };
      if (this.state.reported.length > 0) void storage.update(STORAGE_KEY, this.state);
    }
    this.sub = settings?.onDidChange((affects) => {
      if (affects(MODEL_POLICY_KEY) || affects(TIERS_KEY) || affects(PRICES_KEY)) this.changed();
    });
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  /** The flat model list the launcher offers, each tagged with its source. */
  get value(): ModelChoice[] {
    return this.state.reported.flatMap((r) => r.models.map((m) => ({ ...m, provider: r.source })));
  }

  /** The catalog: facts merged with policy. Rebuilt only when either changes. */
  get catalog(): CapabilityCatalogView {
    if (!this.cached) {
      this.cached = buildCatalog({
        reported: this.state.reported,
        observed: this.state.observed,
        policy: parseModelPolicy(this.settings?.get<unknown>(MODEL_POLICY_KEY, undefined)),
        tiers: parseTiers(this.settings?.get<unknown>(TIERS_KEY, undefined)),
        prices: parsePrices(this.settings?.get<unknown>(PRICES_KEY, undefined)),
      });
    }
    return this.cached;
  }

  /**
   * Record what a runner just reported. Ignores an empty list: a CLI too old
   * to answer, or one that has not answered yet, must not erase a good list
   * from the last conversation.
   */
  remember(source: HostedSource, models: ModelChoice[] | undefined): void {
    const incoming = saneModels(models).map(({ provider: _p, ...m }) => m);
    if (incoming.length === 0) return;
    const at = this.now();
    const previous = this.state.reported.find((r) => r.source === source);
    const same = previous !== undefined && sameModels(previous.models, incoming);
    const reported = [...this.state.reported.filter((r) => r.source !== source), { source, models: incoming, at }];
    // Stable order: the launcher lists Anthropic's models before OpenAI's.
    reported.sort((a, b) => HOSTED_SOURCES.indexOf(a.source) - HOSTED_SOURCES.indexOf(b.source));
    this.state = { ...this.state, reported };
    void this.storage.update(STORAGE_KEY, this.state);
    // Only the timestamp moved: nothing anyone shows has changed.
    if (same) this.cached = undefined;
    else this.changed();
  }

  /** Record the limits a harness reported for a model it just used. */
  observe(source: HostedSource, model: string, limits: { contextWindow?: number; maxOutputTokens?: number }): void {
    const key = modelKey(source, model);
    const prev = this.state.observed[key];
    const next: ObservedLimits = {
      contextWindow: limits.contextWindow ?? prev?.contextWindow,
      maxOutputTokens: limits.maxOutputTokens ?? prev?.maxOutputTokens,
      at: this.now(),
    };
    if (prev && prev.contextWindow === next.contextWindow && prev.maxOutputTokens === next.maxOutputTokens) return;
    this.state = { ...this.state, observed: { ...this.state.observed, [key]: next } };
    void this.storage.update(STORAGE_KEY, this.state);
    this.changed();
  }

  /**
   * Apply one change from Preferences to the declared policy. Refuses a tier
   * the tier list does not have and a model the catalog has never seen.
   */
  async setPolicy(change: ModelPolicyChange): Promise<boolean> {
    if (!this.settings) return false;
    const view = this.catalog;
    const entry = view.entries.find((e) => e.key === change.key);
    if (!entry) return false;
    if (change.tier !== undefined && change.tier !== null && tierRank(view.tiers, change.tier) < 0) return false;
    const policy = parseModelPolicy(this.settings.get<unknown>(MODEL_POLICY_KEY, undefined));
    const next = applyPolicyChange(policy, change, {
      tier: entry.defaultTier,
      enabled: entry.excluded === undefined,
    });
    await this.settings.update(MODEL_POLICY_KEY, Object.keys(next).length > 0 ? next : undefined);
    return true;
  }

  dispose(): void {
    this.sub?.dispose();
    this.emitter.dispose();
  }

  private changed(): void {
    this.cached = undefined;
    this.emitter.fire();
  }
}

// ---------------------------------------------------------------------------
// Reading what is on disk. Trust nothing: older versions, or a person, wrote it.
// ---------------------------------------------------------------------------

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : undefined;
}

function saneModels(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const m = entry as Partial<ModelChoice>;
    if (typeof m.value !== 'string' || m.value === '' || typeof m.label !== 'string') return [];
    const out: ModelChoice = {
      value: m.value,
      label: m.label,
      provider: m.provider === 'openai' ? 'openai' : 'anthropic',
      resolved: typeof m.resolved === 'string' ? m.resolved : undefined,
      effortLevels: strings(m.effortLevels),
    };
    if (typeof m.description === 'string' && m.description !== '') out.description = m.description;
    const modalities = strings(m.inputModalities);
    if (modalities) out.inputModalities = modalities;
    return [out];
  });
}

/** The old flat list, split by source. Entries without a source were Anthropic's (the only one then). */
function fromLegacy(raw: unknown): ReportedModels[] {
  const models = saneModels(raw);
  return HOSTED_SOURCES.flatMap((source) => {
    const mine = models.filter((m) => m.provider === source).map(({ provider: _p, ...m }) => m);
    return mine.length > 0 ? [{ source, models: mine }] : [];
  });
}

function parseStored(raw: unknown): Stored | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<Stored>;
  if (s.v !== 1 || !Array.isArray(s.reported)) return undefined;
  const reported: ReportedModels[] = [];
  for (const r of s.reported) {
    const source = (r as Partial<ReportedModels>)?.source;
    if (source !== 'anthropic' && source !== 'openai') continue;
    const models = saneModels((r as ReportedModels).models).map(({ provider: _p, ...m }) => m);
    if (models.length === 0) continue;
    const at = (r as ReportedModels).at;
    reported.push({ source, models, ...(typeof at === 'number' ? { at } : {}) });
  }
  const observed: Record<string, ObservedLimits> = {};
  if (s.observed && typeof s.observed === 'object') {
    for (const [key, v] of Object.entries(s.observed)) {
      if (!v || typeof v !== 'object' || typeof v.at !== 'number') continue;
      observed[key] = {
        contextWindow: typeof v.contextWindow === 'number' ? v.contextWindow : undefined,
        maxOutputTokens: typeof v.maxOutputTokens === 'number' ? v.maxOutputTokens : undefined,
        at: v.at,
      };
    }
  }
  return { v: 1, reported, observed };
}

function parsePrices(raw: unknown): PriceTable | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: PriceTable = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    const v = p as Partial<PriceTable[string]> | null;
    if (!v || typeof v.inPerMTok !== 'number' || typeof v.outPerMTok !== 'number') continue;
    out[model] = {
      inPerMTok: v.inPerMTok,
      outPerMTok: v.outPerMTok,
      ...(typeof v.cacheReadPerMTok === 'number' ? { cacheReadPerMTok: v.cacheReadPerMTok } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sameModels(a: ModelChoice[], b: ModelChoice[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
