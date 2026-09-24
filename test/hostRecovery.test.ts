import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_LOG_KEEP_MS, HostSupervisor } from '../src/core/session/hostSupervisor';
import {
  HOST_LOST,
  IDLE_PARKED,
  autoResumeCandidate,
  classifyOnStartup,
  deadHostOutcome,
  outcomesFromDeadHosts,
} from '../src/core/session/recovery';
import type { SessionRecord } from '../src/core/session/sessionRegistry';
import { decorateSession, withHostedPermission } from '../src/core/sessionView';
import { IdleRule } from '../src/sessionHost/idleRule';
import { backgroundTaskCount, type HostManifest } from '../src/shared/sessionProtocol';
import type { AgentSession } from '../src/shared/model';

/**
 * Stage 4's pure rules: what a dead host's exit record means for its session
 * at startup (§7.3), which sessions come back by themselves, the idle-orphan
 * rule (§7.5), and how a host-held permission reaches the row and the remote.
 */

const HOUR = 60 * 60 * 1000;

function manifest(over: Partial<HostManifest>): HostManifest {
  return {
    v: 1,
    hostId: 'abcdefgh',
    provider: 'claude',
    sessionId: 's1',
    cwd: '/Users/test/proj',
    hostPid: 4321,
    socketPath: '/tmp/x.sock',
    protocol: 1,
    hostBuild: 'b',
    sdkVersion: 'test',
    startedAt: 1000,
    ...over,
  };
}

function rec(sessionId: string, state: SessionRecord['state'] = 'live', over: Partial<SessionRecord> = {}): SessionRecord {
  return { v: 1, sessionId, provider: 'claude', cwd: '/Users/test/proj', launch: {}, state, createdAt: 0, lastShownAt: 0, updatedAt: 0, ...over };
}

describe('deadHostOutcome (§7.3 step 2)', () => {
  const exit = (e: Partial<NonNullable<HostManifest['exit']>>) => ({ at: 1, lastSeq: 1, ...e });

  it.each([
    [undefined, 'interrupted', HOST_LOST],
    [exit({ reason: 'ended' }), 'ended', 'ended'],
    [exit({}), 'ended', 'ended'],
    [exit({ reason: 'stopped' }), 'interrupted', 'host stopped'],
    [exit({ reason: 'stopped', trigger: 'idleTimeout' }), 'stopped', IDLE_PARKED],
    [exit({ reason: 'signal', hostSignal: 'SIGTERM' }), 'interrupted', 'host signalled (SIGTERM)'],
    [exit({ reason: 'error', error: 'boom' }), 'failed', 'boom'],
    [exit({ reason: 'crashed', error: 'session host crashed: x' }), 'failed', 'session host crashed: x'],
    [exit({ reason: 'someFutureReason' as never }), 'failed', 'host exit: someFutureReason'],
  ])('%j → %s (%s)', (e, state, reason) => {
    expect(deadHostOutcome({ exit: e as HostManifest['exit'] })).toEqual({ state, reason });
  });

  it('lets the newest host decide when a session had several (a migration leaves the old one behind)', () => {
    const outcomes = outcomesFromDeadHosts([
      manifest({ hostId: 'old', sessionId: 'S1', startedAt: 1, exit: { reason: 'stopped', at: 1, lastSeq: 1 } }),
      manifest({ hostId: 'new', sessionId: 's1', startedAt: 2 }),
    ]);
    expect(outcomes.get('s1')).toMatchObject({ state: 'interrupted', reason: HOST_LOST, hostStartedAt: 2 });
  });

  it('calls a recordless host that the machine has booted since a restart, not a crash (auto-resumable)', () => {
    const lost = manifest({ sessionId: 's1', startedAt: 1000 });
    expect(outcomesFromDeadHosts([lost], 5000).get('s1')).toMatchObject({ state: 'interrupted', reason: 'machine restarted' });
    expect(outcomesFromDeadHosts([lost], 500).get('s1')).toMatchObject({ reason: HOST_LOST });
  });
});

describe('classifyOnStartup ignores a dead host older than the current run', () => {
  it('a host that failed before the session was brought back does not decide it', () => {
    const now = 100 * HOUR;
    const dead = new Map([['s', { state: 'failed' as const, reason: 'old error', hostStartedAt: 10 * HOUR }]]);
    const { records, interrupted } = classifyOnStartup([rec('s', 'live', { lastShownAt: now, liveSince: 50 * HOUR })], now, new Set(), dead);
    expect(records[0]).toMatchObject({ state: 'interrupted', endedReason: 'app-restart' });
    expect(interrupted).toHaveLength(1);
    // The host of this run does.
    const same = new Map([['s', { state: 'failed' as const, reason: 'boom', hostStartedAt: 50 * HOUR + 5 }]]);
    expect(classifyOnStartup([rec('s', 'live', { lastShownAt: now, liveSince: 50 * HOUR })], now, new Set(), same).records[0]).toMatchObject({ state: 'failed' });
  });
});

