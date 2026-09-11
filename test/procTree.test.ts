import { describe, expect, it } from 'vitest';
import { ancestorsOf, parseProcessTable } from '../src/core/procTree';

describe('parseProcessTable', () => {
  it('reads pid/ppid pairs and ignores anything else', () => {
    const t = parseProcessTable('  1     0\n 100     1\n200 100\ngarbage line\n\n');
    expect([...t.entries()]).toEqual([
      [1, 0],
      [100, 1],
      [200, 100],
    ]);
  });
});

describe('ancestorsOf', () => {
  // launchd(1) → Code(10) → ext host(20) → claude(30); Code(10) → pty host(21) → zsh(22) → claude(31)
  const table = parseProcessTable('1 0\n10 1\n20 10\n30 20\n21 10\n22 21\n31 22');

  it('walks nearest-first up to but excluding the root', () => {
    expect(ancestorsOf(30, table)).toEqual([20, 10]);
    expect(ancestorsOf(31, table)).toEqual([22, 21, 10]);
  });

  it('is empty for a pid that is not in the table (process gone)', () => {
    expect(ancestorsOf(999, table)).toEqual([]);
  });

  it('stops at a parent missing from the table', () => {
    const torn = parseProcessTable('30 20\n20 10'); // 10 itself is absent
    expect(ancestorsOf(30, torn)).toEqual([20, 10]);
  });

  it('survives a cycle', () => {
    const cyc = parseProcessTable('5 6\n6 5');
    expect(ancestorsOf(5, cyc)).toEqual([6]);
  });
});
