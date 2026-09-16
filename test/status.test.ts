import { describe, expect, it } from 'vitest';
import { blockClearedByClaude, deriveStatus } from '../src/claude/status';

const NOW = 1_000_000;
const THRESHOLD = 60_000;

function status(over: Partial<Parameters<typeof deriveStatus>[0]>) {
  return deriveStatus({
    pidAlive: true,
    nowMs: NOW,
    stuckThresholdMs: THRESHOLD,
    ...over,
  });
}

describe('deriveStatus', () => {
  it('dead pid → ended, regardless of tail', () => {
    expect(status({ pidAlive: false })).toBe('ended');
    expect(
      status({ pidAlive: false, lastMeaningful: { kind: 'assistant', stopReason: 'tool_use' }, transcriptMtimeMs: NOW }),
    ).toBe('ended');
  });

  it('alive with no transcript → waiting (brand-new session; the provider hides it)', () => {
    expect(status({})).toBe('waiting');
  });

  it('assistant end_turn with no reply text → waiting, staleness ignored', () => {
    expect(
      status({ lastMeaningful: { kind: 'assistant', stopReason: 'end_turn' }, transcriptMtimeMs: NOW - 10 * THRESHOLD }),
    ).toBe('waiting');
  });

  it('assistant end_turn → done when the reply just reports, waiting when it asks', () => {
    const finished = { kind: 'assistant' as const, stopReason: 'end_turn' };
    expect(
      status({ lastMeaningful: finished, transcriptMtimeMs: NOW, lastAssistantText: 'Built and pushed. Nothing else changed.' }),
    ).toBe('done');
    expect(
      status({ lastMeaningful: finished, transcriptMtimeMs: NOW, lastAssistantText: 'Built. Should I push it?' }),
    ).toBe('waiting');
  });

  it('other final stop reasons → waiting/done by the same rule', () => {
    for (const sr of ['stop_sequence', 'max_tokens', 'refusal']) {
      expect(status({ lastMeaningful: { kind: 'assistant', stopReason: sr }, transcriptMtimeMs: NOW })).toBe('waiting');
      expect(
        status({ lastMeaningful: { kind: 'assistant', stopReason: sr }, transcriptMtimeMs: NOW, lastAssistantText: 'Done.' }),
      ).toBe('done');
    }
  });

  it('assistant tool_use fresh → busy, stale → stuck', () => {
    const lm = { kind: 'assistant' as const, stopReason: 'tool_use' };
    expect(status({ lastMeaningful: lm, transcriptMtimeMs: NOW - 5_000 })).toBe('busy');
    expect(status({ lastMeaningful: lm, transcriptMtimeMs: NOW - THRESHOLD - 1 })).toBe('stuck');
  });

  it('assistant with null stop_reason (streaming) behaves like busy', () => {
    expect(status({ lastMeaningful: { kind: 'assistant', stopReason: null }, transcriptMtimeMs: NOW })).toBe('busy');
  });

  it('user / queue-operation tails → busy, stale → stuck', () => {
    expect(status({ lastMeaningful: { kind: 'user' }, transcriptMtimeMs: NOW - 1000 })).toBe('busy');
    expect(status({ lastMeaningful: { kind: 'queue-operation' }, transcriptMtimeMs: NOW - THRESHOLD - 1 })).toBe('stuck');
  });

  it('staleness boundary: exactly at threshold is still busy', () => {
    expect(
      status({ lastMeaningful: { kind: 'user' }, transcriptMtimeMs: NOW - THRESHOLD }),
    ).toBe('busy');
  });

  it('unparseable window (no meaningful line but transcript exists) → clock decides', () => {
    expect(status({ transcriptMtimeMs: NOW - 1000 })).toBe('busy');
    expect(status({ transcriptMtimeMs: NOW - THRESHOLD - 1 })).toBe('stuck');
  });
});

describe('blockClearedByClaude', () => {
  const BLOCKED_AT = NOW - 30_000;

  it('clears a block once Claude Code reports busy after it began', () => {
    // The whole point: the human clicked Allow in the Claude Code window and
    // the allowed command is still running, so no hook will fire for minutes.
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'busy', statusUpdatedAtMs: BLOCKED_AT + 1 })).toBe(true);
  });

  it('keeps the block while Claude Code also says waiting', () => {
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'waiting', statusUpdatedAtMs: NOW })).toBe(false);
  });

  it('ignores a status stamped before the block began', () => {
    // The pid file said busy while the tool was being set up; that write cannot
    // be an answer to a prompt that did not exist yet.
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'busy', statusUpdatedAtMs: BLOCKED_AT })).toBe(false);
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'busy', statusUpdatedAtMs: BLOCKED_AT - 1 })).toBe(false);
  });

  it('clears on idle and on unknown statuses, which are still not "waiting"', () => {
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'idle', statusUpdatedAtMs: NOW })).toBe(true);
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'shell', statusUpdatedAtMs: NOW })).toBe(true);
  });

  it('says nothing when the pid file has no status (older Claude Code)', () => {
    expect(blockClearedByClaude(BLOCKED_AT, {})).toBe(false);
    expect(blockClearedByClaude(BLOCKED_AT, { liveStatus: 'busy' })).toBe(false);
    expect(blockClearedByClaude(BLOCKED_AT, { statusUpdatedAtMs: NOW })).toBe(false);
  });

  it('says nothing when there is no open block', () => {
    expect(blockClearedByClaude(undefined, { liveStatus: 'busy', statusUpdatedAtMs: NOW })).toBe(false);
  });
});
