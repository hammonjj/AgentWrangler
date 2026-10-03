/**
 * Phone polish (#134): when the browser's notification banner shows after a
 * dismissal, and how much of the page it keeps clear.
 */
import { describe, expect, it } from 'vitest';
import { DOCK_GAP_PX, dockReserve } from '../src/shared/phoneLayout';
import {
  NOTIFY_BANNER_SNOOZE_MS,
  parseBannerDismissedAt,
  shouldShowNotifyBanner,
  type NotificationState,
} from '../src/shared/webCapabilities';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function show(permission: NotificationState, dismissedAt?: number, insecure = false, now = NOW): boolean {
  return shouldShowNotifyBanner({ permission, insecure, dismissedAt, now });
}

describe('shouldShowNotifyBanner', () => {
  it('shows while permission is undecided and nothing was dismissed', () => {
    expect(show('default')).toBe(true);
  });

  it('never shows once permission is decided, on a secure page', () => {
    expect(show('granted')).toBe(false);
    expect(show('denied')).toBe(false);
    expect(show('unsupported')).toBe(false);
  });

  it('shows the reason on an insecure page, whatever the permission', () => {
    expect(show('unsupported', undefined, true)).toBe(true);
  });

  it('stays away for 30 days after a dismissal', () => {
    expect(show('default', NOW - 1)).toBe(false);
    expect(show('default', NOW - 29 * DAY)).toBe(false);
    expect(show('default', NOW - NOTIFY_BANNER_SNOOZE_MS + 1)).toBe(false);
    expect(show('unsupported', NOW - DAY, true)).toBe(false);
  });

  it('comes back after 30 days if permission is still undecided', () => {
    expect(NOTIFY_BANNER_SNOOZE_MS).toBe(30 * DAY);
    expect(show('default', NOW - NOTIFY_BANNER_SNOOZE_MS)).toBe(true);
    expect(show('default', NOW - 45 * DAY)).toBe(true);
  });

  it('does not come back after 30 days once permission is decided', () => {
    expect(show('granted', NOW - 45 * DAY)).toBe(false);
    expect(show('denied', NOW - 45 * DAY)).toBe(false);
  });

  it('treats a dismissal stamped in the future (a clock moved back) as recent', () => {
    expect(show('default', NOW + DAY)).toBe(false);
  });
});

describe('parseBannerDismissedAt', () => {
  it('reads a stored time', () => {
    expect(parseBannerDismissedAt(String(NOW))).toBe(NOW);
  });

  it('ignores nothing, garbage and non-positive values', () => {
    expect(parseBannerDismissedAt(null)).toBeUndefined();
    expect(parseBannerDismissedAt(undefined)).toBeUndefined();
    expect(parseBannerDismissedAt('')).toBeUndefined();
    expect(parseBannerDismissedAt('yesterday')).toBeUndefined();
    expect(parseBannerDismissedAt('0')).toBeUndefined();
    expect(parseBannerDismissedAt('-5')).toBeUndefined();
    expect(parseBannerDismissedAt('Infinity')).toBeUndefined();
  });
});

describe('dockReserve (--aw-dock-h)', () => {
  it('is the banner height plus the gap, rounded up to a whole pixel', () => {
    expect(dockReserve(44)).toBe(44 + DOCK_GAP_PX);
    expect(dockReserve(43.2)).toBe(44 + DOCK_GAP_PX);
  });

  it('is 0 with no banner, or one that is not drawn', () => {
    expect(dockReserve(undefined)).toBe(0);
    expect(dockReserve(0)).toBe(0);
    expect(dockReserve(-1)).toBe(0);
    expect(dockReserve(Number.NaN)).toBe(0);
  });
});
