/**
 * `lease-hook.sh` (#68) run for real: `/bin/sh` over temporary lease
 * directories, two "sessions" told apart by `session_id`, as Claude Code would
 * run the hook for them. The spawned shell's `$PPID` is this test process, so
 * a lease the hook takes is held by a live pid.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leaseScript, LEASE_ACQUIRED_EVENT, LEASE_DENIED_EVENT, LEASE_RELEASED_EVENT, LEASE_WAITING_EVENT } from '../src/claude/leaseHook';
import { compileResourcesTsv, type LeaseResource } from '../src/shared/leases';
import { FileLeaseService, qualifierFor } from '../src/core/leases/leaseService';
import { startTimeOf, isSameProcessAlive } from '../src/core/procStart';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let dir: string;
let script: string;
let leases: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-lease-hook-'));
  script = path.join(dir, 'lease-hook.sh');
  fs.writeFileSync(script, leaseScript(), { mode: 0o755 });
  leases = path.join(dir, 'leases');
  fs.mkdirSync(leases);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function declare(resources: LeaseResource[]): void {
  fs.writeFileSync(path.join(leases, 'resources.tsv'), compileResourcesTsv(resources));
}

const APP: LeaseResource = { key: 'aw-app', label: 'the installed app', keyBy: 'global', scope: 'command', waitSec: 2, match: { bash: ['npm run app:install'] } };

interface Call {
  session: string;
  tool?: string;
  command?: string;
  background?: boolean;
  toolUseId?: string;
  cwd?: string;
}

function payload(c: Call): string {
  return JSON.stringify({
    session_id: c.session,
    hook_event_name: 'PreToolUse',
    cwd: c.cwd ?? dir,
    tool_name: c.tool ?? 'Bash',
    tool_use_id: c.toolUseId ?? `toolu_${c.session.slice(0, 4)}`,
    tool_input: { command: c.command ?? 'npm run app:install', ...(c.background ? { run_in_background: true } : {}) },
  });
}

function run(mode: 'pre' | 'post' | 'stop', c: Call): Promise<{ stdout: string; code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = cp.spawn('/bin/sh', [script, mode], { cwd: dir });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code, ms: Date.now() - started }));
    child.stdin.end(payload(c));
  });
}

function decision(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string } {
  if (!stdout.trim()) return {};
  return (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
}

function logLines(): { hook_event_name: string; session_id: string; lease?: string }[] {
  const file = path.join(dir, `${process.pid}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function holder(key: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(leases, key, 'holder.json'), 'utf8'));
}

describe('lease-hook.sh', () => {
  it('parses as POSIX sh, and has no code path that prints an allow', () => {
    expect(cp.spawnSync('/bin/sh', ['-n', script]).status).toBe(0);
    // A granted lease prints nothing; the only decision it can print is deny.
    const code = leaseScript()
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/allow/);
    expect(code.match(/"permissionDecision":"deny"/g)).toHaveLength(1);
    expect(code.match(/"permissionDecision"/g)).toHaveLength(1);
  });

  it('does nothing while no resource is declared: the fast path', async () => {
    const r = await run('pre', { session: A });
    expect(r).toMatchObject({ stdout: '', code: 0 });
    expect(fs.readdirSync(leases)).toEqual([]);
  });

  it('lets a call that matches nothing through without taking anything', async () => {
    declare([APP]);
    const r = await run('pre', { session: A, command: 'npm test' });
    expect(r.stdout).toBe('');
    expect(fs.readdirSync(leases)).toEqual(['resources.tsv']);
  });

  it('takes the lease for a matching call, names its holder, and releases it after the call', async () => {
    declare([APP]);
    expect((await run('pre', { session: A, toolUseId: 'toolu_1' })).stdout).toBe('');
    const h = holder('aw-app');
    expect(h).toMatchObject({ resource: 'aw-app', sessionId: A, pid: process.pid, scope: 'command' });
    expect(h.pidStart).toBe(startTimeOf(process.pid));
    expect(fs.existsSync(path.join(leases, 'aw-app', 'uses', 'toolu_1'))).toBe(true);

    await run('post', { session: A, toolUseId: 'toolu_1' });
    expect(fs.existsSync(path.join(leases, 'aw-app'))).toBe(false);
    expect(logLines().map((l) => l.hook_event_name)).toEqual([LEASE_ACQUIRED_EVENT, LEASE_RELEASED_EVENT]);
  });

  it('serialises two sessions: the second waits while the first holds it, and goes ahead once it is released', async () => {
    declare([{ ...APP, waitSec: 20 }]);
    await run('pre', { session: A, toolUseId: 'toolu_a' });
    const waiting = run('pre', { session: B, toolUseId: 'toolu_b' });
    await new Promise((r) => setTimeout(r, 1200));
    // Still B waiting: A holds it.
    expect(holder('aw-app').sessionId).toBe(A);
    expect(logLines().some((l) => l.hook_event_name === LEASE_WAITING_EVENT && l.session_id === B)).toBe(true);
    await run('post', { session: A, toolUseId: 'toolu_a' });
    const r = await waiting;
    expect(r.stdout).toBe('');
    expect(r.ms).toBeGreaterThanOrEqual(1000);
    expect(holder('aw-app').sessionId).toBe(B);
  });

  it('denies a call that waited past waitSec, naming the resource and how long it has been held', async () => {
    declare([{ ...APP, waitSec: 1 }]);
    await run('pre', { session: A });
    const r = await run('pre', { session: B });
    const d = decision(r.stdout);
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toMatch(/^the installed app is in use by another agent session \(for under a minute\)\./);
    // Still A's.
    expect(holder('aw-app').sessionId).toBe(A);
    expect(logLines().some((l) => l.hook_event_name === LEASE_DENIED_EVENT && l.session_id === B)).toBe(true);
  });

  it('is re-entrant for the session that holds it, and releases only when its last call ends', async () => {
    declare([APP]);
    await run('pre', { session: A, toolUseId: 'toolu_1' });
    expect((await run('pre', { session: A, toolUseId: 'toolu_2' })).stdout).toBe('');
    await run('post', { session: A, toolUseId: 'toolu_1' });
    expect(fs.existsSync(path.join(leases, 'aw-app'))).toBe(true);
    await run('post', { session: A, toolUseId: 'toolu_2' });
    expect(fs.existsSync(path.join(leases, 'aw-app'))).toBe(false);
  });

  it('a call that took its lease but never ran (refused at the prompt) gives it back at PermissionDenied, or at the latest when the turn stops', async () => {
    declare([APP]);
    await run('pre', { session: A, toolUseId: 'toolu_no' });
    // PermissionDenied runs the post mode with the same tool_use_id.
    await run('post', { session: A, toolUseId: 'toolu_no' });
    expect(fs.existsSync(path.join(leases, 'aw-app'))).toBe(false);

    // Interrupted instead: nothing ends the call, so Stop does.
    await run('pre', { session: A, toolUseId: 'toolu_esc' });
    expect(fs.existsSync(path.join(leases, 'aw-app', 'uses', 'toolu_esc'))).toBe(true);
    await run('stop', { session: A });
    expect(fs.existsSync(path.join(leases, 'aw-app'))).toBe(false);
  });

  it('waits once for the whole call, however many leases it needs, so it denies inside the hook timeout', async () => {
    const two = (key: string): LeaseResource => ({ key, keyBy: 'global', scope: 'command', waitSec: 2, match: { bash: ['npm run app:install'] } });
    declare([two('first'), two('second')]);
    await run('pre', { session: A, toolUseId: 'toolu_a' });
    expect(fs.readdirSync(leases).sort()).toEqual(['first', 'resources.tsv', 'second']);
    const waiting = run('pre', { session: B });
    // `first` frees up partway through; `second` is still A's.
    await new Promise((r) => setTimeout(r, 1200));
    fs.rmSync(path.join(leases, 'first'), { recursive: true });
    const r = await waiting;
    expect(decision(r.stdout).permissionDecision).toBe('deny');
    // One 2 s deadline in all, not 2 s for each.
    expect(r.ms).toBeLessThan(2900);
    // What it took on the way is given back with the deny.
    expect(fs.existsSync(path.join(leases, 'first'))).toBe(false);
  });

  it('leaves an attempt lease the core keeps fresh alone, whatever its pid, and reaps one the core stopped keeping', async () => {
    declare([APP]);
    const lease = path.join(leases, 'aw-app');
    fs.mkdirSync(lease);
    const file = path.join(lease, 'holder.json');
    fs.writeFileSync(file, `{"v":1,"resource":"aw-app","attemptId":"att1","sessionId":"${A}","pid":999999,"scope":"session","since":1}\n`);
    // The core restarting: its pid is dead, but it touched the lease a moment ago.
    expect(decision((await run('pre', { session: B, command: 'npm run app:install' })).stdout).permissionDecision).toBe('deny');
    // Untouched for longer than the heartbeat: the core is gone, the pid rule applies.
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(file, old, old);
    expect((await run('pre', { session: B })).stdout).toBe('');
    expect(holder('aw-app').sessionId).toBe(B);
  });

  it('refuses a matching command run in the background: its lease would end before it does', async () => {
    declare([APP]);
    const d = decision((await run('pre', { session: A, background: true })).stdout);
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toMatch(/in the foreground/);
    expect(fs.existsSync(path.join(leases, 'aw-app'))).toBe(false);
  });

  it('reaps a lease whose holder is dead, and one whose pid now belongs to another process', async () => {
    declare([APP]);
    fs.mkdirSync(path.join(leases, 'aw-app'));
    fs.writeFileSync(path.join(leases, 'aw-app', 'holder.json'), `{"v":1,"resource":"aw-app","sessionId":"${A}","pid":999999,"scope":"command","since":1}\n`);
    expect((await run('pre', { session: B })).stdout).toBe('');
    expect(holder('aw-app').sessionId).toBe(B);

    fs.rmSync(path.join(leases, 'aw-app'), { recursive: true });
    fs.mkdirSync(path.join(leases, 'aw-app'));
    // Our own pid, but a start time it never had: the pid was reused.
    fs.writeFileSync(path.join(leases, 'aw-app', 'holder.json'), `{"v":1,"resource":"aw-app","sessionId":"${A}","pid":${process.pid},"pidStart":"Thu Jan  1 00:00:00 1970","scope":"command","since":1}\n`);
    expect((await run('pre', { session: B })).stdout).toBe('');
    expect(holder('aw-app').sessionId).toBe(B);
  });

  it('holds a turn-scoped lease across calls until the turn stops', async () => {
    declare([{ key: 'unity-editor', label: 'Unity Editor', keyBy: 'global', scope: 'turn', waitSec: 1, match: { tools: ['^mcp__unity'] } }]);
    await run('pre', { session: A, tool: 'mcp__unity__play' });
    await run('post', { session: A, tool: 'mcp__unity__play' });
    expect(holder('unity-editor').scope).toBe('turn');
    expect(decision((await run('pre', { session: B, tool: 'mcp__unity__console' })).stdout).permissionDecision).toBe('deny');
    await run('stop', { session: A });
    expect(fs.existsSync(path.join(leases, 'unity-editor'))).toBe(false);
  });

  it('qualifies a per-repository lease by the repository, as the core does', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    cp.execFileSync('git', ['init', '-q', repo]);
    declare([{ ...APP, keyBy: 'repo' }]);
    await run('pre', { session: A, cwd: repo });
    const common = cp.execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    expect(fs.existsSync(path.join(leases, `aw-app@${qualifierFor(common)}`))).toBe(true);
  });

  it('honours a lease the core took while the core is gone: the files are the lock (scheduler A5)', async () => {
    declare([APP]);
    const core = new FileLeaseService({
      dir: leases,
      settings: () => ({ enabled: true, resources: [APP] }),
      startTimeOf,
      alive: isSameProcessAlive,
      sessionState: () => undefined,
    });
    expect(core.acquire('aw-app', { kind: 'attempt', attemptId: 'att1', sessionId: A }).ok).toBe(true);
    core.dispose();
    // Another session waits, then is told; the attempt's own session goes straight through.
    expect(decision((await run('pre', { session: B })).stdout).permissionDecision).toBe('deny');
    expect((await run('pre', { session: A, toolUseId: 'toolu_x' })).stdout).toBe('');
    // A session-scoped lease is not the hook's to release.
    await run('post', { session: A, toolUseId: 'toolu_x' });
    await run('stop', { session: A });
    expect(holder('aw-app')).toMatchObject({ attemptId: 'att1', scope: 'session' });
  });

  it('stops waiting at once when the user cancels the wait', async () => {
    declare([{ ...APP, waitSec: 30 }]);
    await run('pre', { session: A });
    const waiting = run('pre', { session: B });
    await new Promise((r) => setTimeout(r, 800));
    fs.mkdirSync(path.join(leases, 'cancel'), { recursive: true });
    fs.writeFileSync(path.join(leases, 'cancel', B), '');
    const r = await waiting;
    expect(r.ms).toBeLessThan(5000);
    expect(decision(r.stdout).permissionDecisionReason).toMatch(/cancelled the wait/);
    expect(fs.existsSync(path.join(leases, 'cancel', B))).toBe(false);
  });
});
