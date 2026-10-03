import { describe, expect, it } from 'vitest';
import {
  CONV_NARROW_PX,
  KEYBOARD_MIN_PX,
  LONG_PRESS_SLOP_PX,
  isNarrowWidth,
  movedPastSlop,
  viewportFrame,
} from '../src/shared/phoneLayout';
import { ITEM_H_TOUCH, rowMenuSize, type RowMenuItem } from '../src/shared/rowMenu';
import { BROWSER_VIEWPORT, renderBrowserWorkbenchHtml, renderWebviewHtml } from '../src/ui/html';

describe('isNarrowWidth', () => {
  it('is narrow below the threshold and wide at or above it', () => {
    expect(isNarrowWidth(360, CONV_NARROW_PX, false)).toBe(true);
    expect(isNarrowWidth(CONV_NARROW_PX - 1, CONV_NARROW_PX, false)).toBe(true);
    expect(isNarrowWidth(CONV_NARROW_PX, CONV_NARROW_PX, true)).toBe(false);
    expect(isNarrowWidth(1400, CONV_NARROW_PX, true)).toBe(false);
  });

  it('keeps the last answer for a hidden pane, which measures zero', () => {
    expect(isNarrowWidth(0, CONV_NARROW_PX, true)).toBe(true);
    expect(isNarrowWidth(0, CONV_NARROW_PX, false)).toBe(false);
    expect(isNarrowWidth(Number.NaN, CONV_NARROW_PX, true)).toBe(true);
  });
});

describe('viewportFrame', () => {
  it('fills the visible viewport and reports no keyboard when nothing covers the page', () => {
    expect(viewportFrame({ layoutHeight: 844, height: 844, offsetTop: 0 })).toEqual({ top: 0, height: 844, keyboard: false });
  });

  it('detects a keyboard by the visual viewport being much shorter than the layout one', () => {
    const f = viewportFrame({ layoutHeight: 844, height: 844 - 300, offsetTop: 0 });
    expect(f).toEqual({ top: 0, height: 544, keyboard: true });
  });

  it('follows the offset iOS scrolls the visual viewport by', () => {
    expect(viewportFrame({ layoutHeight: 844, height: 500, offsetTop: 120.4 })).toEqual({ top: 120, height: 500, keyboard: true });
  });

  it('does not mistake the browser chrome showing or hiding for a keyboard', () => {
    const f = viewportFrame({ layoutHeight: 844, height: 844 - (KEYBOARD_MIN_PX - 1), offsetTop: 0 });
    expect(f?.keyboard).toBe(false);
  });

  it('leaves the page alone while the reader has pinch-zoomed', () => {
    expect(viewportFrame({ layoutHeight: 844, height: 400, offsetTop: 0, scale: 2 })).toBeUndefined();
    expect(viewportFrame({ layoutHeight: 844, height: 400, offsetTop: 0, scale: 1 })?.keyboard).toBe(true);
  });

  it('refuses nonsense', () => {
    expect(viewportFrame({ layoutHeight: 0, height: 0, offsetTop: 0 })).toBeUndefined();
    expect(viewportFrame({ layoutHeight: 800, height: 0, offsetTop: 0 })).toBeUndefined();
    expect(viewportFrame({ layoutHeight: 800, height: Number.NaN, offsetTop: 0 })).toBeUndefined();
  });

  it('never grows past the layout viewport or goes above its top', () => {
    expect(viewportFrame({ layoutHeight: 800, height: 900, offsetTop: -5 })).toEqual({ top: 0, height: 800, keyboard: false });
  });
});

describe('long-press', () => {
  it('is cancelled by moving, which is a scroll, but not by a finger resting', () => {
    expect(movedPastSlop(0, 0)).toBe(false);
    expect(movedPastSlop(3, 4)).toBe(false);
    expect(movedPastSlop(LONG_PRESS_SLOP_PX + 1, 0)).toBe(true);
    expect(movedPastSlop(-8, 8)).toBe(true);
  });
});

describe('row menu size under a finger', () => {
  const items: RowMenuItem[] = [
    { action: 'resume' as RowMenuItem['action'], label: 'a' },
    { action: 'archive' as RowMenuItem['action'], label: 'b' },
    { action: 'close' as RowMenuItem['action'], label: 'c', danger: true },
  ];
  it('is taller with 44px items, so the clamp keeps all of it on screen', () => {
    expect(rowMenuSize(items, ITEM_H_TOUCH).height).toBeGreaterThan(rowMenuSize(items).height);
    expect(rowMenuSize(items, ITEM_H_TOUCH).height).toBe(3 * ITEM_H_TOUCH + 8 + 4);
  });
});

describe('the page meta', () => {
  const base = { cssHref: 'a.css', jsSrc: 'a.js', cspSource: "'self'", title: 't', bundleName: 'workbench' as const };

  it('gives the browser page viewport-fit=cover and keeps zoom available', () => {
    const html = renderBrowserWorkbenchHtml({ asset: (n) => `/${n}`, nonce: 'n', connectSrc: "'self'", build: 'b' });
    expect(html).toContain(`<meta name="viewport" content="${BROWSER_VIEWPORT}">`);
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toContain('maximum-scale');
    expect(html).not.toContain('user-scalable');
  });

  it('leaves every other host with the plain viewport', () => {
    const html = renderWebviewHtml(base);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(html).not.toContain('viewport-fit');
  });
});
