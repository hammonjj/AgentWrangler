import { describe, expect, it } from 'vitest';
import { InputQueue } from '../src/core/runner/inputQueue';

/** Drain an iterable into an array, so the tests read as "what came out". */
async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('InputQueue', () => {
  it('hands over what was pushed before anyone started iterating', async () => {
    const q = new InputQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await drain(q)).toEqual([1, 2]);
  });

  it('parks until something arrives, then resumes', async () => {
    // This is the whole point: the SDK pulls, a human types, and the gap
    // between them must not be a busy loop or a dropped message.
    const q = new InputQueue<string>();
    const collected = drain(q);
    await Promise.resolve();
    q.push('first');
    await Promise.resolve();
    q.push('second');
    q.close();
    expect(await collected).toEqual(['first', 'second']);
  });

  it('drains what is queued before it ends', async () => {
    const q = new InputQueue<number>();
    const collected = drain(q);
    q.push(1);
    q.push(2);
    q.close();
    expect(await collected).toEqual([1, 2]);
  });

  it('ignores a push after close rather than hanging the iterator', async () => {
    const q = new InputQueue<number>();
    q.close();
    q.push(99);
    expect(await drain(q)).toEqual([]);
    expect(q.isClosed).toBe(true);
  });

  it('closing twice is harmless', async () => {
    const q = new InputQueue<number>();
    q.push(1);
    q.close();
    q.close();
    expect(await drain(q)).toEqual([1]);
  });
});
