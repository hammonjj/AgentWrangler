import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/core/access';
import type { ClientSocket } from '../src/core/web/browserConnections';
import type { RelayChannel, RelayNetwork } from '../src/remote/relay/network';
import { startRelayLink } from '../src/remote/relay/relayLink';
import {
  RELAY_EVENT_CONNECT,
  RELAY_EVENT_FRAME,
  RelayCodec,
  connectionTopic,
  importRelayKey,
  lobbyTopic,
  newRelayId,
  newRelayKey,
  parseSealedPart,
  sealConnect,
  type RelayItem,
} from '../src/shared/relay';

const UID = '00000000-0000-4000-8000-000000000001';

/** Topics in memory: a send reaches every other member of the topic, as Broadcast with `self: false` does. */
class Hub {
  private members = new Map<string, Set<Member>>();
  join(topic: string): Member {
    const m = new Member(this, topic);
    let set = this.members.get(topic);
    if (!set) this.members.set(topic, (set = new Set()));
    set.add(m);
    return m;
  }
  leave(m: Member): void {
    this.members.get(m.topic)?.delete(m);
  }
  deliver(from: Member, event: string, payload: unknown): void {
    for (const m of this.members.get(from.topic) ?? []) if (m !== from) m.fire(event, JSON.parse(JSON.stringify(payload)));
  }
  topics(): string[] {
    return [...this.members].filter(([, s]) => s.size > 0).map(([t]) => t);
  }
}

