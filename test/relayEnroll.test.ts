import { describe, expect, it } from 'vitest';
import type { RelayChannel, RelayNetwork } from '../src/remote/relay/network';
import { ENROLL_FAILURES_PER_HOUR, EnrollLimiter, startRelayLink } from '../src/remote/relay/relayLink';
import {
  RELAY_CONNECT_WINDOW_MS,
  RELAY_EVENT_ENROLL,
  RELAY_EVENT_ENROLLED,
  connectionTopic,
  deriveRelayPassword,
  lobbyTopic,
  newEnrollKeyPair,
  newRelayId,
  newRelayKey,
  openEnroll,
  openEnrollReply,
  parseEnrollReply,
  parseEnrollRequest,
  sealEnroll,
  sealEnrollReply,
} from '../src/shared/relay';

const UID = '00000000-0000-4000-8000-000000000001';
/** Few iterations: the derivation is the same, only slower in production. */
const ITER = 1000;

describe('remote password derivation (#187)', () => {
  it('gives the same values on both ends, independent of each other, and salted by email', async () => {
    const a = await deriveRelayPassword('Me@Example.com ', 'correct horse battery', ITER);
    const b = await deriveRelayPassword('me@example.com', 'correct horse battery', ITER);
    expect(a).toEqual(b);
    expect(a.authValue).toMatch(/^[0-9a-f]{64}$/);
    expect(a.enrollKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.authValue).not.toContain('correct');
    expect((await deriveRelayPassword('other@example.com', 'correct horse battery', ITER)).enrollKey).not.toBe(a.enrollKey);
    expect((await deriveRelayPassword('me@example.com', 'correct horse batterz', ITER)).authValue).not.toBe(a.authValue);
  });
});

describe('enrollment messages (#187)', () => {
  it('round-trips a request and a reply', async () => {
    const enrollKey = newRelayKey();
    const t = newRelayId();
    const own = await newEnrollKeyPair();
    const req = parseEnrollRequest(JSON.parse(JSON.stringify(await sealEnroll(enrollKey, UID, t, own.pub, 'iPhone', 1_000_000))))!;
    const body = await openEnroll(enrollKey, req, UID, 1_000_000);
    expect(body).toEqual({ pub: own.pub, label: 'iPhone' });
    const key = newRelayKey();
    const reply = parseEnrollReply(JSON.parse(JSON.stringify(await sealEnrollReply(enrollKey, UID, t, body!.pub, 'dev-1', key))))!;
    expect(await openEnrollReply(enrollKey, UID, t, own, reply)).toEqual({ deviceId: 'dev-1', key });
  });

  it('refuses a request under another key, for another lobby, or out of time', async () => {
    const enrollKey = newRelayKey();
    const t = newRelayId();
    const own = await newEnrollKeyPair();
    const req = await sealEnroll(enrollKey, UID, t, own.pub, 'x', 1_000_000);
    expect(await openEnroll(newRelayKey(), req, UID, 1_000_000)).toBeUndefined();
    expect(await openEnroll(enrollKey, req, '00000000-0000-4000-8000-000000000002', 1_000_000)).toBeUndefined();
    expect(await openEnroll(enrollKey, { ...req, t: newRelayId() }, UID, 1_000_000)).toBeUndefined();
    expect(await openEnroll(enrollKey, req, UID, 1_000_000 + RELAY_CONNECT_WINDOW_MS + 1)).toBeUndefined();
  });

  it('a reply opens only for the device that asked, and only with the enrollment key', async () => {
    const enrollKey = newRelayKey();
    const t = newRelayId();
    const own = await newEnrollKeyPair();
    const reply = await sealEnrollReply(enrollKey, UID, t, own.pub, 'dev-1', newRelayKey());
    expect(await openEnrollReply(newRelayKey(), UID, t, own, reply)).toBeUndefined();
    expect(await openEnrollReply(enrollKey, UID, t, await newEnrollKeyPair(), reply)).toBeUndefined();
    expect(await openEnrollReply(enrollKey, UID, newRelayId(), own, reply)).toBeUndefined();
    // Someone without the enrollment key answering with their own key pair.
    const forged = await sealEnrollReply(newRelayKey(), UID, t, own.pub, 'evil', newRelayKey());
    expect(await openEnrollReply(enrollKey, UID, t, own, forged)).toBeUndefined();
  });
});

