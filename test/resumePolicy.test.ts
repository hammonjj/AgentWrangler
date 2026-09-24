import { describe, expect, it } from 'vitest';
import { shouldAutoResume, type ShouldAutoResumeInput } from '../src/core/session/resumePolicy';

const RECORD = { sessionId: 'abc', cwd: '/Users/test/proj' };

function input(over: Partial<ShouldAutoResumeInput> = {}): ShouldAutoResumeInput {
  return {
    enabled: true,
    record: RECORD,
    cwdExists: true,
    runningElsewhere: false,
    transcriptWrittenMsAgo: undefined,
    recentWriteThresholdMs: 90_000,
    ...over,
  };
}

describe('shouldAutoResume', () => {
  it('resumes when nothing objects', () => {
    expect(shouldAutoResume(input())).toEqual({ resume: true, sessionId: 'abc', cwd: '/Users/test/proj' });
  });

  it('refuses when the setting is off, before even looking at a record', () => {
    expect(shouldAutoResume(input({ enabled: false, record: undefined }))).toEqual({
      resume: false,
      reason: 'disabled',
    });
  });

  it('refuses when there is nothing recent enough to resume', () => {
    expect(shouldAutoResume(input({ record: undefined }))).toEqual({ resume: false, reason: 'no-record' });
  });

  it('refuses when the project directory is gone', () => {
    expect(shouldAutoResume(input({ cwdExists: false }))).toEqual({
      resume: false,
      reason: 'cwd-missing',
      sessionId: 'abc',
    });
  });

  it('refuses when the Claude Code registry already shows the session live elsewhere', () => {
    expect(shouldAutoResume(input({ runningElsewhere: true }))).toEqual({
      resume: false,
      reason: 'running-elsewhere',
      sessionId: 'abc',
    });
  });

  it('refuses when the transcript was written inside the recent-write window', () => {
    expect(shouldAutoResume(input({ transcriptWrittenMsAgo: 500, recentWriteThresholdMs: 90_000 }))).toEqual({
      resume: false,
      reason: 'recent-transcript-write',
      sessionId: 'abc',
      writtenMsAgo: 500,
    });
  });

  it('resumes once the transcript write is old enough to no longer count as "someone else is driving"', () => {
    expect(shouldAutoResume(input({ transcriptWrittenMsAgo: 90_001, recentWriteThresholdMs: 90_000 })).resume).toBe(
      true,
    );
  });

  it('resumes when there is no transcript to read at all — nothing is writing it either', () => {
    expect(shouldAutoResume(input({ transcriptWrittenMsAgo: undefined })).resume).toBe(true);
  });

  it('checks running-elsewhere before the transcript write, matching the order resumeLastRunner always used', () => {
    const decision = shouldAutoResume(input({ runningElsewhere: true, transcriptWrittenMsAgo: 500 }));
    expect(decision).toMatchObject({ reason: 'running-elsewhere' });
  });

  it('checks cwd-missing before running-elsewhere', () => {
    const decision = shouldAutoResume(input({ cwdExists: false, runningElsewhere: true }));
    expect(decision).toMatchObject({ reason: 'cwd-missing' });
  });
});
