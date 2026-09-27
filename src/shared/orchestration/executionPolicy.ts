/**
 * Pins, caps, preferences and exclusions at four scopes, and the one pure
 * function that turns them into the policy an attempt runs under
 * (`docs/plans/intelligent-orchestration.md` §10.2; #40).
 *
 * Pure, and in `src/shared/**` so the Preferences window validates an edit
 * with the same code the task runner enforces it with. No Node, no DOM.
 *
 * The rules, all of them here and nowhere else:
 *
 * - **Scopes, widest first**: global (Preferences) → repository (its policy
 *   file) → mission → task.
 * - **The more specific scope wins** for pins, preferences and plain switches
 *   (`mode`, `autoRecover`, …), one field at a time: a task that pins effort
 *   keeps the mission's pinned harness.
 * - **Caps and exclusions only ever tighten.** The tightest cap at any scope
 *   is the one in force; an exclusion at any scope stays. A narrower scope
 *   that tries to loosen a cap is a conflict, never a quiet override.
 * - **No silent conflict resolution.** A pin that breaks a cap or names
 *   something excluded is a `PolicyConflict` naming both scopes ("This task
 *   pins Opus (expert); the mission is capped at standard."). Resolution still
 *   returns a policy — the tighter value — but whoever is *setting* a value
 *   refuses it when a conflict involves their scope (`checkPolicyEdit`), and
 *   the runner refuses to launch while any remains.
 * - **Pins freeze dimensions for escalation** (`pinnedDimensions`): #41's
 *   ladder never moves a pinned harness, model or effort.
 */
import { harnessLabel } from '../harness';
import { tierRank, type CapabilityCatalogView, type TierDef } from './catalog';
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ExecutionPolicy,
  type Mission,
  type ModelSourceId,
  type PolicyScope,
  type RouteCaps,
  type RouteDimension,
  type RoutePins,
  type RoutingMode,
  type Task,
  type TaskOverrides,
} from './types';

export type { PolicyScope } from './types';

/** Widest first: the order layers are applied in. */
export const POLICY_SCOPES: readonly PolicyScope[] = ['global', 'repo', 'mission', 'task'];

/** One scope's controls. An absent policy is a scope that sets nothing. */
export interface PolicyLayer {
  scope: PolicyScope;
  policy: ExecutionPolicy | undefined;
}

/** What the catalog knows about a pinned model: enough to check it against the caps. */
export interface PinnedModelFacts {
  label: string;
  tier?: string;
  location?: 'hosted' | 'local';
  source?: ModelSourceId;
}

/** What resolution needs besides the layers: the tier order, and a way to look a pinned model up. */
export interface PolicyContext {
  tiers: readonly TierDef[];
  /** The pinned model's facts. Undefined: the catalog has not seen it, and its tier cannot be checked. */
  model?: (pins: RoutePins) => PinnedModelFacts | undefined;
}

export type ConflictKind =
  /** A pinned model or effort is above a cap. */
  | 'pin-above-cap'
  /** A pinned harness, source or model is excluded, or local while local models are off. */
  | 'pin-excluded'
  /** A pinned model runs somewhere a location cap forbids. */
  | 'pin-location'
  /** A narrower scope sets a cap looser than a wider one. */
  | 'cap-loosened'
  /** Two scopes ask for opposite locations (local-only and hosted-only). */
  | 'location-conflict'
  /** A tier cap names no tier the catalog has. */
  | 'cap-unknown';

export interface PolicyConflict {
  kind: ConflictKind;
  /** The dotted field at fault, e.g. `pins.model`, `caps.maxTier`. */
  field: string;
  /** The scope whose value breaks the rule: the pin, or the looser cap. */
  scope: PolicyScope;
  /** The scope whose limit it breaks. */
  against: PolicyScope;
  /** One sentence naming both, for the user. */
  message: string;
}

