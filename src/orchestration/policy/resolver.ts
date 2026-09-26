/**
 * The resolver: a route requirement and an explicit snapshot of the catalog
 * and the sources' health in, a concrete harness × model × effort out — with
 * every candidate it did not pick and why (`docs/plans/intelligent-orchestration.md`
 * §9.4; #38).
 *
 * Pure. The snapshot is a value, not a service, so a stored decision can be
 * replayed in a test against the catalog and health it was made with.
 *
 * Rules it keeps:
 *
 * - **Only routable models.** An unassigned or disabled model is a rejected
 *   candidate that says so; it is never picked, however good it might be
 *   (§6.3: a new model joins the pool by one setting, not by being noticed).
 * - **Exactly `minTier` first.** A higher tier is used only when nothing at
 *   `minTier` is available, and never above `maxTier` or into an
 *   escalation-only tier (§9.4 step 2).
 * - **Fallbacks are the same tier.** The ordered list escalation and failover
 *   may use never quietly changes capability (§9.4 step 5).
 */
import {
  isKnown,
  nativeEffortFor,
  tierRank,
  type CapabilityCatalogView,
  type CatalogEntry,
} from '../../shared/orchestration/catalog';
import type { SourceStatus } from '../../shared/orchestration/sourceHealth';
import { harnessLabel } from '../../shared/harness';
import type {
  ExecutionTarget,
  HarnessId,
  Millis,
  ResolverCandidate,
  RouteCaps,
  RouteExclusions,
  RoutePreferences,
  RouteRequirement,
} from '../../shared/orchestration/types';
import { contextNeedOf } from './router';

/** What the resolver decides against. A value, so a decision replays (§9.1). */
export interface ResolverSnapshot {
  catalog: CapabilityCatalogView;
  /** Health and capacity by source. A source absent here is `unknown`, which does not block. */
  sources: Record<string, SourceStatus>;
  now: Millis;
}

export interface ResolverPolicy {
  caps?: RouteCaps;
  preferences?: RoutePreferences;
  exclusions?: RouteExclusions;
}

export interface Resolution {
  /**
   * `resolved`: `target` runs it. `blocked`: something would, once capacity
   * frees up (§9.4: a usage window resets). `needs-human`: the policy and the
   * catalog allow nothing that can do it.
   */
  outcome: 'resolved' | 'blocked' | 'needs-human';
  target?: ExecutionTarget;
  /** Every candidate considered: the chosen one, same-tier fallbacks, and the rest with why not. */
  candidates: ResolverCandidate[];
  /** Why there is no target, or why the target is above `minTier`. */
  note?: string;
  catalogVersion: string;
}

/**
 * The admission threshold when the mission sets none: a source whose fullest
 * usage window is at or above this is not started on (§9.4 step 3). Just below
 * `sourceHealth`'s `down` at 100%, so a nearly-full window is not spent on a
 * task that would be cut off part-way.
 */
export const DEFAULT_ADMISSION_PERCENT = 95;

/**
 * A hosted model's context window before its harness has reported one. Claude
 * reports it only after first use and Codex not at all (§6.5), so requiring a
 * reported window would make nearly every hosted model unroutable. Every
 * hosted coding model either harness offers today has at least this much, so
 * a need at or under it is accepted and the decision says it was assumed; a
 * larger need waits for a reported figure. A local model is never assumed
 * (§19.6: what Claude Code reports for one is false).
 */
