import { describe, expect, it } from 'vitest';
import { DiscordGateway, type GatewaySocket } from '../src/remote/discord/gateway';

/**
 * A socket we drive by hand. Nothing here touches the network.
 *
 * `close()` fires a close event, exactly as a real WebSocket does. That detail
 * is the whole reason this fake exists in this shape: a fake that stayed silent
 * when closed locally hid the bug where a torn-down socket's close listener
 * asked for a reconnect of its own, and two sockets became four.
 */
class FakeSocket implements GatewaySocket {
  sent: { op: number; d: unknown }[] = [];
  closedWith: number[] = [];
  private listeners = new Map<string, ((e: never) => void)[]>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    if (this.closedWith.length > 0) return; // a real socket closes once
    this.closedWith.push(code ?? 1000);
    this.emit('close', { code: code ?? 1000, reason: '' });
  }
  addEventListener(type: string, listener: (e: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (e: never) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((l) => l !== listener);
    this.listeners.set(type, list);
  }
  /** How many listeners are still attached — a torn-down socket has none. */
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, l) => n + l.length, 0);
  }

  emit(type: string, event: unknown): void {
    for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(event);
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
  serverClose(code: number, reason = ''): void {
    this.emit('close', { code, reason });
  }
  ops(): number[] {
    return this.sent.map((s) => s.op);
  }
  lastOf(op: number): { op: number; d: unknown } | undefined {
    return [...this.sent].reverse().find((s) => s.op === op);
  }
}

const HELLO = { op: 10, d: { heartbeat_interval: 41250 } };
const ready = (session = 'sess-1') => ({
  op: 0,
  s: 1,
  t: 'READY',
  d: { session_id: session, resume_gateway_url: 'wss://resume.example', user: { username: 'bot' } },
});

