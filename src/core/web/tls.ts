/**
 * Certificates for the LAN listener (#136, plan §8, decision D2).
 *
 * Plain http on a LAN address is not a secure context, so a phone would lose
 * the clipboard and notifications, and the device cookie would cross the
 * network in the clear. The LAN listener is therefore https only, with one of:
 *
 * - **A local CA** (the default). `ca.key`/`ca.pem`: a self-signed root,
 *   ten years, `Agent Wrangler Local CA (<host>)`. Each device trusts it once
 *   (`ca.mobileconfig`, see `mobileconfig.ts`). It signs `server.pem`, whose
 *   SANs are `<LocalHostName>.local`, `localhost` and the Mac's current private
 *   IPv4 addresses, valid 397 days, and re-issued whenever those SANs change
 *   or it is within 30 days of expiry. Re-issuing needs nothing from the
 *   devices: they trust the CA, not the leaf.
 * - **The user's own certificate and key** (`web.lan.certFile`/`keyFile`),
 *   checked to be a pair and used as they are.
 *
 * Keys are made with Node's `crypto` (EC P-256, which iOS and every current
 * browser accept) and written 0600 into `<dataDir>/web-tls/` (0700). Node has
 * no API for *issuing* a certificate, so `/usr/bin/openssl` (LibreSSL on
 * macOS) does that, run with `execFile` and argument arrays, never a shell.
 * The CA key is only ever read by that openssl, in that directory; nothing
 * returns it or serves it.
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export const WEB_TLS_DIR = 'web-tls';
export const CA_VALID_DAYS = 3650;
/** The CA/Browser Forum's ceiling is 398; one under it, so no client rounds it over. */
export const SERVER_VALID_DAYS = 397;
/** Re-issue the server certificate (or the CA) this close to its expiry. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OPENSSL = '/usr/bin/openssl';

const CA_KEY = 'ca.key';
const CA_CERT = 'ca.pem';
const SERVER_KEY = 'server.key';
const SERVER_CERT = 'server.pem';

/** A certificate and key to serve, plus what Preferences says about them. */
export interface TlsMaterial {
  cert: string;
  key: string;
  /** `DNS:…`/`IP Address:…`, as `X509Certificate.subjectAltName` lists them. */
  sans: string[];
  validTo: Date;
  source: 'local-ca' | 'user';
}

export interface LocalCertificatesOptions {
  /** `<dataDir>/web-tls`. Created 0700. */
  dir: string;
  openssl?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/** `Agent Wrangler Local CA (<host>)`, from a LocalHostName. */
export function caCommonName(hostName: string): string {
  return `Agent Wrangler Local CA (${safeHostName(hostName)})`;
}

/**
 * A host name safe to put in a DNS SAN and an openssl config: lower case,
 * letters, digits and hyphens, one label. `scutil --get LocalHostName` gives
 * exactly this; anything else is reduced to it.
 */
export function safeHostName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\.local\.?$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned || 'mac';
}

/** The SANs a server certificate for this Mac should carry, in a stable order. */
export function wantedSans(hostName: string, ips: readonly string[]): string[] {
  const dns = [`${safeHostName(hostName)}.local`, 'localhost'];
  const ipv4 = [...new Set(ips.filter((ip) => net.isIPv4(ip)))].sort();
  return [...dns.map((d) => `DNS:${d}`), ...ipv4.map((ip) => `IP Address:${ip}`)];
}

/** `X509Certificate.subjectAltName` as a list. */
export function sanList(cert: crypto.X509Certificate): string[] {
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a.map((s) => s.toLowerCase()));
  return b.every((s) => set.has(s.toLowerCase()));
}

