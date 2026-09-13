import { describe, expect, it } from 'vitest';
import type { SessionDTO } from '../src/shared/model';
import { canCloseSession, clampMenuPosition, rowMenuItems, rowMenuSize, ROW_MENU_WIDTH } from '../src/shared/rowMenu';

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-1',
    key: 'claude:sess-1',
    title: 'proj',
    status: 'waiting',
    lastActivityAt: 1_000,
    cwd: '/Users/test/proj',
    transcriptPath: '/Users/test/.claude/projects/proj/sess-1.jsonl',
    pid: 4242,
    ...over,
  };
}

const actions = (s: SessionDTO) => rowMenuItems(s).map((i) => i.action);

describe('rowMenuItems', () => {
  it('offers the full menu for a live session with a transcript and a pid', () => {
    expect(actions(session())).toEqual(['pin', 'goTo', 'copyId', 'archive', 'close']);
  });

  it('drops Pin when there is no transcript to show in a tab', () => {
    expect(actions(session({ transcriptPath: undefined }))).not.toContain('pin');
  });

  it('drops Go-to and Close for an ended session, which has no process left', () => {
    const items = actions(session({ status: 'ended' }));
    expect(items).toEqual(['pin', 'copyId', 'archive']);
  });

  it('keeps Copy id and Archive on every row, so the menu is never empty', () => {
    const bare = session({ transcriptPath: undefined, status: 'ended', pid: undefined });
    expect(actions(bare)).toEqual(['copyId', 'archive']);
  });

  it('flips Archive to Unarchive for an archived row', () => {
    const label = (s: SessionDTO) => rowMenuItems(s).find((i) => i.action === 'archive')!.label;
    expect(label(session())).toBe('Archive');
    expect(label(session({ archived: true }))).toBe('Unarchive');
  });

  it('marks only Close as dangerous, and puts it last', () => {
    const items = rowMenuItems(session());
    expect(items.filter((i) => i.danger).map((i) => i.action)).toEqual(['close']);
    expect(items[items.length - 1].action).toBe('close');
  });

  // The whole point of Close: adopt withdraws its offer mid-turn, this must not.
  it.each(['busy', 'stuck', 'blocked'] as const)('still offers Close while %s', (status) => {
    expect(actions(session({ status }))).toContain('close');
  });
});

describe('canCloseSession', () => {
  it('is true for a live session with a pid', () => {
    expect(canCloseSession(session())).toBe(true);
  });

  it('is false once the session has ended, pid or not', () => {
    expect(canCloseSession(session({ status: 'ended' }))).toBe(false);
    expect(canCloseSession(session({ status: 'ended', runnerOwned: true }))).toBe(false);
  });

  it('is false for a live session we never saw a pid for — nothing to signal', () => {
    expect(canCloseSession(session({ pid: undefined }))).toBe(false);
  });

  it('is true for a session this window runs, which needs no pid', () => {
    expect(canCloseSession(session({ pid: undefined, runnerOwned: true }))).toBe(true);
  });
});

describe('clampMenuPosition', () => {
  const size = { width: 190, height: 130 };
  const wide = { width: 1200, height: 900 };

  it('opens down-right of the pointer when there is room', () => {
    expect(clampMenuPosition({ x: 300, y: 200 }, size, wide)).toEqual({ left: 300, top: 200 });
  });

  // The dashboard is used at ~300px, where most clicks are within 190px of the
  // right edge; sliding back is the common path, not an edge case.
  it('slides back from the right edge of a narrow dock', () => {
    const narrow = { width: 300, height: 800 };
    expect(clampMenuPosition({ x: 250, y: 100 }, size, narrow).left).toBe(300 - 190 - 4);
  });

  it('slides up from the bottom edge', () => {
    expect(clampMenuPosition({ x: 10, y: 890 }, size, wide).top).toBe(900 - 130 - 4);
  });

  it('never leaves the top-left margin, even in a viewport smaller than the menu', () => {
    expect(clampMenuPosition({ x: 60, y: 60 }, size, { width: 120, height: 80 })).toEqual({ left: 4, top: 4 });
  });
});

describe('rowMenuSize', () => {
  it('is the fixed menu width, whatever the labels say', () => {
    expect(rowMenuSize(rowMenuItems(session())).width).toBe(ROW_MENU_WIDTH);
  });

  it('grows with the item count, and allows for the danger separator', () => {
    const full = rowMenuSize(rowMenuItems(session())); // 5 items, one separator
    const short = rowMenuSize(rowMenuItems(session({ status: 'ended' }))); // 3 items, none
    expect(full.height).toBeGreaterThan(short.height);
  });
});
