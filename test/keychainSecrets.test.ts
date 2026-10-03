import { describe, expect, it } from 'vitest';
import {
  KEYCHAIN_SERVICE,
  KeychainSecrets,
  addPasswordLine,
  isStorableSecret,
  quoteForSecurityShell,
  type SecurityResult,
  type SecurityRunner,
} from '../src/core/keychainSecrets';

/**
 * `security -i`'s line tokenizer as observed on macOS (see keychainSecrets.ts):
 * whitespace separates, `"…"`/`'…'` group, and `\x` is `x` both inside double
 * quotes and outside quotes. Lets the fake check that what we quote comes out
 * as the value we meant.
 */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inToken = true;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** An in-memory Keychain behind a fake `security`. Records every argv it was given. */
class FakeSecurity implements SecurityRunner {
  items = new Map<string, string>();
  argvs: string[][] = [];
  stdins: string[] = [];
  usable = true;
  /** Keys whose add fails, with the value echoed into stderr to test redaction. */
  failAdd = new Set<string>();
  /** Keys whose read returns something else, to test verification. */
  corruptRead = new Set<string>();
  adds = 0;

  available(): boolean {
    return this.usable;
  }

  async run(args: string[], stdin?: string): Promise<SecurityResult> {
    this.argvs.push([...args]);
    if (args[0] === '-i') {
      this.stdins.push(stdin ?? '');
      let last: SecurityResult = { code: 0, stdout: '', stderr: '' };
      for (const line of (stdin ?? '').split('\n').filter((l) => l !== '')) last = this.exec(tokenize(line));
      return last;
    }
    return this.exec(args);
  }

