/**
 * Preferences, host side (#135): what the Electron window and each browser's
 * `#/preferences` route are both served by. Everything is a fake: the settings
 * store, the orchestration callbacks, the device list and the gate.
 */
import { describe, expect, it } from 'vitest';
import { createAccessGate, ownerContext, type AccessAuditRecord, type ActionName, type Authorizer, type BoundAccess, type RequestContext } from '../src/core/access';
import { createPreferencesBackend } from '../src/app/preferencesBackend';
import type { WebDeviceStore } from '../src/core/web/devices';
import { Emitter } from '../src/core/events';
import { currentRequest } from '../src/core/requestScope';
import { isSettingActionId, type HostToPreferences, type PreferencesToHost, type WebDeviceView } from '../src/shared/preferences';
import { SETTINGS } from '../src/shared/settings';
import { isMutatingPaneMessage } from '../src/ui/paneMutations';
import type { PaneChannel } from '../src/ui/paneChannel';
import { PreferencesHost, preferencesRequest, type PreferencesBackend } from '../src/ui/preferencesHost';

const flush = () => new Promise((r) => setTimeout(r, 0));

const SECRET = 'sk-synthetic-secret-value';

function rig(opts: { decision?: 'allow' | 'deny'; backend?: Partial<PreferencesBackend>; update?: (key: string, value: unknown) => Promise<void> } = {}) {
  const stored = new Map<string, unknown>();
  const updates: [string, unknown][] = [];
  const changed = new Emitter<(key: string) => boolean>();
  const logs: string[] = [];
  const asked: { ctx: RequestContext; action: ActionName; resource?: string }[] = [];
  const audit: AccessAuditRecord[] = [];
  const authorizer: Authorizer = (ctx, action, resource) => {
    asked.push({ ctx, action, resource: resource?.id });
    return opts.decision ?? 'allow';
  };
  const access: BoundAccess = {
    context: ownerContext('browser', { deviceId: 'dev-1', connectionId: 'conn-1' }),
    gate: createAccessGate({ authorize: authorizer, audit: { write: (r) => audit.push(r) } }),
  };

  const posted: HostToPreferences[] = [];
  let listener: (m: unknown) => void = () => undefined;
  const channel: PaneChannel = {
    postMessage: async (m) => {
      posted.push(m as HostToPreferences);
      return true;
    },
    onDidReceiveMessage: (l) => {
      listener = l as (m: unknown) => void;
      return { dispose() {} };
    },
  };

  const devices: WebDeviceView[] = [{ id: 'dev-a', name: 'Phone', scope: 'lan', createdAt: 1, lastSeen: 2 }];
  const revoked: string[] = [];
  const devicesChanged = new Emitter<void>();
  const statusChanged = new Emitter<void>();
  const orchChanged = new Emitter<void>();
  const calls: string[] = [];
  const contexts: (RequestContext | undefined)[] = [];
  const backend: PreferencesBackend = {
    settings: {
      get: <T,>(key: string, d: T) => (stored.has(key) ? (stored.get(key) as T) : d),
      update: async (key, value) => {
        updates.push([key, value]);
        if (opts.update) return opts.update(key, value);
        if (value === undefined) stored.delete(key);
        else stored.set(key, value);
        changed.fire(() => true);
      },
      onDidChange: (l) => changed.event(l),
    },
    log: (line) => logs.push(line),
    runAction: async (id) => {
      calls.push(`action:${id}`);
      contexts.push(currentRequest());
      if (id === 'testRemote') throw new Error('network down');
      return { ok: true, lines: [`✓  ${id}`] };
    },
    status: { read: () => ({ 'web.lan.enabled': { ok: true, lines: ['Listening on 192.168.1.5'] } }), onDidChange: statusChanged.event },
    webDevices: {
      list: () => devices,
      revoke: (id) => void revoked.push(id),
      onDidChange: devicesChanged.event,
    },
    orchestration: {
      view: () => ({ catalog: { tiers: [], entries: [] }, sources: [], routing: { mode: 'manual', policy: {}, ignored: [] }, local: { endpoints: [], summaries: [], secretsAvailable: true } }) as never,
      onDidChange: orchChanged.event,
      setPolicy: async (change) => {
        calls.push(`policy:${change.key}`);
        return change.key === 'known';
      },
      localEndpoint: async (change) => {
        calls.push(`endpoint:${change.op}`);
        contexts.push(currentRequest());
        // What the real one does: asks the client that pressed the button, and keeps the answer in the secret store.
        if (change.op === 'setKey') return { ok: true, lines: ['✓  Key saved.'] };
        if (change.op === 'clearKey') return { ok: true, lines: ['✓  Key removed.'] };
        return { ok: true, lines: ['✓  done'] };
      },
      setRouting: async (value) => void calls.push(`routing:${JSON.stringify(value)}`),
    },
    ...opts.backend,
  };

  const host = new PreferencesHost(channel, backend, access, { onClose: () => void calls.push('close') });
  const send = (m: unknown) => listener(m);
  const ofType = <T extends HostToPreferences['type']>(type: T) => posted.filter((m): m is Extract<HostToPreferences, { type: T }> => m.type === type);
  return { host, send, posted, ofType, updates, stored, logs, asked, audit, calls, contexts, revoked, changed, devicesChanged, statusChanged, orchChanged, devices };
}

