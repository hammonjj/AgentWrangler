/**
 * The one-time move from `secrets.json` (Electron `safeStorage` ciphertext) to
 * the Keychain (#124).
 *
 * Only Electron can decrypt the old file, so this runs in the Electron app, at
 * start, while it still exists; the decryption is passed in so this module has
 * no Electron import and can be tested. For each entry: decrypt, store in the
 * Keychain, read it back and compare. When every entry made it, the file is
 * deleted. When one did not, the file is kept with only the entries that did
 * not, and the next start tries those again — the ones already moved are not
 * written a second time, so a key re-entered in between is never overwritten
 * with the old one.
 *
 * Logs name keys, never values.
 */
import * as fsp from 'node:fs/promises';
import type { HostSecrets } from '../host/hostServices';

export interface SecretsMigrationOptions {
  /** `<userData>/secrets.json`. */
  file: string;
  /** False when `safeStorage` cannot decrypt on this machine right now. */
  canDecrypt(): boolean;
  /** `safeStorage.decryptString`; throws when this entry cannot be decrypted. */
  decrypt(ciphertext: Buffer): string;
  /** The Keychain store — not one gated on this migration, or it waits for itself. */
  target: HostSecrets;
  log(message: string): void;
}

export type SecretsMigrationResult =
  | { outcome: 'nothing-to-do' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'migrated'; keys: string[] }
  | { outcome: 'partial'; migrated: string[]; failed: string[] };

export async function migrateSecretsFile(opts: SecretsMigrationOptions): Promise<SecretsMigrationResult> {
  const { file, log, target } = opts;
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'nothing-to-do' };
    return skip(log, `cannot read ${file}: ${String(err)}`);
  }

  let vault: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    vault = parsed as Record<string, unknown>;
  } catch (err) {
    return skip(log, `${file} is not a JSON object (${String(err)}); left in place`);
  }

  const keys = Object.keys(vault);
  if (keys.length === 0) {
    await fsp.rm(file, { force: true });
    log('secrets: secrets.json was empty; removed');
    return { outcome: 'migrated', keys: [] };
  }
  if (!target.available) return skip(log, 'the Keychain is not available; secrets.json left in place');
  if (!opts.canDecrypt()) return skip(log, 'safeStorage cannot decrypt here; secrets.json left in place');

  const migrated: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    const why = await moveOne(opts, key, vault[key]);
    if (why === undefined) migrated.push(key);
    else {
      failed.push(key);
      log(`secrets: could not move ${key} to the Keychain: ${why}`);
    }
  }

  if (failed.length === 0) {
    await fsp.rm(file, { force: true });
    log(`secrets: moved ${migrated.length} secret(s) to the Keychain (${migrated.join(', ')}); secrets.json removed`);
    return { outcome: 'migrated', keys: migrated };
  }

  if (migrated.length > 0) {
    const rest: Record<string, unknown> = {};
    for (const key of failed) rest[key] = vault[key];
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(rest), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
  }
  log(`secrets: moved ${migrated.length} of ${keys.length} secret(s) to the Keychain; secrets.json kept for ${failed.join(', ')}`);
  return { outcome: 'partial', migrated, failed };
}

/** Undefined when `key` is in the Keychain and reads back equal; otherwise why not. */
async function moveOne(opts: SecretsMigrationOptions, key: string, encrypted: unknown): Promise<string | undefined> {
  if (typeof encrypted !== 'string') return 'the entry is not a string';
  let value: string;
  try {
    value = opts.decrypt(Buffer.from(encrypted, 'base64'));
  } catch (err) {
    return `safeStorage could not decrypt it (${String(err)})`;
  }
  try {
    await opts.target.store(key, value);
  } catch (err) {
    // `store` errors never carry the value (see keychainSecrets.ts).
    return String(err);
  }
  const back = await opts.target.get(key).catch(() => undefined);
  return back === value ? undefined : 'it did not read back the same';
}

function skip(log: (message: string) => void, reason: string): SecretsMigrationResult {
  log(`secrets: migration skipped: ${reason}`);
  return { outcome: 'skipped', reason };
}