export interface EffectivePolicy {
  policy: ExecutionPolicy;
  /** The scope each field in force came from, by dotted field (`caps.maxTier` → `mission`). */
  from: Record<string, PolicyScope>;
  conflicts: PolicyConflict[];
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const SCOPE_OBJECT: Record<PolicyScope, string> = {
  global: 'the global default',
  repo: 'the repository policy',
  mission: 'the mission',
  task: 'this task',
};

/** "the mission", "the global default": the scope as the object of a sentence. */
export function scopeName(scope: PolicyScope): string {
  return SCOPE_OBJECT[scope];
}

/** "The mission", "This task": the scope as the subject of a sentence. */
export function scopeSubject(scope: PolicyScope): string {
  const s = SCOPE_OBJECT[scope];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The short label the mission header shows beside a value: `global`, `repo`, `mission`, `task`. */
export function scopeTag(scope: PolicyScope): string {
  return scope === 'repo' ? 'repository' : scope;
}

export const CAP_KEYS = [
  'maxTier',
  'maxEffort',
  'maxAttempts',
  'maxConcurrentAgents',
  'maxEstimatedCostUsd',
  'maxUsageWindowPercent',
  'location',
] as const satisfies readonly (keyof RouteCaps)[];

export const PIN_KEYS = ['harness', 'source', 'model', 'effort'] as const satisfies readonly (keyof RoutePins)[];
/** Upper bounds that catch typos, not policy: nobody means 500 attempts. */
export const POLICY_LIMITS = { maxAttempts: 20, maxConcurrentAgents: 32, maxTasks: 12 } as const;
const PREFERENCE_KEYS = ['harness', 'source', 'preferLocal', 'strategy'] as const;
const SWITCH_KEYS = ['mode', 'frontierAllowed', 'autoRecover', 'allowOverlap'] as const;

/** How each dotted field reads to a person. */
export const FIELD_LABEL: Record<string, string> = {
  mode: 'routing mode',
  frontierAllowed: 'frontier tier allowed',
  autoRecover: 'automatic resume',
  allowOverlap: 'overlapping tasks',
  maxTasks: 'max tasks',
  'pins.harness': 'pinned harness',
  'pins.source': 'pinned source',
  'pins.model': 'pinned model',
  'pins.effort': 'pinned effort',
  'caps.maxTier': 'max tier',
  'caps.maxEffort': 'max effort',
  'caps.maxAttempts': 'max attempts',
  'caps.maxConcurrentAgents': 'max concurrent agents',
  'caps.maxEstimatedCostUsd': 'max estimated spend',
  'caps.maxUsageWindowPercent': 'max usage window',
  'caps.location': 'location',
  'preferences.harness': 'preferred harness',
  'preferences.source': 'preferred source',
  'preferences.preferLocal': 'prefer local',
  'preferences.strategy': 'strategy',
  'exclusions.harnesses': 'excluded harnesses',
  'exclusions.sources': 'excluded sources',
  'exclusions.disableLocal': 'local models off',
};

function capValueText(key: keyof RouteCaps, value: unknown): string {
  switch (key) {
    case 'maxEstimatedCostUsd':
      return `$${Number(value).toFixed(2)}`;
    case 'maxUsageWindowPercent':
      return `${value}%`;
    default:
      return String(value);
  }
}

/** A field's value as the header and the editors say it. */
export function valueText(field: string, value: unknown): string {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map((v) => (field === 'exclusions.harnesses' ? harnessLabel(String(v)) : String(v))).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field === 'pins.harness' || field === 'preferences.harness') return harnessLabel(String(value));
  if (field.startsWith('caps.')) return capValueText(field.slice(5) as keyof RouteCaps, value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Order of caps
// ---------------------------------------------------------------------------

function effortRank(e: EffortLevel | undefined): number {
  return e === undefined ? -1 : EFFORT_LEVELS.indexOf(e);
}

/**
 * Compare two values of one cap: negative when `a` is tighter, positive when
 * looser, 0 when equal, `undefined` when they cannot be ordered (a tier name
 * the catalog does not have, or opposite locations).
 */
function compareCap(key: keyof RouteCaps, a: unknown, b: unknown, tiers: readonly TierDef[]): number | undefined {
  if (a === b) return 0;
  switch (key) {
    case 'maxTier': {
      const ra = tierRank(tiers, a as string);
      const rb = tierRank(tiers, b as string);
      return ra < 0 || rb < 0 ? undefined : ra - rb;
    }
    case 'maxEffort':
      return effortRank(a as EffortLevel) - effortRank(b as EffortLevel);
    case 'location':
      return undefined;
    default:
      return (a as number) - (b as number);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function orderLayers(layers: readonly PolicyLayer[]): PolicyLayer[] {
  // Stable: two layers of one scope keep their order, the later winning.
  return layers
    .map((l, i) => ({ l, i }))
    .sort((a, b) => POLICY_SCOPES.indexOf(a.l.scope) - POLICY_SCOPES.indexOf(b.l.scope) || a.i - b.i)
    .map((x) => x.l);
}

/**
 * The effective policy of a set of layers. Pure: the same layers and context
 * always give the same policy, the same provenance and the same conflicts.
 *
 * Every conflict is reported; none is resolved in anyone's favour except the
 * one direction that is always safe — the tighter cap stays in force.
 */
export function resolveEffectivePolicy(layers: readonly PolicyLayer[], ctx: PolicyContext): EffectivePolicy {
  const out: ExecutionPolicy = {};
  const from: Record<string, PolicyScope> = {};
  const conflicts: PolicyConflict[] = [];
  const pins: RoutePins = {};
  const caps: RouteCaps = {};
  const preferences: NonNullable<ExecutionPolicy['preferences']> = {};
  const excludedHarnesses = new Map<string, PolicyScope>();
  const excludedSources = new Map<string, PolicyScope>();
  let disableLocal: PolicyScope | undefined;

  for (const { scope, policy: p } of orderLayers(layers)) {
    if (!p) continue;
    for (const k of SWITCH_KEYS) {
      if (p[k] !== undefined) {
        (out as Record<string, unknown>)[k] = p[k];
        from[k] = scope;
      }
    }
    if (p.maxTasks !== undefined) {
      if (out.maxTasks === undefined || p.maxTasks < out.maxTasks) {
        out.maxTasks = p.maxTasks;
        from.maxTasks = scope;
      } else if (p.maxTasks > out.maxTasks) {
        conflicts.push(loosened('maxTasks', scope, from.maxTasks, String(p.maxTasks), String(out.maxTasks)));
      }
    }
    for (const k of PIN_KEYS) {
      const v = p.pins?.[k];
      if (isSet(v)) {
        (pins as Record<string, unknown>)[k] = v;
        from[`pins.${k}`] = scope;
      }
    }
    for (const k of PREFERENCE_KEYS) {
      const v = p.preferences?.[k];
      if (isSet(v)) {
        (preferences as Record<string, unknown>)[k] = v;
        from[`preferences.${k}`] = scope;
      }
    }
    for (const h of p.exclusions?.harnesses ?? []) if (!excludedHarnesses.has(h)) excludedHarnesses.set(h, scope);
    for (const s of p.exclusions?.sources ?? []) if (!excludedSources.has(s)) excludedSources.set(s, scope);
    if (p.exclusions?.disableLocal && disableLocal === undefined) disableLocal = scope;

    for (const k of CAP_KEYS) {
      const v = p.caps?.[k];
      if (!isSet(v)) continue;
      const field = `caps.${k}`;
      if (k === 'maxTier' && tierRank(ctx.tiers, v as string) < 0) {
        conflicts.push({
          kind: 'cap-unknown',
          field,
          scope,
          against: scope,
          message: `${scopeSubject(scope)} caps tier at “${String(v)}”, which is not a tier (${ctx.tiers.map((t) => t.name).join(', ')}).`,
        });
        continue;
      }
      const cur = caps[k];
      if (cur === undefined) {
        (caps as Record<string, unknown>)[k] = v;
        from[field] = scope;
        continue;
      }
      const cmp = compareCap(k, v, cur, ctx.tiers);
      if (k === 'location' && v !== cur) {
        conflicts.push({
          kind: 'location-conflict',
          field,
          scope,
          against: from[field],
          message: `${scopeSubject(scope)} is ${String(v)}; ${scopeName(from[field])} is ${String(cur)}.`,
        });
      } else if (cmp !== undefined && cmp < 0) {
        (caps as Record<string, unknown>)[k] = v;
        from[field] = scope;
      } else if (cmp !== undefined && cmp > 0) {
        conflicts.push(loosened(field, scope, from[field], capValueText(k, v), capValueText(k, cur)));
      }
    }
  }

  if (Object.keys(pins).length > 0) out.pins = pins;
  if (Object.keys(caps).length > 0) out.caps = caps;
  if (Object.keys(preferences).length > 0) out.preferences = preferences;
  if (excludedHarnesses.size > 0 || excludedSources.size > 0 || disableLocal) {
    out.exclusions = {
      ...(excludedHarnesses.size > 0 ? { harnesses: [...excludedHarnesses.keys()] } : {}),
      ...(excludedSources.size > 0 ? { sources: [...excludedSources.keys()] } : {}),
      ...(disableLocal ? { disableLocal: true } : {}),
    };
    if (excludedHarnesses.size > 0) from['exclusions.harnesses'] = [...excludedHarnesses.values()].sort((a, b) => POLICY_SCOPES.indexOf(b) - POLICY_SCOPES.indexOf(a))[0];
    if (excludedSources.size > 0) from['exclusions.sources'] = [...excludedSources.values()].sort((a, b) => POLICY_SCOPES.indexOf(b) - POLICY_SCOPES.indexOf(a))[0];
    if (disableLocal) from['exclusions.disableLocal'] = disableLocal;
  }

  conflicts.push(...pinConflicts(pins, caps, from, { excludedHarnesses, excludedSources, disableLocal }, ctx));
  return { policy: out, from, conflicts };
}

function loosened(field: string, scope: PolicyScope, against: PolicyScope, value: string, inForce: string): PolicyConflict {
  const label = FIELD_LABEL[field] ?? field;
  return {
    kind: 'cap-loosened',
    field,
    scope,
    against,
    message: `${scopeSubject(scope)} sets ${label} ${value}; ${scopeName(against)} is capped at ${inForce}, and a narrower scope can only tighten a cap.`,
  };
}

function pinConflicts(
  pins: RoutePins,
  caps: RouteCaps,
  from: Record<string, PolicyScope>,
  ex: { excludedHarnesses: Map<string, PolicyScope>; excludedSources: Map<string, PolicyScope>; disableLocal?: PolicyScope },
  ctx: PolicyContext,
): PolicyConflict[] {
  const out: PolicyConflict[] = [];
  if (pins.effort && caps.maxEffort && effortRank(pins.effort) > effortRank(caps.maxEffort)) {
    out.push({
      kind: 'pin-above-cap',
      field: 'pins.effort',
      scope: from['pins.effort'],
      against: from['caps.maxEffort'],
      message: `${scopeSubject(from['pins.effort'])} pins ${pins.effort} effort; ${scopeName(from['caps.maxEffort'])} caps effort at ${caps.maxEffort}.`,
    });
  }
  if (pins.harness && ex.excludedHarnesses.has(pins.harness)) {
    const by = ex.excludedHarnesses.get(pins.harness)!;
    out.push({
      kind: 'pin-excluded',
      field: 'pins.harness',
      scope: from['pins.harness'],
      against: by,
      message: `${scopeSubject(from['pins.harness'])} pins ${harnessLabel(pins.harness)}; ${scopeName(by)} excludes ${harnessLabel(pins.harness)}.`,
    });
  }
  const facts = pins.model ? ctx.model?.(pins) : undefined;
  const source = pins.source ?? facts?.source;
  if (source && ex.excludedSources.has(source)) {
    const field = pins.source ? 'pins.source' : 'pins.model';
    const by = ex.excludedSources.get(source)!;
    out.push({
      kind: 'pin-excluded',
      field,
      scope: from[field],
      against: by,
      message: `${scopeSubject(from[field])} pins ${pins.source ? source : facts?.label ?? pins.model}; ${scopeName(by)} excludes the ${source} source.`,
    });
  }
  if (pins.model) {
    const scope = from['pins.model'];
    const label = facts?.label ?? pins.model;
    if (facts?.tier && caps.maxTier) {
      const r = tierRank(ctx.tiers, facts.tier);
      const cap = tierRank(ctx.tiers, caps.maxTier);
      if (r >= 0 && cap >= 0 && r > cap) {
        out.push({
          kind: 'pin-above-cap',
          field: 'pins.model',
          scope,
          against: from['caps.maxTier'],
          message: `${scopeSubject(scope)} pins ${label} (${facts.tier}); ${scopeName(from['caps.maxTier'])} is capped at ${caps.maxTier}.`,
        });
      }
    }
    if (facts?.location === 'local' && ex.disableLocal) {
      out.push({ kind: 'pin-excluded', field: 'pins.model', scope, against: ex.disableLocal, message: `${scopeSubject(scope)} pins ${label}, a local model; ${scopeName(ex.disableLocal)} turns local models off.` });
    }
    const where = caps.location;
    if (facts?.location && where && ((where === 'local-only' && facts.location === 'hosted') || (where === 'hosted-only' && facts.location === 'local'))) {
      out.push({
        kind: 'pin-location',
        field: 'pins.model',
        scope,
        against: from['caps.location'],
        message: `${scopeSubject(scope)} pins ${label}, a ${facts.location} model; ${scopeName(from['caps.location'])} is ${where}.`,
      });
    }
  }
  return out;
}

/**
 * The conflicts an edit to one scope would leave: resolve with that scope's
 * layer replaced, and keep the conflicts it is a party to. A conflict between
 * two other scopes is not the editor's to fix, and does not block their edit.
 * Empty: the edit may be saved.
 */
export function checkPolicyEdit(
  layers: readonly PolicyLayer[],
  scope: PolicyScope,
  next: ExecutionPolicy | undefined,
  ctx: PolicyContext,
): PolicyConflict[] {
  const replaced = [...layers.filter((l) => l.scope !== scope), { scope, policy: next }];
  return resolveEffectivePolicy(replaced, ctx).conflicts.filter((c) => c.scope === scope || c.against === scope);
}

/**
 * The route dimensions a policy pins, which escalation must not move (§10.2):
 * a pinned model is never switched (and so its tier is fixed too), a pinned
 * effort is never raised, a pinned harness is never changed.
 */
export function pinnedDimensions(policy: ExecutionPolicy): RouteDimension[] {
  const p = policy.pins ?? {};
  const out: RouteDimension[] = [];
  if (p.harness) out.push('harness');
  if (p.model) out.push('model', 'tier');
  if (p.effort) out.push('effort');
  return out;
}

// ---------------------------------------------------------------------------
// Admission: the caps that are counts, checked when an attempt is about to start
// ---------------------------------------------------------------------------

export interface AdmissionFacts {
  /** Attempts the task has had already (the next one is this + 1). */
  attemptsSoFar: number;
  /** Orchestrated agents running now, across every mission. */
  liveAgents: number;
  /** What the task's attempts have cost so far, where anything reported a cost. */
  spentUsd?: number;
  /** The fullest usage window of the source the attempt would run on, in percent. */
  windowPercent?: number;
}

/**
 * Why the next attempt may not start under these caps, naming the scope that
 * set the cap, or undefined when it may. The caps that are not counts (tier,
 * effort, location) are pins' and the router's business, not admission's.
 */
export function admissionRefusal(eff: EffectivePolicy, facts: AdmissionFacts): string | undefined {
  const c = eff.policy.caps ?? {};
  const by = (k: keyof RouteCaps) => scopeName(eff.from[`caps.${k}`]);
  if (c.maxAttempts !== undefined && facts.attemptsSoFar >= c.maxAttempts) {
    return `This would be attempt ${facts.attemptsSoFar + 1}; ${by('maxAttempts')} caps attempts at ${c.maxAttempts}.`;
  }
  if (c.maxConcurrentAgents !== undefined && facts.liveAgents >= c.maxConcurrentAgents) {
    return `${facts.liveAgents} task agent${facts.liveAgents === 1 ? ' is' : 's are'} running; ${by('maxConcurrentAgents')} caps concurrent agents at ${c.maxConcurrentAgents}.`;
  }
  if (c.maxEstimatedCostUsd !== undefined && facts.spentUsd !== undefined && facts.spentUsd >= c.maxEstimatedCostUsd) {
    return `This task has spent an estimated $${facts.spentUsd.toFixed(2)}; ${by('maxEstimatedCostUsd')} caps estimated spend at $${c.maxEstimatedCostUsd.toFixed(2)}.`;
  }
  if (c.maxUsageWindowPercent !== undefined && facts.windowPercent !== undefined && facts.windowPercent >= c.maxUsageWindowPercent) {
    return `The usage window is at ${Math.round(facts.windowPercent)}%; ${by('maxUsageWindowPercent')} stops starting work at ${c.maxUsageWindowPercent}%.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The editable fields, for the editors (Preferences, the mission and task editors)
// ---------------------------------------------------------------------------

export type PolicyFieldKind = 'tier' | 'effort' | 'count' | 'usd' | 'percent' | 'location' | 'harness' | 'model' | 'flag' | 'harnesses';

export interface PolicyFieldSpec {
  field: string;
  kind: PolicyFieldKind;
  /** The group the editors put it under. */
  group: 'Pins' | 'Caps' | 'Preferences' | 'Exclusions';
  label: string;
  help: string;
  /** Bounds of a `count` or `percent`. */
  min?: number;
  max?: number;
}

/** Every control a person can set at a scope, in the order the editors show them. */
export const POLICY_FIELDS: readonly PolicyFieldSpec[] = [
  { field: 'pins.harness', kind: 'harness', group: 'Pins', label: 'Harness', help: 'Always run on this harness.' },
  { field: 'pins.model', kind: 'model', group: 'Pins', label: 'Model', help: 'Always run on this model. Escalation never switches a pinned model.' },
  { field: 'pins.effort', kind: 'effort', group: 'Pins', label: 'Effort', help: 'Always ask for this effort. Escalation never raises a pinned effort.' },
  { field: 'caps.maxTier', kind: 'tier', group: 'Caps', label: 'Max tier', help: 'Never run on a model above this tier.' },
  { field: 'caps.maxEffort', kind: 'effort', group: 'Caps', label: 'Max effort', help: 'Never ask for more effort than this.' },
  { field: 'caps.maxAttempts', kind: 'count', group: 'Caps', label: 'Max attempts', help: 'Attempts per task, retries included.', min: 1, max: POLICY_LIMITS.maxAttempts },
  { field: 'caps.maxConcurrentAgents', kind: 'count', group: 'Caps', label: 'Max concurrent agents', help: 'Task agents running at once, across every mission.', min: 1, max: POLICY_LIMITS.maxConcurrentAgents },
  { field: 'caps.maxEstimatedCostUsd', kind: 'usd', group: 'Caps', label: 'Max estimated spend', help: 'Stop starting attempts once a task’s estimated hosted cost reaches this, in dollars.' },
  { field: 'caps.maxUsageWindowPercent', kind: 'percent', group: 'Caps', label: 'Max usage window', help: 'Stop starting work on a source whose usage window is at or above this share.', min: 1, max: 100 },
  { field: 'caps.location', kind: 'location', group: 'Caps', label: 'Location', help: 'Only local models, or only hosted ones.' },
  { field: 'preferences.harness', kind: 'harness', group: 'Preferences', label: 'Prefer harness', help: 'Rank this harness first within the tier the work needs.' },
  { field: 'preferences.preferLocal', kind: 'flag', group: 'Preferences', label: 'Prefer local models', help: 'Rank local models first within the tier the work needs.' },
  { field: 'exclusions.harnesses', kind: 'harnesses', group: 'Exclusions', label: 'Excluded harnesses', help: 'Never run on these.' },
  { field: 'exclusions.disableLocal', kind: 'flag', group: 'Exclusions', label: 'Local models off', help: 'Never run on a local model.' },
];

/** A field's value in a layer, or undefined when the layer does not set it. */
export function fieldValue(p: ExecutionPolicy | undefined, field: string): PolicyValue | undefined {
  const [g, k] = field.split('.') as [string, string | undefined];
  if (!p) return undefined;
  if (k === undefined) return (p as Record<string, PolicyValue | undefined>)[g];
  const v = (p as Record<string, Record<string, PolicyValue | undefined> | undefined>)[g]?.[k];
  if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0)) return undefined;
  return v;
}

/** A layer with one field set, or cleared (`undefined`). Empty groups are dropped. Never mutates `p`. */
export function withField(p: ExecutionPolicy | undefined, field: string, value: PolicyValue | undefined): ExecutionPolicy {
  const out = JSON.parse(JSON.stringify(p ?? {})) as Record<string, Record<string, unknown> | unknown>;
  const [g, k] = field.split('.') as [string, string | undefined];
  const clear = value === undefined || value === '' || value === false || (Array.isArray(value) && value.length === 0);
  if (k === undefined) {
    if (clear) delete out[g];
    else out[g] = value;
  } else {
    const group = { ...((out[g] as Record<string, unknown> | undefined) ?? {}) };
    if (clear) delete group[k];
    else group[k] = value;
    if (Object.keys(group).length === 0) delete out[g];
    else out[g] = group;
  }
  return out as ExecutionPolicy;
}

// ---------------------------------------------------------------------------
// Diffs and descriptions
// ---------------------------------------------------------------------------

export type PolicyValue = string | number | boolean | string[];

/** A policy as dotted fields (`caps.maxTier` → `standard`), set fields only. */
export function flattenPolicy(p: ExecutionPolicy | undefined): Record<string, PolicyValue> {
  const out: Record<string, PolicyValue> = {};
  if (!p) return out;
  for (const k of SWITCH_KEYS) if (p[k] !== undefined) out[k] = p[k] as PolicyValue;
  if (p.maxTasks !== undefined) out.maxTasks = p.maxTasks;
  const groups: [string, Record<string, unknown> | undefined][] = [
    ['pins', p.pins as Record<string, unknown> | undefined],
    ['caps', p.caps as Record<string, unknown> | undefined],
    ['preferences', p.preferences as Record<string, unknown> | undefined],
    ['exclusions', p.exclusions as Record<string, unknown> | undefined],
  ];
  for (const [g, obj] of groups) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (!isSet(v) || (Array.isArray(v) && v.length === 0) || (g === 'exclusions' && v === false)) continue;
      out[`${g}.${k}`] = Array.isArray(v) ? [...v].map(String).sort() : (v as PolicyValue);
    }
  }
  return out;
}

/** Every field whose value differs between two layers, with both values. */
export function policyDiff(before: ExecutionPolicy | undefined, after: ExecutionPolicy | undefined): { field: string; from?: PolicyValue; to?: PolicyValue }[] {
  const a = flattenPolicy(before);
  const b = flattenPolicy(after);
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return fields
    .filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]))
    .map((f) => ({ field: f, ...(a[f] !== undefined ? { from: a[f] } : {}), ...(b[f] !== undefined ? { to: b[f] } : {}) }));
}

/** "max tier expert → standard; pinned effort cleared" — a change as the mission header lists it. */
export function diffText(diff: { field: string; from?: PolicyValue; to?: PolicyValue }[]): string {
  return diff
    .map((d) => {
      const label = FIELD_LABEL[d.field] ?? d.field;
      if (d.to === undefined) return `${label} cleared (was ${valueText(d.field, d.from)})`;
      if (d.from === undefined) return `${label} ${valueText(d.field, d.to)}`;
      return `${label} ${valueText(d.field, d.from)} → ${valueText(d.field, d.to)}`;
    })
    .join('; ');
}

/** The effective policy as lines for the mission header: each field in force, and where it came from. */
export function describePolicy(eff: EffectivePolicy): { field: string; label: string; value: string; from: PolicyScope }[] {
  const flat = flattenPolicy(eff.policy);
  const order = Object.keys(FIELD_LABEL);
  return Object.keys(flat)
    .filter((f) => f !== 'mode')
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((f) => ({ field: f, label: FIELD_LABEL[f] ?? f, value: valueText(f, flat[f]), from: eff.from[f] ?? 'mission' }));
}

// ---------------------------------------------------------------------------
// A mission's layers
// ---------------------------------------------------------------------------

/** A task's overrides as a policy layer (the `task` scope). */
export function taskLayer(overrides: TaskOverrides | undefined): ExecutionPolicy | undefined {
  if (!overrides) return undefined;
  const { pins, caps, preferences, exclusions } = overrides;
  return compactPolicy({ pins, caps, preferences, exclusions });
}

/** A policy layer as a task's overrides: the four groups a task may set. */
export function asTaskOverrides(p: ExecutionPolicy | undefined): TaskOverrides | undefined {
  if (!p) return undefined;
  const out: TaskOverrides = {};
  if (p.pins) out.pins = p.pins;
  if (p.caps) out.caps = p.caps;
  if (p.preferences) out.preferences = p.preferences;
  if (p.exclusions) out.exclusions = p.exclusions;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The mission's own layer: what the user set for it. A mission from before #40 has only its `policy`. */
export function missionLayer(m: Pick<Mission, 'policy' | 'policyLayers'>): ExecutionPolicy | undefined {
  return m.policyLayers ? m.policyLayers.mission : m.policy;
}

/**
 * Every layer an attempt of this task runs under, widest first: the global and
 * repository layers frozen into the mission when it was recorded, the
 * mission's own, and the task's overrides.
 */
export function missionLayers(m: Pick<Mission, 'policy' | 'policyLayers'>, task?: Pick<Task, 'overrides'>): PolicyLayer[] {
  const layers: PolicyLayer[] = m.policyLayers
    ? [
        { scope: 'global', policy: m.policyLayers.global },
        { scope: 'repo', policy: m.policyLayers.repo },
        { scope: 'mission', policy: m.policyLayers.mission },
      ]
    : [{ scope: 'mission', policy: m.policy }];
  if (task) layers.push({ scope: 'task', policy: taskLayer(task.overrides) });
  return layers;
}

/** "This task pins Opus (expert); the mission is capped at standard." — every conflict, one sentence each. */
export function conflictText(conflicts: readonly PolicyConflict[]): string {
  return [...new Set(conflicts.map((c) => c.message))].join(' ');
}

// ---------------------------------------------------------------------------
// The catalog as a `PolicyContext`
// ---------------------------------------------------------------------------

const HARNESS_SOURCE: Record<string, ModelSourceId> = { 'claude-code': 'anthropic', codex: 'openai' };

/** Look a pinned model up in the catalog by any of its aliases, within the pinned (or implied) source. */
export function pinnedModelFromCatalog(catalog: Pick<CapabilityCatalogView, 'entries'>, pins: RoutePins): PinnedModelFacts | undefined {
  const model = pins.model?.trim();
  if (!model) return undefined;
  const source = pins.source ?? (pins.harness ? HARNESS_SOURCE[pins.harness] : undefined);
  const lower = model.toLowerCase();
  const entry = catalog.entries.find(
    (e) =>
      (!source || e.descriptor.source === source) &&
      (e.aliases.some((a) => a.toLowerCase() === lower) || e.descriptor.modelId.toLowerCase() === lower || e.descriptor.resolvedId?.toLowerCase() === lower),
  );
  if (!entry) return undefined;
  return { label: entry.descriptor.label, tier: entry.tier, location: entry.descriptor.location, source: entry.descriptor.source };
}

/** The context the router's catalog gives: its tiers, and its models for pin checks. */
export function policyContextFor(catalog: Pick<CapabilityCatalogView, 'entries' | 'tiers'>): PolicyContext {
  return { tiers: catalog.tiers, model: (pins) => pinnedModelFromCatalog(catalog, pins) };
}

// ---------------------------------------------------------------------------
// Validation: a policy as written (settings, a repository file, an editor)
// ---------------------------------------------------------------------------

export interface PolicyFieldError {
  /** Dotted path within the policy, e.g. `caps.maxAttempts`. */
  path: string;
  message: string;
}

export type PolicyParse = { ok: true; policy: ExecutionPolicy } | { ok: false; errors: PolicyFieldError[] };

const MODES: readonly RoutingMode[] = ['manual', 'assisted', 'auto'];
const STRATEGIES = ['balanced', 'max-quality', 'lowest-cost', 'fastest', 'prefer-local'] as const;
const LOCATIONS = ['local-only', 'hosted-only'] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check a policy's shape, reporting every problem with its path, and return
 * it with empty groups dropped. `tiers`, when given, also checks that a tier
 * cap names a tier. `allowed` limits the top-level keys (a task's overrides
 * have no `mode`). Conflicts between scopes are `resolveEffectivePolicy`'s.
 */
export function validateExecutionPolicy(
  doc: unknown,
  opts: { tiers?: readonly TierDef[]; allowed?: readonly string[]; prefix?: string } = {},
): PolicyParse {
  const errors: PolicyFieldError[] = [];
  const pre = opts.prefix ? `${opts.prefix}.` : '';
  const err = (p: string, message: string) => void errors.push({ path: `${pre}${p}`, message });
  if (!isObj(doc)) return { ok: false, errors: [{ path: opts.prefix ?? '', message: 'must be an object' }] };
  const allowed = opts.allowed ?? ['mode', 'pins', 'caps', 'preferences', 'exclusions', 'frontierAllowed', 'autoRecover', 'allowOverlap', 'maxTasks'];
  for (const k of Object.keys(doc)) if (!allowed.includes(k)) err(k, `unknown field; expected one of ${allowed.join(', ')}`);

  const out: ExecutionPolicy = {};
  if (doc.mode !== undefined) {
    if (!MODES.includes(doc.mode as RoutingMode)) err('mode', `must be one of ${MODES.join(', ')}`);
    else out.mode = doc.mode as RoutingMode;
  }
  for (const k of ['frontierAllowed', 'autoRecover', 'allowOverlap'] as const) {
    if (doc[k] === undefined) continue;
    if (typeof doc[k] !== 'boolean') err(k, 'must be true or false');
    else out[k] = doc[k] as boolean;
  }
  if (doc.maxTasks !== undefined) {
    const v = wholeNumber(doc.maxTasks, 1, POLICY_LIMITS.maxTasks);
    if (v === undefined) err('maxTasks', `must be a whole number from 1 to ${POLICY_LIMITS.maxTasks}`);
    else out.maxTasks = v;
  }

  const group = (name: string, keys: readonly string[]): Record<string, unknown> | undefined => {
    const g = doc[name];
    if (g === undefined) return undefined;
    if (!isObj(g)) {
      err(name, 'must be an object');
      return undefined;
    }
    for (const k of Object.keys(g)) if (!keys.includes(k)) err(`${name}.${k}`, `unknown field; expected one of ${keys.join(', ')}`);
    return g;
  };
  const id = (v: unknown, p: string): string | undefined => {
    if (typeof v !== 'string' || v.trim() === '') {
      err(p, 'must be a non-empty string');
      return undefined;
    }
    return v.trim();
  };

  const pins = group('pins', PIN_KEYS);
  if (pins) {
    const o: RoutePins = {};
    if (pins.harness !== undefined) o.harness = id(pins.harness, 'pins.harness');
    if (pins.source !== undefined) o.source = id(pins.source, 'pins.source');
    if (pins.model !== undefined) o.model = id(pins.model, 'pins.model');
    if (pins.effort !== undefined) {
      if (!(EFFORT_LEVELS as readonly unknown[]).includes(pins.effort)) err('pins.effort', `must be one of ${EFFORT_LEVELS.join(', ')}`);
      else o.effort = pins.effort as EffortLevel;
    }
    const clean = dropUndefined(o);
    if (Object.keys(clean).length > 0) out.pins = clean;
  }

  const caps = group('caps', CAP_KEYS);
  if (caps) {
    const o: RouteCaps = {};
    if (caps.maxTier !== undefined) {
      const t = id(caps.maxTier, 'caps.maxTier');
      if (t && opts.tiers && tierRank(opts.tiers, t) < 0) err('caps.maxTier', `must be a tier: ${opts.tiers.map((x) => x.name).join(', ')}`);
      else if (t) o.maxTier = t;
    }
    if (caps.maxEffort !== undefined) {
      if (!(EFFORT_LEVELS as readonly unknown[]).includes(caps.maxEffort)) err('caps.maxEffort', `must be one of ${EFFORT_LEVELS.join(', ')}`);
      else o.maxEffort = caps.maxEffort as EffortLevel;
    }
    if (caps.maxAttempts !== undefined) {
      const v = wholeNumber(caps.maxAttempts, 1, POLICY_LIMITS.maxAttempts);
      if (v === undefined) err('caps.maxAttempts', `must be a whole number from 1 to ${POLICY_LIMITS.maxAttempts}`);
      else o.maxAttempts = v;
    }
    if (caps.maxConcurrentAgents !== undefined) {
      const v = wholeNumber(caps.maxConcurrentAgents, 1, POLICY_LIMITS.maxConcurrentAgents);
      if (v === undefined) err('caps.maxConcurrentAgents', `must be a whole number from 1 to ${POLICY_LIMITS.maxConcurrentAgents}`);
      else o.maxConcurrentAgents = v;
    }
    if (caps.maxEstimatedCostUsd !== undefined) {
      const v = caps.maxEstimatedCostUsd;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) err('caps.maxEstimatedCostUsd', 'must be a number of dollars above 0');
      else o.maxEstimatedCostUsd = v;
    }
    if (caps.maxUsageWindowPercent !== undefined) {
      const v = caps.maxUsageWindowPercent;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) err('caps.maxUsageWindowPercent', 'must be a percentage from 1 to 100');
      else o.maxUsageWindowPercent = v;
    }
    if (caps.location !== undefined) {
      if (!(LOCATIONS as readonly unknown[]).includes(caps.location)) err('caps.location', `must be one of ${LOCATIONS.join(', ')}`);
      else o.location = caps.location as RouteCaps['location'];
    }
    if (Object.keys(o).length > 0) out.caps = o;
  }

  const prefs = group('preferences', PREFERENCE_KEYS);
  if (prefs) {
    const o: NonNullable<ExecutionPolicy['preferences']> = {};
    if (prefs.harness !== undefined) o.harness = id(prefs.harness, 'preferences.harness');
    if (prefs.source !== undefined) o.source = id(prefs.source, 'preferences.source');
    if (prefs.preferLocal !== undefined) {
      if (typeof prefs.preferLocal !== 'boolean') err('preferences.preferLocal', 'must be true or false');
      else o.preferLocal = prefs.preferLocal;
    }
    if (prefs.strategy !== undefined) {
      if (!(STRATEGIES as readonly unknown[]).includes(prefs.strategy)) err('preferences.strategy', `must be one of ${STRATEGIES.join(', ')}`);
      else o.strategy = prefs.strategy as (typeof STRATEGIES)[number];
    }
    const clean = dropUndefined(o);
    if (Object.keys(clean).length > 0) out.preferences = clean;
  }

  const ex = group('exclusions', ['harnesses', 'sources', 'disableLocal']);
  if (ex) {
    const o: NonNullable<ExecutionPolicy['exclusions']> = {};
    for (const k of ['harnesses', 'sources'] as const) {
      if (ex[k] === undefined) continue;
      const v = ex[k];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) err(`exclusions.${k}`, 'must be an array of names');
      else if (v.length > 0) o[k] = [...new Set((v as string[]).map((x) => x.trim()))];
    }
    if (ex.disableLocal !== undefined) {
      if (typeof ex.disableLocal !== 'boolean') err('exclusions.disableLocal', 'must be true or false');
      else if (ex.disableLocal) o.disableLocal = true;
    }
    if (Object.keys(o).length > 0) out.exclusions = o;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy: out };
}

function wholeNumber(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// The global scope: `orchestration.routing` in settings.json
// ---------------------------------------------------------------------------

/** The settings key for the global routing defaults (#38, extended by #40). */
export const ROUTING_KEY = 'orchestration.routing';

/** What the global scope may set. `mode` is read separately: it picks the entry point, not a limit. */
export const GLOBAL_POLICY_KEYS = ['pins', 'caps', 'preferences', 'exclusions'] as const;

export interface RoutingSettings {
  /** How new tasks from the launcher are routed. */
  mode: 'manual' | 'assisted';
  /** The global scope's pins, caps, preferences and exclusions. */
  policy: ExecutionPolicy;
  /** Groups that were malformed and so were ignored, each with why. */
  errors: PolicyFieldError[];
}

/**
 * Read `orchestration.routing`: `{ mode, pins?, caps?, preferences?,
 * exclusions? }`. The flat `maxTier` / `maxEffort` #38 shipped are still read,
 * as caps. Trust nothing in settings.json: a malformed group is dropped whole
 * (and reported), never half-read, and the other groups still apply.
 */
export function parseRoutingSettings(raw: unknown): RoutingSettings {
  const r = isObj(raw) ? raw : {};
  const errors: PolicyFieldError[] = [];
  const policy: ExecutionPolicy = {};
  const legacyCaps: Record<string, unknown> = {};
  if (r.maxTier !== undefined) legacyCaps.maxTier = r.maxTier;
  if (r.maxEffort !== undefined) legacyCaps.maxEffort = r.maxEffort;
  for (const g of GLOBAL_POLICY_KEYS) {
    let value = r[g];
    if (g === 'caps' && Object.keys(legacyCaps).length > 0) value = { ...legacyCaps, ...(isObj(value) ? value : {}) };
    if (value === undefined) continue;
    const parsed = validateExecutionPolicy({ [g]: value }, { allowed: [g] });
    if (parsed.ok) Object.assign(policy, parsed.policy);
    else errors.push(...parsed.errors);
  }
  return { mode: r.mode === 'assisted' ? 'assisted' : 'manual', policy, errors };
}

/** What Preferences writes back to `orchestration.routing`: the nested form, empty groups left out. */
export function routingSettingsValue(mode: 'manual' | 'assisted', policy: ExecutionPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = { mode };
  for (const g of GLOBAL_POLICY_KEYS) {
    const v = policy[g];
    if (v && Object.keys(v).length > 0) out[g] = v;
  }
  return out;
}

/** A policy with every empty group removed, or undefined when nothing is set. For storing a layer. */
export function compactPolicy(p: ExecutionPolicy | undefined): ExecutionPolicy | undefined {
  if (!p) return undefined;
  const r = validateExecutionPolicy(p);
  const out = r.ok ? r.policy : p;
  return Object.keys(out).length > 0 ? out : undefined;
}