describe('PreferencesHost: reading', () => {
  it('says nothing until the page has said ready, then sends everything it shows', async () => {
    const r = rig();
    r.changed.fire(() => true);
    r.devicesChanged.fire();
    r.statusChanged.fire();
    r.orchChanged.fire();
    expect(r.posted).toEqual([]);

    r.send({ type: 'ready' });
    await flush();
    const values = r.ofType('values')[0].values;
    // Every declared setting, with its default where nothing is stored.
    expect(Object.keys(values).sort()).toEqual(SETTINGS.map((s) => s.key).sort());
    expect(values['pollIntervalSeconds']).toBe(5);
    expect(r.ofType('status')[0].status['web.lan.enabled'].lines).toEqual(['Listening on 192.168.1.5']);
    expect(r.ofType('webDevices')[0].devices).toEqual(r.devices);
    expect(r.ofType('orchestration')).toHaveLength(1);
  });

  it('shows a stored value, and a change made elsewhere reaches the open page', async () => {
    const r = rig();
    r.send({ type: 'ready' });
    r.stored.set('pollIntervalSeconds', 9);
    r.changed.fire(() => true);
    const latest = r.ofType('values').at(-1)!;
    expect(latest.values['pollIntervalSeconds']).toBe(9);
  });

  it('pushes the device list, the LAN status and the catalog as they change', () => {
    const r = rig();
    r.send({ type: 'ready' });
    const before = r.posted.length;
    r.devicesChanged.fire();
    r.statusChanged.fire();
    r.orchChanged.fire();
    expect(r.posted.slice(before).map((m) => m.type)).toEqual(['webDevices', 'status', 'orchestration']);
  });

  it('stops pushing once disposed', () => {
    const r = rig();
    r.send({ type: 'ready' });
    r.host.dispose();
    const before = r.posted.length;
    r.changed.fire(() => true);
    r.devicesChanged.fire();
    expect(r.posted).toHaveLength(before);
  });

  it('close is handed to the window, which closes itself', () => {
    const r = rig();
    r.send({ type: 'close' });
    expect(r.calls).toEqual(['close']);
  });
});

describe('PreferencesHost: changing a setting', () => {
  it('writes a declared key with a value of its type, and reset removes it', async () => {
    const r = rig();
    r.send({ type: 'ready' });
    r.send({ type: 'set', key: 'pollIntervalSeconds', value: 7 });
    r.send({ type: 'reset', key: 'pollIntervalSeconds' });
    await flush();
    expect(r.updates).toEqual([
      ['pollIntervalSeconds', 7],
      ['pollIntervalSeconds', undefined],
    ]);
  });

  it.each<[string, PreferencesToHost]>([
    ['an undeclared key', { type: 'set', key: 'somethingElse', value: true }],
    ['the qualified key', { type: 'set', key: 'agentWrangler.showUsage', value: true }],
    ['a value of the wrong type', { type: 'set', key: 'pollIntervalSeconds', value: '5' as never }],
    ['a number below its minimum', { type: 'set', key: 'pollIntervalSeconds', value: 0 }],
    ['a number that is not finite', { type: 'set', key: 'pollIntervalSeconds', value: Number.POSITIVE_INFINITY }],
    ['a string outside its enum', { type: 'set', key: 'runner.defaultPermissionMode', value: 'bypassEverything' }],
    ['a reset of an undeclared key', { type: 'reset', key: 'somethingElse' }],
    ['a key that is not a string', { type: 'set', key: { toString: () => 'showUsage' } as never, value: true }],
  ])('refuses %s, and tells the page what is true', async (_name, message) => {
    const r = rig();
    r.send({ type: 'ready' });
    const before = r.ofType('values').length;
    r.send(message);
    await flush();
    expect(r.updates).toEqual([]);
    expect(r.logs.join('\n')).toMatch(/refused/);
    expect(r.ofType('values').length).toBe(before + 1);
  });

  it('accepts a number at its minimum and an enum value', async () => {
    const r = rig();
    r.send({ type: 'set', key: 'pollIntervalSeconds', value: 2 });
    r.send({ type: 'set', key: 'runner.defaultPermissionMode', value: 'plan' });
    await flush();
    expect(r.updates).toEqual([
      ['pollIntervalSeconds', 2],
      ['runner.defaultPermissionMode', 'plan'],
    ]);
  });

  it('a write that fails is logged and the page is shown the stored value again', async () => {
    const r = rig({ update: async () => { throw new Error('read-only file system'); } });
    r.send({ type: 'ready' });
    const before = r.ofType('values').length;
    r.send({ type: 'set', key: 'pollIntervalSeconds', value: 7 });
    await flush();
    expect(r.logs.join('\n')).toMatch(/could not write pollIntervalSeconds/);
    expect(r.ofType('values').length).toBe(before + 1);
    expect(r.ofType('values').at(-1)!.values['pollIntervalSeconds']).toBe(5);
  });
});