export const ASSUMED_HOSTED_WINDOW = 200_000;

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`;
}

function targetOf(entry: CatalogEntry, harness: HarnessId, req: RouteRequirement): ExecutionTarget {
  const d = entry.descriptor;
  return {
    harness,
    source: d.source,
    model: d.modelId,
    ...(d.resolvedId ? { resolvedModel: d.resolvedId } : {}),
    tier: entry.tier ?? 'unassigned',
    effortNative: nativeEffortFor(entry, req.effort),
    location: d.location,
  };
}

interface Considered {
  entry: CatalogEntry;
  target: ExecutionTarget;
  /** Index in the catalog, for a stable last rank key. */
  order: number;
  tierRank: number;
  /** Why not, when it fails a hard filter. */
  rejected?: string;
  /** Failed only on capacity: it would do once a window resets. */
  capacityOnly?: boolean;
  /** A soft note that rides along with a candidate that passed (e.g. an assumed window). */
  note?: string;
}

/** The first hard filter a candidate fails, or undefined when it passes them all. */
function hardFilter(
  c: Considered,
  req: RouteRequirement,
  snap: ResolverSnapshot,
  policy: ResolverPolicy,
): { reason: string; capacity?: boolean; note?: string } | { note?: string } {
  const e = c.entry;
  const d = e.descriptor;
  const label = d.label;
  const tiers = snap.catalog.tiers;

  // 1. In the pool at all (§6.3).
  if (!e.routable) return { reason: `${label}: ${e.notRoutableBecause ?? 'not routable'}` };

  // 2. Policy: exclusions and location caps.
  const ex = policy.exclusions;
  if (ex?.harnesses?.includes(c.target.harness)) return { reason: `${label}: ${harnessLabel(c.target.harness)} is excluded` };
  if (ex?.sources?.includes(d.source)) return { reason: `${label}: its source is excluded` };
  if (d.location === 'local' && (ex?.disableLocal || policy.caps?.location === 'hosted-only')) return { reason: `${label}: local models are off` };
  if (d.location === 'hosted' && policy.caps?.location === 'local-only') return { reason: `${label}: the mission is local-only` };

  // 3. Tier fit.
  const r = c.tierRank;
  const def = tiers[r];
  if (def && def.reachableBy !== 'route') return { reason: `${label}: ${def.name} is reached only by escalation` };
  const lo = tierRank(tiers, req.minTier);
  const hi = tierRank(tiers, req.maxTier);
  if (hi >= 0 && r > hi) return { reason: `${label}: ${e.tier} is above the ${req.maxTier} cap` };
  if (lo >= 0 && r < lo) return { reason: `${label}: ${e.tier} is below the required ${req.minTier}` };

  // 4. Hard needs the model has to meet. Tool needs (edit, shell, network) are
  // the harness's, and both harnesses are agentic; `exclusive:` is a lease (#68).
  if (req.needs.includes('vision')) {
    if (!isKnown(d.vision)) return { reason: `${label}: nothing has reported whether it takes images` };
    if (!d.vision.value) return { reason: `${label}: does not take images` };
  }

  // 5. Context window, with headroom already in the need.
  let note: string | undefined;
  const need = contextNeedOf(req.needs);
  if (need !== undefined) {
    if (isKnown(d.contextWindow)) {
      if (d.contextWindow.value < need) return { reason: `${label}: context ${fmtTokens(d.contextWindow.value)} < needed ${fmtTokens(need)}` };
    } else if (d.location === 'hosted' && need <= ASSUMED_HOSTED_WINDOW) {
      note = `context window not reported yet; ${fmtTokens(need)} needed is within the ${fmtTokens(ASSUMED_HOSTED_WINDOW)} every hosted model has`;
    } else {
      return { reason: `${label}: context window not reported, and ${fmtTokens(need)} is needed` };
    }
  }

  // 6. Availability (§9.4 step 3). An unknown source does not block: nothing says it is full.
  const status = snap.sources[d.source];
  if (status) {
    const backoff = status.capacity.backoffUntil;
    if (status.health.state === 'down' || (backoff !== undefined && backoff > snap.now)) {
      return { reason: `${label}: ${status.health.reason}`, capacity: status.health.state === 'down' && backoff !== undefined };
    }
    const threshold = policy.caps?.maxUsageWindowPercent ?? DEFAULT_ADMISSION_PERCENT;
    const pct = status.capacity.windowPercent;
    if (isKnown(pct) && pct.value >= threshold) {
      return { reason: `${label}: usage window ${Math.round(pct.value)}% (admits below ${threshold}%)`, capacity: true };
    }
  }
  return { note };
}

/** Rank keys within one tier (§9.4 step 4): preferences, effort support, price, then catalog order. */
function compare(a: Considered, b: Considered, req: RouteRequirement, policy: ResolverPolicy): number {
  const prefer = policy.preferences ?? req.prefer;
  const keys: ((c: Considered) => number)[] = [
    (c) => (prefer?.harness && c.target.harness === prefer.harness ? 0 : 1),
    (c) => (prefer?.source && c.entry.descriptor.source === prefer.source ? 0 : 1),
    (c) => (prefer?.preferLocal || prefer?.strategy === 'prefer-local' ? (c.entry.descriptor.location === 'local' ? 0 : 1) : 0),
    // A soft preference only (§6.4): a model that can be asked to think harder, when harder is wanted.
    (c) => (req.effort === 'high' || req.effort === 'max' ? (c.entry.effortMap ? 0 : 1) : 0),
    (c) => {
      const p = c.entry.descriptor.price;
      return p ? p.inPerMTok + p.outPerMTok : Number.MAX_SAFE_INTEGER;
    },
    (c) => c.order,
  ];
  for (const k of keys) {
    const d = k(a) - k(b);
    if (d !== 0) return d;
  }
  return 0;
}

/** Requirement + snapshot + policy → target, fallbacks and every rejection. Pure. */
export function resolveRoute(req: RouteRequirement, snap: ResolverSnapshot, policy: ResolverPolicy = {}): Resolution {
  const tiers = snap.catalog.tiers;
  const all: Considered[] = [];
  snap.catalog.entries.forEach((entry, order) => {
    for (const harness of entry.harnesses) {
      all.push({ entry, target: targetOf(entry, harness, req), order, tierRank: tierRank(tiers, entry.tier) });
    }
  });

  const lo = tierRank(tiers, req.minTier);
  const hi = tierRank(tiers, req.maxTier);
  // Tier-fit is applied after the other filters, so "above the tier we need" is
  // only said of a candidate that could otherwise have run: the rest say their
  // real reason. The upgrade path relaxes only the lower bound.
  const passing: Considered[] = [];
  for (const c of all) {
    const f = hardFilter(c, req, snap, policy);
    if ('reason' in f) {
      c.rejected = f.reason;
      c.capacityOnly = f.capacity;
    } else {
      c.note = f.note;
      passing.push(c);
    }
  }

  const atMin = passing.filter((c) => c.tierRank === lo);
  let pool = atMin;
  let note: string | undefined;
  if (pool.length === 0) {
    // Upgrade for availability only: the lowest tier above `minTier`, within `maxTier`, reachable by route.
    const higher = passing.filter((c) => c.tierRank > lo && (hi < 0 || c.tierRank <= hi)).sort((a, b) => a.tierRank - b.tierRank);
    if (higher.length > 0) {
      const t = higher[0].tierRank;
      pool = higher.filter((c) => c.tierRank === t);
      const blockers = all.filter((c) => c.tierRank === lo && c.rejected).map((c) => c.rejected!);
      note = `Upgraded to ${tiers[t].name}: no ${req.minTier} model is available${blockers.length > 0 ? ` (${blockers.join('; ')})` : ''}.`;
    }
  }
  pool.sort((a, b) => compare(a, b, req, policy));

  const chosen = pool[0];
  const candidates: ResolverCandidate[] = [];
  for (const c of pool) {
    if (c === chosen) {
      candidates.push({ target: c.target, verdict: 'chosen', reason: c.note ? `best fit; ${c.note}` : 'best fit' });
    } else {
      candidates.push({ target: c.target, verdict: 'fallback', reason: `same tier, ranked after ${chosen.entry.descriptor.label}` });
    }
  }
  for (const c of passing) {
    if (pool.includes(c)) continue;
    const why =
      c.tierRank > (chosen?.tierRank ?? lo)
        ? `${c.entry.descriptor.label}: ${c.entry.tier} is above the ${req.minTier} this needs`
        : `${c.entry.descriptor.label}: ${c.entry.tier} is below the required ${req.minTier}`;
    candidates.push({ target: c.target, verdict: 'rejected', reason: why });
  }
  for (const c of all) {
    if (c.rejected) candidates.push({ target: c.target, verdict: 'rejected', reason: c.rejected });
  }

  if (chosen) return { outcome: 'resolved', target: chosen.target, candidates, note, catalogVersion: snap.catalog.version };

  // Nothing fits. Blocked if something in range would run once a window resets; otherwise a person decides.
  const inRange = (c: Considered) => c.tierRank >= lo && (hi < 0 || c.tierRank <= hi);
  const waiting = all.filter((c) => c.capacityOnly && inRange(c));
  if (waiting.length > 0) {
    return {
      outcome: 'blocked',
      candidates,
      note: `Every ${req.minTier}-or-better model is out of capacity until a usage window resets.`,
      catalogVersion: snap.catalog.version,
    };
  }
  const routable = snap.catalog.entries.filter((e) => e.routable).length;
  return {
    outcome: 'needs-human',
    candidates,
    note:
      routable === 0
        ? 'No model is routable: give models a tier in Preferences → Orchestration.'
        : `Nothing the policy allows can run ${req.minTier}–${req.maxTier} work.`,
    catalogVersion: snap.catalog.version,
  };
}