export class LocalCertificates {
  private readonly openssl: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** One openssl job at a time: a CA download and a re-bind must not both make a CA. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LocalCertificatesOptions) {
    this.openssl = opts.openssl ?? DEFAULT_OPENSSL;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => undefined);
  }

  get dir(): string {
    return this.opts.dir;
  }

  /** The CA certificate (PEM), made first if there is none or it is about to expire. Never the key. */
  caCertificate(hostName: string): Promise<string> {
    return this.serial(async () => (await this.ensureCa(hostName)).pem);
  }

  /** A server certificate for these SANs, re-issued if they changed or it is near expiry. */
  serverCertificate(hostName: string, ips: readonly string[]): Promise<TlsMaterial> {
    return this.serial(async () => {
      const ca = await this.ensureCa(hostName);
      const sans = wantedSans(hostName, ips);
      const current = this.readServer(ca.cert, sans);
      if (current) return current;
      await this.issueServer(hostName, sans);
      // Just issued, so its dates are openssl's (the real clock), not `now`'s.
      const issued = this.readServer(ca.cert, sans, { fresh: true });
      if (!issued) throw new Error('openssl issued a server certificate that does not check out');
      this.log(`web: issued a LAN server certificate for ${sans.length} names, valid until ${issued.validTo.toISOString().slice(0, 10)}`);
      return issued;
    });
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- CA ----

  private async ensureCa(hostName: string): Promise<{ pem: string; cert: crypto.X509Certificate }> {
    const existing = this.readCa();
    if (existing) return existing;
    this.mkdir();
    const key = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    // A new CA invalidates the server certificate it signed.
    this.remove(SERVER_CERT);
    writePrivate(this.file(CA_KEY), key);
    const config = [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      `CN = ${caCommonName(hostName)}`,
      'O = Agent Wrangler',
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE,pathlen:0',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n');
    await this.withTemp('ca', config, async (cnf) => {
      await this.run([
        'req', '-new', '-x509', '-sha256',
        '-key', this.file(CA_KEY),
        '-days', String(CA_VALID_DAYS),
        '-set_serial', serial(),
        '-config', cnf,
        '-extensions', 'v3_ca',
        '-out', this.file(`${CA_CERT}.tmp`),
      ]);
    });
    fs.renameSync(this.file(`${CA_CERT}.tmp`), this.file(CA_CERT));
    const made = this.readCa({ fresh: true });
    if (!made) throw new Error('openssl made a CA certificate that does not check out');
    this.log(`web: made a local CA (${caCommonName(hostName)})`);
    return made;
  }

  /** The CA on disk if it is whole, matches its key, is a CA, and is not about to expire. */
  private readCa(opts: { fresh?: boolean } = {}): { pem: string; cert: crypto.X509Certificate } | undefined {
    try {
      const pem = fs.readFileSync(this.file(CA_CERT), 'utf8');
      const cert = new crypto.X509Certificate(pem);
      const key = crypto.createPrivateKey(fs.readFileSync(this.file(CA_KEY)));
      tightenMode(this.file(CA_KEY));
      if (!cert.ca || !cert.checkPrivateKey(key)) return undefined;
      if (!opts.fresh && new Date(cert.validTo).getTime() - this.now() < RENEW_BEFORE_MS) return undefined;
      return { pem, cert };
    } catch {
      return undefined;
    }
  }

  // ---- server ----

  private async issueServer(hostName: string, sans: string[]): Promise<void> {
    this.mkdir();
    const key = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const keyTmp = this.file(`${SERVER_KEY}.tmp`);
    writePrivate(keyTmp, key);
    const altNames = sans.map((s) => s.replace(/^IP Address:/, 'IP:')).join(',');
    const config = [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      '[dn]',
      `CN = ${safeHostName(hostName)}.local`,
      'O = Agent Wrangler',
      '[v3_server]',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${altNames}`,
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid',
      '',
    ].join('\n');
    const csr = this.file('server.csr.tmp');
    try {
      await this.withTemp('server', config, async (cnf) => {
        await this.run(['req', '-new', '-sha256', '-key', keyTmp, '-config', cnf, '-out', csr]);
        await this.run([
          'x509', '-req', '-sha256',
          '-in', csr,
          '-CA', this.file(CA_CERT),
          '-CAkey', this.file(CA_KEY),
          '-set_serial', serial(),
          '-days', String(SERVER_VALID_DAYS),
          '-extfile', cnf,
          '-extensions', 'v3_server',
          '-out', this.file(`${SERVER_CERT}.tmp`),
        ]);
      });
      fs.renameSync(keyTmp, this.file(SERVER_KEY));
      fs.renameSync(this.file(`${SERVER_CERT}.tmp`), this.file(SERVER_CERT));
    } finally {
      this.remove('server.csr.tmp');
      this.remove(`${SERVER_KEY}.tmp`);
      this.remove(`${SERVER_CERT}.tmp`);
    }
  }

  /** The server certificate on disk, if it is signed by this CA, has exactly these SANs and is not near expiry. */
  private readServer(ca: crypto.X509Certificate, sans: readonly string[], opts: { fresh?: boolean } = {}): TlsMaterial | undefined {
    try {
      const pem = fs.readFileSync(this.file(SERVER_CERT), 'utf8');
      const keyPem = fs.readFileSync(this.file(SERVER_KEY), 'utf8');
      const cert = new crypto.X509Certificate(pem);
      tightenMode(this.file(SERVER_KEY));
      if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) return undefined;
      if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem))) return undefined;
      const validTo = new Date(cert.validTo);
      if (!opts.fresh && validTo.getTime() - this.now() < RENEW_BEFORE_MS) return undefined;
      const have = sanList(cert);
      if (!sameSet(have, sans)) return undefined;
      return { cert: pem, key: keyPem, sans: have, validTo, source: 'local-ca' };
    } catch {
      return undefined;
    }
  }

  // ---- helpers ----

  private file(name: string): string {
    return path.join(this.opts.dir, name);
  }

  private mkdir(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.opts.dir, 0o700);
  }

  private remove(name: string): void {
    fs.rmSync(this.file(name), { force: true });
  }

  /** An openssl config, in the private directory, for the length of `job`. */
  private async withTemp(stem: string, body: string, job: (file: string) => Promise<void>): Promise<void> {
    const file = this.file(`${stem}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.cnf`);
    fs.writeFileSync(file, body, { mode: 0o600 });
    try {
      await job(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      // An empty environment but PATH: no OPENSSL_CONF from the user's shell
      // can change what gets issued.
      execFile(this.openssl, args, { cwd: this.opts.dir, env: { PATH: '/usr/bin:/bin' }, timeout: 30_000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`openssl ${args[0]} failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
        else resolve();
      });
    });
  }
}

