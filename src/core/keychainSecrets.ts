/**
 * Credentials in the macOS login Keychain, through `/usr/bin/security`.
 *
 * The Electron builds kept secrets in `safeStorage` ciphertext, which only
 * Electron could read; they moved them here (#124), and the daemon (epic
 * #121) reads them here. One generic-password item each: service
 * `Agent Wrangler`, account = the secret's key (`remote.discord.botToken`,
 * `localEndpoint:<id>`). Keychain Access shows them under that name.
 *
 * **A secret never appears in argv.** `ps` shows every process's arguments to
 * every user, so writes go through `security -i`, which reads the command line
 * from stdin and tokenizes it itself. Reads and deletes put only the service
 * and the key on the command line; the value comes back on stdout.
 *
 * How `security -i` tokenizes a line (checked on macOS 26 against a keychain
 * path that does not exist, so no keychain was touched):
 *   - whitespace separates arguments; `"…"` and `'…'` group them;
 *   - inside double quotes, `\"` is `"` and `\\` is `\`; any other `\x` is `x`;
 *   - a line longer than 4096 bytes is cut and the rest run as a second
 *     command — so a long line is refused here rather than half-executed;
 *   - there is no way to put a newline in an argument.
 * `quoteForSecurityShell` therefore double-quotes every argument and escapes
 * `\` and `"`, and values with control characters are refused.
 *
 * Values are printable ASCII only. `find-generic-password -w` prints a password
 * that is not printable as hex, and an all-hex token would then be ambiguous;
 * every token and API key this app stores is ASCII anyway, so refusing the rest
 * on the way in is cheaper than guessing on the way out.
 *
 * The items' access list trusts the program that created them, which is
 * `/usr/bin/security` — a system binary whose signature does not change when
 * this app is rebuilt, so there is no Keychain prompt per build either.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { HostSecrets } from '../host/hostServices';

export const KEYCHAIN_SERVICE = 'Agent Wrangler';
export const SECURITY_BIN = '/usr/bin/security';

/** `security -i` reads at most this many bytes per line, newline included. */
const MAX_LINE_BYTES = 4096;
/** `errSecItemNotFound`, as `security`'s exit status. */
const EXIT_NOT_FOUND = 44;

export interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * How `security` is run. Injectable so tests never touch a real Keychain.
 * `stdin`, when given, is written to the process and closed.
 */
export interface SecurityRunner {
  /** True when `security` can be run here at all. */
  available(): boolean;
  run(args: string[], stdin?: string): Promise<SecurityResult>;
}

/** The real runner: `/usr/bin/security`, no shell, a timeout for a prompt nobody answers. */
export function systemSecurityRunner(bin = SECURITY_BIN, timeoutMs = 120_000): SecurityRunner {
  let usable: boolean | undefined;
  return {
    available() {
      if (usable === undefined) {
        try {
          fs.accessSync(bin, fs.constants.X_OK);
          usable = process.platform === 'darwin';
        } catch {
          usable = false;
        }
      }
      return usable;
    },
    run(args, stdin) {
      return new Promise((resolve) => {
        const child = execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          // A non-zero exit carries its status in `code`; a timeout or a
          // failed spawn does not, and counts as a plain failure.
          const status = (err as { code?: unknown } | null)?.code;
          const code = !err ? 0 : typeof status === 'number' ? status : 1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
        child.stdin?.on('error', () => undefined); // a process that died early; the exit code says why
        child.stdin?.end(stdin ?? '');
      });
    },
  };
}

/** True for a value `security -i` can carry and `-w` prints back verbatim. */
export function isStorableSecret(value: string): boolean {
  return value.length > 0 && /^[\x20-\x7e]+$/.test(value);
}

/** One argument for a `security -i` line: always double-quoted, `\` and `"` escaped. */
export function quoteForSecurityShell(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('A Keychain argument cannot contain control characters.');
  return `"${arg.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The stdin line that stores `value` under (service, account), replacing any existing item. */
export function addPasswordLine(service: string, account: string, value: string): string {
  const line = ['add-generic-password', '-U', '-s', quoteForSecurityShell(service), '-a', quoteForSecurityShell(account), '-w', quoteForSecurityShell(value)].join(' ');
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) throw new Error('The secret is too long for the Keychain command line.');
  return `${line}\n`;
}

export class KeychainSecrets implements HostSecrets {
  constructor(
    private runner: SecurityRunner = systemSecurityRunner(),
    private log: (message: string) => void = () => undefined,
    private service: string = KEYCHAIN_SERVICE,
  ) {}

  get available(): boolean {
    return this.runner.available();
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.available) return undefined;
    const r = await this.runner.run(['find-generic-password', '-s', this.service, '-a', key, '-w']);
    if (r.code === EXIT_NOT_FOUND) return undefined;
    if (r.code !== 0) {
      // Locked keychain, a denied access prompt, a timeout. stderr names the
      // item and the error, never the value: there is no value on this path.
      this.log(`cannot read ${key} from the Keychain: exit ${r.code} ${r.stderr.trim()}`);
      return undefined;
    }
    // `-w` prints the password and one newline.
    const value = r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
    return value === '' ? undefined : value;
  }

  async store(key: string, value: string): Promise<void> {
    if (!this.available) throw new Error('The macOS Keychain is not available here, so the secret was not saved.');
    if (!isStorableSecret(value)) throw new Error('Only printable ASCII secrets can be stored in the Keychain.');
    const r = await this.runner.run(['-i'], addPasswordLine(this.service, key, value));
    if (r.code !== 0) {
      // Defence in depth: `security` should never echo the value, but a
      // message from it is going into a log and an error dialog.
      const detail = r.stderr.split(value).join('[redacted]').trim();
      this.log(`cannot store ${key} in the Keychain: exit ${r.code} ${detail}`);
      throw new Error(`The Keychain refused to store the secret (exit ${r.code}).`);
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.available) return;
    const r = await this.runner.run(['delete-generic-password', '-s', this.service, '-a', key]);
    if (r.code !== 0 && r.code !== EXIT_NOT_FOUND) {
      this.log(`cannot delete ${key} from the Keychain: exit ${r.code} ${r.stderr.trim()}`);
      throw new Error(`The Keychain refused to delete the secret (exit ${r.code}).`);
    }
  }
}
