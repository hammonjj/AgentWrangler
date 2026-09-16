import * as cp from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ancestorsOf, parseProcessTable, parseStoppedPids, readStoppedPids } from '../src/core/procTree';

describe('parseStoppedPids', () => {
  // Real `ps -o pid=,stat=` output shapes, from this machine.
  it('picks out the stopped processes and nothing else', () => {
    const text = ['10017 S', '10019 T', '10020 R+', '10021 Ss', '10022 Z'].join('\n');
    expect([...parseStoppedPids(text)]).toEqual([10019]);
  });

  it('counts the flag suffixes, since only the first letter is the state', () => {
    expect([...parseStoppedPids('1 T+\n2 TN\n3 Te')].sort()).toEqual([1, 2, 3]);
  });

  // Stopped by a debugger rather than by a signal — still not running.
  it('counts a traced stop', () => {
    expect([...parseStoppedPids('7 t')]).toEqual([7]);
  });

  it('ignores headers, blanks and anything unparseable', () => {
    expect(parseStoppedPids('  PID STAT\n\ngarbage\n  T 5\n').size).toBe(0);
  });
});

describe('readStoppedPids', () => {
  it('asks nothing of the OS when there is nothing to ask about', async () => {
    expect(await readStoppedPids([])).toEqual(new Set());
  });

  /**
   * A pid that has ended is a real answer ("not stopped"), not a failure.
   * `ps -p <dead>` alone exits non-zero, which is indistinguishable from `ps`
   * being broken — hence the self-pid that rides along to guarantee a match.
   * Without it, a window whose sessions had all ended would read every snapshot
   * as "cannot tell" and leave them marked paused indefinitely.
   */
  it('reports an empty set, not a failure, for a pid that has ended', async () => {
    const child = cp.spawn(process.execPath, ['-e', '']);
    const dead = child.pid!;
    await new Promise((r) => child.on('exit', r));
    expect(await readStoppedPids([dead])).toEqual(new Set());
  });

  it('does not report this very much running process as stopped', async () => {
    expect(await readStoppedPids([process.pid])).toEqual(new Set());
  });

  // A genuinely unusable argument is the case that *should* read as "cannot
  // tell", so the caller keeps whatever it last knew rather than un-pausing.
  it('reports undefined when ps cannot answer at all', async () => {
    expect(await readStoppedPids([999_999_999])).toBeUndefined();
  });

  it('sees a real stopped process, and stops seeing it once continued', async () => {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const pid = child.pid!;
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(await readStoppedPids([pid])).toEqual(new Set());
      process.kill(pid, 'SIGSTOP');
      await new Promise((r) => setTimeout(r, 150));
      expect(await readStoppedPids([pid])).toEqual(new Set([pid]));
      process.kill(pid, 'SIGCONT');
      await new Promise((r) => setTimeout(r, 150));
      expect(await readStoppedPids([pid])).toEqual(new Set());
    } finally {
      child.kill('SIGKILL');
    }
  });
});

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
