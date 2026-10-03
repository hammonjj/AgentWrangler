/**
 * Browser devices and their credentials (#127, plan §8).
 *
 * A device is a browser that exchanged a login link. It is given a 256-bit
 * random credential, which it keeps as an `HttpOnly` cookie; this side keeps
 * only the credential's sha256, in `<dataDir>/web-devices.json` (0600). A
 * device is *bound to* a principal, never one itself (`core/access.ts`).
 *
 * Expiry slides: a device unseen for 30 days stops working. `lastSeen` is
 * written at most once an hour per device, so an open tab does not mean a
 * write per request.
 *
 * Revoking (#137) deletes the device; `onDidRevoke` tells the server, which
 * closes that device's open connections at once. One store per process, shared
 * by every `WebServer` it starts, so a revocation reaches whichever is running.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCAL_OWNER } from '../access';
import { Emitter } from '../events';

export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_MS = 60 * 60 * 1000;
export const WEB_DEVICES_FILE = 'web-devices.json';

/**
 * Where a credential works (#136). A loopback credential (from `aw web open`)
 * is never accepted on the LAN listener and a LAN one (pairing, #137) never on
 * loopback: each listener verifies against its own scope only, and they use
 * different cookies as well.
 */
export type DeviceScope = 'loopback' | 'lan';

export interface WebDevice {
  id: string;
  /** A summary of the user agent at login ("Chrome on macOS"). For a device list, not identity. */
  name: string;
  createdAt: number;
  lastSeen: number;
  principal: string;
  /** Where the credential works. A file from before #136 has none, which reads as loopback. */
  scope: DeviceScope;
}

interface StoredDevice extends WebDevice {
  /** sha256 of the credential, hex. The credential itself is never stored. */
  credentialHash: string;
}

interface DevicesFile {
  version: 1;
  devices: StoredDevice[];
}

function hashCredential(credential: string): Buffer {
  return crypto.createHash('sha256').update(credential, 'utf8').digest();
}

export class WebDeviceStore {
  private devices: StoredDevice[];
  private readonly revoked = new Emitter<string>();
  private readonly changed = new Emitter<void>();
  /** A device was revoked: its id. Its connections must close now. */
  readonly onDidRevoke = this.revoked.event;
  /** The list changed: a device was added or revoked, or was seen. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.devices = this.load();
  }

  /** Issue a new device and its credential. The credential is returned once and not kept. */
  issue(name: string, id: string = crypto.randomUUID(), scope: DeviceScope = 'loopback'): { device: WebDevice; credential: string } {
    const credential = crypto.randomBytes(32).toString('base64url');
    const at = this.now();
    const stored: StoredDevice = {
      id,
      name: name.slice(0, 80),
      createdAt: at,
      lastSeen: at,
      principal: LOCAL_OWNER.id,
      scope,
      credentialHash: hashCredential(credential).toString('hex'),
    };
    this.devices = [...this.live(), stored];
    this.save();
    this.changed.fire();
    return { device: publicView(stored), credential };
  }

  /**
   * Forget a device: its credential stops working from this call on, and
   * `onDidRevoke` fires so its open connections are closed. Undefined when
   * there is no such device.
   */
  revoke(id: string): WebDevice | undefined {
    const found = this.devices.find((d) => d.id === id);
    if (!found) return undefined;
    this.devices = this.devices.filter((d) => d !== found);
    this.save();
    this.revoked.fire(id);
    this.changed.fire();
    return publicView(found);
  }

  /** Whether `id` is a current device (it may have been revoked since a check). */
  has(id: string): boolean {
    return this.live().some((d) => d.id === id);
  }

  /**
   * The device a credential belongs to, if it is current and of `scope`, and
   * mark it seen. Every stored hash is compared, in constant time each,
   * whether or not an earlier one matched. A credential of the other scope is
   * no credential here.
   */
  verify(credential: string | undefined, scope: DeviceScope): WebDevice | undefined {
    if (typeof credential !== 'string' || credential.length === 0 || credential.length > 128) return undefined;
    const given = hashCredential(credential);
    const at = this.now();
    let match: StoredDevice | undefined;
    for (const d of this.devices) {
      const stored = Buffer.from(d.credentialHash, 'hex');
      if (stored.length === given.length && crypto.timingSafeEqual(stored, given) && !match) match = d;
    }
    if (!match || match.scope !== scope || at - match.lastSeen > DEVICE_TTL_MS) return undefined;
    if (at - match.lastSeen > LAST_SEEN_WRITE_MS) {
      match.lastSeen = at;
      this.devices = this.live();
      this.save();
      this.changed.fire();
    }
    return publicView(match);
  }

  list(): WebDevice[] {
    return this.live().map(publicView);
  }

  private live(): StoredDevice[] {
    const at = this.now();
    return this.devices.filter((d) => at - d.lastSeen <= DEVICE_TTL_MS);
  }

  private load(): StoredDevice[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DevicesFile>;
      if (!Array.isArray(raw.devices)) return [];
      return raw.devices
        .filter(
          (d): d is StoredDevice =>
            !!d && typeof d.id === 'string' && typeof d.credentialHash === 'string' && /^[0-9a-f]{64}$/.test(d.credentialHash) && typeof d.lastSeen === 'number',
        )
        // Anything but an explicit 'lan' is loopback, the narrower of the two.
        .map((d): StoredDevice => ({ ...d, scope: d.scope === 'lan' ? 'lan' : 'loopback' }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`web: could not read ${path.basename(this.file)}; starting with no devices`);
      return [];
    }
  }

  private save(): void {
    const body: DevicesFile = { version: 1, devices: this.devices };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      this.log(`web: could not save ${path.basename(this.file)}: ${String(err)}`);
    }
  }
}

function publicView(d: StoredDevice): WebDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, principal: d.principal, scope: d.scope };
}

/** The longest device name kept. */
export const MAX_DEVICE_NAME = 60;

/**
 * The name a device is paired under (#137): what was typed, one line, no
 * control characters, at most `MAX_DEVICE_NAME`; or `fallback` when that
 * leaves nothing.
 */
export function cleanDeviceName(input: string | null | undefined, fallback: string): string {
  const name = typeof input === 'string' ? input.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DEVICE_NAME).trim() : '';
  return name || fallback;
}

/** "Chrome on macOS", from a user agent, for a device list. Never stored as more than this. */
export function summarizeUserAgent(ua: string | undefined): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : undefined;
  return os ? `${browser} on ${os}` : browser;
}
