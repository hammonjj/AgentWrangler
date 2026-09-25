/**
 * Plan §23.3's recovery table, one fixture per row, against `sessionVerdict`
 * (the same function the task runner reads live and at start-up). Plus the
 * live-only readings (§7.5) and turn-result classification.
 */
import { describe, expect, it } from 'vitest';
import { sessionVerdict, turnFailure, turnMessageIds, type VerdictInput } from '../../src/orchestration/engine/sessionVerdict';

const base: VerdictInput = { attempt: 'running', hasSession: true, turnEnded: true, stoppedByUs: false };
const live = { state: 'live' as const };
const idle = { lifecycle: 'idle' as const, pendingAsk: false, backgroundTasks: 0 };

describe('§23.3 recovery table', () => {
  const rows: [string, Partial<VerdictInput>, ReturnType<typeof sessionVerdict>][] = [
    ['live + connecting: stays running (the common case after app:install)', { record: live, handle: { lifecycle: 'connecting', pendingAsk: false } }, { kind: 'running' }],
    ['live + starting: stays running', { record: live, handle: { lifecycle: 'starting', pendingAsk: false } }, { kind: 'running' }],
    ['live + running: stays running', { record: live, handle: { lifecycle: 'running', pendingAsk: false } }, { kind: 'running' }],
    ['live + idle, nothing pending: finishing', { record: live, handle: idle }, { kind: 'finished' }],
    ['live + a pending ask: waiting-human', { record: live, handle: { ...idle, pendingAsk: true } }, { kind: 'waiting-human' }],
    ['live + unreachable: running, flagged, never interrupted', { record: live, handle: { lifecycle: 'unreachable', pendingAsk: false } }, { kind: 'running', unreachable: true }],
    ['live + no handle (a foreign host): held for a person', { record: live }, { kind: 'held', reason: 'held by a session host this version cannot follow' }],
    ['interrupted: app-restart', { record: { state: 'interrupted', endedReason: 'app-restart' } }, { kind: 'interrupted', reason: 'app-restart', resumable: true, autoResumable: true }],
    ['interrupted: machine restarted', { record: { state: 'interrupted', endedReason: 'machine restarted' } }, { kind: 'interrupted', reason: 'machine restarted', resumable: true, autoResumable: true }],
    ['interrupted: host stopped', { record: { state: 'interrupted', endedReason: 'host stopped' } }, { kind: 'interrupted', reason: 'host stopped', resumable: true, autoResumable: true }],
    ['interrupted: host signalled', { record: { state: 'interrupted', endedReason: 'host signalled (SIGTERM)' } }, { kind: 'interrupted', reason: 'host signalled (SIGTERM)', resumable: true, autoResumable: true }],
    ['interrupted: host lost — resumable, never automatically', { record: { state: 'interrupted', endedReason: 'host lost' } }, { kind: 'interrupted', reason: 'host lost', resumable: true, autoResumable: false }],
    ['stopped: idle (parked) — interrupted, resumable', { record: { state: 'stopped', endedReason: 'idle' } }, { kind: 'interrupted', reason: 'parked while idle', resumable: true, autoResumable: true }],
    ['stopped: open-elsewhere — for a person', { record: { state: 'stopped', endedReason: 'open-elsewhere' } }, { kind: 'held', reason: 'open in another app' }],
    ['stopped: anything else, not by us — cancelled', { record: { state: 'stopped' } }, { kind: 'cancelled', reason: 'stopped outside the task (closed, released or quit with its agents)' }],
    ['ended: finishing', { record: { state: 'ended' } }, { kind: 'finished' }],
    ['failed: failed, with a category', { record: { state: 'failed', endedReason: 'agent error' } }, { kind: 'failed', reason: 'agent error', category: 'infra' }],
    ['no record, attempt launching: nothing ran', { attempt: 'launching', hasSession: true }, { kind: 'interrupted', reason: 'nothing ran', resumable: false, autoResumable: false }],
    ['no record, attempt past launching: interrupted, unexpected', { attempt: 'running' }, { kind: 'interrupted', reason: 'its session has no record', resumable: true, autoResumable: false, unexpected: true }],
  ];
  it.each(rows)('%s', (_name, input, expected) => {
    expect(sessionVerdict({ ...base, ...input })).toEqual(expected);
  });

  it('a stop the orchestrator made itself is ignored', () => {
    expect(sessionVerdict({ ...base, record: { state: 'stopped' }, stoppedByUs: true })).toEqual({ kind: 'ignore' });
  });
});

describe('live readings (§7.5)', () => {
  it('idle is not finished while background work runs (A8)', () => {
    expect(sessionVerdict({ ...base, record: live, handle: { ...idle, backgroundTasks: 1 } })).toEqual({ kind: 'running' });
  });

  it('idle is not finished before a turn of the attempt has ended', () => {
    expect(sessionVerdict({ ...base, turnEnded: false, record: live, handle: idle })).toEqual({ kind: 'running' });
  });

  it('a running session with a pending ask is waiting on a person', () => {
    expect(sessionVerdict({ ...base, record: live, handle: { lifecycle: 'running', pendingAsk: true } })).toEqual({ kind: 'waiting-human' });
  });

  it('the registry wins over a handle that has not caught up', () => {
    expect(sessionVerdict({ ...base, record: { state: 'interrupted', endedReason: 'host lost' }, handle: { lifecycle: 'running', pendingAsk: false } }).kind).toBe('interrupted');
  });

  it('a handle with no record yet is read on its own', () => {
    expect(sessionVerdict({ ...base, handle: { lifecycle: 'running', pendingAsk: false } })).toEqual({ kind: 'running' });
  });
});

describe('turnFailure', () => {
  it('a success is not a failure', () => {
    expect(turnFailure({ type: 'result', subtype: 'success', is_error: false })).toBeUndefined();
    expect(turnFailure(undefined)).toBeUndefined();
  });

  it('classifies Claude error results', () => {
    expect(turnFailure({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429 })).toEqual({ category: 'capacity', signature: 'api-429' });
    expect(turnFailure({ type: 'result', subtype: 'error_max_turns', is_error: true })).toEqual({ category: 'budget', signature: 'error_max_turns' });
    expect(turnFailure({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'prompt_too_long' })).toEqual({ category: 'context', signature: 'context-overflow' });
    expect(turnFailure({ type: 'result', subtype: 'error_during_execution', is_error: true })).toEqual({ category: 'infra', signature: 'error_during_execution' });
  });

  it('classifies a failed Codex turn', () => {
    expect(turnFailure({ turn: { id: 't', status: 'failed' } })).toEqual({ category: 'infra', signature: 'codex-turn-failed' });
    expect(turnFailure({ turn: { id: 't', status: 'completed' } })).toBeUndefined();
  });
});

describe('turnMessageIds', () => {
  it('reads either field, lower-cased, and says when there are none', () => {
    expect(turnMessageIds({ user_message_uuid: 'AB', user_message_uuids: ['ab', 'cd'] })?.sort()).toEqual(['ab', 'cd']);
    expect(turnMessageIds({ type: 'result' })).toBeUndefined();
  });
});