/** Build a gateway over a controllable socket, with time and jitter removed. */
function build(opts: { onSleep?: (ms: number) => void } = {}) {
  const sockets: FakeSocket[] = [];
  const sleeps: number[] = [];
  /**
   * The live heartbeat intervals, by handle, so a test can fire beats without
   * waiting 41s — and can assert that a reconnect left none behind. Orphaned
   * intervals are how one connection's beats ended up judging another's.
   */
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  const gateway = new DiscordGateway({
    token: () => 'TOKEN',
    gatewayUrl: async () => 'wss://gateway.example',
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    // Resolve immediately so the lifecycle is deterministic, but record the
    // delay so backoff can be asserted.
    sleep: async (ms) => {
      sleeps.push(ms);
      opts.onSleep?.(ms);
    },
    random: () => 0.5,
    log: () => undefined,
    setIntervalImpl: (fn) => {
      const handle = nextHandle++;
      timers.set(handle, fn);
      return handle;
    },
    clearIntervalImpl: (handle) => {
      timers.delete(handle as number);
    },
  });
  return {
    gateway,
    sockets,
    sleeps,
    latest: () => sockets[sockets.length - 1],
    /** Fire every live heartbeat interval, as the event loop would. */
    beat: () => {
      for (const fn of [...timers.values()]) fn();
    },
    liveTimers: () => timers.size,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('DiscordGateway', () => {
  it('identifies with intents 0 after HELLO, and reports ready on READY', async () => {
    const { gateway, latest } = build();
    await gateway.connect();
    const socket = latest();
    expect(socket.url).toContain('?v=10&encoding=json');

    socket.receive(HELLO);
    await tick();

    const identify = socket.lastOf(2);
    expect(identify?.d).toMatchObject({ token: 'TOKEN', intents: 0 });
    expect(gateway.connected).toBe(false);

    socket.receive(ready());
    expect(gateway.connected).toBe(true);
    gateway.dispose();
  });

  it('subscribes to nothing, so no privileged intent is needed', async () => {
    const { gateway, latest } = build();
    await gateway.connect();
    latest().receive(HELLO);
    await tick();
    expect((latest().lastOf(2)?.d as { intents: number }).intents).toBe(0);
    gateway.dispose();
  });

  it('heartbeats with the interval HELLO gave, jittering the first one', async () => {
    const seen: number[] = [];
    const { gateway, latest } = build({ onSleep: (ms) => seen.push(ms) });
    await gateway.connect();
    latest().receive(HELLO);
    await tick();
    // First beat is delayed by interval * random (0.5 here).
    expect(seen).toContain(41250 * 0.5);
    expect(latest().ops()).toContain(1);
    gateway.dispose();
  });

  it('answers a server-requested heartbeat', async () => {
    const { gateway, latest } = build();
    await gateway.connect();
    const socket = latest();
    socket.receive(HELLO);
    await tick();
    socket.receive(ready());
    socket.sent.length = 0;
    socket.receive({ op: 1 });
    expect(socket.ops()).toEqual([1]);
    gateway.dispose();
  });

  it('forwards dispatches other than READY', async () => {
    const { gateway, latest } = build();
    const seen: string[] = [];
    gateway.onDispatch((d) => seen.push(d.t));
    await gateway.connect();
    const socket = latest();
    socket.receive(HELLO);
    await tick();
    socket.receive(ready());
    socket.receive({ op: 0, s: 2, t: 'INTERACTION_CREATE', d: { id: '1' } });
    expect(seen).toEqual(['INTERACTION_CREATE']);
    gateway.dispose();
  });

  it('resumes to the url READY supplied, with the last sequence', async () => {
    const { gateway, sockets, latest } = build();
    await gateway.connect();
    latest().receive(HELLO);
    await tick();
    latest().receive(ready());
    latest().receive({ op: 0, s: 7, t: 'INTERACTION_CREATE', d: {} });

    latest().serverClose(4000); // a resumable drop
    await tick();
    await tick();

    expect(sockets).toHaveLength(2);
    // Not the url we first dialled: Discord hands out a dedicated resume host.
    expect(latest().url).toContain('resume.example');
    latest().receive(HELLO);
    await tick();
    expect(latest().lastOf(6)?.d).toMatchObject({ session_id: 'sess-1', seq: 7 });
    gateway.dispose();
  });

  it('re-identifies rather than resuming when the session is unresumable', async () => {
    const { gateway, latest, sockets } = build();
    await gateway.connect();
    latest().receive(HELLO);
    await tick();
    latest().receive(ready());

    latest().receive({ op: 9, d: false }); // invalid, not resumable
    await tick();
    await tick();
    expect(sockets.length).toBeGreaterThan(1);
    latest().receive(HELLO);
    await tick();
    expect(latest().lastOf(2)).toBeDefined(); // IDENTIFY
    expect(latest().lastOf(6)).toBeUndefined(); // not RESUME
    gateway.dispose();
  });

  it('reconnects when told to (op 7)', async () => {
    const { gateway, latest, sockets } = build();
    await gateway.connect();
    latest().receive(HELLO);
    await tick();
    latest().receive(ready());
    latest().receive({ op: 7 });
    await tick();
    await tick();
    expect(sockets.length).toBe(2);
    gateway.dispose();
  });

  it('keeps beating while Discord acknowledges', async () => {
    const { gateway, latest, sockets, beat } = build();
    await gateway.connect();
    const socket = latest();
    socket.receive(HELLO);
    await tick();
    socket.receive(ready());

    // `startHeartbeat` already sent the first, jittered beat, so each round
    // acknowledges the outstanding one before sending the next — which is the
    // order a healthy connection actually produces.
    for (let i = 0; i < 3; i++) {
      socket.receive({ op: 11 });
      beat();
    }
    expect(sockets).toHaveLength(1);
    expect(socket.ops().filter((op) => op === 1).length).toBe(4);
    gateway.dispose();
  });

  it('treats a missed heartbeat ack as a zombie connection and reconnects', async () => {
    // The socket is open and sending, but nothing is coming back. Without this
    // the bot sits there looking connected and silently misses every press.
    const { gateway, latest, sockets, beat } = build();
    await gateway.connect();
    const socket = latest();
    socket.receive(HELLO);
    await tick();
    socket.receive(ready());

    beat(); // sent, awaiting an ack that never arrives
    expect(sockets).toHaveLength(1);
    beat(); // the next beat finds the previous one unacknowledged
    await tick();
    await tick();

    expect(sockets).toHaveLength(2);
    expect(socket.closedWith).toContain(4000);
    gateway.dispose();
  });

  describe('close codes', () => {
    it('stops permanently on 4004, because the token will never work', async () => {
      const { gateway, latest, sockets } = build();
      await gateway.connect();
      latest().receive(HELLO);
      await tick();
      latest().receive(ready());

      latest().serverClose(4004, 'Authentication failed');
      await tick();
      await tick();

      expect(sockets).toHaveLength(1); // no retry storm
      expect(gateway.connected).toBe(false);
      expect(gateway.fatalError).toMatch(/rejected the bot token/i);
      gateway.dispose();
    });

    it('stops permanently on a disallowed intent', async () => {
      const { gateway, latest, sockets } = build();
      await gateway.connect();
      latest().serverClose(4014);
      await tick();
      await tick();
      expect(sockets).toHaveLength(1);
      expect(gateway.fatalError).toBeDefined();
      gateway.dispose();
    });

    it('reconnects on an ordinary drop', async () => {
      const { gateway, latest, sockets } = build();
      await gateway.connect();
      latest().serverClose(1006);
      await tick();
      await tick();
      expect(sockets).toHaveLength(2);
      expect(gateway.fatalError).toBeUndefined();
      gateway.dispose();
    });
  });

  it('backs off further each failed attempt, and resets after a good connection', async () => {
    const delays: number[] = [];
    const { gateway, latest } = build({ onSleep: (ms) => delays.push(ms) });
    await gateway.connect();

    for (let i = 0; i < 3; i++) {
      latest().serverClose(1006);
      await tick();
      await tick();
    }
    // 1s, 2s, 4s with the fixed 0.5 jitter factor applied (×1.0).
    const reconnectDelays = delays.filter((d) => d >= 1000);
    expect(reconnectDelays[0]).toBeLessThan(reconnectDelays[1]);
    expect(reconnectDelays[1]).toBeLessThan(reconnectDelays[2]);

    latest().receive(HELLO);
    await tick();
    latest().receive(ready());
    delays.length = 0;

    latest().serverClose(1006);
    await tick();
    await tick();
    expect(delays.filter((d) => d >= 1000)[0]).toBeLessThan(reconnectDelays[2]);
    gateway.dispose();
  });

  it('does not reconnect after an explicit disconnect', async () => {
    const { gateway, latest, sockets } = build();
    await gateway.connect();
    await gateway.disconnect();
    latest().serverClose(1006);
    await tick();
    await tick();
    expect(sockets).toHaveLength(1);
    expect(gateway.connected).toBe(false);
  });

  /**
   * The bug that took remote control down after a few hours: one connection
   * became two, two became four, and by the end the bot was opening hundreds of
   * sockets a minute while every button press raced itself and lost.
   */
  describe('one socket at a time', () => {
    /** Drive a connection to READY and hand back its socket. */
    const ready1 = async (h: ReturnType<typeof build>) => {
      await h.gateway.connect();
      const socket = h.latest();
      socket.receive(HELLO);
      await tick();
      socket.receive(ready());
      return socket;
    };

    it('opens exactly one replacement when told to reconnect', async () => {
      // `reopen` closes the socket *and* schedules a reconnect. The close event
      // that follows must not schedule a second one.
      const h = build();
      const socket = await ready1(h);
      socket.receive({ op: 7 });
      await tick();
      await tick();
      expect(h.sockets).toHaveLength(2);
    });

    it('opens exactly one replacement when a heartbeat goes unacknowledged', async () => {
      const h = build();
      const socket = await ready1(h);
      h.beat(); // sent, awaiting an ack that never arrives
      h.beat(); // the next beat finds the previous one unacknowledged
      await tick();
      await tick();
      expect(h.sockets).toHaveLength(2);
      expect(socket.closedWith).toEqual([4000]);
    });

    it('does not multiply sockets over repeated reconnects', async () => {
      // The shape of the outage: each round used to double the population.
      const h = build();
      await ready1(h);
      for (let i = 0; i < 6; i++) {
        h.latest().receive({ op: 7 });
        await tick();
        await tick();
        h.latest().receive(HELLO);
        await tick();
        h.latest().receive({ op: 0, s: 1, t: 'RESUMED', d: {} });
      }
      expect(h.sockets).toHaveLength(7); // one per round, not 2^6
    });

    it('retires the old socket so it can neither beat nor reconnect', async () => {
      const h = build();
      const old = await ready1(h);
      old.receive({ op: 7 });
      await tick();
      await tick();
      expect(h.sockets).toHaveLength(2);
      expect(old.listenerCount()).toBe(0);

      // Anything the retired socket still emits is not ours to act on.
      old.emit('close', { code: 1006, reason: '' });
      old.receive({ op: 7 });
      await tick();
      await tick();
      expect(h.sockets).toHaveLength(2);
    });

    it('leaves no heartbeat interval behind when a connection is replaced', async () => {
      // Two intervals sharing one connection's ack state is what made healthy
      // sockets look like zombies.
      const h = build();
      await ready1(h);
      expect(h.liveTimers()).toBe(1);

      h.latest().receive({ op: 7 });
      await tick();
      await tick();
      expect(h.liveTimers()).toBe(0);

      h.latest().receive(HELLO);
      await tick();
      expect(h.liveTimers()).toBe(1);
    });

    it('holds one reconnect chain even when closes arrive while it is sleeping', async () => {
      // A slow backoff used to be a window in which every further close added
      // another chain, each with its own socket at the end of it.
      // Every parked sleep is collected, so releasing them all reveals exactly
      // how many chains were waiting rather than only the last one.
      const releases: (() => void)[] = [];
      const sockets: FakeSocket[] = [];
      const gateway = new DiscordGateway({
        token: () => 'TOKEN',
        gatewayUrl: async () => 'wss://gateway.example',
        socketFactory: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        sleep: (ms) => (ms >= 500 ? new Promise<void>((r) => releases.push(r)) : Promise.resolve()),
        random: () => 0.5,
        log: () => undefined,
        setIntervalImpl: () => 1,
        clearIntervalImpl: () => undefined,
      });
      await gateway.connect();
      sockets[0].serverClose(1006); // starts the one chain, now parked in sleep
      await tick();
      expect(sockets).toHaveLength(1);

      // More closes while it sleeps. None of them may start a chain of its own.
      for (let i = 0; i < 5; i++) {
        sockets[0].emit('close', { code: 1006, reason: '' });
        await tick();
      }
      expect(releases).toHaveLength(1);
      for (const r of releases) r();
      await tick();
      await tick();
      expect(sockets).toHaveLength(2);
      gateway.dispose();
    });

    it('abandons a sleeping reconnect if the gateway is disconnected meanwhile', async () => {
      const releases: (() => void)[] = [];
      const sockets: FakeSocket[] = [];
      const gateway = new DiscordGateway({
        token: () => 'TOKEN',
        gatewayUrl: async () => 'wss://gateway.example',
        socketFactory: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        sleep: (ms) => (ms >= 500 ? new Promise<void>((r) => releases.push(r)) : Promise.resolve()),
        random: () => 0.5,
        log: () => undefined,
        setIntervalImpl: () => 1,
        clearIntervalImpl: () => undefined,
      });
      await gateway.connect();
      sockets[0].serverClose(1006);
      await tick();

      await gateway.disconnect(); // the Discord switch goes off
      for (const r of releases) r();
      await tick();
      await tick();
      expect(sockets).toHaveLength(1); // the sleeping chain woke and stood down
      gateway.dispose();
    });
  });

  it('ignores a frame that is not JSON', async () => {
    const { gateway, latest } = build();
    await gateway.connect();
    expect(() => latest().emit('message', { data: 'not json at all' })).not.toThrow();
    gateway.dispose();
  });
});

describe('DiscordGateway.wake (the machine woke from sleep)', () => {
  it('drops the connection and resumes on a new one at once, without backoff', async () => {
    const h = build();
    await h.gateway.connect();
    const first = h.latest();
    first.receive(HELLO);
    await tick();
    first.receive(ready('sess-9'));
    const sleepsBefore = h.sleeps.length;

    h.gateway.wake();
    await tick();
    await tick();
    expect(first.closedWith).toEqual([4000]); // not 1000: the session stays resumable
    expect(h.sockets).toHaveLength(2);
    expect(h.gateway.connected).toBe(false);
    // No backoff sleep before dialling again.
    expect(h.sleeps.slice(sleepsBefore).filter((ms) => ms >= 1000)).toEqual([]);

    const second = h.latest();
    second.receive(HELLO);
    await tick();
    expect(second.lastOf(6)?.d).toMatchObject({ session_id: 'sess-9' }); // RESUME, not IDENTIFY
    expect(h.liveTimers()).toBeLessThanOrEqual(1);
    h.gateway.dispose();
  });

  it('does nothing when the gateway is not meant to be open', async () => {
    const h = build();
    h.gateway.wake();
    await tick();
    expect(h.sockets).toHaveLength(0);
    h.gateway.dispose();
  });
});
