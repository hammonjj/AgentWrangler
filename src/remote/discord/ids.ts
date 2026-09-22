/**
 * The `custom_id` a button carries, and the strict parser for what comes back.
 *
 * Discord echoes this string to us verbatim when a button is pressed, which
 * makes it foreign input from an untrusted source — anyone who can see the
 * message can read it, and a malicious client can send whatever it likes. So it
 * carries **no authority and nothing private**: not a session id, not a hook
 * marker id, not a path, not a tool name. Only an opaque random handle that
 * means something to the mirror map, and which of the ask's own choices was
 * pressed. Everything else is looked up locally and re-checked against live
 * state.
 *
 * Pure.
 */

/** Ours, so a press meant for some other bot's component is ignored cheaply. */
const PREFIX = 'aw';

/** Discord's hard limit on a component `custom_id`. */
export const MAX_CUSTOM_ID = 100;

/** 16 random bytes as base64url is 22 chars; allow room without allowing junk. */
const INTERACTION_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** `allow` | `always` | `deny` today; kept general, but bounded and lowercase. */
const CHOICE_ID = /^[a-z][a-z-]{0,23}$/;

export interface ParsedCustomId {
  interactionId: string;
  choiceId: string;
}

export function encodeCustomId(interactionId: string, choiceId: string): string {
  const id = `${PREFIX}:${interactionId}:${choiceId}`;
  if (id.length > MAX_CUSTOM_ID) {
    // Would be silently rejected by Discord at publish time, which would look
    // like a mysteriously button-less card. Fail where the cause is visible.
    throw new Error(`custom_id too long (${id.length} > ${MAX_CUSTOM_ID})`);
  }
  if (!INTERACTION_ID.test(interactionId)) throw new Error('interaction id is not in the expected alphabet');
  if (!CHOICE_ID.test(choiceId)) throw new Error(`choice id is not in the expected alphabet: ${choiceId}`);
  return id;
}

/**
 * Parse a `custom_id` back, or `undefined` for anything that is not ours and
 * exactly well-formed. Undefined is not an error condition — a press on a
 * component from another application, or from an older build, lands here.
 */
export function decodeCustomId(raw: unknown): ParsedCustomId | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_CUSTOM_ID) return undefined;
  const parts = raw.split(':');
  // Exactly three: a separator inside either field would otherwise let one
  // field impersonate the shape of two.
  if (parts.length !== 3) return undefined;
  const [prefix, interactionId, choiceId] = parts;
  if (prefix !== PREFIX) return undefined;
  if (!INTERACTION_ID.test(interactionId)) return undefined;
  if (!CHOICE_ID.test(choiceId)) return undefined;
  return { interactionId, choiceId };
}