describe('PreferencesHost: setting actions', () => {
  it('runs a button as the connection that pressed it, and reports busy then the result', async () => {
    const r = rig();
    r.send({ type: 'action', id: 'connectDiscord' });
    await flush();
    expect(r.calls).toEqual(['action:connectDiscord']);
    // The prompt it raises goes to this connection (#126), not to whoever is the "current" client.
    expect(r.contexts[0]?.connectionId).toBe('conn-1');
    expect(r.posted.map((m) => m.type)).toEqual(['actionBusy', 'actionResult']);
    expect(r.ofType('actionResult')[0]).toMatchObject({ id: 'connectDiscord', ok: true, lines: ['✓  connectDiscord'] });
  });

  it('a failing action reports it in the page instead of throwing', async () => {
    const r = rig();
    r.send({ type: 'action', id: 'testRemote' });
    await flush();
    expect(r.ofType('actionResult')[0]).toMatchObject({ ok: false, lines: ['✗  Error: network down'] });
  });

  it('refuses an action that is not in the closed set', async () => {
    const r = rig();
    r.send({ type: 'action', id: 'rm -rf' });
    await flush();
    expect(r.calls).toEqual([]);
    expect(r.posted).toEqual([]);
    expect(isSettingActionId('connectDiscord')).toBe(true);
    expect(isSettingActionId('rm -rf')).toBe(false);
  });
});

