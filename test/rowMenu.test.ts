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
    expect(actions(session())).toEqual([
      'pin',
      'rename',
      'openInTab',
      'pause',
      'copyId',
      'archive',
      'close',
    ]);
  });

  it('drops Open-in-its-own-tab when there is no transcript to show in one', () => {
    expect(actions(session({ transcriptPath: undefined }))).not.toContain('openInTab');
  });

  it('drops Go-to and Close for an ended session, which has no process left', () => {
    const items = actions(session({ status: 'ended' }));
    expect(items).toEqual(['pin', 'rename', 'openInTab', 'copyId', 'archive']);
  });

  it('keeps Pin, Rename, Copy id and Archive on every row, so the menu is never empty', () => {
    const bare = session({ transcriptPath: undefined, status: 'ended', pid: undefined });
    expect(actions(bare)).toEqual(['pin', 'rename', 'copyId', 'archive']);
  });

  /**
   * Pinning a row and opening a conversation in its own tab are unrelated, and
   * were both called "pin" until this feature needed the word. The menu must
   * never present two items by that name again.
   */
  it('has exactly one item whose label starts with Pin', () => {
    const labels = rowMenuItems(session()).map((i) => i.label);
    expect(labels.filter((l) => /^(Pin|Unpin)\b/.test(l))).toHaveLength(1);
  });

  it('flips Pin to Unpin for a pinned row, and pins whatever the status is', () => {
    const label = (s: SessionDTO) => rowMenuItems(s).find((i) => i.action === 'pin')!.label;
    expect(label(session())).toBe('Pin to top');
    expect(label(session({ pinned: true }))).toBe('Unpin');
    // Unlike the tab item, pinning needs no transcript and no live process.
    expect(actions(session({ status: 'ended', transcriptPath: undefined, pid: undefined }))).toContain('pin');
  });

  it('offers a rename on every row, and says so differently once one is set', () => {
    const label = (s: SessionDTO) => rowMenuItems(s).find((i) => i.action === 'rename')!.label;
    expect(label(session())).toBe('Give it a name…');
    expect(label(session({ nickname: 'my name for it' }))).toBe('Rename…');
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

  it('offers Pause for a running session, and Resume instead once it is paused', () => {
    expect(actions(session())).toContain('pause');
    const paused = actions(session({ paused: true }));
    expect(paused).toContain('unpause');
    expect(paused).not.toContain('pause');
  });

  // Pausing is a signal, so it needs a pid; ending a runner session does not,
  // because the runner holds the child handle itself.
  it('drops Pause when there is no pid to signal, even for a runner session', () => {
    expect(actions(session({ pid: undefined, runnerOwned: true }))).not.toContain('pause');
  });

  it('drops Pause for an ended session, which has nothing left to stop', () => {
    expect(actions(session({ status: 'ended' }))).not.toContain('pause');
  });

  // Pause is reversible by pressing the same menu again; Close is not. Only one
  // of them gets the red treatment, or the colour stops meaning anything.
  it('does not mark Pause as dangerous', () => {
    const item = rowMenuItems(session()).find((i) => i.action === 'pause')!;
    expect(item.danger).toBeUndefined();
  });

  // A paused session is still worth opening, copying and archiving, so the rest
  // of the menu has to survive the swap.
  it('keeps the rest of the menu on a paused row', () => {
    expect(actions(session({ paused: true }))).toEqual([
      'pin',
      'rename',
      'openInTab',
      'unpause',
      'copyId',
      'archive',
      'close',
    ]);
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
