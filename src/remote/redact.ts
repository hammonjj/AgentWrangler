/**
 * Scrubbing a command before it leaves the machine.
 *
 * A permission prompt is shown so a human can decide, which means the command
 * has to stay readable — an over-eager mask makes the decision worse, not
 * safer. So this errs toward leaving text alone, and only removes shapes that
 * are secrets and essentially nothing else: an assignment to a
 * secret-sounding name, a token with a known vendor prefix, a bearer header, a
 * PEM block, an explicit `--password`-style flag.
 *
 * Two deliberate omissions, both because the false positive is worse than the
 * false negative:
 *
 * - **bare `-p`**. `mysql -pSECRET` is real, but so is `mkdir -p`, `git log -p`
 *   and `grep -p`. Masking the flag that appears in half the commands an agent
 *   runs would make the card unreadable to buy very little.
 * - **anything positional.** `curl https://user:pw@host` aside, a value is only
 *   recognisable as a secret by the name attached to it, and guessing from
 *   position would hit file paths and arguments constantly.
 *
 * The home directory is replaced with `~` separately: not a secret, but a
 * channel full of `/Users/<name>/…` accumulates one fact about the user in
 * every message for no benefit.
 *
 * Pure — no Node imports, so the home directory arrives as an argument.
 */

/** What a masked run is replaced with. Visible on purpose: silence would look like the real text. */
export const MASK = '‹redacted›';

/**
 * Names whose value is a secret whatever it looks like. Matched
 * case-insensitively as a whole word-ish segment, so `GITHUB_TOKEN`,
 * `api_key` and `DB-PASSWORD` all hit while `TOKENIZER` does not.
 */
const SECRET_NAME = '(?:[A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|AUTH))';

const RULES: { re: RegExp; replace: string }[] = [
  // -----BEGIN … PRIVATE KEY----- … -----END … -----  (whole block)
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: MASK,
  },
  // Authorization: Bearer xyz  /  Authorization: Basic xyz
  { re: /\b(Authorization\s*:\s*(?:Bearer|Basic|token)\s+)\S+/gi, replace: `$1${MASK}` },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, replace: `$1${MASK}` },
  // Vendor-shaped tokens, recognisable on their own.
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: MASK },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: MASK },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: MASK },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, replace: MASK },
  { re: /\bAKIA[0-9A-Z]{12,}/g, replace: MASK },
  // A URL carrying credentials: https://user:pw@host -> https://user:‹redacted›@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, replace: `$1${MASK}$2` },
  // NAME=value and NAME: value, where NAME sounds like a secret.
  { re: new RegExp(`\\b(${SECRET_NAME}\\s*=\\s*)(?:"[^"]*"|'[^']*'|\\S+)`, 'gi'), replace: `$1${MASK}` },
  { re: new RegExp(`\\b(${SECRET_NAME}\\s*:\\s*)(?:"[^"]*"|'[^']*'|\\S+)`, 'gi'), replace: `$1${MASK}` },
  // Explicit flags, --flag=value and --flag value.
  {
    re: /\B(--(?:password|passwd|token|secret|api-?key|auth|credential)[= ])(?:"[^"]*"|'[^']*'|\S+)/gi,
    replace: `$1${MASK}`,
  },
];

export interface RedactOptions {
  /** Absolute home directory to fold to `~`. Omit to leave paths alone. */
  home?: string;
  /** Hard ceiling on the result, after masking. */
  max?: number;
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mask secrets, fold the home directory, and cap the length.
 *
 * Order matters: masking runs before truncation so a secret cannot survive by
 * sitting past the cut, and the home fold runs last so it cannot create a
 * shape the rules would then have matched.
 */
export function redactForDisplay(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace);

  if (opts.home && opts.home.length > 1) {
    out = out.replace(new RegExp(escapeRe(opts.home.replace(/\/+$/, '')), 'g'), '~');
  }

  if (opts.max !== undefined && out.length > opts.max) {
    out = `${out.slice(0, Math.max(0, opts.max - 1))}…`;
  }
  return out;
}

/** True when anything was masked — for the audit line, which records that rather than what. */
export function wasRedacted(original: string, redacted: string): boolean {
  return !original.includes(MASK) && redacted.includes(MASK);
}
