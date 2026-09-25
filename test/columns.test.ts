import { describe, expect, it } from 'vitest';
import {
  clampResizeWidth,
  columnDef,
  columnWidth,
  COLUMNS,
  isHidden,
  MAX_COLUMN_WIDTH,
  sanitizeColumnPrefs,
  visibleColumns,
  withDefaultWidths,
  withHidden,
  withWidths,
  type ColumnPrefs,
  type ResizeBounds,
} from '../src/shared/columns';

const proj = columnDef('proj')!;
const age = columnDef('age')!;

describe('visibleColumns', () => {
  it('shows everything by default', () => {
    expect(visibleColumns({}, false).map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
  });

  it('drops what the user hid', () => {
    const prefs: ColumnPrefs = { hidden: ['branch', 'pr'] };
    expect(visibleColumns(prefs, false).map((c) => c.id)).toEqual(['proj', 'worktree', 'model', 'usage', 'subagents', 'eta', 'age']);
  });

  it('folds the location columns away in a narrow dock', () => {
    // The dashboard is docked at ~300px most of the time; Project and Branch
    // there would leave the Agent column nothing.
    expect(visibleColumns({}, true).map((c) => c.id)).toEqual(['eta', 'age']);
  });

  it('narrow only ever hides more, never less', () => {
    const prefs: ColumnPrefs = { hidden: ['eta'] };
    expect(visibleColumns(prefs, true).map((c) => c.id)).toEqual(['age']);
  });
});

describe('columnWidth', () => {
  it('falls back to the default until something is saved', () => {
    expect(columnWidth({}, proj)).toBe(proj.defaultWidth);
    expect(columnWidth(undefined, proj)).toBe(proj.defaultWidth);
  });

  it('uses a saved width, clamped to what the column can take', () => {
    expect(columnWidth({ widths: { proj: 200 } }, proj)).toBe(200);
    expect(columnWidth({ widths: { proj: 1 } }, proj)).toBe(proj.minWidth);
    expect(columnWidth({ widths: { proj: 99_999 } }, proj)).toBe(MAX_COLUMN_WIDTH);
  });
});

describe('sanitizeColumnPrefs', () => {
  it('keeps what it recognises', () => {
    expect(sanitizeColumnPrefs({ hidden: ['pr'], widths: { age: 70 } })).toEqual({
      hidden: ['pr'],
      widths: { age: 70 },
    });
  });

  it('drops ids and widths it does not', () => {
    // Storage outlives builds: a column that existed in an older version, or a
    // hand-edited value, must not take the table down with it.
    const out = sanitizeColumnPrefs({
      hidden: ['pr', 'gone', 42, null],
      widths: { age: 70, gone: 100, proj: 'wide', branch: Number.NaN },
    });
    expect(out).toEqual({ hidden: ['pr'], widths: { age: 70 } });
  });

  it('survives junk where the prefs should be', () => {
    for (const junk of [undefined, null, 'nope', 42, []]) {
      expect(sanitizeColumnPrefs(junk)).toEqual({ hidden: [], widths: {} });
    }
  });

  it('de-duplicates the hidden set', () => {
    expect(sanitizeColumnPrefs({ hidden: ['pr', 'pr'] }).hidden).toEqual(['pr']);
  });
});

describe('prefs updates', () => {
  it('hides and shows without disturbing widths', () => {
    const withPrHidden = withHidden({ widths: { age: 70 } }, 'pr', true);
    expect(isHidden(withPrHidden, 'pr')).toBe(true);
    expect(withPrHidden.widths).toEqual({ age: 70 });

    expect(isHidden(withHidden(withPrHidden, 'pr', false), 'pr')).toBe(false);
  });

  it('merges widths rather than replacing them', () => {
    const next = withWidths({ widths: { age: 70 } }, { proj: 200 });
    expect(next.widths).toEqual({ age: 70, proj: 200 });
  });

  it('resets widths while keeping the hidden set', () => {
    const next = withDefaultWidths({ hidden: ['pr'], widths: { age: 70 } });
    expect(next).toEqual({ hidden: ['pr'], widths: {} });
  });
});

describe('clampResizeWidth', () => {
  const bounds = (over: Partial<ResizeBounds> = {}): ResizeBounds => ({
    startWidth: 150,
    minWidth: 56,
    slack: 200,
    ...over,
  });

  it('tracks the pointer: the handle is on the left edge, so dragging left grows', () => {
    expect(clampResizeWidth(-30, bounds())).toBe(180);
    expect(clampResizeWidth(30, bounds())).toBe(120);
  });

  it('stops at the column`s own floor', () => {
    expect(clampResizeWidth(500, bounds())).toBe(56);
  });

  it('grows no further than the Agent column has left to give', () => {
    // Agent is 40px above its floor: this column may take those 40 and no more.
    expect(clampResizeWidth(-500, bounds({ slack: 40 }))).toBe(190);
    // Agent already at its floor: the column can only shrink from here.
    expect(clampResizeWidth(-500, bounds({ slack: 0 }))).toBe(150);
    expect(clampResizeWidth(20, bounds({ slack: 0 }))).toBe(130);
  });

  it('treats a table already overflowing as no slack at all', () => {
    expect(clampResizeWidth(-50, bounds({ slack: -80 }))).toBe(150);
  });

  it('never exceeds the ceiling, however much slack there is', () => {
    expect(clampResizeWidth(-5000, bounds({ slack: 5000 }))).toBe(MAX_COLUMN_WIDTH);
  });

  it('keeps a narrow column draggable down to its own floor', () => {
    const b = bounds({ startWidth: age.defaultWidth, minWidth: age.minWidth });
    expect(clampResizeWidth(500, b)).toBe(age.minWidth);
  });

  it('returns whole pixels', () => {
    expect(clampResizeWidth(-10.4, bounds({ startWidth: 150.6 }))).toBe(161);
  });
});
