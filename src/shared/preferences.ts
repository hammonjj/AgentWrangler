/**
 * The Preferences window's wire protocol.
 *
 * Separate from `messages.ts` because that file is the two panes' protocol and
 * this is a different document with a different lifetime — it is opened, used
 * and closed, and it never sees a session. It reuses the same preload, so the
 * envelope the panes wrap everything in is deliberately not used here: there is
 * only one thing in this window and nothing to address a message to.
 */

export type PreferencesToHost =
  /** The window has rendered and wants the current values. */
  | { type: 'ready' }
  /** One setting changed. Sent per edit; the host is the only store. */
  | { type: 'set'; key: string; value: string | boolean | number }
  /** Put one setting back to the value it ships with. */
  | { type: 'reset'; key: string }
  | { type: 'close' };

export type HostToPreferences = {
  type: 'values';
  /** Every setting the app offers, keyed without the `agentWrangler.` prefix. */
  values: Record<string, string | boolean | number>;
};

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