  private exec(args: string[]): SecurityResult {
    const id = `${flag(args, '-s')}\u0000${flag(args, '-a')}`;
    const account = flag(args, '-a') ?? '';
    switch (args[0]) {
      case 'add-generic-password': {
        const value = flag(args, '-w') ?? '';
        if (this.failAdd.has(account)) return { code: 45, stdout: '', stderr: `security: SecKeychainItemCreateFromContent: failed for ${value}` };
        if (this.items.has(id) && !args.includes('-U')) return { code: 45, stdout: '', stderr: 'duplicate' };
        this.adds++;
        this.items.set(id, value);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'find-generic-password': {
        const v = this.items.get(id);
        if (v === undefined) return { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' };
        return { code: 0, stdout: `${this.corruptRead.has(account) ? 'x' : ''}${v}\n`, stderr: '' };
      }
      case 'delete-generic-password':
        return this.items.delete(id) ? { code: 0, stdout: 'keychain: …', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
      default:
        return { code: 2, stdout: '', stderr: `unknown command "${args[0]}"` };
    }
  }

  value(key: string): string | undefined {
    return this.items.get(`${KEYCHAIN_SERVICE}\u0000${key}`);
  }
}

const TRICKY = [
  'plain-token.abc123',
  'has "double" quotes',
  "has 'single' quotes",
  'back\\slash and \\" both',
  'trailing backslash\\',
  '-starts-with-a-dash',
  '$HOME `cmd` ; # | & * ?',
  '  spaces  around  ',
];

describe('quoteForSecurityShell', () => {
  it('double-quotes and escapes backslashes and double quotes', () => {
    expect(quoteForSecurityShell('abc')).toBe('"abc"');
    expect(quoteForSecurityShell('a"b')).toBe('"a\\"b"');
    expect(quoteForSecurityShell('a\\b')).toBe('"a\\\\b"');
    expect(quoteForSecurityShell("it's")).toBe('"it\'s"');
  });

  it('round-trips through the tokenizer for awkward values', () => {
    for (const v of TRICKY) expect(tokenize(`cmd ${quoteForSecurityShell(v)} next`)).toEqual(['cmd', v, 'next']);
  });

  it('refuses control characters, which a line cannot carry', () => {
    expect(() => quoteForSecurityShell('a\nb')).toThrow();
    expect(() => quoteForSecurityShell('a\rb')).toThrow();
    expect(() => quoteForSecurityShell('a\u0000b')).toThrow();
  });

  it('refuses a line too long for security -i rather than letting it be split', () => {
    expect(() => addPasswordLine(KEYCHAIN_SERVICE, 'k', 'x'.repeat(5000))).toThrow(/too long/);
    expect(addPasswordLine(KEYCHAIN_SERVICE, 'k', 'x'.repeat(3000))).toMatch(/\n$/);
  });
});

describe('isStorableSecret', () => {
  it('accepts printable ASCII only', () => {
    expect(isStorableSecret('MTk4Nj.abc-_DEF')).toBe(true);
    expect(isStorableSecret('')).toBe(false);
    expect(isStorableSecret('café')).toBe(false);
    expect(isStorableSecret('tab\there')).toBe(false);
  });
});

describe('KeychainSecrets', () => {
  it('stores and reads back awkward values without the value ever in argv', async () => {
    const fake = new FakeSecurity();
    const secrets = new KeychainSecrets(fake);
    for (const [i, v] of TRICKY.entries()) {
      await secrets.store(`key.${i}`, v);
      expect(await secrets.get(`key.${i}`)).toBe(v);
      expect(fake.value(`key.${i}`)).toBe(v);
    }
    for (const argv of fake.argvs) for (const v of TRICKY) expect(argv.some((a) => a.includes(v))).toBe(false);
    // Writes are one `security -i` each, with the command on stdin.
    expect(fake.argvs.filter((a) => a[0] === '-i')).toHaveLength(TRICKY.length);
    expect(fake.argvs.filter((a) => a[0] === '-i').every((a) => a.length === 1)).toBe(true);
  });

  it('uses the service name and the key as the account, replacing an existing item', async () => {
    const fake = new FakeSecurity();
    const secrets = new KeychainSecrets(fake);
    await secrets.store('remote.discord.botToken', 'one');
    await secrets.store('remote.discord.botToken', 'two');
    expect(fake.value('remote.discord.botToken')).toBe('two');
    expect(tokenize(fake.stdins[0]).slice(0, 6)).toEqual(['add-generic-password', '-U', '-s', 'Agent Wrangler', '-a', 'remote.discord.botToken']);
    expect(fake.argvs.at(-1)).toEqual(['-i']);
    await secrets.get('remote.discord.botToken');
    expect(fake.argvs.at(-1)).toEqual(['find-generic-password', '-s', 'Agent Wrangler', '-a', 'remote.discord.botToken', '-w']);
  });

  it('returns undefined for a missing key and deletes idempotently', async () => {
    const fake = new FakeSecurity();
    const secrets = new KeychainSecrets(fake);
    expect(await secrets.get('nope')).toBeUndefined();
    await secrets.store('k', 'v');
    await secrets.delete('k');
    await secrets.delete('k');
    expect(await secrets.get('k')).toBeUndefined();
  });

  it('refuses values it cannot round-trip', async () => {
    const secrets = new KeychainSecrets(new FakeSecurity());
    await expect(secrets.store('k', 'café')).rejects.toThrow(/printable ASCII/);
    await expect(secrets.store('k', 'two\nlines')).rejects.toThrow();
    await expect(secrets.store('k', '')).rejects.toThrow();
  });

  it('keeps the value out of the error and the log when a write fails', async () => {
    const fake = new FakeSecurity();
    fake.failAdd.add('k');
    const logs: string[] = [];
    const secrets = new KeychainSecrets(fake, (m) => logs.push(m));
    const err = await secrets.store('k', 'SECRET-VALUE').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('SECRET-VALUE');
    expect(logs.join('\n')).not.toContain('SECRET-VALUE');
    expect(logs.join('\n')).toContain('[redacted]');
  });

  it('is unavailable when security is, and then refuses to store', async () => {
    const fake = new FakeSecurity();
    fake.usable = false;
    const secrets = new KeychainSecrets(fake);
    expect(secrets.available).toBe(false);
    await expect(secrets.store('k', 'v')).rejects.toThrow(/not available/);
    expect(await secrets.get('k')).toBeUndefined();
    expect(fake.argvs).toHaveLength(0);
  });
});
