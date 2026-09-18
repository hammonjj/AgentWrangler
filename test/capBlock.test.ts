import { describe, expect, it } from 'vitest';
import { capBlock, MAX_BLOCK_CHARS, MAX_OVERFLOW_CHARS, rememberFullText } from '../src/shared/conversation';

describe('capBlock', () => {
  it('leaves a block that fits alone, and holds nothing for it', () => {
    const store = new Map<string, string>();
    expect(capBlock(store, 'b1', 'short')).toEqual({ text: 'short' });
    expect(store.size).toBe(0);
  });

  it('cuts at the cap, counts what it cut, and keeps the whole of it', () => {
    const store = new Map<string, string>();
    const whole = 'a'.repeat(MAX_BLOCK_CHARS + 1234);

    const capped = capBlock(store, 'b1', whole);

    expect(capped.text).toHaveLength(MAX_BLOCK_CHARS);
    expect(capped.more).toBe(1234);
    expect(store.get('b1')).toBe(whole);
  });

  it('drops what it held once the block fits again', () => {
    // A streamed reply gets rewritten by its complete message. Keeping the old
    // tail would let the pane fetch text that no longer follows what is shown.
    const store = new Map<string, string>();
    capBlock(store, 'b1', 'b'.repeat(MAX_BLOCK_CHARS + 10));
    expect(store.has('b1')).toBe(true);

    expect(capBlock(store, 'b1', 'rewritten, and short')).toEqual({ text: 'rewritten, and short' });
    expect(store.has('b1')).toBe(false);
  });

  it('counts characters, not code units, the same way the slice does', () => {
    // An emoji is two code units: `more` has to agree with what was actually
    // left behind, or the button offers to fetch a number that is not there.
    const store = new Map<string, string>();
    const whole = `${'x'.repeat(MAX_BLOCK_CHARS)}🙂`;

    const capped = capBlock(store, 'b1', whole);

    expect(capped.more).toBe(2);
    expect(store.get('b1')).toBe(whole);
  });
});

describe('rememberFullText', () => {
  it('evicts the oldest first when the budget is spent', () => {
    const store = new Map<string, string>();
    const big = 'x'.repeat(MAX_OVERFLOW_CHARS / 2);

    rememberFullText(store, 'old', big);
    rememberFullText(store, 'mid', big);
    rememberFullText(store, 'new', big);

    expect([...store.keys()]).toEqual(['mid', 'new']);
  });

  it('keeps a re-remembered block as the newest, not the oldest', () => {
    // A streaming reply is re-capped on every delta. If re-remembering left it
    // where it was, the block being read right now would be first out.
    const store = new Map<string, string>();
    const big = 'x'.repeat(MAX_OVERFLOW_CHARS / 2);

    rememberFullText(store, 'streaming', big);
    rememberFullText(store, 'other', big);
    rememberFullText(store, 'streaming', big);
    rememberFullText(store, 'newcomer', big);

    expect([...store.keys()]).toEqual(['streaming', 'newcomer']);
  });

  it('keeps one text bigger than the whole budget rather than holding nothing', () => {
    const store = new Map<string, string>();
    rememberFullText(store, 'huge', 'x'.repeat(MAX_OVERFLOW_CHARS + 1000));
    expect(store.get('huge')).toHaveLength(MAX_OVERFLOW_CHARS + 1000);
  });
});