describe('enroll limiter', () => {
  it('pauses for an hour after the fifth failure in an hour', () => {
    const l = new EnrollLimiter();
    for (let i = 1; i < ENROLL_FAILURES_PER_HOUR; i++) expect(l.fail(i)).toBe(false);
    expect(l.open(10)).toBe(true);
    expect(l.fail(10)).toBe(true);
    expect(l.open(11)).toBe(false);
    expect(l.pausedUntilAt(11)).toBe(10 + 60 * 60 * 1000);
    expect(l.open(10 + 60 * 60 * 1000)).toBe(true);
  });

  it('forgets failures older than an hour', () => {
    const l = new EnrollLimiter();
    for (let i = 0; i < ENROLL_FAILURES_PER_HOUR - 1; i++) l.fail(i);
    expect(l.fail(60 * 60 * 1000 + 10)).toBe(false);
  });
});

// ---- the daemon's side, over an in-memory relay ----

class Topic {
  members = new Set<Chan>();
}
class Chan implements RelayChannel {
  listeners = new Map<string, ((p: unknown) => void)[]>();
  constructor(
    private topics: Map<string, Topic>,
    readonly name: string,
  ) {
    this.topic().members.add(this);
  }
  private topic(): Topic {
    let t = this.topics.get(this.name);
    if (!t) this.topics.set(this.name, (t = new Topic()));
    return t;
  }
  async send(event: string, payload: unknown, self = false): Promise<void> {
    for (const m of this.topic().members) if (self || m !== this) for (const l of m.listeners.get(event) ?? []) l(JSON.parse(JSON.stringify(payload)));
  }
  httpSend(event: string, payload: unknown): Promise<void> {
    return this.send(event, payload, true);
  }
  on(event: string, listener: (p: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  async leave(): Promise<void> {
    this.topic().members.delete(this);
  }
}

async function setup(enrollKey: string | undefined, limiter = new EnrollLimiter()) {
  const topics = new Map<string, Topic>();
  const net: RelayNetwork = { uid: UID, join: async (t) => new Chan(topics, t), heartbeat: async () => undefined, dispose: () => undefined };
  const issued: { id: string; key: string; label: string }[] = [];
  const logs: string[] = [];
  const link = await startRelayLink({
    network: net,
    keyOf: () => undefined,
    attach: () => undefined,
    build: () => 'b1',
    daemonId: 'd',
    log: (l) => logs.push(l),
    probeMs: 60_000,
    probeTimeoutMs: 50,
    enroll: {
      key: () => enrollKey,
      issue: (label) => {
        const d = { id: `dev-${issued.length + 1}`, key: newRelayKey(), label };
        issued.push(d);
        return d;
      },
      limiter,
    },
  });
  /** A phone asking with `key`: what the daemon answered, or undefined. */
  const ask = async (key: string) => {
    const t = newRelayId();
    const own = await newEnrollKeyPair();
    const replyChan = new Chan(topics, connectionTopic(UID, t));
    let got: unknown;
    replyChan.on(RELAY_EVENT_ENROLLED, (p) => (got = p));
    await new Chan(topics, lobbyTopic(UID)).httpSend(RELAY_EVENT_ENROLL, await sealEnroll(key, UID, t, own.pub, 'iPhone', Date.now()));
    for (let i = 0; i < 50 && got === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    const reply = parseEnrollReply(got);
    return reply ? openEnrollReply(key, UID, t, own, reply) : undefined;
  };
  return { link, issued, logs, ask };
}

describe('relay link enrollment (#187)', () => {
  it('issues a device to a phone that knows the enrollment key', async () => {
    const enrollKey = newRelayKey();
    const { link, issued, ask } = await setup(enrollKey);
    const got = await ask(enrollKey);
    expect(got).toEqual({ deviceId: 'dev-1', key: issued[0].key });
    expect(issued[0].label).toBe('iPhone');
    link.dispose();
  });

  it('issues nothing for a wrong key, and pauses after five wrong tries', async () => {
    const enrollKey = newRelayKey();
    const { link, issued, logs, ask } = await setup(enrollKey);
    for (let i = 0; i < ENROLL_FAILURES_PER_HOUR; i++) expect(await ask(newRelayKey())).toBeUndefined();
    expect(logs.some((l) => l.includes('pausing enrollment'))).toBe(true);
    // Even the right key is refused while paused.
    expect(await ask(enrollKey)).toBeUndefined();
    expect(issued).toEqual([]);
    link.dispose();
  });

  it('issues nothing while password sign-in is off', async () => {
    const { link, issued, ask } = await setup(undefined);
    expect(await ask(newRelayKey())).toBeUndefined();
    expect(issued).toEqual([]);
    link.dispose();
  });
});
