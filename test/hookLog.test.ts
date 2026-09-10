import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookLog } from '../src/claude/hookLog';

const SID_A = 'aaaaaaaa-2222-3333-4444-555555555555';
const SID_B = 'bbbbbbbb-2222-3333-4444-555555555555';

/** A pid above the OS maximum: process.kill(pid, 0) reports ESRCH, i.e. dead. */
const DEAD_PID = 999_999;

function ev(sessionId: string, name: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ hook_event_name: name, session_id: sessionId, cwd: '/proj', ...extra })}\n`;
}

describe('HookLog', () => {
  let dir: string;
  let log: HookLog;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-hooklog-'));
    log = new HookLog(() => undefined, dir);
  });
  afterEach(() => {
    log.dispose();
    return fsp.rm(dir, { recursive: true, force: true });
  });

  const write = (pid: number, body: string) => fsp.writeFile(path.join(dir, `${pid}.jsonl`), body, 'utf8');
  const append = (pid: number, body: string) => fsp.appendFile(path.join(dir, `${pid}.jsonl`), body, 'utf8');

  it('tolerates a missing directory', async () => {
    const missing = new HookLog(() => undefined, path.join(dir, 'nope'));
    await expect(missing.scanAll()).resolves.toBeUndefined();
    expect(missing.hasEverReported).toBe(false);
    missing.dispose();
  });

  it('reads events and reports per-session state', async () => {
    await write(1234, ev(SID_A, 'UserPromptSubmit') + ev(SID_A, 'PermissionRequest', { tool_name: 'Bash' }));
    await log.scanAll();
    expect(log.get(SID_A)).toMatchObject({ status: 'blocked', blockedReason: 'Bash', cwd: '/proj' });
    expect(log.hasEverReported).toBe(true);
  });

  it('is case-insensitive on session id', async () => {
    await write(1234, ev(SID_A.toUpperCase(), 'Stop'));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('waiting');
    expect(log.get(SID_A.toUpperCase())?.status).toBe('waiting');
  });

  it('reads only appended bytes on the next pass', async () => {
    await write(1234, ev(SID_A, 'UserPromptSubmit'));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('busy');

    await append(1234, ev(SID_A, 'Stop'));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('waiting');
  });

  it('skips a file whose size has not changed', async () => {
    await write(1234, ev(SID_A, 'Stop'));
    await log.scanAll();
    const first = log.get(SID_A)?.lastEventAtMs;
    await log.scanAll(); // no writes in between
    expect(log.get(SID_A)?.lastEventAtMs).toBe(first);
  });

  it('picks up a torn trailing line once it is completed', async () => {
    // Mid-write state: the last line has no newline yet.
    const partial = `${JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: SID_A })}`;
    await write(1234, ev(SID_A, 'UserPromptSubmit') + partial.slice(0, 40));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('busy'); // partial line ignored, not misparsed

    // The writer finishes the line.
    await append(1234, `${partial.slice(40)}\n`);
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('blocked');
  });

  it('recovers when a log is truncated or rotated', async () => {
    await write(1234, ev(SID_A, 'UserPromptSubmit') + ev(SID_A, 'PreToolUse', { tool_name: 'Bash' }));
    await log.scanAll();
    expect(log.get(SID_A)?.activeTool?.name).toBe('Bash');

    // Same pid, freshly truncated file with new content — offset must reset.
    await write(1234, ev(SID_A, 'Stop'));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('waiting');
  });

  it('keeps concurrent sessions separate across sharded files', async () => {
    // The $PPID sharding claim: two processes, two files, no interference.
    await write(1001, ev(SID_A, 'PermissionRequest', { tool_name: 'Write' }));
    await write(1002, ev(SID_B, 'PreToolUse', { tool_name: 'Bash' }));
    await log.scanAll();
    expect(log.get(SID_A)).toMatchObject({ status: 'blocked', blockedReason: 'Write' });
    expect(log.get(SID_B)?.activeTool?.name).toBe('Bash');
  });

  it('merges events for one session even if they land in different files', async () => {
    // Session identity comes from the payload, so a wrong or reused pid costs
    // file granularity but never correctness.
    await write(1001, ev(SID_A, 'UserPromptSubmit'));
    await write(1002, ev(SID_A, 'Stop'));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('waiting');
  });

  it('ignores files that are not <pid>.jsonl', async () => {
    await fsp.writeFile(path.join(dir, 'notes.txt'), ev(SID_A, 'Stop'), 'utf8');
    await fsp.writeFile(path.join(dir, 'events.jsonl'), ev(SID_A, 'Stop'), 'utf8');
    await log.scanAll();
    expect(log.get(SID_A)).toBeUndefined();
  });

  it('handles a large file by tailing the end without reading it whole', async () => {
    const filler = ev(SID_A, 'PostToolBatch').repeat(4000); // ~400 KB, past the tail chunk
    await write(1234, filler + ev(SID_A, 'PermissionRequest', { tool_name: 'Bash' }));
    await log.scanAll();
    expect(log.get(SID_A)?.status).toBe('blocked');
  });

  it('prunes logs of dead processes outside the ended window', async () => {
    await write(DEAD_PID, ev(SID_A, 'SessionEnd'));
    const file = path.join(dir, `${DEAD_PID}.jsonl`);
    const old = new Date(Date.now() - 72 * 3_600_000);
    await fsp.utimes(file, old, old);

    await log.prune(48 * 3_600_000);
    await expect(fsp.stat(file)).rejects.toThrow();
  });

  it('keeps a dead process log that is still inside the ended window', async () => {
    await write(DEAD_PID, ev(SID_A, 'SessionEnd'));
    await log.prune(48 * 3_600_000);
    expect((await fsp.stat(path.join(dir, `${DEAD_PID}.jsonl`))).isFile()).toBe(true);
  });

  it('never deletes a live process log, however old', async () => {
    const file = path.join(dir, `${process.pid}.jsonl`);
    await write(process.pid, ev(SID_A, 'Stop'));
    const old = new Date(Date.now() - 500 * 3_600_000);
    await fsp.utimes(file, old, old);

    await log.prune(48 * 3_600_000);
    expect((await fsp.stat(file)).isFile()).toBe(true);
  });

  it('fires a change event when new events arrive', async () => {
    let fired = 0;
    log.onDidChange(() => fired++);
    await write(1234, ev(SID_A, 'Stop'));
    await log.scanAll();
    expect(fired).toBe(1);
    await log.scanAll(); // nothing new
    expect(fired).toBe(1);
  });

  it('flags a turn whose start it only learned from the backlog', async () => {
    // Every line of a first read is stamped with one receipt time, so the turn
    // could be seconds or hours old. Consumers must not render it as elapsed.
    await write(1234, ev(SID_A, 'UserPromptSubmit') + ev(SID_A, 'PreToolUse', { tool_name: 'Bash' }));
    await log.scanAll();
    expect(log.get(SID_A)).toMatchObject({ status: 'busy', turnStartUncertain: true });

    // A prompt we actually watch arrive is trustworthy again.
    await append(1234, ev(SID_A, 'Stop') + ev(SID_A, 'UserPromptSubmit'));
    await log.scanAll();
    expect(log.get(SID_A)?.turnStartUncertain).toBe(false);
  });

  it('reports completed turns, but never ones replayed from the backlog', async () => {
    const durations: number[] = [];
    log.onTurnCompleted((ms) => durations.push(ms));

    // Backlog: a whole turn in one read measures ~0 and is not real data.
    await write(1234, ev(SID_A, 'UserPromptSubmit') + ev(SID_A, 'Stop'));
    await log.scanAll();
    expect(durations).toEqual([]);

    // Live: the prompt and the Stop arrive in separate reads, so the gap is real.
    await append(1234, ev(SID_A, 'UserPromptSubmit'));
    await log.scanAll();
    await new Promise((r) => setTimeout(r, 25));
    await append(1234, ev(SID_A, 'Stop'));
    await log.scanAll();
    expect(durations).toHaveLength(1);
    expect(durations[0]).toBeGreaterThanOrEqual(20);
  });
});
