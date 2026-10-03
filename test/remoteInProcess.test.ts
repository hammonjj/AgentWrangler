/**
 * Discord folded into the core daemon (#138), with fakes throughout: a fake
 * Discord, a fake `security` for the Keychain, fake launchd and processes.
 *
 * - the in-process factory applies a press through the core's actions, as
 *   Discord, and through the access gate;
 * - the token comes from the Keychain;
 * - the old remote daemon's LaunchAgent (Electron-era builds) is booted out
 *   and removed, and one an unpackaged build spawned is stopped, before
 *   anything connects;
 * - one connector after another: a card the last connector posted is adopted
 *   by the next one (a daemon restart or update), not posted again.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccessGate, ActionName, RequestContext } from '../src/core/access';
import { DEFAULT_CONFIG, type WranglerConfig } from '../src/core/config';
import { Emitter, type Disposable } from '../src/core/events';
import { KeychainSecrets, type SecurityRunner } from '../src/core/keychainSecrets';
import { currentRequest } from '../src/core/requestScope';
import { remoteDaemonPaths, retireRemoteDaemon } from '../src/node/remoteDaemonAgent';
import { MemoryAuditLog } from '../src/remote/audit';
import { createInProcessRemoteControl } from '../src/remote/inProcess';
import type { RemoteClose, RemoteInvocation, RemoteMessageRef, RemoteTransport } from '../src/remote/transport';
import type { SessionDTO } from '../src/shared/model';
import type { RemoteAsk, RemoteNotice } from '../src/shared/remote';
import type { SessionActions } from '../src/ui/actions';

class FakeTransport implements RemoteTransport {
  readonly id = 'fake';
  connected = false;
  published: { interactionId: string; ask: RemoteAsk }[] = [];
  closed: RemoteClose[] = [];
  replies: string[] = [];
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
  async notify(_notice: RemoteNotice) {}
  dispose() {}
  press(interactionId: string, choiceId: string) {
    this.invoke.fire({ interactionId, choiceId, actor: { id: 'U1', displayName: 'T' }, scope: { guildId: 'G1', channelId: 'C1' } });
  }
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

/** `security`, as far as the Keychain uses it: one stored item, or none. */
function fakeSecurity(token: string | undefined): SecurityRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    available: () => true,
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'find-generic-password' && token) return { code: 0, stdout: `${token}\n`, stderr: '' };
      return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    },
  };
}

/** Every call the core's actions get, with the request each ran in. */
function recordingActions(): { actions: SessionActions; calls: { method: string; args: unknown[]; ctx: RequestContext | undefined }[] } {
  const calls: { method: string; args: unknown[]; ctx: RequestContext | undefined }[] = [];
  const actions = new Proxy({} as SessionActions, {
    get: (_t, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args, ctx: currentRequest() });
      return 'applied';
    },
  });
  return { actions, calls };
}

function recordingGate(allow = true): AccessGate & { admitted: { ctx: RequestContext; action: ActionName }[] } {
  const admitted: { ctx: RequestContext; action: ActionName }[] = [];
  return {
    admitted,
    admit(ctx, action) {
      admitted.push({ ctx, action });
      return allow;
    },
    loginFailed() {},
  };
}

