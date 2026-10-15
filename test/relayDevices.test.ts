import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_TTL_MS, WebDeviceStore } from '../src/core/web/devices';
import { newRelayKey } from '../src/shared/relay';

const dirs: string[] = [];
function store(now: () => number = () => 1_000_000): { s: WebDeviceStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-relay-devices-'));
  dirs.push(dir);
  const file = path.join(dir, 'web-devices.json');
  return { s: new WebDeviceStore(file, now), file };
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('relay devices (#174)', () => {
  it('keeps a relay device\'s key, lists it, and survives a reload', () => {
    const { s, file } = store();
    const key = newRelayKey();
    const d = s.issueRelay('Remote device', key);
    expect(d.scope).toBe('relay');
    expect(s.relayKeyOf(d.id)).toBe(key);
    expect(s.list().map((x) => x.scope)).toEqual(['relay']);
    // The file is private: it holds the key.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new WebDeviceStore(file, () => 1_000_000).relayKeyOf(d.id)).toBe(key);
  });

  it('gives no key once revoked or expired, and never for a listener device', () => {
    let now = 1_000_000;
    const { s } = store(() => now);
    const d = s.issueRelay('Remote device', newRelayKey());
    const lan = s.issue('Phone', undefined, 'lan');
    expect(s.relayKeyOf(lan.device.id)).toBeUndefined();
    const revoked: string[] = [];
    s.onDidRevoke((id) => revoked.push(id));
    s.revoke(d.id);
    expect(s.relayKeyOf(d.id)).toBeUndefined();
    expect(revoked).toEqual([d.id]);

    const e = s.issueRelay('Remote device', newRelayKey());
    now += DEVICE_TTL_MS + 1;
    expect(s.relayKeyOf(e.id)).toBeUndefined();
  });

  it('a relay device cannot sign in to a listener', () => {
    const { s } = store();
    s.issueRelay('Remote device', newRelayKey());
    // Its stand-in credential hash matches nothing anyone holds; and the scope never matches.
    expect(s.verify('anything', 'lan')).toBeUndefined();
    expect(s.verify('anything', 'loopback')).toBeUndefined();
  });
});
