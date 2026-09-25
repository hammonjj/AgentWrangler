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
import type { SourceStatus } from './orchestration/sourceHealth';

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
  | { type: 'close' };

/** What Preferences → Orchestration shows: the catalog and each source's health. */
export interface OrchestrationPrefsView {
  catalog: CapabilityCatalogView;
  sources: SourceStatus[];
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

export type HostToPreferences =
  | {
      type: 'values';
      /** Every setting the app offers, keyed without the `agentWrangler.` prefix. */
      values: Record<string, string | boolean | number>;
    }
  /**
   * What an action did, shown in the window that asked rather than in a dialog
   * over it. A check with six separate results is a thing to read next to the
   * fields it is about, not a modal to dismiss.
   */
  | { type: 'actionResult'; id: SettingActionId; ok: boolean; lines: string[]; busy?: false }
  /** The action has started; the button says so and cannot be pressed twice. */
  | { type: 'actionBusy'; id: SettingActionId }
  /** The model catalog changed, or the window just opened. */
  | { type: 'orchestration'; view: OrchestrationPrefsView };

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
