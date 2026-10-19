/**
 * LAN access (#136): certificates, the CA profile, the LAN listener's Host
 * allowlist and credential scope, and the https listener itself. Every
 * listener here binds 127.0.0.1 with LAN-style names; nothing listens on a
 * real network interface.
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGate } from '../src/core/access';
import { LanAccess, describe as describeLan, isPrivateIPv4, privateIPv4s, type LanSettings } from '../src/core/web/lan';
import { caMobileconfig } from '../src/core/web/mobileconfig';
import { DEVICE_COOKIE, LAN_DEVICE_COOKIE, WebServer, isLanHost, type LanConfig } from '../src/core/web/server';
import { CA_VALID_DAYS, LocalCertificates, SERVER_VALID_DAYS, caCommonName, loadUserCertificate, safeHostName, wantedSans, type TlsMaterial } from '../src/core/web/tls';
import { SETTINGS } from '../src/shared/settings';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';

const HAS_OPENSSL = fs.existsSync('/usr/bin/openssl');
const DAY = 24 * 60 * 60 * 1000;
const HOST = 'test-mac';
const LAN_NAME = `${HOST}.local`;

let tmp: string;
let certs: LocalCertificates;
let caPem: string;
let material: TlsMaterial;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-lan-'));
  if (!HAS_OPENSSL) return;
  certs = new LocalCertificates({ dir: path.join(tmp, 'web-tls') });
  caPem = await certs.caCertificate(HOST);
  material = await certs.serverCertificate(HOST, ['192.168.1.20']);
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!HAS_OPENSSL)('LAN certificates (openssl)', () => {
  it('makes a ten-year CA named for the Mac, its key 0600 in a 0700 directory', () => {
    const ca = new crypto.X509Certificate(caPem);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain(`CN=${caCommonName(HOST)}`);
    expect(caCommonName(HOST)).toBe('Agent Wrangler Local CA (test-mac)');
    expect(ca.checkIssued(ca)).toBe(true);
    const days = (new Date(ca.validTo).getTime() - new Date(ca.validFrom).getTime()) / DAY;
    expect(Math.round(days)).toBe(CA_VALID_DAYS);
    const dir = certs.dir;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'ca.key')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'server.key')).mode & 0o777).toBe(0o600);
    // Nothing returned carries a key, and no temporary file is left behind.
    expect(caPem).not.toContain('PRIVATE KEY');
    expect(material.cert).not.toContain('PRIVATE KEY');
    expect(fs.readdirSync(dir).sort()).toEqual(['ca.key', 'ca.pem', 'server.key', 'server.pem']);
  });

  it('issues a server certificate for <host>.local, localhost and the LAN addresses, signed by the CA, at most 397 days', () => {
    const cert = new crypto.X509Certificate(material.cert);
    const ca = new crypto.X509Certificate(caPem);
    expect(cert.subjectAltName?.split(', ').sort()).toEqual(['DNS:localhost', `DNS:${LAN_NAME}`, 'IP Address:192.168.1.20'].sort());
    expect(material.sans).toEqual(wantedSans(HOST, ['192.168.1.20']));
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.checkHost(LAN_NAME)).toBe(LAN_NAME);
    expect(cert.checkIP('192.168.1.20')).toBe('192.168.1.20');
    expect(cert.checkHost('evil.example')).toBeUndefined();
    // Node's `keyUsage` is the extended key usage list: serverAuth.
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    const days = (new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()) / DAY;
    expect(Math.round(days)).toBe(SERVER_VALID_DAYS);
    expect(cert.checkPrivateKey(crypto.createPrivateKey(material.key))).toBe(true);
  });

  it('keeps the certificate while the SANs stay, and re-issues (same CA) when an address changes', async () => {
    const same = await certs.serverCertificate(HOST, ['192.168.1.20']);
    expect(same.cert).toBe(material.cert);
    const moved = await certs.serverCertificate(HOST, ['192.168.1.20', '10.0.0.7']);
    expect(moved.cert).not.toBe(material.cert);
    expect(moved.key).not.toBe(material.key);
    expect(new crypto.X509Certificate(moved.cert).subjectAltName).toContain('IP Address:10.0.0.7');
    expect(await certs.caCertificate(HOST)).toBe(caPem);
    // Back again for the rest of the file.
    material = await certs.serverCertificate(HOST, ['192.168.1.20']);
    expect(new crypto.X509Certificate(material.cert).subjectAltName).not.toContain('10.0.0.7');
  }, 30_000);

  it('re-issues within 30 days of expiry', async () => {
    const validTo = new Date(new crypto.X509Certificate(material.cert).validTo).getTime();
    const later = new LocalCertificates({ dir: certs.dir, now: () => validTo - 10 * DAY });
    const renewed = await later.serverCertificate(HOST, ['192.168.1.20']);
    expect(renewed.cert).not.toBe(material.cert);
    // The CA has ten years left, so it stays.
    expect(await later.caCertificate(HOST)).toBe(caPem);
    material = renewed;
  }, 30_000);

  it('loads a user-supplied certificate and key, and refuses a mismatched pair', () => {
    const dir = certs.dir;
    const own = loadUserCertificate(path.join(dir, 'server.pem'), path.join(dir, 'server.key'));
    expect(own.source).toBe('user');
    expect(own.sans).toContain(`DNS:${LAN_NAME}`);
    expect(() => loadUserCertificate(path.join(dir, 'server.pem'), path.join(dir, 'ca.key'))).toThrow(/not a pair/);
    expect(() => loadUserCertificate(path.join(dir, 'missing.pem'), path.join(dir, 'server.key'))).toThrow(/certFile/);
  });
});

describe.skipIf(!HAS_OPENSSL)('the CA as a configuration profile', () => {
  it('is a Configuration profile with one com.apple.security.root payload holding the CA (DER)', () => {
    const profile = caMobileconfig(caPem);
    const der = new crypto.X509Certificate(caPem).raw.toString('base64');
    expect(profile.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(profile).toContain('<!DOCTYPE plist');
    expect(profile.match(/<string>com\.apple\.security\.root<\/string>/g)).toHaveLength(1);
    expect(profile).toContain('<string>Configuration</string>');
    const data = /<data>([\s\S]*?)<\/data>/.exec(profile)?.[1].replace(/\s+/g, '');
    expect(data).toBe(der);
    expect(profile).not.toContain('PRIVATE KEY');
    const uuids = [...profile.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(uuids).toHaveLength(2);
    for (const u of uuids) expect(u).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(new Set(uuids).size).toBe(2);
    // Stable: downloading twice gives the same profile, which iOS replaces rather than duplicates.
    expect(caMobileconfig(caPem)).toBe(profile);
  });

  it.skipIf(!fs.existsSync('/usr/bin/plutil'))('parses as a property list with the fields iOS needs', () => {
    const file = path.join(tmp, 'ca.mobileconfig');
    fs.writeFileSync(file, caMobileconfig(caPem));
    expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
    const get = (keyPath: string) => execFileSync('/usr/bin/plutil', ['-extract', keyPath, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();
    expect(get('PayloadType')).toBe('Configuration');
    expect(get('PayloadVersion')).toBe('1');
    expect(get('PayloadDisplayName')).toBe(caCommonName(HOST));
    expect(get('PayloadRemovalDisallowed')).toBe('false');
    expect(get('PayloadContent')).toBe('1');
    expect(get('PayloadContent.0.PayloadType')).toBe('com.apple.security.root');
    expect(get('PayloadContent.0.PayloadVersion')).toBe('1');
    // `raw` prints data as base64.
    expect(get('PayloadContent.0.PayloadContent')).toBe(new crypto.X509Certificate(caPem).raw.toString('base64'));
    expect(get('PayloadContent.0.PayloadIdentifier').startsWith(get('PayloadIdentifier'))).toBe(true);
  });
});

describe('LAN addresses and names', () => {
  it('private IPv4 means RFC 1918 only', () => {
    for (const a of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20']) expect(isPrivateIPv4(a), a).toBe(true);
    for (const a of ['127.0.0.1', '169.254.1.1', '100.64.0.1', '172.32.0.1', '172.15.0.1', '8.8.8.8', '192.169.0.1', '::1', 'fe80::1', '999.168.1.1', '']) {
      expect(isPrivateIPv4(a), a).toBe(false);
    }
  });

  it('reads the private IPv4s from the interfaces: no loopback, IPv6, link-local, tunnel or public address', () => {
    const info = (address: string, family: 'IPv4' | 'IPv6', internal = false): os.NetworkInterfaceInfo =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
    expect(
      privateIPv4s({
        lo0: [info('127.0.0.1', 'IPv4', true), info('::1', 'IPv6', true)],
        en0: [info('192.168.1.20', 'IPv4'), info('fe80::1', 'IPv6')],
        en1: [info('10.0.0.5', 'IPv4'), info('169.254.3.4', 'IPv4')],
        utun3: [info('100.101.102.103', 'IPv4')],
        en5: [info('203.0.113.9', 'IPv4'), info('192.168.1.20', 'IPv4')],
      }),
    ).toEqual(['10.0.0.5', '192.168.1.20']);
  });

  it('the Host allowlist is a bound name with the listener port, exactly', () => {
    const names = [LAN_NAME, '192.168.1.20'];
    expect(isLanHost(`${LAN_NAME}:7392`, 7392, names)).toBe(true);
    expect(isLanHost(`TEST-MAC.LOCAL:7392`, 7392, names)).toBe(true);
    expect(isLanHost('192.168.1.20:7392', 7392, names)).toBe(true);
    expect(isLanHost(LAN_NAME, 7392, names)).toBe(false);
    expect(isLanHost(`${LAN_NAME}:7391`, 7392, names)).toBe(false);
    expect(isLanHost('127.0.0.1:7392', 7392, names)).toBe(false);
    expect(isLanHost('localhost:7392', 7392, names)).toBe(false);
    expect(isLanHost(`evil.${LAN_NAME}:7392`, 7392, names)).toBe(false);
    expect(isLanHost(undefined, 7392, names)).toBe(false);
  });

  it('host names are reduced to one DNS label', () => {
    expect(safeHostName('Test-Mac')).toBe('test-mac');
    expect(safeHostName('test-mac.local')).toBe('test-mac');
    expect(safeHostName("James's MacBook Pro")).toBe('james-s-macbook-pro');
    expect(safeHostName('\n=')).toBe('mac');
    expect(wantedSans('Test-Mac', ['192.168.1.20', '10.0.0.5', '192.168.1.20', 'nope'])).toEqual([
      'DNS:test-mac.local',
      'DNS:localhost',
      'IP Address:10.0.0.5',
      'IP Address:192.168.1.20',
    ]);
  });
});

describe('LAN access: off by default, and re-binding', () => {
  const tls: TlsMaterial = { cert: 'CERT', key: 'KEY', sans: [], validTo: new Date(Date.UTC(2027, 0, 1)), source: 'local-ca' };
  let calls: (LanConfig | undefined)[];
  let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  let settings: LanSettings;
  let issued: string[][];
  let lan: LanAccess;
  const v4 = (address: string) => ({ address, family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;

  beforeEach(() => {
    calls = [];
    issued = [];
    ifaces = { en0: [v4('192.168.1.20')] };
    settings = { enabled: false, port: 7392, certFile: '', keyFile: '' };
    lan = new LanAccess({
      server: {
        setLan: async (config) => {
          calls.push(config);
          return (config?.addresses ?? []).map((address) => ({ address, port: config!.port }));
        },
      },
      certs: {
        serverCertificate: async (_host, ips) => {
          issued.push([...ips]);
          return tls;
        },
      },
      settings: () => settings,
      log: () => undefined,
      interfaces: () => ifaces,
      hostName: async () => HOST,
      pollMs: 60_000,
    });
  });

  afterEach(() => lan.dispose());

  it('the setting ships off, and off binds nothing', async () => {
    const spec = SETTINGS.find((s) => s.key === 'web.lan.enabled');
    expect(spec).toMatchObject({ type: 'boolean', default: false });
    expect(SETTINGS.find((s) => s.key === 'web.lan.port')?.default).toBe(7392);
    await lan.refresh();
    expect(calls).toEqual([undefined]);
    expect(issued).toEqual([]);
    expect(lan.status.state).toBe('off');
  });

  it('on: binds each private address with the .local name and the addresses as allowed names', async () => {
    settings.enabled = true;
    ifaces = { en0: [v4('192.168.1.20')], en1: [v4('10.0.0.5')], utun0: [v4('203.0.113.9')] };
    await lan.refresh();
    expect(calls).toEqual([{ addresses: ['10.0.0.5', '192.168.1.20'], names: [LAN_NAME, '10.0.0.5', '192.168.1.20'], port: 7392, cert: 'CERT', key: 'KEY' }]);
    expect(lan.status).toMatchObject({ state: 'on' });
    expect(lan.status.lines).toContain(`Listening on https://${LAN_NAME}:7392/`);
    expect(lan.status.lines).toContain('✓ https://192.168.1.20:7392/');
    // Nothing changed: no re-bind.
    await lan.refresh();
    expect(calls).toHaveLength(1);
    // An address changed: re-bind, with a certificate for the new set.
    ifaces = { en0: [v4('192.168.1.31')] };
    await lan.refresh();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.addresses).toEqual(['192.168.1.31']);
    expect(issued.at(-1)).toEqual(['192.168.1.31']);
    // Switched off: everything closes.
    settings.enabled = false;
    await lan.refresh();
    expect(calls.at(-1)).toBeUndefined();
  });

  it('no private address: nothing bound, and it says why', async () => {
    settings.enabled = true;
    ifaces = { lo0: [{ ...v4('127.0.0.1'), internal: true }] };
    await lan.refresh();
    expect(calls).toEqual([undefined]);
    expect(lan.status.state).toBe('error');
  });

  it('a user certificate that cannot be read closes the listener rather than falling back', async () => {
    settings = { enabled: true, port: 7392, certFile: path.join(tmp, 'nope.pem'), keyFile: path.join(tmp, 'nope.key') };
    await lan.refresh();
    expect(calls).toEqual([undefined]);
    expect(issued).toEqual([]);
    expect(lan.status.lines[0]).toMatch(/certFile/);
  });

  it('describes a failed address', () => {
    const s = describeLan([{ address: '192.168.1.20', error: 'EADDRINUSE' }], LAN_NAME, tls);
    expect(s.state).toBe('error');
    expect(s.lines[0]).toBe('✗ 192.168.1.20: not listening (port in use)');
  });
});

// ---- the https listener ----

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe.skipIf(!HAS_OPENSSL)('the LAN listener (https on 127.0.0.1, LAN-style names)', () => {
  let dir: string;
  let server: WebServer;
  let loopPort: number;
  let lanPort: number;
  let upgrades: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-lanweb-'));
    const webviewDir = path.join(dir, 'dist', 'webview');
    fs.mkdirSync(webviewDir, { recursive: true });
    for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
    upgrades = [];
    server = new WebServer({
      port: 0,
      webviewDir,
      dataDir: path.join(dir, 'data'),
      gate: createAccessGate(),
      log: () => undefined,
      page: renderBrowserWorkbenchHtml,
      onClient: (socket, context) => {
        upgrades.push(context.deviceId ?? '');
        socket.close();
      },
      caCertificate: async () => caPem,
    });
    loopPort = await server.listen();
    const status = await server.setLan({ addresses: ['127.0.0.1'], names: [LAN_NAME, '192.168.1.20'], port: 0, cert: material.cert, key: material.key });
    expect(status).toHaveLength(1);
    expect(status[0].error).toBeUndefined();
    lanPort = status[0].port!;
  });

  afterEach(() => {
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function lan(pathname: string, opts: { method?: string; headers?: Record<string, string>; ca?: string | null } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: lanPort,
          servername: LAN_NAME,
          path: pathname,
          method: opts.method ?? 'GET',
          headers: { host: `${LAN_NAME}:${lanPort}`, ...opts.headers },
          agent: false,
          ...(opts.ca === null ? {} : { ca: opts.ca ?? caPem }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function loop(pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: loopPort, path: pathname, headers: { host: `127.0.0.1:${loopPort}`, ...headers }, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function lanUpgrade(headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = https.request({
        host: '127.0.0.1',
        port: lanPort,
        servername: LAN_NAME,
        ca: caPem,
        path: '/ws',
        agent: false,
        headers: {
          host: `${LAN_NAME}:${lanPort}`,
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-version': '13',
          'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
          ...headers,
        },
      });
      socket.on('upgrade', (res) => {
        resolve(`${res.statusCode}`);
        res.socket.destroy();
      });
      socket.on('response', (res) => {
        resolve(`${res.statusCode}`);
        res.resume();
      });
      socket.on('error', reject);
      socket.end();
    });
  }

  async function loopbackCredential(): Promise<string> {
    const code = new URL(server.loginLink().url).searchParams.get('code');
    const r = await loop(`/login?code=${code}`);
    expect(r.status).toBe(303);
    return String(r.headers['set-cookie']?.[0]).split(';')[0].split('=')[1];
  }

  async function lanCredential(): Promise<{ value: string; setCookie: string }> {
    const link = server.loginLink('lan');
    expect(link.url).toMatch(new RegExp(`^https://${LAN_NAME.replace('.', '\\.')}:${lanPort}/login\\?code=`));
    const r = await lan(`/login?code=${new URL(link.url).searchParams.get('code')}`);
    expect(r.status).toBe(303);
    const setCookie = String(r.headers['set-cookie']?.[0]);
    return { value: setCookie.split(';')[0].split('=')[1], setCookie };
  }

  it('answers over https to a client that trusts the generated CA, and not to one that does not', async () => {
    const r = await lan('/');
    expect(r.status).toBe(401);
    expect(r.body).toContain('paired');
    await expect(lan('/', { ca: null })).rejects.toThrow(/self[- ]signed|unable to (get|verify)|certificate/i);
    // The loopback listener is still plain http.
    expect((await loop('/')).status).toBe(401);
  });

  it('the Host allowlist: the .local name and the LAN addresses with this port, nothing else', async () => {
    expect((await lan('/', { headers: { host: `${LAN_NAME}:${lanPort}` } })).status).toBe(401);
    expect((await lan('/', { headers: { host: `192.168.1.20:${lanPort}` } })).status).toBe(401);
    for (const host of [`evil.example:${lanPort}`, `${LAN_NAME}:${loopPort}`, `localhost:${lanPort}`, `127.0.0.1:${lanPort}`, LAN_NAME]) {
      expect((await lan('/', { headers: { host } })).status, host).toBe(421);
    }
    // And the LAN names are no good on loopback.
    expect((await loop('/', { host: `${LAN_NAME}:${loopPort}` })).status).toBe(421);
  });

  it('Origin on the LAN is https://<host>', async () => {
    expect((await lan('/', { method: 'POST', headers: { origin: `http://${LAN_NAME}:${lanPort}` } })).status).toBe(403);
    expect((await lan('/', { method: 'POST', headers: { origin: `https://${LAN_NAME}:${lanPort}` } })).status).toBe(405);
  });

  it('a loopback credential is not accepted on the LAN, under either cookie name, nor for an upgrade', async () => {
    const cred = await loopbackCredential();
    expect((await loop('/', { cookie: `${DEVICE_COOKIE}=${cred}` })).status).toBe(200);
    expect((await lan('/', { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } })).status).toBe(401);
    expect((await lan('/', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${cred}` } })).status).toBe(401);
    expect(await lanUpgrade({ origin: `https://${LAN_NAME}:${lanPort}`, cookie: `${LAN_DEVICE_COOKIE}=${cred}` })).toBe('401');
    expect(upgrades).toHaveLength(0);
  });

  it('a loopback login code does not sign in on the LAN', async () => {
    const code = new URL(server.loginLink().url).searchParams.get('code');
    const r = await lan(`/login?code=${code}`);
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('a LAN credential (the path pairing will use) gets a Secure __Host- cookie, the page and the socket on the LAN only', async () => {
    const { value, setCookie } = await lanCredential();
    expect(setCookie).toMatch(new RegExp(`^${LAN_DEVICE_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/; Max-Age=\\d+; Secure$`));
    const page = await lan('/', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${value}` } });
    expect(page.status).toBe(200);
    expect(String(page.headers['content-security-policy'])).toContain(`connect-src 'self' wss://${LAN_NAME}:${lanPort}`);
    expect(String(page.headers['set-cookie']?.[0])).toContain('; Secure');
    expect(await lanUpgrade({ origin: `https://${LAN_NAME}:${lanPort}`, cookie: `${LAN_DEVICE_COOKIE}=${value}` })).toBe('101');
    expect(upgrades).toHaveLength(1);
    // Not a credential on loopback.
    expect((await loop('/', { cookie: `${DEVICE_COOKIE}=${value}` })).status).toBe(401);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'web-devices.json'), 'utf8')).devices;
    expect(stored.map((d: { scope: string }) => d.scope)).toEqual(['lan']);
  });

  it('serves the CA (PEM and profile) on loopback to a signed-in browser only, never on the LAN', async () => {
    expect((await loop('/ca.mobileconfig')).status).toBe(401);
    const cookie = `${DEVICE_COOKIE}=${await loopbackCredential()}`;
    const pem = await loop('/ca.pem', { cookie });
    expect(pem.status).toBe(200);
    expect(pem.body).toBe(caPem);
    expect(pem.headers['content-disposition']).toContain('attachment');
    const profile = await loop('/ca.mobileconfig', { cookie });
    expect(profile.status).toBe(200);
    expect(profile.headers['content-type']).toBe('application/x-apple-aspen-config');
    expect(profile.body).toBe(caMobileconfig(caPem));
    const { value } = await lanCredential();
    expect((await lan('/ca.mobileconfig', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${value}` } })).status).toBe(404);
    expect((await lan('/ca.pem', { headers: { cookie: `${LAN_DEVICE_COOKIE}=${value}` } })).status).toBe(404);
  });

  it('switching LAN access off closes the listener and its sockets', async () => {
    await server.setLan(undefined);
    expect(server.lanStatus()).toEqual([]);
    await expect(lan('/')).rejects.toThrow(/ECONNREFUSED|ECONNRESET|socket hang up/);
    expect(() => server.loginLink('lan')).toThrow();
    // Loopback carries on.
    expect((await loop('/')).status).toBe(401);
  });

  it('a new certificate is swapped in without re-binding', async () => {
    const before = server.lanStatus();
    const other = await new LocalCertificates({ dir: certs.dir }).serverCertificate(HOST, ['192.168.1.20', '10.9.9.9']);
    const after = await server.setLan({ addresses: ['127.0.0.1'], names: [LAN_NAME], port: 0, cert: other.cert, key: other.key });
    expect(after).toEqual(before);
    const peer = await new Promise<crypto.X509Certificate>((resolve, reject) => {
      const s = (https.request({ host: '127.0.0.1', port: lanPort, servername: LAN_NAME, ca: caPem, agent: false, headers: { host: `${LAN_NAME}:${lanPort}` } }) as http.ClientRequest)
        .on('socket', (sock) => {
          sock.on('secureConnect', () => {
            const raw = (sock as import('node:tls').TLSSocket).getPeerX509Certificate();
            if (raw) resolve(raw);
            sock.destroy();
          });
        })
        .on('error', () => undefined);
      s.end();
      setTimeout(() => reject(new Error('no handshake')), 5000).unref();
    });
    expect(peer.subjectAltName).toContain('10.9.9.9');
  }, 30_000);
});
