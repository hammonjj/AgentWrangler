/**
 * LAN access to the browser workbench (#136, plan §8): which addresses to
 * listen on, with which certificate, kept current as the network changes.
 * The binding itself is `WebServer.setLan`; this decides what to ask it for.
 *
 * **Off by default** (`web.lan.enabled`). Off, nothing listens on anything but
 * 127.0.0.1.
 *
 * **One listener per private IPv4 address, not 0.0.0.0.** A wildcard bind
 * would also answer on every other interface the Mac has or later gains: a
 * VPN tunnel, a public address on a hotel or office network, a Thunderbolt
 * bridge, and loopback itself, which would put the LAN scope on 127.0.0.1
 * next to the loopback listener. Binding the RFC 1918 addresses only (10/8,
 * 172.16/12, 192.168/16) keeps the listener on the home network the user
 * opted into, at the cost of re-binding when an address changes, which the
 * poll below does anyway.
 *
 * **Re-binding.** `os.networkInterfaces()` is read every 30 s and on wake
 * (`refresh`). A changed address set gets a new server certificate (its SANs
 * name the addresses) and listeners for the new addresses; addresses that went
 * away are closed. The same read re-issues a certificate near expiry.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import type { Disposable } from '../events';
import type { LanListenerStatus, WebServer } from './server';
import { loadUserCertificate, safeHostName, type LocalCertificates, type TlsMaterial } from './tls';

export const LAN_DEFAULT_PORT = 7392;
export const LAN_POLL_MS = 30_000;

export interface LanSettings {
  enabled: boolean;
  port: number;
  certFile: string;
  keyFile: string;
}

/** What Preferences shows under the switch. */
export interface LanStatus {
  state: 'off' | 'on' | 'error';
  lines: string[];
}

/** RFC 1918 only: not loopback, link-local (169.254/16), CGNAT (100.64/10) or public. */
export function isPrivateIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((p) => Number(p) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The Mac's private IPv4 addresses, sorted, without duplicates. */
export function privateIPv4s(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address)) out.add(info.address);
    }
  }
  return [...out].sort();
}

/**
 * The Bonjour name (`scutil --get LocalHostName`), which is what
 * `<name>.local` resolves to on the network. Falls back to the host name.
 */
export function localHostName(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 5000 }, (err, stdout) => {
      const name = !err ? stdout.trim() : '';
      resolve(safeHostName(name || os.hostname()));
    });
  });
}

export interface LanAccessOptions {
  server: Pick<WebServer, 'setLan'>;
  certs: Pick<LocalCertificates, 'serverCertificate'>;
  settings: () => LanSettings;
  log: (line: string) => void;
  /** Told whenever the status changes, for Preferences. */
  onStatus?: (status: LanStatus) => void;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostName?: () => Promise<string>;
  pollMs?: number;
}

export class LanAccess implements Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private current: LanStatus = { state: 'off', lines: [OFF_LINE] };
  private lastKey = '';
  private allBound = false;
  private disposed = false;

  constructor(private readonly opts: LanAccessOptions) {}

  get status(): LanStatus {
    return this.current;
  }

  /** Re-read the settings and the network, and re-bind if anything changed. Serialised. */
  refresh(): Promise<void> {
    const run = this.chain.then(() => this.sync());
    this.chain = run.catch((err) => this.opts.log(`web: LAN: ${String(err)}`));
    return this.chain;
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    void this.opts.server.setLan(undefined);
  }

  private async sync(): Promise<void> {
    if (this.disposed) return;
    const s = this.opts.settings();
    if (!s.enabled) {
      this.stopPolling();
      await this.opts.server.setLan(undefined);
      this.lastKey = '';
      this.publish({ state: 'off', lines: [OFF_LINE] });
      return;
    }
    this.startPolling();
    const ips = privateIPv4s(this.opts.interfaces?.() ?? os.networkInterfaces());
    if (ips.length === 0) {
      await this.opts.server.setLan(undefined);
      this.lastKey = '';
      this.publish({ state: 'error', lines: ['Not listening: this Mac has no private network address (is Wi-Fi on?). Checking again every 30 seconds.'] });
      return;
    }
    const hostName = await (this.opts.hostName ?? localHostName)();
    const notes: string[] = [];
    let tls: TlsMaterial;
    try {
      if (s.certFile && s.keyFile) {
        tls = loadUserCertificate(s.certFile, s.keyFile);
      } else {
        if (s.certFile || s.keyFile) notes.push('Only one of web.lan.certFile and web.lan.keyFile is set, so the local CA’s certificate is used.');
        tls = await this.opts.certs.serverCertificate(hostName, ips);
      }
    } catch (err) {
      await this.opts.server.setLan(undefined);
      this.lastKey = '';
      this.publish({ state: 'error', lines: [`Not listening: ${err instanceof Error ? err.message : String(err)}`] });
      return;
    }
    const names = [`${hostName}.local`, ...ips];
    const port = validPort(s.port);
    // Unchanged, and every address bound: nothing to do. A failed address is retried.
    const key = JSON.stringify([ips, names, port, tls.cert, tls.key]);
    if (key === this.lastKey && this.allBound) return;
    const listeners = await this.opts.server.setLan({ addresses: ips, names, port, cert: tls.cert, key: tls.key });
    if (this.disposed) return;
    this.lastKey = key;
    this.allBound = listeners.every((l) => !l.error);
    this.publish(describe(listeners, `${hostName}.local`, tls, notes));
  }

  private publish(status: LanStatus): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.current);
    this.current = status;
    if (changed) {
      for (const line of status.lines) this.opts.log(`web: LAN: ${line}`);
      this.opts.onStatus?.(status);
    }
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.opts.pollMs ?? LAN_POLL_MS);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const OFF_LINE = 'Off. Nothing listens beyond this Mac.';

function validPort(port: number): number {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : LAN_DEFAULT_PORT;
}

/** The status lines for bound (or failed) listeners. */
export function describe(listeners: LanListenerStatus[], dnsName: string, tls: Pick<TlsMaterial, 'source' | 'validTo'>, notes: string[] = []): LanStatus {
  const bound = listeners.filter((l) => l.port !== undefined && !l.error);
  const lines: string[] = [];
  if (bound.length > 0) lines.push(`Listening on https://${dnsName}:${bound[0].port}/`);
  for (const l of listeners) {
    lines.push(l.error ? `✗ ${l.address}: not listening (${l.error === 'EADDRINUSE' ? 'port in use' : l.error})` : `✓ https://${l.address}:${l.port}/`);
  }
  const until = tls.validTo.toISOString().slice(0, 10);
  lines.push(tls.source === 'user' ? `Your certificate (web.lan.certFile), valid until ${until}.` : `Local CA certificate, valid until ${until}; renewed automatically.`);
  lines.push(...notes);
  return { state: bound.length > 0 ? 'on' : 'error', lines };
}
