/**
 * The remote daemon (#74) end to end over a real Unix socket: the daemon with a
 * fake Discord and a fake own feed, the app's `RemoteDaemonLink` with a fake
 * session list. What it pins is the handover: whichever feed is followed, a
 * card is posted once and kept, a press lands with the feed that can apply it,
 * and nothing is closed while no feed is ready.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type WranglerConfig } from '../src/core/config';
import { Emitter, type Disposable } from '../src/core/events';
import { MemoryAuditLog } from '../src/remote/audit';
import { RemoteDaemonLink } from '../src/remote/daemon/client';
import { RemoteDaemon, type OwnFeed } from '../src/remote/daemon/daemon';
import { remoteDaemonPaths } from '../src/remote/daemon/paths';
import type { RemoteClose, RemoteInvocation, RemoteMessageRef, RemoteTransport } from '../src/remote/transport';
import type { SessionDTO } from '../src/shared/model';
import type { RemoteAsk, RemoteNotice } from '../src/shared/remote';
import type { PermissionDecisionOutcome } from '../src/ui/actions';

class FakeTransport implements RemoteTransport {
  readonly id = 'fake';
  connected = false;
  published: { interactionId: string; ask: RemoteAsk }[] = [];
  closed: RemoteClose[] = [];
  replies: string[] = [];
  notices: RemoteNotice[] = [];
  private seq = 0;
  private invoke = new Emitter<RemoteInvocation>();
  private conn = new Emitter<void>();
  onDidInvoke = (l: (i: RemoteInvocation) => void): Disposable => this.invoke.event(l);
  onDidChangeConnection = (l: () => void): Disposable => this.conn.event(l);
  constructor(readonly token: string) {}
  async connect() {
    this.connected = true;
    this.conn.fire();
  }
  async disconnect() {
    this.connected = false;
    this.conn.fire();
  }
  async publish(interactionId: string, ask: RemoteAsk): Promise<RemoteMessageRef> {
    this.published.push({ interactionId, ask });
    return { channelId: 'C1', messageId: `M${this.seq++}` };
  }
  async update() {}
  async close(_ref: RemoteMessageRef, _ask: RemoteAsk, outcome: RemoteClose) {
    this.closed.push(outcome);
  }
  async reply(_i: RemoteInvocation, text: string) {
    this.replies.push(text);
  }
  async notify(notice: RemoteNotice) {
    this.notices.push(notice);
  }
  dispose() {}
  press(choiceId: string) {
    const last = this.published[this.published.length - 1];
    this.invoke.fire({ interactionId: last.interactionId, choiceId, actor: { id: 'U1', displayName: 'T' }, scope: { guildId: 'G1', channelId: 'C1' } });
  }
}

class FakeFeed implements OwnFeed {
  sessions: SessionDTO[] = [];
  ready = false;
  hostCount = 0;
  decided: string[] = [];
  private emitter = new Emitter<void>();
  onDidUpdate = (l: () => void) => this.emitter.event(l);
  async start() {}
  redecorate() {}
  set(sessions: SessionDTO[], ready = true) {
    this.sessions = sessions;
    this.ready = ready;
    this.emitter.fire();
  }
  async decidePermission(key: string, behavior: string): Promise<PermissionDecisionOutcome> {
    this.decided.push(`${key}:${behavior}`);
    return 'applied';
  }
  async answerQuestion(): Promise<PermissionDecisionOutcome> {
    return 'unsupported';
  }
  async decidePlan(): Promise<PermissionDecisionOutcome> {
    return 'unsupported';
  }
  dispose() {}
}

function blocked(requestId = '100-1'): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-a',
    key: 'claude:sess-a',
    title: 'agent-a',
    status: 'blocked',
    lastActivityAt: 1,
    permissionRequestId: requestId,
    blockedReason: 'Bash',
    blockedAsk: { summary: 'Run the tests', body: 'npm test', isCommand: true },
  };
}

const enabled: WranglerConfig = {
  ...DEFAULT_CONFIG,
  remoteEnabled: true,
  remoteGuildId: 'G1',
  remoteChannelId: 'C1',
  remoteAuthorizedUserIds: ['U1'],
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir: string;
let daemon: RemoteDaemon;
let transports: FakeTransport[];
let own: FakeFeed;
let link: RemoteDaemonLink | undefined;
let appSessions: { list: SessionDTO[]; ready: boolean; changed: Emitter<void> };
let appDecided: string[];
let config: WranglerConfig;
let token: string | null;
let appFails = false;

function newLink(): RemoteDaemonLink {
  return new RemoteDaemonLink({
    paths: remoteDaemonPaths({ runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb') }),
    build: 'b1',
    log: () => undefined,
    ensure: async () => undefined,
    replaceOutdated: false,
    configure: async () => ({ config, homeDir: '/Users/test', botToken: token }),
    sessions: {
      get sessions() {
        return appSessions.list;
      },
      onDidUpdate: (l) => appSessions.changed.event(l),
    },
    ready: () => appSessions.ready,
    extras: () => ({ archived: [], nicknames: {} }),
    actions: {
      decidePermission: async (key, behavior) => {
        if (appFails) throw new Error('the app is going away');
        appDecided.push(`${key}:${behavior}`);
        return 'applied';
      },
      answerQuestion: async () => 'applied',
      decidePlan: async () => 'applied',
    },
  });
}

beforeEach(async () => {
  // Short: a Unix socket path must fit in 104 bytes.
  dir = fs.mkdtempSync(path.join('/tmp', 'awrd-'));
  transports = [];
  own = new FakeFeed();
  appDecided = [];
  appFails = false;
  config = enabled;
  token = 'tok-1';
  appSessions = { list: [], ready: false, changed: new Emitter<void>() };
  const paths = remoteDaemonPaths({ runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb') });
  daemon = new RemoteDaemon({
    ...paths,
    runDir: path.join(dir, 'run'),
    build: 'b1',
    log: () => undefined,
    makeTransport: (t) => {
      const tr = new FakeTransport(t);
      transports.push(tr);
      return tr;
    },
    makeOwnFeed: () => own,
    mirrorFile: path.join(dir, 'mirrors.json'),
    audit: new MemoryAuditLog(),
  });
  await daemon.start();
});

afterEach(async () => {
  await link?.stop();
  link = undefined;
  await daemon.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const transport = () => transports[transports.length - 1];

describe('remote daemon', () => {
  it('does nothing until the app hands over a token, then connects with it', async () => {
    expect(daemon.status()).toMatchObject({ hasToken: false, connected: false, source: 'none' });
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    expect(transport().token).toBe('tok-1');
    expect(daemon.status()).toMatchObject({ hasToken: true, connected: true });
  });

  it('follows the app once its list is ready, and sends its presses back to it', async () => {
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    appSessions.list = [blocked()];
    appSessions.ready = true;
    link.pushSoon();
    await until(() => transport().published.length === 1);
    expect(daemon.status().source).toBe('app');
    transport().press('allow');
    await until(() => appDecided.length === 1);
    expect(appDecided).toEqual(['claude:sess-a:allow']);
    expect(own.decided).toEqual([]);
  });

  it('keeps the card when the app goes and its own feed carries on; a press then lands locally', async () => {
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    appSessions.list = [blocked()];
    appSessions.ready = true;
    link.pushSoon();
    await until(() => transport().published.length === 1);

    own.set([blocked()]); // the same ask, seen from the hook log
    await link.stop(); // the app quits
    link = undefined;
    await until(() => daemon.status().source === 'daemon');
    await daemon.whenIdle();
    expect(transport().published).toHaveLength(1);
    expect(transport().closed).toEqual([]);

    transport().press('deny');
    await until(() => own.decided.length === 1);
    expect(own.decided).toEqual(['claude:sess-a:deny']);
  });

  it('closes nothing while no feed is ready, and says so to a press', async () => {
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    appSessions.list = [blocked()];
    appSessions.ready = true;
    link.pushSoon();
    await until(() => transport().published.length === 1);

    await link.stop(); // gone, and the own feed has not finished its first scan
    link = undefined;
    await until(() => daemon.status().source === 'none');
    await daemon.whenIdle();
    expect(transport().closed).toEqual([]);

    transport().press('allow');
    await until(() => transport().replies.length === 1);
    expect(transport().replies[0]).toMatch(/catching up/);
    expect(own.decided).toEqual([]);
  });

  it('switching off closes the cards before it hangs up', async () => {
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    appSessions.list = [blocked()];
    appSessions.ready = true;
    link.pushSoon();
    await until(() => transport().published.length === 1);

    config = { ...enabled, remoteEnabled: false };
    token = null;
    await link.reconfigure();
    expect(transport().closed.map((c) => c.outcome)).toEqual(['cancelled']);
    expect(transport().connected).toBe(false);
    expect(daemon.status().hasToken).toBe(false);
  });

  it('keeps the card when the app cannot apply a press, rather than calling it answered', async () => {
    appFails = true;
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    appSessions.list = [blocked()];
    appSessions.ready = true;
    link.pushSoon();
    await until(() => transport().published.length === 1);
    transport().press('allow');
    await until(() => transport().replies.length === 1);
    expect(transport().replies[0]).toMatch(/could not apply/);
    await daemon.whenIdle();
    expect(transport().closed).toEqual([]);
  });

  it('stops promptly even while a connect is still in flight', async () => {
    link = newLink();
    link.start();
    const stopped = link.stop();
    await expect(Promise.race([stopped.then(() => 'stopped'), new Promise((r) => setTimeout(() => r('hung'), 2000))])).resolves.toBe('stopped');
    expect(link.connected).toBe(false);
    link = undefined;
  });

  it('forwards notices from the app', async () => {
    link = newLink();
    link.start();
    await until(() => transports.length === 1 && transport().connected);
    await link.notify({ title: 'done', body: 'agent-a finished', tone: 'info' } as RemoteNotice);
    expect(transport().notices.map((n) => n.title)).toEqual(['done']);
  });

  it('refuses a client without the token', async () => {
    fs.writeFileSync(path.join(dir, 'run', 'remote.token'), 'wrong');
    link = newLink();
    link.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(link.connected).toBe(false);
    expect(transports).toHaveLength(0);
  });
});

describe('remote daemon paths', () => {
  it('falls back to the short run directory when the socket path is too long', () => {
    const long = path.join(os.tmpdir(), 'x'.repeat(120));
    const p = remoteDaemonPaths({ runDir: long, fallbackRunDir: '/tmp/aw' });
    expect(p.socketPath).toBe('/tmp/aw/remote.sock');
    expect(p.tokenPath).toBe(path.join(long, 'remote.token'));
  });
});
