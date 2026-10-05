import { describe, expect, it } from 'vitest';
import { messageTimeTitle } from '../src/shared/model';

describe('messageTimeTitle', () => {
  const ts = '2026-10-05T12:00:00.000Z';
  const at = Date.parse(ts);

  it('is empty without a usable timestamp', () => {
    expect(messageTimeTitle(at, undefined)).toBe('');
    expect(messageTimeTitle(at, 'not a date')).toBe('');
  });

  it('says just now for a fresh block', () => {
    expect(messageTimeTitle(at + 1_000, ts)).toMatch(/ · just now$/);
  });

  it('appends the age', () => {
    expect(messageTimeTitle(at + 3 * 60_000, ts)).toMatch(/ · 3m ago$/);
    expect(messageTimeTitle(at + 2 * 3_600_000, ts)).toMatch(/ · 2h ago$/);
  });

  it('includes the year and a time of day', () => {
    expect(messageTimeTitle(at + 60_000, ts)).toMatch(/2026/);
    expect(messageTimeTitle(at + 60_000, ts)).toMatch(/\d:\d\d:\d\d/);
  });
});
