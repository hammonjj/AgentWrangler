/**
 * Credentials, encrypted by the OS.
 *
 * `safeStorage` is Electron's binding to the platform keystore — on macOS the
 * Keychain, through a key the app owns. It hands back ciphertext rather than
 * managing storage, so the ciphertext is kept in a file of its own beside the
 * other state, at mode 0600.
 *
 * A separate file from `settings.json` on purpose. Settings are plain JSON a
 * person may open, copy into an issue or screenshot; the whole reason a token
 * is not a setting is that it must not be in that file. Keeping it in a
 * different one makes that obvious to anyone reading the directory.
 *
 * When the OS declines to encrypt — a Linux session with no keyring, an
 * unsupported platform — `available` is false and storing **refuses**. Writing
 * plaintext instead would be the one outcome nobody asked for, and silently at
 * that.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type { HostSecrets } from '../host/hostServices';

type Vault = Record<string, string>;

export class ElectronSecrets implements HostSecrets {
  private cache?: Vault;

  constructor(
    private file: string,
    private log: (message: string) => void = () => undefined,
  ) {}

  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | undefined> {
    const vault = await this.read();
    const encrypted = vault[key];
    if (encrypted === undefined) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (err) {
      // The keystore key changed, or the file was copied from another machine.
      // The credential is unrecoverable; say so rather than return nonsense.
      this.log(`cannot decrypt ${key}: ${String(err)}`);
      return undefined;
    }
  }

  async store(key: string, value: string): Promise<void> {
    if (!this.available) throw new Error('This system cannot encrypt secrets, so the token was not saved.');
    const vault = await this.read();
    vault[key] = safeStorage.encryptString(value).toString('base64');
    await this.write(vault);
  }

  async delete(key: string): Promise<void> {
    const vault = await this.read();
    if (!(key in vault)) return;
    delete vault[key];
    await this.write(vault);
  }

  private async read(): Promise<Vault> {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.cache = typeof parsed === 'object' && parsed !== null ? (parsed as Vault) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(vault: Vault): Promise<void> {
    this.cache = vault;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // 0600 as well as encrypted: defence in depth costs nothing here, and a
    // world-readable file of ciphertext is still a thing worth not having.
    await fsp.writeFile(tmp, JSON.stringify(vault), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }
}