class Member implements RelayChannel {
  private listeners = new Map<string, ((p: unknown) => void)[]>();
  constructor(
    private hub: Hub,
    readonly topic: string,
  ) {}
  async send(event: string, payload: unknown): Promise<void> {
    this.hub.deliver(this, event, payload);
  }
  on(event: string, listener: (p: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  fire(event: string, payload: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
  async leave(): Promise<void> {
    this.hub.leave(this);
  }
}

function network(hub: Hub, beats: string[] = []): RelayNetwork {
  return {
    uid: UID,
    join: async (topic) => hub.join(topic),
    heartbeat: async (id, build) => void beats.push(`${id}:${build}`),
    dispose: () => undefined,
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Wait until `pred` holds (a loaded machine can take a while to seal a batch), or give up after 3 s. */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !pred(); i++) await tick(20);
}

/** A remote tab: asks on the lobby, then speaks the codec on its channel. */
async function browser(hub: Hub, deviceId: string, keyText: string) {
  const key = await importRelayKey(keyText);
  const connId = newRelayId();
  const topic = connectionTopic(UID, connId);
  const channel = hub.join(topic);
  const codec = new RelayCodec(key, deviceId, topic, 'b2d');
  const received: RelayItem[] = [];
  let chain = Promise.resolve();
  channel.on(RELAY_EVENT_FRAME, (raw) => {
    chain = chain.then(async () => {
      const items = await codec.open(parseSealedPart(raw)!);
      if (items) received.push(...items);
      else received.push({ k: 'close', reason: 'refused' });
    });
  });
  const lobby = hub.join(lobbyTopic(UID));
  await lobby.send(RELAY_EVENT_CONNECT, await sealConnect(key, deviceId, UID, connId, Date.now()));
  return {
    received,
    channel,
    topic,
    send: async (items: RelayItem[]) => {
      for (const p of await codec.seal(items)) await channel.send(RELAY_EVENT_FRAME, p);
    },
  };
}

/** A stand-in for `browserConnections`: says hello, echoes every message back. */
function echoAttach(contexts: RequestContext[]) {
  return (socket: ClientSocket, context: RequestContext) => {
    contexts.push(context);
    socket.send('{"pane":"shell","body":{"type":"hello"}}');
    socket.on('message', (data) => socket.send(`echo:${String(data)}`));
  };
}

describe('relay link', () => {
  it('opens a tab for a paired device and carries its traffic both ways', async () => {
    const hub = new Hub();
    const key = newRelayKey();
    const contexts: RequestContext[] = [];
    const beats: string[] = [];
    const link = await startRelayLink({
      network: network(hub, beats),
      keyOf: (id) => (id === 'dev1' ? key : undefined),
      attach: echoAttach(contexts),
      build: () => 'b1',
      daemonId: 'daemon-1',
      log: () => undefined,
      batchMs: 5,
    });
    const tab = await browser(hub, 'dev1', key);
    await until(() => tab.received.length >= 2);
    expect(link.tabs).toBe(1);
    expect(contexts[0]).toMatchObject({ via: 'browser', deviceId: 'dev1', deviceScope: 'relay' });
    // The build first, then what the connection said, in one batch.
    expect(tab.received.slice(0, 2)).toEqual([
      { k: 'open', build: 'b1', protocol: 1 },
      { k: 'data', line: '{"pane":"shell","body":{"type":"hello"}}' },
    ]);
    await tab.send([{ k: 'data', line: 'hi' }]);
    await until(() => tab.received.length >= 3);
    expect(tab.received.at(-1)).toEqual({ k: 'data', line: 'echo:hi' });
    expect(beats).toEqual(['daemon-1:b1']);
    expect(link.counts.sentMessages).toBeGreaterThan(0);
    link.dispose();
  });

  it('never puts clear text on the wire', async () => {
    const hub = new Hub();
    const key = newRelayKey();
    const seen: unknown[] = [];
    const link = await startRelayLink({
      network: {
        ...network(hub),
        join: async (topic) => {
          const m = hub.join(topic);
          const send = m.send.bind(m);
          m.send = async (event, payload) => {
            seen.push(payload);
            return send(event, payload);
          };
          return m;
        },
      },
      keyOf: () => key,
      attach: (socket) => socket.send('{"secret":"transcript text"}'),
      build: () => 'b1',
      daemonId: 'd',
      log: () => undefined,
      batchMs: 5,
    });
    await browser(hub, 'dev1', key);
    await until(() => seen.length > 0);
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain('transcript');
    link.dispose();
  });

  it('ignores a device it does not know and one with the wrong key', async () => {
    const hub = new Hub();
    const lines: string[] = [];
    const link = await startRelayLink({
      network: network(hub),
      keyOf: (id) => (id === 'dev1' ? newRelayKey() : undefined),
      attach: () => {
        throw new Error('must not attach');
      },
      build: () => 'b1',
      daemonId: 'd',
      log: (l) => lines.push(l),
      batchMs: 5,
    });
    await browser(hub, 'stranger', newRelayKey());
    await browser(hub, 'dev1', newRelayKey());
    await until(() => lines.length >= 2);
    expect(link.tabs).toBe(0);
    expect(lines.join('\n')).toMatch(/unknown or revoked/);
    expect(lines.join('\n')).toMatch(/did not authenticate/);
    link.dispose();
  });

  it('drops a tab whose frame does not authenticate', async () => {
    const hub = new Hub();
    const key = newRelayKey();
    const link = await startRelayLink({
      network: network(hub),
      keyOf: () => key,
      attach: echoAttach([]),
      build: () => 'b1',
      daemonId: 'd',
      log: () => undefined,
      batchMs: 5,
    });
    const tab = await browser(hub, 'dev1', key);
    await until(() => link.tabs === 1);
    expect(link.tabs).toBe(1);
    await tab.channel.send(RELAY_EVENT_FRAME, { s: 1, n: 'AAAAAAAAAAAAAAAA', c: 'AAAA' });
    await until(() => link.tabs === 0);
    expect(link.tabs).toBe(0);
    link.dispose();
  });

  it('closes a revoked device\'s tabs and leaves their channels', async () => {
    const hub = new Hub();
    const key = newRelayKey();
    const link = await startRelayLink({
      network: network(hub),
      keyOf: () => key,
      attach: echoAttach([]),
      build: () => 'b1',
      daemonId: 'd',
      log: () => undefined,
      batchMs: 5,
    });
    const tab = await browser(hub, 'dev1', key);
    await until(() => link.tabs === 1);
    expect(link.closeDevice('dev1')).toBe(1);
    await until(() => tab.received.some((i) => i.k === 'close'));
    expect(link.tabs).toBe(0);
    expect(tab.received.at(-1)).toMatchObject({ k: 'close', code: 4401 });
    link.dispose();
  });

  it('serves the workbench assets for its own build only', async () => {
    const hub = new Hub();
    const key = newRelayKey();
    const link = await startRelayLink({
      network: network(hub),
      keyOf: () => key,
      attach: () => undefined,
      build: () => 'b1',
      assets: async () => [
        { name: 'workbench.js', type: 'text/javascript', text: 'console.log(1)' },
        { name: 'workbench.css', type: 'text/css', text: 'body{}' },
      ],
      daemonId: 'd',
      log: () => undefined,
      batchMs: 5,
    });
    const tab = await browser(hub, 'dev1', key);
    await until(() => tab.received.length >= 1);
    await tab.send([{ k: 'assets', build: 'b1' }]);
    await until(() => tab.received.some((i) => i.k === 'asset' && i.last));
    const assets = tab.received.filter((i) => i.k === 'asset');
    expect(assets.map((a) => (a as { name: string }).name)).toEqual(['workbench.js', 'workbench.css']);
    expect(assets.at(-1)).toMatchObject({ last: true });
    link.dispose();
  });
});