/**
 * The user's own certificate and key (`web.lan.certFile`/`keyFile`). Throws,
 * with a sentence for Preferences, if either cannot be read or they are not a pair.
 */
export function loadUserCertificate(certFile: string, keyFile: string): TlsMaterial {
  let pem: string;
  let keyPem: string;
  try {
    pem = fs.readFileSync(certFile, 'utf8');
  } catch (err) {
    throw new Error(`cannot read web.lan.certFile: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  try {
    keyPem = fs.readFileSync(keyFile, 'utf8');
  } catch (err) {
    throw new Error(`cannot read web.lan.keyFile: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  let cert: crypto.X509Certificate;
  try {
    cert = new crypto.X509Certificate(pem);
  } catch {
    throw new Error('web.lan.certFile is not a PEM certificate');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    throw new Error('web.lan.keyFile is not a PEM private key (an encrypted key is not supported)');
  }
  if (!cert.checkPrivateKey(key)) throw new Error('web.lan.certFile and web.lan.keyFile are not a pair');
  return { cert: pem, key: keyPem, sans: sanList(cert), validTo: new Date(cert.validTo), source: 'user' };
}

/** A positive, random 127-bit serial, as openssl's `-set_serial` takes it. */
function serial(): string {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x01;
  return `0x${bytes.toString('hex')}`;
}

function writePrivate(file: string, body: string): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

function tightenMode(file: string): void {
  if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
}
