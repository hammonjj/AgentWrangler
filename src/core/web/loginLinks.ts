/**
 * Single-use browser login codes (#127, plan §8).
 *
 * `aw web open` asks the app for one; it is the `code` of a `/login` link and
 * is good once, for two minutes. Held in memory only: a restart forgets every
 * code, which only means running `aw web open` again.
 */
import * as crypto from 'node:crypto';

export const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;
/** Codes outstanding at once. Minting past this drops the oldest. */
const MAX_OUTSTANDING = 16;

interface Pending {
  code: Buffer;
  expiresAt: number;
}

export type RedeemOutcome = 'ok' | 'invalid' | 'expired';

export class LoginCodes {
  private pending: Pending[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  mint(): { code: string; expiresAt: number } {
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + LOGIN_CODE_TTL_MS;
    this.pending = [...this.pending, { code: Buffer.from(code), expiresAt }].slice(-MAX_OUTSTANDING);
    return { code, expiresAt };
  }

  /**
   * Use a code. `ok` once; the same code again is `invalid`, as is one never
   * minted. Compared in constant time against every outstanding code.
   */
  redeem(code: string | null | undefined): RedeemOutcome {
    if (typeof code !== 'string' || code.length === 0 || code.length > 128) return 'invalid';
    const given = Buffer.from(code);
    let match: Pending | undefined;
    for (const p of this.pending) {
      if (p.code.length === given.length && crypto.timingSafeEqual(p.code, given) && !match) match = p;
    }
    const at = this.now();
    // Used or not, a match is spent; and expired ones go while we are here.
    this.pending = this.pending.filter((p) => p !== match && p.expiresAt > at);
    if (!match) return 'invalid';
    return match.expiresAt > at ? 'ok' : 'expired';
  }
}
