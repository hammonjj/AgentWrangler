/**
 * Pairing codes and the limits on guessing them (#137, plan §8).
 *
 * A pairing offer is started on the Mac (`aw web pair`, or `/pair/new` in a
 * signed-in browser there) and redeemed on the LAN listener's `/pair` by the
 * device being paired, which gets a `scope: 'lan'` credential for it.
 *
 * - **The code.** Eight characters of Crockford's base32 (no I, L, O or U),
 *   40 random bits, shown as `ABCD-EF12`. Typing is forgiving: case, spaces,
 *   dashes, and O/I/L for 0/1 are all accepted.
 * - **One offer at a time**, good for five minutes and once. Starting another
 *   replaces it.
 * - **Guessing.** Per source address, five failures in ten minutes lock that
 *   address out for fifteen. Across every address, twenty failures in ten
 *   minutes lock pairing out for fifteen. And an offer that has seen five
 *   wrong codes is withdrawn, so at most five guesses are ever made against
 *   one 40-bit code. While locked, a request is refused without its code
 *   being looked at, right or wrong.
 *
 * Held in memory only: a restart forgets the offer and the counters, which
 * costs a guesser a restart of the Mac's app it cannot cause.
 */
import * as crypto from 'node:crypto';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_CODE_LENGTH = 8;
/** Crockford's base32: no I, L, O or U. */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const PAIRING_LOCKOUT_MS = 15 * 60 * 1000;
export const PAIRING_MAX_FAILURES_PER_ADDRESS = 5;
export const PAIRING_MAX_FAILURES_GLOBAL = 20;
export const PAIRING_MAX_FAILURES_PER_OFFER = 5;

export interface PairingOffer {
  /** Normalised, without the dash. */
  code: string;
  expiresAt: number;
}

export type PairingFailure =
  /** Wrong, malformed, or no offer to match. Deliberately not told apart to the device. */
  | 'invalid'
  /** The right code, after its five minutes. */
  | 'expired'
  /** This address, or pairing as a whole, is locked out; the code was not looked at. */
  | 'locked';

export type PairingOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: PairingFailure;
      /** This failure is the one that locked `ip` or everything out. */
      lockedOut?: 'address' | 'global';
      /** This failure withdrew the offer (its fifth). */
      offerWithdrawn?: boolean;
    };

interface AddressRecord {
  failures: number[];
  lockedUntil: number;
}

/** `ABCDEF12` → `ABCD-EF12`. */
export function formatPairingCode(code: string): string {
  return code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * What someone typed, as a code: upper case, without spaces or dashes, with
 * O read as 0 and I or L as 1. Undefined when it cannot be one.
 */
export function normalizePairingCode(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string' || input.length > 64) return undefined;
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const c of code) if (!PAIRING_ALPHABET.includes(c)) return undefined;
  return code;
}

export class PairingOffers {
  private offer: (PairingOffer & { failures: number }) | undefined;
  private readonly addresses = new Map<string, AddressRecord>();
  private globalFailures: number[] = [];
  private globalLockedUntil = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A new offer, replacing any other. */
  start(): PairingOffer {
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
    const offer = { code, expiresAt: this.now() + PAIRING_TTL_MS };
    this.offer = { ...offer, failures: 0 };
    return offer;
  }

  /** The outstanding offer's expiry, if there is one that can still be used. */
  current(): { expiresAt: number } | undefined {
    if (!this.offer || this.offer.expiresAt <= this.now()) return undefined;
    return { expiresAt: this.offer.expiresAt };
  }

  /** Withdraw the offer (LAN access went off, the server is closing). */
  cancel(): void {
    this.offer = undefined;
  }

  /** Whether `ip` may try a code now. Checked before a form is even read. */
  locked(ip: string): boolean {
    const at = this.now();
    if (at < this.globalLockedUntil) return true;
    const rec = this.addresses.get(ip);
    return rec !== undefined && at < rec.lockedUntil;
  }

  /**
   * Try `input` from `ip`. `ok` spends the offer. Every other outcome but
   * `locked` counts as a failure against `ip`, against everyone, and against
   * the offer.
   */
  redeem(input: string | null | undefined, ip: string): PairingOutcome {
    return this.attempt(input, ip, true);
  }

  /**
   * Like `redeem`, but a right code leaves the offer in place: the setup
   * pages (certificate, then the pairing link) check the code several times
   * before the device spends it. Wrong codes count exactly as they do there.
   */
  verify(input: string | null | undefined, ip: string): PairingOutcome {
    return this.attempt(input, ip, false);
  }

  private attempt(input: string | null | undefined, ip: string, spend: boolean): PairingOutcome {
    if (this.locked(ip)) return { ok: false, reason: 'locked' };
    const at = this.now();
    const code = normalizePairingCode(input);
    const offer = this.offer;
    const matches =
      code !== undefined && offer !== undefined && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(offer.code));
    if (matches && offer.expiresAt > at) {
      if (spend) this.offer = undefined;
      return { ok: true };
    }
    const reason: PairingFailure = matches ? 'expired' : 'invalid';
    let offerWithdrawn = false;
    if (matches) {
      this.offer = undefined;
    } else if (offer) {
      offer.failures++;
      if (offer.failures >= PAIRING_MAX_FAILURES_PER_OFFER) {
        this.offer = undefined;
        offerWithdrawn = true;
      }
    }
    const lockedOut = this.recordFailure(ip, at);
    return { ok: false, reason, ...(lockedOut ? { lockedOut } : {}), ...(offerWithdrawn ? { offerWithdrawn } : {}) };
  }

  private recordFailure(ip: string, at: number): 'address' | 'global' | undefined {
    this.prune(at);
    const rec = this.addresses.get(ip) ?? { failures: [], lockedUntil: 0 };
    rec.failures.push(at);
    this.addresses.set(ip, rec);
    this.globalFailures.push(at);
    if (this.globalFailures.length >= PAIRING_MAX_FAILURES_GLOBAL) {
      this.globalLockedUntil = at + PAIRING_LOCKOUT_MS;
      this.globalFailures = [];
      return 'global';
    }
    if (rec.failures.length >= PAIRING_MAX_FAILURES_PER_ADDRESS) {
      rec.lockedUntil = at + PAIRING_LOCKOUT_MS;
      rec.failures = [];
      return 'address';
    }
    return undefined;
  }

  /** Forget failures older than the window, and addresses with nothing left to remember. */
  private prune(at: number): void {
    const since = at - PAIRING_FAILURE_WINDOW_MS;
    this.globalFailures = this.globalFailures.filter((t) => t > since);
    for (const [ip, rec] of this.addresses) {
      rec.failures = rec.failures.filter((t) => t > since);
      if (rec.failures.length === 0 && rec.lockedUntil <= at) this.addresses.delete(ip);
    }
  }
}
