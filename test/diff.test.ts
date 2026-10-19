import { describe, expect, it } from 'vitest';
import { sideBySideRows, splitUnifiedPatch } from '../src/shared/diff';

/** The shape `diffFromToolUseResult` produces from an edit's `structuredPatch`. */
const PATCH = ['@@ -1,3 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'].join('\n');

describe('splitUnifiedPatch', () => {
  it('puts removed lines on the left and added lines on the right', () => {
    const { before, after } = splitUnifiedPatch(PATCH);
    expect(before.split('\n')).toEqual(['@@ -1,3 +1,3 @@', 'const a = 1;', 'const b = 2;', 'const c = 4;']);
    expect(after.split('\n')).toEqual(['@@ -1,3 +1,3 @@', 'const a = 1;', 'const b = 3;', 'const c = 4;']);
  });

  it('keeps hunk headers on both sides, so disjoint regions do not align across the gap', () => {
    // Two hunks a hundred lines apart. Without the header between them the diff
    // editor would try to match the end of one against the start of the next.
    const two = ['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -100,1 +100,1 @@', '-z', '+Z'].join('\n');
    const { before, after } = splitUnifiedPatch(two);
    expect(before.split('\n')).toEqual(['@@ -1,1 +1,1 @@', 'a', '@@ -100,1 +100,1 @@', 'z']);
    expect(after.split('\n')).toEqual(['@@ -1,1 +1,1 @@', 'A', '@@ -100,1 +100,1 @@', 'Z']);
  });

  it('keeps a blank context line, which is written as a bare space', () => {
    const { before, after } = splitUnifiedPatch(['@@ -1,2 +1,2 @@', ' ', '-x', '+y'].join('\n'));
    expect(before).toBe('@@ -1,2 +1,2 @@\n\nx');
    expect(after).toBe('@@ -1,2 +1,2 @@\n\ny');
  });

  it('drops the "no newline at end of file" marker, which is not content', () => {
    const { before, after } = splitUnifiedPatch(['@@ -1,1 +1,1 @@', '-x', '\\ No newline at end of file', '+y'].join('\n'));
    expect(before).toBe('@@ -1,1 +1,1 @@\nx');
    expect(after).toBe('@@ -1,1 +1,1 @@\ny');
  });

  it('handles a pure addition, where the left side is only context', () => {
    const { before, after } = splitUnifiedPatch(['@@ -1,1 +1,3 @@', ' keep', '+one', '+two'].join('\n'));
    expect(before).toBe('@@ -1,1 +1,3 @@\nkeep');
    expect(after).toBe('@@ -1,1 +1,3 @@\nkeep\none\ntwo');
  });

  it('survives an empty patch rather than throwing', () => {
    expect(splitUnifiedPatch('')).toEqual({ before: '', after: '' });
  });
});

describe('sideBySideRows', () => {
  it('numbers each side from the hunk header and pairs a change with its replacement', () => {
    const rows = sideBySideRows(['@@ -10,3 +20,3 @@', ' keep', '-old', '+new', ' end'].join('\n'));
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -10,3 +20,3 @@' },
      { kind: 'line', left: { n: 10, text: 'keep', change: 'ctx' }, right: { n: 20, text: 'keep', change: 'ctx' } },
      { kind: 'line', left: { n: 11, text: 'old', change: 'del' }, right: { n: 21, text: 'new', change: 'add' } },
      { kind: 'line', left: { n: 12, text: 'end', change: 'ctx' }, right: { n: 22, text: 'end', change: 'ctx' } },
    ]);
  });

  it('leaves the shorter side of a run empty', () => {
    const rows = sideBySideRows(['@@ -1,1 +1,3 @@', '-a', '+x', '+y', '+z'].join('\n'));
    expect(rows.slice(1).map((r) => (r.kind === 'line' ? [r.left?.text, r.right?.text] : []))).toEqual([
      ['a', 'x'],
      [undefined, 'y'],
      [undefined, 'z'],
    ]);
  });

  it('shows a file header as a full-width row and skips the no-newline marker and the trailing newline', () => {
    const rows = sideBySideRows(['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-x', '\\ No newline at end of file', '+y', ''].join('\n'));
    expect(rows.map((r) => r.kind)).toEqual(['meta', 'meta', 'hunk', 'line']);
  });

  it('survives an empty patch', () => {
    expect(sideBySideRows('')).toEqual([]);
  });
});
