import { describe, expect, it } from 'vitest';
import { claudeRateLimitFromLatest, claudeRateLimitFromTranscript } from '../../src/claude/rateLimit';

describe('claudeRateLimitFromLatest', () => {
  it('returns undefined when latest is empty', () => {
    expect(claudeRateLimitFromLatest(undefined)).toBeUndefined();
    expect(claudeRateLimitFromLatest({})).toBeUndefined();
  });

  it('classifies a cached rate_limit_event as five-hour with its reset time', () => {
    const msg = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000, rateLimitType: 'five_hour' } };
    const result = claudeRateLimitFromLatest({ rate_limit_event: msg });
    expect(result?.provider).toBe('claude');
    expect(result?.category).toBe('claude-five-hour');
    expect(result?.resetAtMs).toBe(1_700_000_000_000);
    expect(result?.raw).toBe(msg);
  });

  it('classifies a cached rate_limit_event as weekly', () => {
    const msg = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'weekly' } };
    const result = claudeRateLimitFromLatest({ rate_limit_event: msg });
    expect(result?.category).toBe('claude-weekly');
  });

  it('falls back to a generic-429 result when there is no rate_limit_event', () => {
    const msg = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429 };
    const result = claudeRateLimitFromLatest({ result: msg });
    expect(result?.provider).toBe('claude');
    expect(result?.category).toBe('unknown');
    expect(result?.resetAtMs).toBeUndefined();
    expect(result?.raw).toBe(msg);
  });

  it('prefers the rate_limit_event over a bare 429 result', () => {
    const event = { rate_limit_info: { rateLimitType: 'weekly' } };
    const result = { is_error: true, api_error_status: 429 };
    const stoppage = claudeRateLimitFromLatest({ rate_limit_event: event, result });
    expect(stoppage?.category).toBe('claude-weekly');
  });

  it('reports nothing for a successful result', () => {
    const msg = { type: 'result', subtype: 'success', is_error: false };
    expect(claudeRateLimitFromLatest({ result: msg })).toBeUndefined();
  });

  it('reports nothing for a non-429 error result', () => {
    const msg = { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 500 };
    expect(claudeRateLimitFromLatest({ result: msg })).toBeUndefined();
  });
});

describe('claudeRateLimitFromTranscript', () => {
  it('reports nothing for an undefined result', () => {
    expect(claudeRateLimitFromTranscript(undefined)).toBeUndefined();
  });

  it('reports nothing for a non-error result', () => {
    expect(claudeRateLimitFromTranscript({ isError: false })).toBeUndefined();
  });

  it('reports nothing for an error with no 429 status', () => {
    expect(claudeRateLimitFromTranscript({ isError: true, apiErrorStatus: 500 })).toBeUndefined();
  });

  it('classifies a 429 transcript result as unknown, never weekly', () => {
    const result = claudeRateLimitFromTranscript({ isError: true, apiErrorStatus: 429 });
    expect(result?.provider).toBe('claude');
    expect(result?.category).toBe('unknown');
    expect(result?.category).not.toBe('claude-weekly');
    expect(result?.resetAtMs).toBeUndefined();
  });
});
