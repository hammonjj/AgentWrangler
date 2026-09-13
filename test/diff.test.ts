import { describe, expect, it } from 'vitest';
import { splitUnifiedPatch } from '../src/shared/diff';

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
