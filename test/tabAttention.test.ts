import { describe, expect, it } from 'vitest';
import { attentionTotal, badgeText, tabTitle } from '../src/shared/tabAttention';

describe('attentionTotal', () => {
  it('counts blocked and waiting rows, not archived or other statuses', () => {
    expect(
      attentionTotal([
        { status: 'blocked' },
        { status: 'waiting' },
        { status: 'waiting', archived: true },
        { status: 'busy' },
        { status: 'done' },
        { status: 'ended' },
      ]),
    ).toBe(2);
  });

  it('adds the missions the host says need you', () => {
    expect(attentionTotal([{ status: 'blocked' }], 3)).toBe(4);
  });
});

describe('tabTitle', () => {
  it('prefixes the count only above zero', () => {
    expect(tabTitle('Agents', 2)).toBe('(2) Agents · Agent Wrangler');
    expect(tabTitle('Agents', 0)).toBe('Agents · Agent Wrangler');
  });
});

describe('badgeText', () => {
  it('is empty at zero, the number to nine, 9+ beyond', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(4)).toBe('4');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
  });
});