describe('PreferencesHost: orchestration', () => {
  it('applies a model policy change, and the catalog is pushed again either way', async () => {
    const r = rig();
    r.send({ type: 'ready' });
    const before = r.ofType('orchestration').length;
    r.send({ type: 'modelPolicy', change: { key: 'known', tier: 'fast' } });
    r.send({ type: 'modelPolicy', change: { key: 'unknown', enabled: false } });
    await flush();
    expect(r.calls).toEqual(['policy:known', 'policy:unknown']);
    expect(r.ofType('orchestration').length).toBe(before + 2);
    expect(r.logs.join('\n')).toMatch(/refused model policy for unknown/);
  });

  it('refuses a malformed model policy change', async () => {
    const r = rig();
    r.send({ type: 'modelPolicy', change: { key: '', tier: 'fast' } });
    r.send({ type: 'modelPolicy', change: { key: 'known' } });
    await flush();
    expect(r.calls).toEqual([]);
  });

  it('local endpoint changes run and their result comes back; a malformed one does not run', async () => {
    const r = rig();
    r.send({ type: 'localEndpoint', change: { op: 'probe', id: 'ep1' } });
    r.send({ type: 'localEndpoint', change: { op: 'drop tables' } });
    r.send({ type: 'localEndpoint', change: { op: 'enable', id: 'ep1', enabled: 'yes' } });
    await flush();
    expect(r.calls).toEqual(['endpoint:probe']);
    expect(r.ofType('localEndpointResult')).toEqual([{ type: 'localEndpointResult', ok: true, lines: ['✓  done'] }]);
  });

  it('a local endpoint that throws is reported, not raised', async () => {
    const failing = rig({
      backend: {
        orchestration: {
          view: () => ({ catalog: { tiers: [], entries: [] }, sources: [] }) as never,
          onDidChange: () => ({ dispose() {} }),
          setPolicy: async () => true,
          localEndpoint: async () => { throw new Error('unreachable'); },
        },
      },
    });
    failing.send({ type: 'localEndpoint', change: { op: 'probe', id: 'ep1' } });
    await flush();
    expect(failing.ofType('localEndpointResult')[0]).toMatchObject({ ok: false, lines: ['✗  Error: unreachable'] });
  });

  it('setting or clearing a key as a secret never sends the value back', async () => {
    const r = rig();
    r.send({ type: 'ready' });
    // The protocol has no field a key could ride in: a key is asked for by a prompt and kept in the secret store.
    r.send({ type: 'localEndpoint', change: { op: 'setKey', id: 'ep1', key: SECRET } });
    r.send({ type: 'localEndpoint', change: { op: 'clearKey', id: 'ep1' } });
    await flush();
    expect(r.calls).toEqual(['endpoint:setKey', 'endpoint:clearKey']);
    expect(JSON.stringify(r.posted)).not.toContain(SECRET);
    expect(r.ofType('localEndpointResult').map((m) => m.lines)).toEqual([['✓  Key saved.'], ['✓  Key removed.']]);
  });

  it('runs the setKey prompt as the connection that pressed the button', async () => {
    const r = rig();
    r.send({ type: 'localEndpoint', change: { op: 'setKey', id: 'ep1' } });
    await flush();
    expect(r.contexts[0]).toMatchObject({ via: 'browser', connectionId: 'conn-1', deviceId: 'dev-1' });
  });

  it('saves valid routing defaults and says so', async () => {
    const r = rig();
    r.send({ type: 'routingPolicy', mode: 'manual', policy: {} });
    await flush();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^routing:/);
    expect(r.ofType('routingResult')).toEqual([{ type: 'routingResult', ok: true, errors: [] }]);
  });

  it('refuses an invalid routing change with the reasons', async () => {
    const r = rig();
    r.send({ type: 'routingPolicy', mode: 'sideways', policy: {} });
    r.send({ type: 'routingPolicy', mode: 'manual', policy: { nonsense: 1 } });
    await flush();
    expect(r.calls).toEqual([]);
    const results = r.ofType('routingResult');
    expect(results).toHaveLength(2);
    expect(results.every((m) => !m.ok && m.errors.length > 0)).toBe(true);
  });

  it('automatic routing over an unmet gate needs the explicit override', async () => {
    const r = rig();
    r.send({ type: 'routingPolicy', mode: 'auto', policy: {} });
    await flush();
    expect(r.calls).toEqual([]);
    expect(r.ofType('routingResult')[0]).toMatchObject({ ok: false, needsOverride: true });
    r.send({ type: 'routingPolicy', mode: 'auto', policy: {}, overrideGate: true });
    await flush();
    expect(r.calls).toHaveLength(1);
    expect(r.ofType('routingResult').at(-1)).toMatchObject({ ok: true });
  });
});

