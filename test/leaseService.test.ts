/**
 * The core's lease service and the pure rules under it (#68): declared
 * resources, the file format the hook shares, acquire/bind/release, and the
 * reaper. Real files in a temp directory; processes are faked.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BIND_BY_MS,
  DEFAULT_LEASE_RESOURCES,
  MAX_WAIT_SEC,
  compileResourcesTsv,
  heldForText,
  parseLeaseResources,
  resourceOfKey,
  type LeaseResource,
} from '../src/shared/leases';
import { formatHolder, leaseSlug, parseHolder, reapReason, type HolderFile } from '../src/core/leases/leaseFiles';
import { FileLeaseService, qualifierFor } from '../src/core/leases/leaseService';
import type { SessionRecordState } from '../src/core/session/sessionRegistry';

const CORE_PID = 4242;
const AGENT_PID = 5151;

describe('declared resources', () => {
  it('ships aw-app, which compiles to rows the hook reads', () => {
    const { resources, errors } = parseLeaseResources(DEFAULT_LEASE_RESOURCES);
    expect(errors).toEqual([]);
    expect(resources.map((r) => r.key)).toEqual(['aw-app']);
    expect(compileResourcesTsv(resources).split('\n').filter(Boolean)).toEqual([
      'aw-app\tglobal\tcommand\t600\tbash\tnpm run app:install\tthe installed app',
      'aw-app\tglobal\tcommand\t600\tbash\tinstall-app\\.sh\tthe installed app',
      'aw-app\tglobal\tcommand\t600\tbash\tquit app "Agent Wrangler"\tthe installed app',
    ]);
  });

  it('compiles nothing to an empty file: the hook fast path', () => {
    expect(compileResourcesTsv([])).toBe('');
  });

  it('keeps the good entries and says what is wrong with the rest', () => {
    const { resources, errors } = parseLeaseResources([
      { key: 'Bad Key', match: { bash: ['x'] } },
      { key: 'ok', match: { bash: ['a\tb'] } },
      { key: 'ok2', match: { tools: ['('] } },
      { key: 'unity-editor', keyBy: 'repo', scope: 'turn', waitSec: 99999, match: { tools: ['^mcp__unity'] } },
      { key: 'unity-editor', match: {} },
      'nope',
    ]);
    expect(resources).toEqual([{ key: 'unity-editor', keyBy: 'repo', scope: 'turn', waitSec: MAX_WAIT_SEC, match: { tools: ['^mcp__unity'] } }]);
    expect(errors).toHaveLength(5);
  });

  it('orders rows by key, so every session takes several leases in one order', () => {
    const rs: LeaseResource[] = [
      { key: 'zeta', keyBy: 'global', scope: 'command', match: { bash: ['z'] } },
      { key: 'alpha', keyBy: 'global', scope: 'command', match: { bash: ['a'] } },
    ];
    expect(compileResourcesTsv(rs).split('\n')[0].startsWith('alpha\t')).toBe(true);
  });

  it('words a hold the way the deny message does', () => {
    expect(heldForText(0, 30_000)).toBe('for under a minute');
    expect(heldForText(0, 6 * 60_000 + 1)).toBe('for 6 min');
  });
});

describe('holder.json', () => {
  const h: HolderFile = { v: 1, resource: 'aw-app', attemptId: 'a1', pid: 1, pidStart: 'Tue Oct 13 10:00:00 2026', scope: 'session', since: 5, bindBy: 10, cwd: '/Users/test/a "quoted", path' };

  it('round-trips, one line, cwd last, as the hook reads it', () => {
    const text = formatHolder(h);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().includes('\n')).toBe(false);
    expect(parseHolder(text)).toEqual(h);
    expect(Object.keys(JSON.parse(text)).at(-1)).toBe('cwd');
    // The hook's sed is anchored on `{` or `,` before the key: a key inside a value never matches.
    expect(/[{,]"pid":1[,}]/.test(text)).toBe(true);
  });

  it('refuses torn or foreign files', () => {
    expect(parseHolder('{"v":1,"resource":"x","pid":1')).toBeUndefined();
    expect(parseHolder('{"v":1,"resource":"x","pid":1,"scope":"command","since":1}')).toBeUndefined(); // no holder
    expect(parseHolder('{"v":1,"resource":"x","sessionId":"s","pid":1,"scope":"forever","since":1}')).toBeUndefined();
  });

  it('folds an orchestration lease name into a directory name', () => {
    expect(leaseSlug('unity-editor:Game')).toBe('unity-editor-game');
    expect(leaseSlug('../..')).toBe('resource');
  });
});

describe('reapReason', () => {
  const ctx = (o: { alive?: boolean; state?: SessionRecordState; changedAt?: number; active?: boolean; now?: number } = {}) => ({
    now: o.now ?? 1000,
    alive: () => o.alive ?? true,
    sessionState: () => (o.state ? { state: o.state, changedAt: o.changedAt ?? 500 } : undefined),
    ...(o.active !== undefined || 'active' in o ? { attemptActive: () => o.active } : {}),
  });
  const session: HolderFile = { v: 1, resource: 'r', sessionId: 's', pid: 1, scope: 'command', since: 100 };
  const attempt: HolderFile = { v: 1, resource: 'r', attemptId: 'a', pid: 1, scope: 'session', since: 0, bindBy: 2000 };

  it('keeps a live session’s lease; releases a dead or ended one', () => {
    expect(reapReason(session, ctx())).toBeUndefined();
    expect(reapReason(session, ctx({ alive: false }))).toBe('stale');
    for (const s of ['stopped', 'ended', 'failed', 'interrupted'] as const) expect(reapReason(session, ctx({ state: s }))).toBe('session-ended');
    expect(reapReason(session, ctx({ state: 'live' }))).toBeUndefined();
  });

  it('ignores an end recorded before the lease was taken: the session was resumed outside AW', () => {
    expect(reapReason(session, ctx({ state: 'stopped', changedAt: 50 }))).toBeUndefined();
  });

  it('lets orchestration decide an attempt’s lease when it can, whatever the pid says', () => {
    expect(reapReason(attempt, ctx({ alive: false, active: true }))).toBeUndefined();
    expect(reapReason(attempt, ctx({ alive: true, active: false }))).toBe('attempt-ended');
    // It cannot say: the pid decides.
    expect(reapReason(attempt, ctx({ alive: false, active: undefined }))).toBe('stale');
  });

  it('releases an attempt lease never bound by its deadline', () => {
    expect(reapReason(attempt, ctx({ now: 2001, active: true }))).toBe('unbound');
    expect(reapReason({ ...attempt, sessionId: 's' }, ctx({ now: 2001, active: true }))).toBeUndefined();
  });
});

describe('FileLeaseService', () => {
  let dir: string;
  let alive: Set<number>;
  let states: Map<string, SessionRecordState>;
  let enabled: boolean;
  let resources: unknown;
  let now: number;
  let hold: boolean;

  const service = (pid = CORE_PID) =>
    new FileLeaseService({
      dir,
      settings: () => ({ enabled, resources }),
      startTimeOf: (p) => (alive.has(p) ? `start-${p}` : undefined),
      alive: (p, s) => alive.has(p) && (s === undefined || s === `start-${p}`),
      sessionState: (id) => {
        const state = states.get(id);
        return state ? { state, changedAt: now } : undefined;
      },
      gitCommonDir: (cwd) => `${cwd}/.git`,
      holdAttemptLeases: () => hold,
      now: () => now,
      pid,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-leases-'));
    alive = new Set([CORE_PID, AGENT_PID]);
    states = new Map();
    enabled = false;
    resources = undefined;
    now = 1_000_000;
    hold = false;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tsv = () => fs.readFileSync(path.join(dir, 'resources.tsv'), 'utf8');
  /** What a reap released, by resource. */
  const reaped = (s: FileLeaseService) => s.reap().map(resourceOfKey);

  it('ships with every resource off: resources.tsv is empty until leases.enabled', () => {
    const s = service();
    s.start(60_000);
    expect(s.resources()).toEqual([]);
    expect(tsv()).toBe('');
    enabled = true;
    s.syncResources();
    expect(tsv()).toContain('aw-app\tglobal');
    s.dispose();
  });

  it('acquires without waiting, and says who holds it when it cannot', () => {
    const s = service();
    const a = s.acquire('unity-editor:Game', { kind: 'attempt', attemptId: 'a1' }, { scope: 'session', cwd: '/Users/test/proj' });
    expect(a.ok).toBe(true);
    const key = `unity-editor-game@${qualifierFor('/Users/test/proj/.git')}`;
    expect(a.ok && a.lease.key).toBe(key);
    // Re-entrant for the same attempt.
    expect(s.acquire('unity-editor:Game', { kind: 'attempt', attemptId: 'a1' }, { cwd: '/Users/test/proj' }).ok).toBe(true);
    const b = s.acquire('unity-editor:Game', { kind: 'attempt', attemptId: 'a2' }, { cwd: '/Users/test/proj' });
    expect(b).toMatchObject({ ok: false, heldBy: { key, holder: { kind: 'attempt', attemptId: 'a1' } } });
    // Another repository is another lease.
    expect(s.acquire('unity-editor:Game', { kind: 'attempt', attemptId: 'a2' }, { cwd: '/Users/test/other' }).ok).toBe(true);
    expect(s.heldBy('unity-editor:Game', { cwd: '/Users/test/proj' })?.holder).toEqual({ kind: 'attempt', attemptId: 'a1' });
    expect(s.heldBy('unity-editor:Game', { cwd: '/Users/test/proj', except: { kind: 'attempt', attemptId: 'a1' } })).toBeUndefined();
  });

  it('shares the declared resource’s lease with the hook: `unity-editor:Game` is `unity-editor`, keyed as declared', () => {
    enabled = true;
    resources = [{ key: 'unity-editor', keyBy: 'repo', scope: 'turn', match: { tools: ['^mcp__unity'] } }];
    const s = service();
    const got = s.acquire('unity-editor:Game', { kind: 'attempt', attemptId: 'a1' }, { cwd: '/Users/test/proj' });
    expect(got.ok && got.lease.key).toBe(`unity-editor@${qualifierFor('/Users/test/proj/.git')}`);
  });

  it('binds an attempt lease to its session and agent (A5), and drops its bind deadline', () => {
    const s = service();
    const got = s.acquire('x', { kind: 'attempt', attemptId: 'a1' }, { cwd: '/r' });
    if (!got.ok) throw new Error('not acquired');
    const raw = () => parseHolder(fs.readFileSync(path.join(dir, got.lease.key, 'holder.json'), 'utf8'))!;
    expect(raw()).toMatchObject({ pid: CORE_PID, bindBy: now + DEFAULT_BIND_BY_MS });
    s.bind(got.lease.key, 'a1', 'sess-1', AGENT_PID);
    expect(raw()).toMatchObject({ attemptId: 'a1', sessionId: 'sess-1', pid: AGENT_PID, pidStart: `start-${AGENT_PID}` });
    expect(raw().bindBy).toBeUndefined();
    // Another attempt's bind is ignored.
    s.bind(got.lease.key, 'a2', 'sess-2', 1);
    expect(raw().sessionId).toBe('sess-1');
  });

  it('releases what an attempt holds when it ends', () => {
    const s = service();
    s.acquire('x', { kind: 'attempt', attemptId: 'a1' }, { cwd: '/r' });
    s.acquire('y', { kind: 'attempt', attemptId: 'a1' }, { cwd: '/r' });
    s.acquire('z', { kind: 'attempt', attemptId: 'a2' }, { cwd: '/r' });
    s.releaseAttempt('a1');
    expect(s.list().map((l) => l.resource)).toEqual(['z']);
  });

  it('reaps a session’s lease when the registry says it ended, or its process is gone', () => {
    const s = service();
    s.acquire('x', { kind: 'session', sessionId: 'sess-1' });
    s.acquire('y', { kind: 'session', sessionId: 'sess-2' });
    states.set('sess-1', 'ended');
    expect(s.reap()).toEqual(['x']);
    alive.delete(CORE_PID);
    expect(s.reap()).toEqual(['y']);
  });

  it('keeps an attempt’s lease across a core restart: held until orchestration says, then by what it says', () => {
    hold = true;
    const first = service(CORE_PID);
    first.acquire('x', { kind: 'attempt', attemptId: 'a1', sessionId: 'sess-1' }, { cwd: '/r' });
    first.acquire('y', { kind: 'attempt', attemptId: 'a2', sessionId: 'sess-2' }, { cwd: '/r' });
    first.dispose();
    alive.delete(CORE_PID); // the old core is gone

    const second = service(6000);
    alive.add(6000);
    // Orchestration has not recovered yet: nothing is judged by the dead core's pid.
    expect(reaped(second)).toEqual([]);
    second.attemptActive = (id) => (id === 'a1' ? true : false);
    expect(reaped(second)).toEqual(['y']);
    expect(second.list().map((l) => l.resource)).toEqual(['x']);
    // Recovery rebinds it: the new core's pid until the agent's is known.
    second.bind(`x@${qualifierFor('/r/.git')}`, 'a1', 'sess-1');
    expect(second.list()[0].pid).toBe(6000);
  });

  it('keeps a kept attempt lease fresh for the hook, which cannot ask orchestration', () => {
    const s = service();
    s.attemptActive = () => true;
    const got = s.acquire('x', { kind: 'attempt', attemptId: 'a1', sessionId: 'sess-1' }, { cwd: '/r' });
    if (!got.ok) throw new Error('not acquired');
    const file = path.join(dir, got.lease.key, 'holder.json');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(file, old, old);
    s.reap();
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000);
  });

  it('without orchestration, an attempt lease lives as long as its pid', () => {
    const s = service();
    s.acquire('x', { kind: 'attempt', attemptId: 'a1', sessionId: 'sess-1' }, { cwd: '/r' });
    expect(reaped(s)).toEqual([]);
    alive.delete(CORE_PID);
    expect(reaped(s)).toEqual(['x']);
  });

  it('releases an attempt lease no session was bound to by its deadline', () => {
    const s = service();
    s.attemptActive = () => true;
    s.acquire('x', { kind: 'attempt', attemptId: 'a1' }, { cwd: '/r' });
    now += DEFAULT_BIND_BY_MS + 1;
    expect(reaped(s)).toEqual(['x']);
  });

  it('takes over a stale lease on acquire', () => {
    const s = service();
    s.acquire('x', { kind: 'session', sessionId: 'sess-1' });
    alive.delete(CORE_PID);
    alive.add(7000);
    const other = service(7000);
    expect(other.acquire('x', { kind: 'session', sessionId: 'sess-2' }).ok).toBe(true);
  });

  it('fires a change when a lease comes or goes, from this side or the hook’s', () => {
    const s = service();
    s.start(60_000);
    let fired = 0;
    s.onDidChange(() => fired++);
    s.acquire('x', { kind: 'session', sessionId: 'sess-1' });
    expect(fired).toBe(1);
    // The hook releases it behind our back; the next tick notices.
    fs.rmSync(path.join(dir, 'x'), { recursive: true });
    s.tick();
    expect(fired).toBe(2);
    s.dispose();
  });

  it('cancels a wait with a marker the hook polls', () => {
    const s = service();
    s.cancelWait('sess-1');
    expect(fs.existsSync(path.join(dir, 'cancel', 'sess-1'))).toBe(true);
    s.forceRelease('nothing-here');
  });
});
