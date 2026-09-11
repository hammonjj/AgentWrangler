import { describe, expect, it } from 'vitest';
import { deriveStatus } from '../src/claude/status';

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