describe('PreferencesHost: devices', () => {
  it('revokes a device by id, and sends the list again', async () => {
    const r = rig();
    r.send({ type: 'ready' });
    const before = r.ofType('webDevices').length;
    r.send({ type: 'revokeWebDevice', id: 'dev-a' });
    await flush();
    expect(r.revoked).toEqual(['dev-a']);
    expect(r.ofType('webDevices').length).toBe(before + 1);
    expect(r.audit.map((a) => [a.action, a.resource?.kind, a.resource?.id])).toEqual([['web.device.revoke', 'device', 'dev-a']]);
  });

  it('refuses a revocation with no usable id', async () => {
    const r = rig();
    r.send({ type: 'revokeWebDevice', id: '' });
    r.send({ type: 'revokeWebDevice', id: 'x'.repeat(65) });
    r.send({ type: 'revokeWebDevice', id: 12 });
    await flush();
    expect(r.revoked).toEqual([]);
    expect(r.logs.filter((l) => /refused a device revocation/.test(l))).toHaveLength(3);
  });

  it('the backend lists a device by its public fields only, never a credential', () => {
    const store = {
      list: () => [{ id: 'a', name: 'Phone', scope: 'lan', createdAt: 1, lastSeen: 2, secretHash: SECRET, token: SECRET }],
      revoke: () => undefined,
      onDidChange: new Emitter<void>().event,
    } as unknown as WebDeviceStore;
    const backend = createPreferencesBackend({
      app: {} as never,
      host: { settings: {} as never, log: () => undefined } as never,
      lan: { status: () => ({ state: 'off', lines: ['Off.'] }), onDidChange: new Emitter<void>().event },
      devices: store,
    });
    const listed = backend.webDevices!.list();
    expect(listed).toEqual([{ id: 'a', name: 'Phone', scope: 'lan', createdAt: 1, lastSeen: 2 }]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(backend.status!.read()).toEqual({ 'web.lan.enabled': { ok: true, lines: ['Off.'] } });
  });
});

// ---- the access gate ----

type Samples<U extends { type: string }> = { [T in U['type']]: Extract<U, { type: T }>[] };

/** One or more of every message type. A new `PreferencesToHost` fails to compile here until it has one. */
const SAMPLES: Samples<PreferencesToHost> = {
  ready: [{ type: 'ready' }],
  set: [{ type: 'set', key: 'pollIntervalSeconds', value: 7 }],
  reset: [{ type: 'reset', key: 'pollIntervalSeconds' }],
  action: [{ type: 'action', id: 'connectDiscord' }, { type: 'action', id: 'testRemote' }, { type: 'action', id: 'disconnectDiscord' }],
  modelPolicy: [{ type: 'modelPolicy', change: { key: 'known', tier: 'fast' } }],
  localEndpoint: [{ type: 'localEndpoint', change: { op: 'setKey', id: 'ep1' } }],
  routingPolicy: [{ type: 'routingPolicy', mode: 'manual', policy: {} }],
  revokeWebDevice: [{ type: 'revokeWebDevice', id: 'dev-a' }],
  close: [{ type: 'close' }],
};
const ALL = Object.values(SAMPLES).flat() as PreferencesToHost[];

describe('PreferencesHost: every message is authorised before it acts', () => {
  it.each(ALL.map((m) => [m.type === 'action' ? `action:${m.id}` : m.type, m] as const))(
    '%s: refused → authorised once as the owner via browser, audited, nothing ran or was posted',
    async (_name, m) => {
      const r = rig({ decision: 'deny' });
      r.send(m);
      await flush();
      expect(r.asked).toHaveLength(1);
      expect(r.asked[0].ctx.principal.id).toBe('local-owner');
      expect(r.asked[0].ctx.via).toBe('browser');
      expect(r.updates).toEqual([]);
      expect(r.calls).toEqual([]);
      expect(r.revoked).toEqual([]);
      expect(r.posted).toEqual([]);
      expect(r.audit).toHaveLength(1);
      expect(r.audit[0]).toMatchObject({ event: 'refused-unauthorised', via: 'browser', connectionId: 'conn-1' });
    },
  );

  it('a message type the page made up is authorised as a settings write, then does nothing', async () => {
    const r = rig({ decision: 'deny' });
    r.send({ type: 'sudo', command: 'x' });
    expect(r.asked.map((a) => a.action)).toEqual(['settings.write']);
    const allowed = rig();
    allowed.send({ type: 'sudo', command: 'x' });
    await flush();
    expect(allowed.updates).toEqual([]);
    expect(allowed.calls).toEqual([]);
  });

  it('allowed, a write is audited with the setting and the tab, and a read is not', async () => {
    const r = rig();
    r.send({ type: 'ready' });
    r.send({ type: 'set', key: 'pollIntervalSeconds', value: 7 });
    r.send({ type: 'action', id: 'connectDiscord' });
    await flush();
    expect(r.audit.map((a) => [a.event, a.action, a.resource?.id, a.deviceId, a.connectionId])).toEqual([
      ['authorized', 'settings.write', 'pollIntervalSeconds', 'dev-1', 'conn-1'],
      ['authorized', 'settings.write', 'action.connectDiscord', 'dev-1', 'conn-1'],
    ]);
  });

  it('a made-up key is never written to the audit log', () => {
    const req = preferencesRequest({ type: 'set', key: '/Users/test/proj/secret', value: true });
    expect(req).toEqual({ action: 'settings.write', resource: { kind: 'setting', id: 'unknown' } });
  });
});

describe('the connection remembers only what changes something', () => {
  it('classifies preferences messages for exactly-once resends', () => {
    expect(isMutatingPaneMessage('preferences', { type: 'ready' })).toBe(false);
    expect(isMutatingPaneMessage('preferences', { type: 'close' })).toBe(false);
    expect(isMutatingPaneMessage('preferences', { type: 'set', key: 'showUsage', value: false })).toBe(true);
    expect(isMutatingPaneMessage('preferences', { type: 'revokeWebDevice', id: 'dev-a' })).toBe(true);
    expect(isMutatingPaneMessage('preferences', { type: 'localEndpoint', change: { op: 'clearKey', id: 'a' } })).toBe(true);
    // Unknown is a mutation.
    expect(isMutatingPaneMessage('preferences', { type: 'whatever' })).toBe(true);
  });
});
