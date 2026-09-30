/**
 * How the derived orchestration state reads on screen (#101): the words the
 * table's chips, the Missions pane and the conversation's summary share.
 * Every input comes from the real derivation over synthetic mission records.
 */
import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../src/shared/model';
import {
  certaintyMark,
  drillsToConversation,
  linkedChip,
  linkedTone,
  outcomeFacts,
  TASK_PHASE_LABEL,
  waitingReasonChip,
  waitReasonText,
} from '../../src/shared/orchestration/delegatedLabels';
import { deriveSessionState, missionPhase, type SessionEvidence } from '../../src/shared/orchestration/delegatedState';
import type { Mission, RouteRecommendation } from '../../src/shared/orchestration/types';
import { attempt, mission, T0, task } from './fixtures';

const ORIGIN = { provider: 'codex' as const, sessionId: 'thread-0001' };
const REC = { verdict: 'route', requirement: { minTier: 'standard', maxTier: 'expert', effort: 'medium', needs: [], gates: [] } } as unknown as RouteRecommendation;

function origin(over: Partial<AgentSession> = {}): SessionEvidence & AgentSession {
  return { provider: 'codex', sessionId: ORIGIN.sessionId, key: `codex:${ORIGIN.sessionId}`, title: 'Origin', status: 'waiting', lastActivityAt: T0, runnerOwned: true, turnStartedAt: T0, ...over };
}

function proposal(id: string, createdAt = T0 + 1): Mission {
  return mission({ id, title: `Mission ${id}`, origin: { ...ORIGIN, turnStartedAt: T0 }, state: 'draft', tasks: [task('t1', { state: 'routed', recommendation: REC })], createdAt, updatedAt: createdAt });
}

function running(m: Mission): Mission {
  return {
    ...m,
    state: 'running',
    startApproval: { at: T0 + 2, by: 'user' },
    tasks: [{ ...m.tasks[0], state: 'running', attemptIds: ['a1'] }],
    attempts: [attempt('a1', 't1', { state: 'running', launchedAt: T0 + 3 })],
    updatedAt: T0 + 3,
  };
}

function merged(m: Mission): Mission {
  const r = running(m);
  return {
    ...r,
    state: 'completed',
    finish: 'merge-local',
    finishResult: { mergeCommit: 'def4567890', note: 'merged into main' },
    tasks: [{ ...r.tasks[0], state: 'done' }],
    attempts: [attempt('a1', 't1', { state: 'succeeded', launchedAt: T0 + 3, endedAt: T0 + 4 })],
    updatedAt: T0 + 4,
  };
}

const NOW = T0 + 60_000;

describe('row chips', () => {
  it('a parent waiting on its children says so, in the activity tone, and links to Missions', () => {
    const d = deriveSessionState(origin({ status: 'busy' }), [running(proposal('mA'))], NOW);
    expect(d.wait?.reason).toBe('awaiting-children');
    const chip = linkedChip(d.linked, d.wait)!;
    expect(chip.text).toBe('Waiting on delegated work · running · 0/1 done');
    expect(chip.tone).toBe('activity');
    expect(chip.missionId).toBe('mA');
    expect(chip.title).toContain('not counted as needing you');
  });

  it('pending approval reads as approval, never running, and drills to the conversation card', () => {
    const d = deriveSessionState(origin(), [proposal('mA')], NOW);
    expect(d.status).toBe('waiting');
    const chip = linkedChip(d.linked, d.wait)!;
    expect(chip.text).toBe('Delegated: 1 task to start');
    expect(chip.text).not.toContain('running');
    expect(chip.tone).toBe('needs');
    expect(chip.missionId).toBeUndefined();
    expect(drillsToConversation('awaiting-approval')).toBe(true);
    // The approval chip carries the ask; there is no separate "your reply" chip.
    expect(waitingReasonChip(d.status, d.wait)).toBeUndefined();
  });

  it('a Waiting row with no delegated work names the user action', () => {
    const d = deriveSessionState(origin(), [], NOW);
    const chip = waitingReasonChip(d.status, d.wait)!;
    expect(chip).toMatchObject({ text: 'Asked you something', short: 'Your reply', tone: 'needs', mark: '~' });
    expect(linkedChip(d.linked, d.wait)).toBeUndefined();
  });

  it('several missions: the most urgent leads, the rest are +N', () => {
    const d = deriveSessionState(origin({ status: 'done' }), [merged(proposal('mA')), proposal('mB', T0 + 5)], NOW);
    const chip = linkedChip(d.linked, d.wait)!;
    expect(chip.text).toBe('Delegated: 1 task to start +1');
    expect(chip.short).toBe('Task to start +1');
  });

  it('an estimated keying carries the ~ marker', () => {
    const d = deriveSessionState(origin({ status: 'busy', turnStartedAt: undefined }), [running(proposal('mA'))], NOW);
    expect(linkedChip(d.linked, d.wait)!.mark).toBe('~');
  });
});

describe('merged, verified and closed out are separate facts (C1–C3)', () => {
  it('a merged, unchecked mission reads as three chips, not one "done"', () => {
    const p = missionPhase(merged(proposal('mA')));
    const facts = outcomeFacts(p.outcome!);
    expect(facts.map((f) => f.text)).toEqual(['Merged', 'Unverified · no checks configured', 'Closeout: yours']);
    expect(facts.map((f) => f.tone)).toEqual(['ok', 'warn', 'neutral']);
    expect(linkedTone(p)).toBe('terminal');
  });

  it('a finished task is "completed", never "done"', () => {
    expect(TASK_PHASE_LABEL.done).toBe('completed');
    expect(TASK_PHASE_LABEL['to-start']).toBe('to start');
  });
});

describe('uncertainty and reasons', () => {
  it('marks estimated with ~ and unknown with ?', () => {
    expect(certaintyMark('verified')).toBe('');
    expect(certaintyMark('inferred')).toBe('~');
    expect(certaintyMark('unknown')).toBe('?');
  });

  it('words every wait reason', () => {
    expect(waitReasonText({ reason: 'awaiting-children', certainty: 'verified', source: 'mission', since: T0 })).toContain('nothing for you');
    expect(waitReasonText({ reason: 'planning', certainty: 'verified', source: 'mission', since: T0, detail: 'Delegated: planning' })).toBe('delegating: the planner is deciding (Delegated: planning)');
  });
});
