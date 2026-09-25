/**
 * ULIDs: 48 bits of time then 80 random bits, in Crockford base32, so ids
 * sort by creation time (mission files list in order, telemetry lines line up).
 *
 * Pure given its inputs: the clock and the randomness are passed in.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number, random: (bytes: number) => Uint8Array): string {
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) throw new RangeError(`ulid: bad time ${now}`);
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(10);
  // 80 bits → 16 base32 characters, 5 bits at a time.
  let bits = 0;
  let value = 0;
  let rand = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return time + rand;
}
