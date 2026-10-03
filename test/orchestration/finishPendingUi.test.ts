/**
 * The pending-action pattern in the Missions view (docs/plans/pending-actions.md):
 * a finish button is busy from the click, the mission's other finishes are
 * off, the host's own state keeps them off across a re-render or a reload of
 * the pane, and a failure brings them back with its reason.
 */
import { describe, expect, it } from 'vitest';
import { missionViewOf } from '../../src/orchestration/view/missionViews';
import { missionPhase } from '../../src/shared/orchestration/delegatedState';
import type { MissionOp, MissionsSnapshot } from '../../src/shared/orchestration/missionView';
import type { Mission } from '../../src/shared/orchestration/types';
import { PendingActions, pendingAttrs } from '../../src/shared/pendingActions';
import { missionsHtml, newMissionsUiState, pendingKeyOf } from '../../src/webview/dashboard/missions';
import { T0, mission, task } from './fixtures';

const review = (over: Partial<Mission> = {}): Mission =>
  mission({ state: 'review', planned: true, integration: { branch: 'aw/x/mission', worktreeId: 'w1' }, tasks: [task('t1', { state: 'done' })], ...over });

const snap = (m: Mission, finishing?: { how: 'merge-local'; uncertain?: string }): MissionsSnapshot => ({
  missions: [missionViewOf(m, { actions: () => [], ...(finishing ? { finishing } : {}) })],
  tiers: [],
  harnesses: [],
});

/** The `<button …>` for one finish, attributes and label. */
function finishButton(html: string, how: string): string {
  const m = html.match(new RegExp(`<button[^>]*data-finish="${how}"[^>]*>[^<]*</button>`));
  if (!m) throw new Error(`no ${how} button`);
  return m[0];
}

describe('PendingActions', () => {
  it('begins once per key: a second press while in flight gets no request id', () => {
    const p = new PendingActions('t');
    const id = p.begin('mission:m:finish:merge-local', 'Merging…', 1000);
    expect(id).toBe('t-1');
    expect(p.begin('mission:m:finish:merge-local', 'Merging…', 1001)).toBeUndefined();
    expect(p.under('mission:m:')?.label).toBe('Merging…');
    expect(p.under('mission:n:')).toBeUndefined();
    expect(p.settle('t-1')).toBe('mission:m:finish:merge-local');
    expect(p.settle('t-1')).toBeUndefined();
    expect(p.begin('mission:m:finish:merge-local', 'Merging…')).toBe('t-2');
  });

  it('forgets a request the host never answered, so a button is never off for ever on the pane’s word', () => {
    const p = new PendingActions('t');
    p.begin('a', 'A…', 0);
    p.begin('b', 'B…', 50_000);
    expect(p.expire(60_001, 60_000)).toEqual(['a']);
    expect(p.size).toBe(1);
  });

  it('busy and blocked buttons are aria-disabled (still focusable), and busy says so', () => {
    expect(pendingAttrs('busy', 'k')).toBe(' data-fk="k" aria-disabled="true" aria-busy="true"');
    expect(pendingAttrs('blocked')).toBe(' aria-disabled="true"');
    expect(pendingAttrs(undefined)).toBe('');
  });
});

describe('pendingKeyOf', () => {
  it('keys slow actions per mission and leaves quick ones out', () => {
    expect(pendingKeyOf('m', { kind: 'finish', how: 'merge-local' })).toEqual({ key: 'mission:m:finish:merge-local', label: 'Merging…' });
    expect(pendingKeyOf('m', { kind: 'finish', how: 'pull-request' })?.label).toBe('Opening PR…');
    expect(pendingKeyOf('m', { kind: 'task', taskId: 't1', action: 'retry' })).toEqual({ key: 'mission:m:task:t1:retry', label: 'Retrying…' });
    expect(pendingKeyOf('m', { kind: 'task', taskId: 't1', action: 'open-diff' })).toBeUndefined();
    expect(pendingKeyOf('m', { kind: 'open', taskId: 't1' })).toBeUndefined();
    expect(pendingKeyOf('m', { kind: 'edit', edit: { kind: 'add' } } as MissionOp)).toBeUndefined();
  });
});

