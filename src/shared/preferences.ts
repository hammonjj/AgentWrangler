/**
 * The Preferences window's wire protocol.
 *
 * Separate from `messages.ts` because that file is the two panes' protocol and
 * this is a different document with a different lifetime — it is opened, used
 * and closed, and it never sees a session. It reuses the same preload, so the
 * envelope the panes wrap everything in is deliberately not used here: there is
 * only one thing in this window and nothing to address a message to.
 */

import type { CapabilityCatalogView, ModelPolicyChange } from './orchestration/catalog';
import {
  FIELD_LABEL,
  GLOBAL_POLICY_KEYS,
  checkPolicyEdit,
  policyContextFor,
  routingSettingsValue,
  validateExecutionPolicy,
  type LauncherRoutingMode,
  type StoredAutoOverride,
} from './orchestration/executionPolicy';
import { gateLines, type ComparisonReport, type GateResult } from './orchestration/autoRouting';
import type { SourceStatus } from './orchestration/sourceHealth';
import type { LocalEndpointChange, LocalEndpointView } from './orchestration/localEndpoints';
import type { LocalModelSummary } from './orchestration/localMetrics';
import type { ExecutionPolicy } from './orchestration/types';

export type PreferencesToHost =
  /** The window has rendered and wants the current values. */
  | { type: 'ready' }
  /** One setting changed. Sent per edit; the host is the only store. */
  | { type: 'set'; key: string; value: string | boolean | number }
  /** Put one setting back to the value it ships with. */
  | { type: 'reset'; key: string }
  /**
   * A button was pressed. Not every control in this window is a setting: some
   * things a feature needs are actions — connecting a credential, checking that
   * a connection works — and they belong beside the settings they are about
   * rather than only in a menu.
   */
  | { type: 'action'; id: SettingActionId }
  /** A change to one model's tier or enabled flag, from Orchestration → tier map. */
  | { type: 'modelPolicy'; change: ModelPolicyChange }
  /** Add, remove, turn on or off, key, probe or qualify a local endpoint (#51). */
  | { type: 'localEndpoint'; change: LocalEndpointChange }
  /**
   * The global routing defaults, whole, from Orchestration → Routing defaults
   * (#40). `overrideGate`: the user pressed "Enable anyway" with the gate's
   * numbers in front of them (#42); only then may `auto` be set over an unmet gate.
   */
  | { type: 'routingPolicy'; mode: LauncherRoutingMode; policy: ExecutionPolicy; overrideGate?: boolean }
  | { type: 'close' };

/** What Preferences → Orchestration shows: the catalog, each source's health, and the routing defaults. */
export interface OrchestrationPrefsView {
  catalog: CapabilityCatalogView;
  sources: SourceStatus[];
  /** Local endpoints and what their models have done (#51). */
  local?: {
    endpoints: LocalEndpointView[];
    summaries: LocalModelSummary[];
    /** The OS can encrypt keys; without it no key can be stored. */
    secretsAvailable: boolean;
  };
  /** The global scope of §10.2 as stored (#40). Absent: the host has none to offer. */
  routing?: {
    mode: LauncherRoutingMode;
    policy: ExecutionPolicy;
    ignored: string[];
    /** `auto` was enabled over an unmet gate (#42). */
    autoOverride?: StoredAutoOverride;
    /** Automatic routing's gate, with its numbers (§27.3, #42). */
    gate?: GateResult;
    /** The shadow comparison report (§27.3, #42). */
    report?: ComparisonReport;
  };
}

/** What a routing change needs to know besides the message: the gate now, what is stored, and the time. */
export interface RoutingUpdateContext {
  gate?: GateResult;
  stored?: { mode: LauncherRoutingMode; autoOverride?: StoredAutoOverride };
  now?: number;
}

/**
 * Check the routing defaults a Preferences window sent (#40): the shape, the
 * tier names against the catalog, and a pin at this scope against a cap at
 * this scope — the one conflict the global scope can have on its own. The
 * narrower scopes are checked against it when a mission is recorded. The same
 * function runs in the window, so an error shows the moment a value is set,
 * and in the host, which trusts nothing the window sends.
 */
export function routingPolicyUpdate(
  message: unknown,
  catalog: Pick<CapabilityCatalogView, 'tiers' | 'entries'>,
  ctx: RoutingUpdateContext = {},
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[]; needsOverride?: true } {
  if (!message || typeof message !== 'object') return { ok: false, errors: ['not a routing change'] };
  const m = message as { type?: unknown; mode?: unknown; policy?: unknown; overrideGate?: unknown };
  if (m.type !== 'routingPolicy' || (m.mode !== 'manual' && m.mode !== 'assisted' && m.mode !== 'auto')) return { ok: false, errors: ['not a routing change'] };
  const parsed = validateExecutionPolicy(m.policy ?? {}, { tiers: catalog.tiers, allowed: GLOBAL_POLICY_KEYS });
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map((e) => `${FIELD_LABEL[e.path] ?? e.path}: ${e.message}`) };
  const conflicts = checkPolicyEdit([], 'global', parsed.policy, policyContextFor(catalog));
  if (conflicts.length > 0) return { ok: false, errors: conflicts.map((c) => c.message) };
  if (m.mode !== 'auto') return { ok: true, value: routingSettingsValue(m.mode, parsed.policy) };
  // `auto` (§27.3, #42): with the gate met, as is. Over an unmet gate, only by
  // an explicit override with the numbers shown — or an override that already
  // stands, so editing a cap while on `auto` does not ask again.
  if (ctx.gate?.met) return { ok: true, value: routingSettingsValue('auto', parsed.policy) };
  const standing = ctx.stored?.mode === 'auto' ? ctx.stored.autoOverride : undefined;
  if (standing) return { ok: true, value: routingSettingsValue('auto', parsed.policy, standing) };
  const shown = ctx.gate ? gateLines(ctx.gate) : ['✗ The gate could not be read'];
  if (m.overrideGate === true) return { ok: true, value: routingSettingsValue('auto', parsed.policy, { at: ctx.now ?? Date.now(), shown }) };
  return { ok: false, needsOverride: true, errors: ['Automatic routing’s gate is not met:', ...shown] };
}

