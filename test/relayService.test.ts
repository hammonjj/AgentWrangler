import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebDeviceStore } from '../src/core/web/devices';
import type { HostServices } from '../src/host/hostServices';
import type { RelayHealth, RelayLink, RelayLinkOptions } from '../src/remote/relay/relayLink';

// The network and the link are faked: this is about how the service reacts to a deaf lobby (#186).
const connects: number[] = [];
const links: { opts: RelayLinkOptions; link: RelayLink & { checks: string[]; health: RelayHealth; fire(): void } }[] = [];

vi.mock('../src/remote/relay/supabaseNetwork', () => ({
  connectSupabaseNetwork: async () => {
    connects.push(Date.now());
    return { uid: 'u', login: 'octocat', join: async () => undefined, heartbeat: async () => undefined, dispose: () => undefined };
  },
}));

vi.mock('../src/remote/relay/relayLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote/relay/relayLink')>()),
  startRelayLink: async (opts: RelayLinkOptions) => {
    const listeners: (() => void)[] = [];
    const link = {
      tabs: 0,
      counts: { sentMessages: 0, sentBytes: 0, receivedMessages: 0, receivedBytes: 0, since: 0 },
      health: { checking: false, misses: 0 } as RelayHealth,
      checks: [] as string[],
      check(reason: string) {
        link.checks.push(reason);
      },
      onDidChange: (l: () => void) => {
        listeners.push(l);
        return { dispose: () => undefined };
      },
      fire: () => listeners.forEach((l) => l()),
      closeDevice: () => 0,
      dispose: () => undefined,
    };
    links.push({ opts, link });
    return link;
  },
}));

const { startRelayService } = await import('../src/app/relayService');

function fakeHost(): HostServices {
  const values: Record<string, unknown> = {
    'remote.relay.enabled': true,
    'remote.relay.url': 'https://example.supabase.co',
    'remote.relay.anonKey': 'anon',
  };
  return {
    settings: { get: (k: string, d: unknown) => values[k] ?? d, onDidChange: () => ({ dispose: () => undefined }) },
    secrets: { available: true, get: async () => 'refresh-token', store: async () => undefined, delete: async () => undefined },
    globalState: { get: (_k: string, d: unknown) => d, update: async () => undefined },
    dataDir: '/Users/test/data',
    shell: { openExternal: () => undefined },
  } as unknown as HostServices;
}

const devices = { relayKeyOf: () => undefined, relayPushTargets: () => [], onDidRevoke: () => ({ dispose: () => undefined }) } as unknown as WebDeviceStore;

function start(logs: string[] = []) {
  return startRelayService({
    host: fakeHost(),
    devices,
    webviewDir: '/Users/test/webview',
    attach: () => undefined,
    closeDevice: () => undefined,
    port: () => undefined,
    log: (l) => logs.push(l),
  });
}

describe('relay service self-healing (#186)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connects.length = 0;
    links.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('rebuilds the link at once when its lobby goes deaf, then backs off while new links fail too', async () => {
    const logs: string[] = [];
    const svc = start(logs);
    await vi.advanceTimersByTimeAsync(0);
    expect(links).toHaveLength(1);

    links[0].opts.onLobbyLost!('scheduled check: probe unanswered');
    expect(svc.status().lines[0]).toBe('Reconnecting (scheduled check: probe unanswered)…');
    await vi.advanceTimersByTimeAsync(0);
    expect(links).toHaveLength(2);
    expect(logs).toContain('relay: reconnecting (scheduled check: probe unanswered)');

    // The new link's first check fails too: wait 30 s this time.
    links[1].opts.onLobbyLost!('first check: probe unanswered');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(links).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(links).toHaveLength(3);

    // A check that passes clears the back-off.
    links[2].link.health.lastOkAt = Date.now();
    links[2].link.fire();
    links[2].opts.onLobbyLost!('scheduled check: probe unanswered');
    await vi.advanceTimersByTimeAsync(0);
    expect(links).toHaveLength(4);
    svc.dispose();
  });

  it('ignores a lost report from a link it already replaced', async () => {
    const svc = start();
    await vi.advanceTimersByTimeAsync(0);
    links[0].opts.onLobbyLost!('a');
    await vi.advanceTimersByTimeAsync(0);
    links[0].opts.onLobbyLost!('b');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(links).toHaveLength(2);
    svc.dispose();
  });

  it('checks the lobby on wake', async () => {
    const svc = start();
    await vi.advanceTimersByTimeAsync(0);
    svc.wake();
    expect(links[0].link.checks).toEqual(['woke from sleep']);
    svc.dispose();
  });

  it('says when the lobby last answered, and when it did not', async () => {
    const svc = start();
    await vi.advanceTimersByTimeAsync(0);
    const link = links[0].link;
    expect(svc.status()).toMatchObject({ ok: true, lines: expect.arrayContaining(['Checking the lobby…']) });
    link.health.lastOkAt = Date.now();
    expect(svc.status().lines[1]).toMatch(/^Lobby checked /);
    link.health.misses = 1;
    link.health.lastCheckAt = Date.now();
    expect(svc.status().ok).toBe(false);
    expect(svc.status().lines[1]).toMatch(/^The lobby did not answer its last check/);
    svc.dispose();
  });
});
