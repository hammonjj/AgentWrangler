import { describe, expect, it } from 'vitest';
import {
  classifyClaudeRateLimit,
  classifyCodexRateLimit,
  type ClaudeRateLimitSignal,
  type CodexRateLimitSignal,
} from '../../src/shared/rateLimitClassification';

describe('classifyClaudeRateLimit', () => {
  it('classifies a five-hour rate-limit-event with a reset time', () => {
    const raw = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', resetsAt: 1_700_000_000 } };
    const signal: ClaudeRateLimitSignal = { kind: 'rate-limit-event', rateLimitType: 'five_hour', resetsAtMs: 1_700_000_000_000, raw };
    const result = classifyClaudeRateLimit(signal);
    expect(result).toEqual({
      provider: 'claude',
      category: 'claude-five-hour',
      reason: 'Claude five-hour session limit',
      resetAtMs: 1_700_000_000_000,
      raw,
    });
  });

  it('classifies a five-hour rate-limit-event with no reset time', () => {
    const raw = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five-hour' } };
    const signal: ClaudeRateLimitSignal = { kind: 'rate-limit-event', rateLimitType: 'five-hour', raw };
    const result = classifyClaudeRateLimit(signal);
    expect(result.category).toBe('claude-five-hour');
    expect(result.resetAtMs).toBeUndefined();
    expect(result.raw).toBe(raw);
  });

  it('classifies a weekly rate-limit-event', () => {
    const raw = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'weekly', resetsAt: 1_700_500_000 } };
    const signal: ClaudeRateLimitSignal = { kind: 'rate-limit-event', rateLimitType: 'weekly', resetsAtMs: 1_700_500_000_000, raw };
    const result = classifyClaudeRateLimit(signal);
    expect(result.provider).toBe('claude');
    expect(result.category).toBe('claude-weekly');
    expect(result.reason).toMatch(/weekly/i);
    expect(result.resetAtMs).toBe(1_700_500_000_000);
    expect(result.raw).toBe(raw);
  });

  it('classifies a weekly rate-limit-event given as seven_day', () => {
    const raw = { rateLimitType: 'seven_day' };
    const result = classifyClaudeRateLimit({ kind: 'rate-limit-event', rateLimitType: 'seven_day', raw });
    expect(result.category).toBe('claude-weekly');
  });

  it('classifies a rate-limit-event with an unrecognized rateLimitType as unknown, still Claude', () => {
    const raw = { rate_limit_info: { rateLimitType: 'some-new-window' } };
    const result = classifyClaudeRateLimit({ kind: 'rate-limit-event', rateLimitType: 'some-new-window', raw });
    expect(result.provider).toBe('claude');
    expect(result.category).toBe('unknown');
    expect(result.reason).toBe('Unknown rate limit');
    expect(result.raw).toBe(raw);
  });

  it('classifies a rate-limit-event with a missing rateLimitType as unknown', () => {
    const raw = { rate_limit_info: {} };
    const result = classifyClaudeRateLimit({ kind: 'rate-limit-event', raw });
    expect(result.provider).toBe('claude');
    expect(result.category).toBe('unknown');
    expect(result.raw).toBe(raw);
  });

  it('never infers a weekly reset from a generic 429', () => {
    const raw = { type: 'result', is_error: true, api_error_status: 429 };
    const result = classifyClaudeRateLimit({ kind: 'generic-429', raw });
    expect(result.provider).toBe('claude');
    expect(result.category).toBe('unknown');
    expect(result.category).not.toBe('claude-weekly');
    expect(result.resetAtMs).toBeUndefined();
    expect(result.raw).toBe(raw);
  });
});

describe('classifyCodexRateLimit', () => {
  it('classifies a primary window with a limit name and reset time', () => {
    const raw = { limitId: 'codex', limitName: 'Codex Plan', primary: { usedPercent: 100, resetsAt: 1_701_000_000 } };
    const signal: CodexRateLimitSignal = {
      kind: 'codex-window',
      windowKind: 'primary',
      limitId: 'codex',
      limitName: 'Codex Plan',
      resetsAtMs: 1_701_000_000_000,
      raw,
    };
    const result = classifyCodexRateLimit(signal);
    expect(result).toEqual({
      provider: 'codex',
      category: 'codex-primary',
      reason: 'Codex Plan',
      resetAtMs: 1_701_000_000_000,
      raw,
    });
  });

  it('classifies a primary window with no limit name using the fallback reason', () => {
    const raw = { primary: { usedPercent: 100 } };
    const result = classifyCodexRateLimit({ kind: 'codex-window', windowKind: 'primary', raw });
    expect(result.category).toBe('codex-primary');
    expect(result.reason).toBe('Codex primary rate limit');
    expect(result.resetAtMs).toBeUndefined();
  });

  it('classifies a secondary window', () => {
    const raw = { secondary: { usedPercent: 100 } };
    const result = classifyCodexRateLimit({ kind: 'codex-window', windowKind: 'secondary', raw });
    expect(result.provider).toBe('codex');
    expect(result.category).toBe('codex-secondary');
    expect(result.reason).toBe('Codex secondary rate limit');
    expect(result.raw).toBe(raw);
  });

  it('classifies an error code with a code string', () => {
    const raw = { codexErrorInfo: { usageLimitExceeded: {} } };
    const result = classifyCodexRateLimit({ kind: 'codex-error-code', code: 'usageLimitExceeded', raw });
    expect(result.provider).toBe('codex');
    expect(result.category).toBe('unknown');
    expect(result.reason).toContain('usageLimitExceeded');
    expect(result.raw).toBe(raw);
  });

  it('classifies an error code with no code string', () => {
    const raw = { codexErrorInfo: {} };
    const result = classifyCodexRateLimit({ kind: 'codex-error-code', raw });
    expect(result.provider).toBe('codex');
    expect(result.category).toBe('unknown');
    expect(result.reason).toBe('Unknown rate limit');
    expect(result.raw).toBe(raw);
  });
});