/**
 * A `modelPolicy` message's change, or nothing if it is not well formed. The
 * host still checks the key and tier against the catalog; this only refuses
 * shapes no Preferences window sends.
 */
export function modelPolicyChange(message: unknown): ModelPolicyChange | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { type?: unknown; change?: unknown };
  if (m.type !== 'modelPolicy' || !m.change || typeof m.change !== 'object') return undefined;
  const c = m.change as Record<string, unknown>;
  if (typeof c.key !== 'string' || c.key === '') return undefined;
  const out: ModelPolicyChange = { key: c.key };
  if (c.tier === null || (typeof c.tier === 'string' && c.tier !== '')) out.tier = c.tier as string | null;
  else if (c.tier !== undefined) return undefined;
  if (typeof c.enabled === 'boolean') out.enabled = c.enabled;
  else if (c.enabled !== undefined) return undefined;
  if (c.reset === 'tier' || c.reset === 'enabled' || c.reset === 'all') out.reset = c.reset;
  else if (c.reset !== undefined) return undefined;
  if (out.tier === undefined && out.enabled === undefined && out.reset === undefined) return undefined;
  return out;
}

/** The actions Preferences can invoke. A closed set: the host switches on it. */
export type SettingActionId = 'connectDiscord' | 'testRemote' | 'disconnectDiscord';

export const SETTING_ACTION_IDS: SettingActionId[] = ['connectDiscord', 'testRemote', 'disconnectDiscord'];

export function isSettingActionId(value: unknown): value is SettingActionId {
  return typeof value === 'string' && (SETTING_ACTION_IDS as string[]).includes(value);
}

/**
 * What a setting is doing right now, shown read-only under it: the addresses
 * `web.lan.enabled` is bound to, for one (#136). Not a value and never written.
 */
export interface SettingStatus {
  ok: boolean;
  lines: string[];
}

export type HostToPreferences =
  | {
      type: 'values';
      /** Every setting the app offers, keyed without the `agentWrangler.` prefix. */
      values: Record<string, string | boolean | number>;
    }
  /** Every setting's current status, by key. A key that is absent has none. */
  | { type: 'status'; status: Record<string, SettingStatus> }
  /**
   * What an action did, shown in the window that asked rather than in a dialog
   * over it. A check with six separate results is a thing to read next to the
   * fields it is about, not a modal to dismiss.
   */
  | { type: 'actionResult'; id: SettingActionId; ok: boolean; lines: string[]; busy?: false }
  /** The action has started; the button says so and cannot be pressed twice. */
  | { type: 'actionBusy'; id: SettingActionId }
  /** The model catalog changed, or the window just opened. */
  | { type: 'orchestration'; view: OrchestrationPrefsView }
  /** What a local endpoint change did, shown beside the endpoints. */
  | { type: 'localEndpointResult'; ok: boolean; lines: string[] }
  /** The routing defaults the window sent were saved, or refused and why (#40). */
  | { type: 'routingResult'; ok: boolean; errors: string[]; needsOverride?: boolean };

/**
 * What a `set` or `reset` should actually write, or nothing.
 *
 * Separated from the window because it is the part with rules in it and the
 * window is the part with Electron in it. The rules: only a declared key, only
 * a value of that key's declared type, and `reset` writes `undefined` — which
 * removes the key, so the default keeps coming from the declaration rather than
 * being copied into the file. That last one is what makes a changed default
 * reach someone who once pressed Reset.
 *
 * A message that fails any of this is not a person changing a setting. It is a
 * stale document, or something else that reached the channel, and it does not
 * get to write.
 */
export function settingUpdate(
  message: PreferencesToHost,
  specFor: (key: string) => { key: string; type: 'string' | 'boolean' | 'number' } | undefined,
): { key: string; value: string | boolean | number | undefined } | undefined {
  if (!message || typeof message !== 'object') return undefined;
  if (message.type === 'reset') {
    const spec = specFor(message.key);
    return spec ? { key: spec.key, value: undefined } : undefined;
  }
  if (message.type !== 'set') return undefined;
  const spec = specFor(message.key);
  if (!spec || typeof message.value !== spec.type) return undefined;
  return { key: spec.key, value: message.value };
}