describe('Merge locally in the Missions view', () => {
  it('is busy from the click: “Merging…”, aria-busy, and the other finishes are off', () => {
    const ui = newMissionsUiState();
    const m = review();
    let html = missionsHtml(snap(m), ui, T0);
    expect(finishButton(html, 'merge-local')).not.toContain('aria-disabled');
    expect(finishButton(html, 'merge-local')).toContain('>Merge locally<');

    // The click: the pane's own pending state, before the host has said anything.
    expect(ui.pending.begin(pendingKeyOf(m.id, { kind: 'finish', how: 'merge-local' })!.key, 'Merging…')).toBeDefined();
    html = missionsHtml(snap(m), ui, T0);
    const merge = finishButton(html, 'merge-local');
    expect(merge).toContain('aria-busy="true"');
    expect(merge).toContain('aria-disabled="true"');
    expect(merge).toContain('>Merging…<');
    for (const other of ['pull-request', 'keep', 'discard']) {
      expect(finishButton(html, other)).toContain('aria-disabled="true"');
      expect(finishButton(html, other)).not.toContain('aria-busy');
    }
    // Announced in a live region; no inline styles.
    expect(html).toMatch(/role="status" aria-live="polite">.*Merging…/);
    expect(html).not.toMatch(/style=/);
    // Unrelated controls stay: the mission header still toggles.
    expect(html).toContain('data-mission-toggle');
  });

  it('stays busy on the host’s word after the pane forgets (a re-render, a pane reload)', () => {
    const fresh = newMissionsUiState();
    const html = missionsHtml(snap(review(), { how: 'merge-local' }), fresh, T0);
    expect(finishButton(html, 'merge-local')).toContain('aria-busy="true"');
    expect(finishButton(html, 'discard')).toContain('aria-disabled="true"');
  });

  it('is read from the mission’s own write-ahead record after a restart', () => {
    const m = review({ pendingFinish: { id: 'f1', how: 'merge-local', at: T0, branch: 'aw/x/mission' } });
    const v = missionViewOf(m, { actions: () => [] });
    expect(v.finishing).toEqual({ how: 'merge-local' });
    expect(finishButton(missionsHtml({ missions: [v], tiers: [], harnesses: [] }, newMissionsUiState(), T0), 'merge-local')).toContain('aria-busy="true"');
    // Merging is activity, not a question for the user.
    expect(missionPhase(m)).toMatchObject({ phase: 'verifying', needsYou: false, short: 'Merging…' });
  });

  it('an outcome that could not be read back keeps every finish off and offers Check again', () => {
    const m = review({ pendingFinish: { id: 'f1', how: 'merge-local', at: T0, branch: 'aw/x/mission', uncertain: { why: 'git could not be run.', at: T0 } } });
    const html = missionsHtml(snap(m), newMissionsUiState(), T0);
    for (const f of ['merge-local', 'pull-request', 'keep', 'discard']) {
      expect(finishButton(html, f)).toContain('aria-disabled="true"');
      expect(finishButton(html, f)).not.toContain('aria-busy');
    }
    expect(html).toContain('Could not confirm whether the merge went through: git could not be run.');
    expect(html).toContain('data-mission-op="recheck-finish"');
    expect(missionPhase(m)).toMatchObject({ phase: 'needs-you', needsYou: true });
  });

  it('a refusal is shown with the buttons, and they are back', () => {
    const m = review({ finishFailure: { how: 'merge-local', why: 'The primary checkout has uncommitted changes on main; commit or stash them, then merge.', at: T0 } });
    const html = missionsHtml(snap(m), newMissionsUiState(), T0);
    expect(html).toMatch(/role="alert"><span><b>Merge locally did not go through\.<\/b> The primary checkout has uncommitted changes/);
    for (const f of ['merge-local', 'pull-request', 'keep', 'discard']) expect(finishButton(html, f)).not.toContain('aria-disabled');
  });

  it('a pending action on one mission leaves another mission’s buttons alone', () => {
    const ui = newMissionsUiState();
    ui.pending.begin('mission:other:finish:merge-local', 'Merging…');
    expect(finishButton(missionsHtml(snap(review()), ui, T0), 'merge-local')).not.toContain('aria-disabled');
  });
});