describe('classifyOnStartup with dead hosts', () => {
  const now = 10 * HOUR;

  it('applies what a dead host reported, and lists only sessions left interrupted', () => {
    const dead = new Map([
      ['ended', { state: 'ended' as const, reason: 'ended' }],
      ['failed', { state: 'failed' as const, reason: 'boom' }],
      ['parked', { state: 'stopped' as const, reason: IDLE_PARKED }],
      ['lost', { state: 'interrupted' as const, reason: HOST_LOST }],
    ]);
    const records = ['ended', 'failed', 'parked', 'lost', 'plain'].map((id) => rec(id, 'live', { lastShownAt: now - HOUR }));
    const { records: out, interrupted } = classifyOnStartup(records, now, new Set(), dead);
    const byId = new Map(out.map((r) => [r.sessionId, r]));
    expect(byId.get('ended')).toMatchObject({ state: 'ended' });
    expect(byId.get('failed')).toMatchObject({ state: 'failed', endedReason: 'boom' });
    expect(byId.get('parked')).toMatchObject({ state: 'stopped', endedReason: IDLE_PARKED });
    expect(byId.get('lost')).toMatchObject({ state: 'interrupted', endedReason: HOST_LOST });
    expect(byId.get('plain')).toMatchObject({ state: 'interrupted', endedReason: 'app-restart' });
    expect(interrupted.map((r) => r.sessionId).sort()).toEqual(['lost', 'plain']);
  });

  it("keeps what this app recorded for a session it had already stopped (Close), whatever the host's record says", () => {
    const dead = new Map([['closed', { state: 'interrupted' as const, reason: 'host stopped' }]]);
    const { records } = classifyOnStartup([rec('closed', 'stopped', { lastShownAt: now })], now, new Set(), dead);
    expect(records[0]).toMatchObject({ state: 'stopped' });
  });

  it('a live host beats any dead one for the same session', () => {
    const dead = new Map([['s', { state: 'failed' as const, reason: 'x' }]]);
    const { records } = classifyOnStartup([rec('s', 'live', { lastShownAt: now })], now, new Set(['s']), dead);
    expect(records[0]).toMatchObject({ state: 'live' });
  });
});

describe('autoResumeCandidate after a host crash', () => {
  it('never brings back a session whose host was lost (crash loops), though its row still offers Resume', () => {
    const now = 10 * HOUR;
    const lost = rec('lost', 'interrupted', { endedReason: HOST_LOST, lastShownAt: now - 1000 });
    const older = rec('older', 'interrupted', { endedReason: 'app-restart', lastShownAt: now - 2000 });
    expect(autoResumeCandidate([lost, older], now)).toBeUndefined();
    expect(autoResumeCandidate([older], now)?.sessionId).toBe('older');
  });
});

describe('IdleRule (§7.5)', () => {
  const idle = { clients: 0, state: 'idle' as const, pendingAsks: 0, backgroundTasks: 0 };

  it('parks an idle session nobody has connected to for the configured hours, once', () => {
    const rule = new IdleRule(24, 0);
    expect(rule.check(24 * HOUR - 1, idle)).toBe(false);
    expect(rule.check(24 * HOUR, idle)).toBe(true);
    expect(rule.check(25 * HOUR, idle)).toBe(false);
  });

  it('never parks a busy session, one waiting on an ask, or one with background tasks', () => {
    for (const s of [{ state: 'running' as const }, { pendingAsks: 1 }, { backgroundTasks: 2 }, { state: 'starting' as const }]) {
      const rule = new IdleRule(1, 0);
      expect(rule.check(100 * HOUR, { ...idle, ...s })).toBe(false);
    }
  });

  it('starts the clock again whenever a client is connected', () => {
    const rule = new IdleRule(1, 0);
    expect(rule.check(0.9 * HOUR, { ...idle, clients: 1 })).toBe(false);
    expect(rule.check(1.5 * HOUR, idle)).toBe(false);
    expect(rule.check(1.9 * HOUR, idle)).toBe(true);
  });

  it('0, negatives and nonsense mean never', () => {
    for (const hours of [0, -1, Number.NaN, 'x', undefined]) {
      const rule = new IdleRule(1, 0);
      rule.setHours(hours);
      expect(rule.check(1000 * HOUR, idle)).toBe(false);
    }
  });
});

