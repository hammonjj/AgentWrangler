/**
 * Credentials for the Electron app: the Keychain store, after a one-time move
 * of anything still in the old `safeStorage` file (#124).
 *
 * Until #124 secrets were `safeStorage` ciphertext in `<userData>/secrets.json`.
 * That only Electron can read, and Electron is being retired (epic #121), so
 * they now live in the login Keychain through `src/core/keychainSecrets.ts`,
 * which a plain-Node daemon can use too. This file is the only part that needs
 * Electron: decrypting the old file, once, while there is still an Electron to
 * do it. It must ship at least one release before Electron is removed.
 *
 * Every operation on the returned store waits for the migration, so the first
 * read of the Discord token after an upgrade finds it in the Keychain rather
 * than missing.
 */
import { safeStorage } from 'electron';
import type { HostSecrets } from '../host/hostServices';
import { KEYCHAIN_SERVICE, KeychainSecrets, systemSecurityRunner } from '../core/keychainSecrets';
import { migrateSecretsFile } from '../core/secretsMigration';

export function createElectronSecrets(legacyFile: string, log: (message: string) => void): HostSecrets {
  const runner = systemSecurityRunner();
  // Ungated: the migration writes and verifies through this one.
  const keychain = new KeychainSecrets(runner, log);
  const migration = migrateSecretsFile({
    file: legacyFile,
    canDecrypt: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
    target: keychain,
    log,
  }).catch((err: unknown) => {
    log(`secrets: migration failed: ${String(err)}`);
  });
  return new KeychainSecrets(runner, log, KEYCHAIN_SERVICE, migration);
}
