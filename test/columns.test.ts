import { describe, expect, it } from 'vitest';
import {
  clampResizeDelta,
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
    expect(visibleColumns(prefs, false).map((c) => c.id)).toEqual(['proj', 'model', 'eta', 'age']);
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

describe('clampResizeDelta', () => {
  const bounds = (over: Partial<ResizeBounds> = {}): ResizeBounds => ({
    startWidth: 150,
    startPrevWidth: 120,
    minWidth: 56,
    minPrevWidth: 56,
    prevIsElastic: false,
    ...over,
  });

  it('passes a delta that breaks nothing straight through', () => {
    expect(clampResizeDelta(30, bounds())).toBe(30);
    expect(clampResizeDelta(-30, bounds())).toBe(-30);
  });

  it('stops at the dragged column`s floor', () => {
    // 150 wide, floor 56: it can give up 94px and not a pixel more.
    expect(clampResizeDelta(500, bounds())).toBe(94);
  });

  it('stops at the neighbour`s floor', () => {
    // 120 wide, floor 56: dragging left can take 64px off it.
    expect(clampResizeDelta(-500, bounds())).toBe(-64);
  });

  it('gives the elastic Agent column a floor but no ceiling', () => {
    const elastic = bounds({ prevIsElastic: true, startPrevWidth: 300, minPrevWidth: 110 });
    expect(clampResizeDelta(-500, elastic)).toBe(-190); // Agent may not go below 110
    expect(clampResizeDelta(94, elastic)).toBe(94); // but may grow as far as this column shrinks
  });

  it('refuses to let either column exceed the ceiling', () => {
    // Both already at the cap: growing either one is out, so the divider is stuck.
    const wide = bounds({ startWidth: MAX_COLUMN_WIDTH, startPrevWidth: MAX_COLUMN_WIDTH });
    expect(clampResizeDelta(-50, wide)).toBe(0);
    expect(clampResizeDelta(50, wide)).toBe(0);

    // A neighbour at the cap can still be dragged narrower.
    const other = bounds({ startWidth: 100, startPrevWidth: MAX_COLUMN_WIDTH });
    expect(clampResizeDelta(-10, other)).toBe(-10);
    expect(clampResizeDelta(10, other)).toBe(0); // but not wider
  });

  it('does not move at all when the floors cannot both be met', () => {
    const cramped = bounds({ startWidth: 40, minWidth: 56, startPrevWidth: 40, minPrevWidth: 56 });
    expect(clampResizeDelta(20, cramped)).toBe(0);
  });

  it('is symmetric: what one column gives, the other takes', () => {
    const b = bounds();
    const d = clampResizeDelta(25, b);
    expect(b.startWidth - d + (b.startPrevWidth + d)).toBe(b.startWidth + b.startPrevWidth);
  });

  it('keeps a narrow column draggable down to its own floor', () => {
    expect(clampResizeDelta(500, bounds({ startWidth: age.defaultWidth, minWidth: age.minWidth }))).toBe(
      age.defaultWidth - age.minWidth,
    );
  });
});