function listOf(initial: SessionDTO[]) {
  const changed = new Emitter<void>();
  const list = { sessions: initial, changed };
  return {
    list,
    feed: {
      get sessions() {
        return list.sessions;
      },
      onDidUpdate: (l: () => void) => changed.event(l),
    },
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir: string;
beforeEach(() => {
  // Short: a Unix socket path must fit in 104 bytes.
  dir = fs.mkdtempSync(path.join('/tmp', 'awrc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Discord in the core daemon (createInProcessRemoteControl)', () => {
  it('applies a press through the core actions, as Discord, through the gate', async () => {
    const transports: FakeTransport[] = [];
    const { actions, calls } = recordingActions();
    const gate = recordingGate();
    const { feed } = listOf([blocked()]);
    const rc = createInProcessRemoteControl({
      sessions: feed,
      ready: () => true,
      actions,
      gate,
      getConfig: () => enabled,
      secrets: { get: async () => 'tok-kc' },
      log: () => undefined,
      homeDir: '/Users/test',
      makeTransport: (t) => {
        const tr = new FakeTransport(t);
        transports.push(tr);
        return tr;
      },
      mirrorFile: path.join(dir, 'mirrors.json'),
      audit: new MemoryAuditLog(),
    });
    await rc.sync();
    await until(() => transports[0]?.published.length === 1);
    const t = transports[0];
    expect(t.token).toBe('tok-kc');

    t.press(t.published[0].interactionId, 'allow');
    await until(() => calls.length === 1);
    expect(calls[0].method).toBe('decidePermission');
    expect(calls[0].args.slice(0, 2)).toEqual(['claude:sess-a', 'allow']);
    expect(calls[0].ctx).toMatchObject({ via: 'discord', principal: { id: 'local-owner', kind: 'owner' } });
    expect(gate.admitted).toHaveLength(1);
    expect(gate.admitted[0]).toMatchObject({ action: 'session.decide', ctx: { via: 'discord' } });
    expect(rc.status()).toMatchObject({ pid: process.pid, hasToken: true, connected: true, mirrored: 1 });
    await rc.dispose();
  });

  it('applies nothing the gate refuses, and keeps the card', async () => {
    const transports: FakeTransport[] = [];
    const { actions, calls } = recordingActions();
    const { feed } = listOf([blocked()]);
    const rc = createInProcessRemoteControl({
      sessions: feed,
      ready: () => true,
      actions,
      gate: recordingGate(false),
      getConfig: () => enabled,
      secrets: { get: async () => 'tok-kc' },
      log: () => undefined,
      makeTransport: (t) => {
        const tr = new FakeTransport(t);
        transports.push(tr);
        return tr;
      },
      mirrorFile: path.join(dir, 'mirrors.json'),
      audit: new MemoryAuditLog(),
    });
    await rc.sync();
    await until(() => transports[0]?.published.length === 1);
    transports[0].press(transports[0].published[0].interactionId, 'allow');
    await until(() => transports[0].replies.length === 1);
    await rc.whenIdle();
    expect(calls).toEqual([]);
    expect(transports[0].closed).toEqual([]);
    await rc.dispose();
  });

  it('reads the bot token from the Keychain, and follows it being removed', async () => {
    const transports: FakeTransport[] = [];
    let stored: string | undefined = 'tok-kc';
    const security: SecurityRunner & { calls: string[][] } = {
      calls: [],
      available: () => true,
      run: async (args) => {
        security.calls.push(args);
        if (args[0] === 'find-generic-password' && stored) return { code: 0, stdout: `${stored}\n`, stderr: '' };
        return { code: 44, stdout: '', stderr: 'not found' };
      },
    };
    const { feed } = listOf([]);
    const rc = createInProcessRemoteControl({
      sessions: feed,
      ready: () => true,
      actions: recordingActions().actions,
      gate: recordingGate(),
      getConfig: () => enabled,
      secrets: new KeychainSecrets(security),
      log: () => undefined,
      makeTransport: (t) => {
        const tr = new FakeTransport(t);
        transports.push(tr);
        return tr;
      },
      mirrorFile: path.join(dir, 'mirrors.json'),
      audit: new MemoryAuditLog(),
    });
    await rc.sync();
    expect(security.calls[0]).toEqual(['find-generic-password', '-s', 'Agent Wrangler', '-a', 'remote.discord.botToken', '-w']);
    expect(transports.map((t) => t.token)).toEqual(['tok-kc']);
    expect(transports[0].connected).toBe(true);

    // Disconnect Discord: the item is deleted, and the next sync hangs up.
    stored = undefined;
    await rc.sync();
    expect(transports[0].connected).toBe(false);
    expect(rc.status().hasToken).toBe(false);
    await rc.dispose();
  });

  it('does not touch the Keychain while Discord integration is off', async () => {
    const security = fakeSecurity('tok-kc');
    const transports: FakeTransport[] = [];
    const { feed } = listOf([]);
    const rc = createInProcessRemoteControl({
      sessions: feed,
      ready: () => true,
      actions: recordingActions().actions,
      gate: recordingGate(),
      getConfig: () => ({ ...enabled, remoteEnabled: false }),
      secrets: new KeychainSecrets(security),
      log: () => undefined,
      makeTransport: (t) => {
        const tr = new FakeTransport(t);
        transports.push(tr);
        return tr;
      },
      mirrorFile: path.join(dir, 'mirrors.json'),
      audit: new MemoryAuditLog(),
    });
    await rc.sync();
    expect(security.calls).toEqual([]);
    expect(transports).toEqual([]);
    await rc.dispose();
  });
});

describe('retireRemoteDaemon', () => {
  function runFiles() {
    const runDirs = { runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb') };
    const paths = remoteDaemonPaths(runDirs);
    fs.mkdirSync(runDirs.runDir, { recursive: true });
    return { runDirs, paths };
  }

  it('boots out the LaunchAgent, deletes its plist, and waits for the daemon to exit', async () => {
    const { runDirs, paths } = runFiles();
    const plistPath = path.join(dir, 'LaunchAgents', 'com.hammonjj.agentwrangler.remote.plist');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, '<plist/>');
    fs.writeFileSync(paths.manifestPath, JSON.stringify({ pid: 4242, build: 'b0', startedAt: 1 }));
    fs.writeFileSync(paths.tokenPath, 'secret');
    const launchctl: string[][] = [];
    let running = true;
    const killed: string[] = [];
    const result = await retireRemoteDaemon({
      runDirs,
      log: () => undefined,
      plistPath,
      domain: 'gui/501',
      launchctl: async (args) => {
        launchctl.push(args);
        if (args[0] === 'bootout') setTimeout(() => (running = false), 30); // launchd's SIGTERM, then the exit
        return '';
      },
      probe: async () => running,
      alive: (pid) => pid === 4242 && running,
      kill: (pid, signal) => killed.push(`${pid}:${signal}`),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(launchctl).toEqual([['bootout', 'gui/501/com.hammonjj.agentwrangler.remote']]);
    expect(fs.existsSync(plistPath)).toBe(false);
    expect(killed).toEqual([]); // launchd stopped it
    expect(result).toEqual({ removedLaunchAgent: true, wasRunning: true, exited: true });
    expect(fs.existsSync(paths.manifestPath)).toBe(false);
    expect(fs.existsSync(paths.tokenPath)).toBe(false);
  });

  it('stops a daemon the unpackaged app spawned (no LaunchAgent) with SIGTERM', async () => {
    const { runDirs, paths } = runFiles();
    fs.writeFileSync(paths.manifestPath, JSON.stringify({ pid: 4243, build: 'dev', startedAt: 1 }));
    let running = true;
    const killed: string[] = [];
    const launchctl: string[][] = [];
    const result = await retireRemoteDaemon({
      runDirs,
      log: () => undefined,
      plistPath: path.join(dir, 'none.plist'),
      launchctl: async (args) => {
        launchctl.push(args);
        return '';
      },
      probe: async () => running,
      alive: () => running,
      kill: (pid, signal) => {
        killed.push(`${pid}:${signal}`);
        setTimeout(() => (running = false), 20);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(launchctl).toEqual([]);
    expect(killed).toEqual(['4243:SIGTERM']);
    expect(result).toEqual({ removedLaunchAgent: false, wasRunning: true, exited: true });
  });

  it('signals nobody when nothing answers, whatever a stale manifest says', async () => {
    const { runDirs, paths } = runFiles();
    fs.writeFileSync(paths.manifestPath, JSON.stringify({ pid: 4244, build: 'old', startedAt: 1 }));
    const killed: string[] = [];
    const result = await retireRemoteDaemon({
      runDirs,
      log: () => undefined,
      plistPath: path.join(dir, 'none.plist'),
      launchctl: async () => '',
      probe: async () => false,
      alive: () => true, // a recycled pid
      kill: (pid, signal) => killed.push(`${pid}:${signal}`),
    });
    expect(killed).toEqual([]);
    expect(result).toEqual({ removedLaunchAgent: false, wasRunning: false, exited: true });
    expect(fs.existsSync(paths.manifestPath)).toBe(false);
  });
});

describe('one connector after another', () => {
  it('the next daemon adopts the card the last one posted, rather than posting it again', async () => {
    const mirrorFile = path.join(dir, 'mirrors.json');
    const audit = new MemoryAuditLog();

    // The daemon before an update or a restart posts the card.
    const before: FakeTransport[] = [];
    const first = createInProcessRemoteControl({
      sessions: listOf([blocked()]).feed,
      ready: () => true,
      actions: recordingActions().actions,
      gate: recordingGate(),
      getConfig: () => enabled,
      secrets: new KeychainSecrets(fakeSecurity('tok-kc')),
      log: () => undefined,
      makeTransport: (t) => {
        const tr = new FakeTransport(t);
        before.push(tr);
        return tr;
      },
      mirrorFile,
      audit,
    });
    await first.sync();
    await first.reconcile();
    await until(() => before[0]?.published.length === 1);
    const posted = before[0].published[0].interactionId;

    // It stops: hung up, the map written, the card left up for the next one.
    await first.dispose();
    expect(before[0].connected).toBe(false);
    expect(before[0].closed).toEqual([]); // the card stays up

    const after: FakeTransport[] = [];
    const { actions, calls } = recordingActions();
    const { feed } = listOf([blocked()]);
    const rc = createInProcessRemoteControl({
      sessions: feed,
      ready: () => true,
      actions,
      gate: recordingGate(),
      getConfig: () => enabled,
      secrets: new KeychainSecrets(fakeSecurity('tok-kc')),
      log: () => undefined,
      makeTransport: (t) => {
        const tr = new FakeTransport(t);
        after.push(tr);
        return tr;
      },
      mirrorFile,
      audit,
    });
    await rc.sync();
    await rc.whenIdle();
    expect(after).toHaveLength(1);
    expect(after[0].connected).toBe(true);
    expect(after[0].published).toEqual([]); // no duplicate
    expect(rc.status().mirrored).toBe(1);

    // And a press on the old card lands in the core.
    after[0].press(posted, 'allow');
    await until(() => calls.length === 1);
    expect(calls[0].args.slice(0, 2)).toEqual(['claude:sess-a', 'allow']);
    await rc.dispose();
  });
});