describe('backgroundTaskCount', () => {
  it('reads the last background_tasks_changed, and treats an unreadable one as busy', () => {
    expect(backgroundTaskCount(undefined)).toBe(0);
    expect(backgroundTaskCount({})).toBe(0);
    expect(backgroundTaskCount({ 'system/background_tasks_changed': { tasks: [] } })).toBe(0);
    expect(backgroundTaskCount({ 'system/background_tasks_changed': { tasks: [{ task_id: 'a' }, { task_id: 'b' }] } })).toBe(2);
    expect(backgroundTaskCount({ 'system/background_tasks_changed': { tasks: 'garbled' } })).toBe(1);
    expect(backgroundTaskCount({ 'system/background_tasks_changed': { tasks: [{ task_id: 'w', ambient: true }, { task_id: 'b' }] } })).toBe(1);
  });
});

describe('HostSupervisor.collect: strays', () => {
  it("removes old logs and tokens of hosts that are gone, and nothing a manifest still names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awgc-'));
    try {
      const runDir = path.join(root, 'run');
      const logDir = path.join(root, 'logs');
      fs.mkdirSync(runDir, { recursive: true });
      fs.mkdirSync(logDir, { recursive: true });
      const old = (Date.now() - HOST_LOG_KEEP_MS - HOUR) / 1000;
      const put = (file: string, stale: boolean) => {
        fs.writeFileSync(file, 'x');
        if (stale) fs.utimesSync(file, old, old);
      };
      // A dead host with no exit record: its manifest is kept for the sweep, so are its files.
      fs.writeFileSync(path.join(runDir, 'keptkept.json'), JSON.stringify(manifest({ hostId: 'keptkept', hostPid: 999_999, startedAt: Date.now() })));
      put(path.join(logDir, 'host-keptkept.log'), true);
      put(path.join(runDir, 'keptkept.token'), true);
      put(path.join(logDir, 'host-gonegone.log'), true);
      put(path.join(logDir, 'host-freshfre.log'), false);
      put(path.join(runDir, 'strayabc.token'), true);
      put(path.join(runDir, 'newnewab.token'), false);
      const sup = new HostSupervisor({
        runDir,
        fallbackRunDir: path.join(root, 'fb'),
        logDir,
        runtime: { buildId: 't', prepare: async () => ({ exe: '', entry: '' }) },
        log: () => undefined,
        build: 't',
      });
      sup.collect(sup.scan());
      expect(fs.readdirSync(logDir).sort()).toEqual(['host-freshfre.log', 'host-keptkept.log']);
      expect(fs.readdirSync(runDir).sort()).toEqual(['keptkept.json', 'keptkept.token', 'newnewab.token']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('withHostedPermission', () => {
  const row: AgentSession = {
    provider: 'claude',
    sessionId: 's1',
    key: 'claude:s1',
    title: 't',
    cwd: '/Users/test/proj',
    projectName: 'proj',
    status: 'busy',
    lastActivityAt: 0,
  } as AgentSession;

  it("shows the host's ask as the row's pending prompt, answerable by its request id", () => {
    const out = withHostedPermission(row, { requestId: 'req-1', toolName: 'Bash', ask: { body: 'ls' } });
    expect(out).toMatchObject({ status: 'blocked', permissionRequestId: 'req-1', blockedReason: 'Bash', blockedAsk: { body: 'ls' } });
  });

  it("wins over the hook's marker and description, so a button approves exactly what it shows", () => {
    const out = withHostedPermission(
      { ...row, status: 'blocked', permissionRequestId: '123-456', blockedReason: 'Edit', blockedAsk: { body: 'other prompt' }, alwaysAllow: { rules: ['x'], destination: 'y' } } as AgentSession,
      { requestId: 'req-1', toolName: 'Bash', ask: { body: 'ls' } },
    );
    expect(out).toMatchObject({ permissionRequestId: 'req-1', blockedReason: 'Bash', blockedAsk: { body: 'ls' } });
    expect(out.alwaysAllow).toBeUndefined();
  });

  it('leaves a session without one alone (identity preserved)', () => {
    expect(withHostedPermission(row, undefined)).toBe(row);
    expect(decorateSession(row, { isArchived: () => false, isPaused: () => false, pendingPermission: () => undefined })).toBe(row);
  });

  it('is applied by decorateSession, which is what the remote reads', () => {
    const out = decorateSession(row, { isArchived: () => false, isPaused: () => false, pendingPermission: () => ({ requestId: 'r', toolName: 'Edit' }) });
    expect(out).toMatchObject({ status: 'blocked', permissionRequestId: 'r' });
  });
});
