/**
 * The derived orchestration state (#101, docs/plans/status-contract.md):
 * transitions and replays over mission records and an origin's own signals.
 *
 * Every scenario is a sequence of mission snapshots, as the runner writes
 * them, plus the origin's own evidence, and every assertion is on the one
 * derivation the table, the Missions view and the conversation all read.
 * Fixtures are synthetic: `/Users/test/proj` paths, invented titles.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../src/shared/model';
import {
  attentionCount,
  deriveSessionState,
  headlineOf,
  latestMissions,
  linkedNotices,
  linkedWorkFor,
  missionPhase,
  taskPhase,
  toastAllowed,
  withDerivedState,
  type SessionEvidence,
} from '../../src/shared/orchestration/delegatedState';
import type { ExecutionAttempt, Mission, RouteRecommendation, Task } from '../../src/shared/orchestration/types';
import { missionMetrics, missionViewOf } from '../../src/orchestration/view/missionViews';
import { attempt, mission, T0, task } from './fixtures';

const MIN = 60_000;
const ORIGIN = { provider: 'codex' as const, sessionId: 'thread-0001' };
const OTHER = { provider: 'claude' as const, sessionId: 'aaaa0000-0000-0000-0000-000000000002' };

const REC = { verdict: 'route', requirement: { minTier: 'standard', maxTier: 'expert', effort: 'medium', needs: [], gates: [] } } as unknown as RouteRecommendation;

/** The origin conversation, as a provider reports its own turn. */
function origin(over: Partial<AgentSession> = {}): SessionEvidence & AgentSession {
  return {
    provider: 'codex',
    sessionId: ORIGIN.sessionId,
    key: `codex:${ORIGIN.sessionId}`,
    title: 'Origin',
    status: 'busy',
    lastActivityAt: T0,
    runnerOwned: true,
    ...over,
  };
}

// ---- mission snapshots, one per write the runner makes ----

function proposal(id: string, turnStartedAt: number | undefined, createdAt: number, title = `Mission ${id}`): Mission {
  return mission({
    id,
    title,
    origin: { ...ORIGIN, ...(turnStartedAt !== undefined ? { turnStartedAt } : {}) },
    state: 'draft',
    tasks: [task('t1', { state: 'routed', recommendation: REC })],
    createdAt,
    updatedAt: createdAt,
  });
}

function write(m: Mission, at: number, patch: Partial<Mission>): Mission {
  return { ...m, ...patch, updatedAt: at };
}

function withTask(m: Mission, t: Partial<Task>, at: number, extra: Partial<Mission> = {}, attempts?: ExecutionAttempt[]): Mission {
  return write(m, at, { ...extra, tasks: [{ ...m.tasks[0], ...t }], ...(attempts ? { attempts } : {}) });
}

const approve = (m: Mission, at: number) => write(m, at, { startApproval: { at, by: 'user' } });
const launch = (m: Mission, at: number) =>
  withTask(m, { state: 'running', attemptIds: ['a1'] }, at, { state: 'running' }, [attempt('a1', 't1', { state: 'running', launchedAt: at })]);
const workerAsks = (m: Mission, at: number) => withTask(m, {}, at, {}, [attempt('a1', 't1', { state: 'waiting-human', launchedAt: at })]);
const verifying = (m: Mission, at: number) =>
  withTask(m, { state: 'verifying' }, at, {}, [attempt('a1', 't1', { state: 'verifying', launchedAt: at })]);
const review = (m: Mission, at: number) =>
  withTask(m, { state: 'done' }, at, { state: 'review' }, [attempt('a1', 't1', { state: 'succeeded', launchedAt: at, endedAt: at })]);
const merge = (m: Mission, at: number) =>
  write(m, at, { state: 'completed', finish: 'merge-local', finishResult: { mergeCommit: 'def456', note: 'merged into main' }, stateReason: 'merged into main' });

function derive(session: SessionEvidence, records: Mission[], now = T0 + 60 * MIN) {
  return deriveSessionState(session, records, now);
}

// ---------------------------------------------------------------------------

describe('pending approval is never running (§4)', () => {
  it('an open proposal is awaiting approval until its start is on record, then running, never back', () => {
    const a = proposal('mA', T0, T0 + 1);
    expect(missionPhase(a)).toMatchObject({ phase: 'awaiting-approval', needsYou: true, text: '1 task to start' });
    // A proposal that needs the user to pick a route is still awaiting approval, not needs-you or running.
    const pick = withTask(a, { state: 'needs-human' }, T0 + 2);
    expect(missionPhase(pick).phase).toBe('awaiting-approval');
    expect(taskPhase(pick, pick.tasks[0]).phase).toBe('to-start');

    const approved = approve(a, T0 + 3);
    expect(missionPhase(approved)).toMatchObject({ phase: 'running', needsYou: false });
    expect(missionPhase(launch(approved, T0 + 4))).toMatchObject({ phase: 'running', text: 'running · 0/1 done' });
  });

  it('an approved proposal whose launch was refused needs you, with the task named, and is not "to start" again', () => {
    const refused = withTask(approve(proposal('mA', T0, T0 + 1), T0 + 2), { state: 'needs-human', stateReason: 'cap refused' }, T0 + 3);
    expect(missionPhase(refused)).toMatchObject({ phase: 'needs-you', ref: { missionId: 'mA', taskId: 't1' } });
  });

  it('a plan in review is awaiting approval keyed by its planner run; a replan is a new key (K1)', () => {
    const planned = mission({
      id: 'mP',
      origin: { ...ORIGIN, turnStartedAt: T0 },
      planned: true,
      delegation: { at: T0, acceptanceCriteria: [] },
      state: 'plan-review',
      tasks: [task('t1'), task('t2'), task('t3')],
      planning: [{ id: 'run1', kind: 'plan', state: 'proposed', startedAt: T0, model: 'm', rounds: [], editsInReview: 0 }],
    });
    expect(missionPhase(planned)).toMatchObject({ phase: 'awaiting-approval', text: 'plan of 3 to approve', ref: { missionId: 'mP', planRunId: 'run1' } });
    const replanned = write(planned, T0 + 5, {
      planning: [...planned.planning!, { id: 'run2', kind: 'replan', state: 'proposed', startedAt: T0 + 5, model: 'm', rounds: [], editsInReview: 0 }],
    });
    expect(missionPhase(replanned).ref.planRunId).toBe('run2');
    // Still planning: activity, not an ask.
    expect(missionPhase(write(planned, T0 + 6, { state: 'planning' }))).toMatchObject({ phase: 'planning', needsYou: false, short: 'Delegating' });
  });
});

describe('the origin row (§5.1, W3)', () => {
  it('planning is its own activity beside Busy, not plain Busy', () => {
    const planning = mission({ id: 'mP', origin: { ...ORIGIN, turnStartedAt: T0 }, planned: true, delegation: { at: T0, acceptanceCriteria: [] }, state: 'planning', createdAt: T0 + 1, updatedAt: T0 + 1 });
    const d = derive(origin({ status: 'busy', turnStartedAt: T0 }), [planning]);
    expect(d.status).toBe('busy');
    expect(d.wait).toMatchObject({ reason: 'planning', source: 'mission', ref: { missionId: 'mP' }, detail: 'Delegated: planning' });
    expect(d.needsUser).toBe(false);
  });

  it('a parent waiting on child work is not Waiting, not counted, and says it waits on delegated work', () => {
    const running = launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3);
    const row = origin({ status: 'waiting', turnStartedAt: T0, lastActivityAt: T0 + 4 });
    const d = derive(row, [running]);
    expect(d.status).toBe('done');
    expect(d.needsUser).toBe(false);
    expect(d.wait).toMatchObject({ reason: 'awaiting-children', ref: { missionId: 'mA' } });
    const applied = withDerivedState(row, [running], T0 + 5);
    expect(attentionCount([applied], [running])).toBe(0);
    // Never an early Done toast while the child runs.
    expect(toastAllowed(applied)).toBe(false);
  });

  it('Waiting stays only for a real outstanding ask, and carries its reason and mission', () => {
    const a = proposal('mA', T0, T0 + 1);
    const d = derive(origin({ status: 'waiting', turnStartedAt: T0 }), [a]);
    expect(d.status).toBe('waiting');
    expect(d.wait).toMatchObject({ reason: 'awaiting-approval', source: 'mission', ref: { missionId: 'mA', taskId: 't1' }, certainty: 'verified' });
    // A plain question with nothing delegated is a user-reply, inferred from prose.
    expect(derive(origin({ status: 'waiting', turnStartedAt: T0 }), []).wait).toMatchObject({ reason: 'user-reply', certainty: 'inferred' });
  });

  it('a provider prompt beats everything, with the prompt kind as its reason (W1)', () => {
    const a = launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3);
    expect(derive(origin({ status: 'blocked', blockedReason: 'Approval' }), [a]).wait?.reason).toBe('permission');
    expect(derive(origin({ status: 'blocked', blockedReason: 'Question' }), [a]).wait?.reason).toBe('user-question');
    expect(derive(origin({ provider: 'claude', key: 'claude:x', status: 'blocked', blockedReason: 'plan approval' }), []).wait?.reason).toBe('plan-approval');
    expect(derive(origin({ provider: 'claude', key: 'claude:x', status: 'blocked', blockedReason: 'Bash' }), []).wait).toMatchObject({ reason: 'permission', source: 'hook' });
  });

  it('quiet legitimate waits never become Possibly stuck', () => {
    const planning = mission({ id: 'mP', origin: { ...ORIGIN, turnStartedAt: T0 }, planned: true, state: 'planning', createdAt: T0 + 1, updatedAt: T0 + 1 });
    expect(derive(origin({ status: 'stuck', turnStartedAt: T0 }), [planning])).toMatchObject({ status: 'busy', wait: { reason: 'planning' } });
    const rl = { provider: 'claude', category: 'unknown', reason: 'rate limited', raw: {} } as unknown as AgentSession['rateLimit'];
    expect(derive(origin({ status: 'stuck', rateLimit: rl }), [])).toMatchObject({ status: 'busy', wait: { reason: 'rate-limit', certainty: 'unknown' } });
    // #60 kept: background work on a busy row is its own reason.
    expect(derive(origin({ status: 'busy', backgroundTasks: { subagents: 2, shells: 0, other: 0 } }), []).wait).toMatchObject({ reason: 'background', detail: '2 in background' });
    // A stall with nothing in flight is still a stall.
    expect(derive(origin({ status: 'stuck' }), []).status).toBe('stuck');
  });

  it('W4: a new user prompt after the mission ends the tie, and prose decides again', () => {
    const a = proposal('mA', T0, T0 + 1);
    const d = derive(origin({ status: 'waiting', turnStartedAt: T0 + 10 * MIN }), [a]);
    expect(d.status).toBe('waiting');
    expect(d.wait).toMatchObject({ reason: 'user-reply' });
    expect(d.wait?.ref).toBeUndefined();
    expect(d.linked[0]).toMatchObject({ missionId: 'mA', keyed: false });
  });

  it('marks unknown signals uncertain instead of guessing (U1)', () => {
    const weird = write(proposal('mX', T0, T0 + 1), T0 + 2, { state: 'teleporting' as Mission['state'] });
    expect(missionPhase(weird)).toMatchObject({ phase: 'unknown', certainty: 'unknown', needsYou: false });
    // No turn start: the keying is estimated, and so is the wait it gives.
    const d = derive(origin({ status: 'waiting' }), [proposal('mA', undefined, T0 + 1)]);
    expect(d.linked[0].keyedEstimated).toBe(true);
    expect(d.wait).toMatchObject({ reason: 'awaiting-approval', certainty: 'inferred' });
    // A host link that is down makes the row's certainty unknown.
    expect(derive(origin({ status: 'busy', statusUncertain: 'reconnecting', backgroundTasks: { subagents: 1, shells: 0, other: 0 } }), []).wait?.certainty).toBe('unknown');
  });
});

describe('approval / launch / final-reply races', () => {
  const turn = T0;
  const a0 = proposal('mA', turn, T0 + 1);

  it('approval before the final reply: Busy with delegated activity, then Done when the reply lands', () => {
    const approved = approve(a0, T0 + 2);
    expect(derive(origin({ status: 'busy', turnStartedAt: turn }), [a0, approved])).toMatchObject({ status: 'busy', wait: { reason: 'awaiting-children' } });
    // The reply, written from `aw task`'s answer, still says "waiting for your approval".
    expect(derive(origin({ status: 'waiting', turnStartedAt: turn }), [a0, approved]).status).toBe('done');
  });

  it('final reply before approval: Waiting on that approval, cleared by approval, launch, completion or merge', () => {
    const row = origin({ status: 'waiting', turnStartedAt: turn });
    expect(derive(row, [a0]).status).toBe('waiting');
    const approved = approve(a0, T0 + 2);
    const launched = launch(approved, T0 + 3);
    const reviewed = review(launched, T0 + 4);
    const merged = merge(reviewed, T0 + 5);
    expect(derive(row, [a0, approved]).status).toBe('done');
    expect(derive(row, [a0, approved, launched]).status).toBe('done');
    // Ready to merge is a real ask again: the reply's Waiting now points at the merge.
    expect(derive(row, [a0, approved, launched, reviewed]).wait).toMatchObject({ reason: 'user-reply', ref: { missionId: 'mA' } });
    const final = derive(row, [a0, approved, launched, reviewed, merged]);
    expect(final.status).toBe('done');
    expect(final.wait).toBeUndefined();
    expect(final.linked[0]).toMatchObject({ phase: 'integrated', terminal: true });
  });

  it('launch landing before the approval write is seen (out of order) still reads as the newest record', () => {
    const approved = approve(a0, T0 + 2);
    const launched = launch(approved, T0 + 3);
    const row = origin({ status: 'waiting', turnStartedAt: turn });
    expect(derive(row, [a0, launched, approved]).linked[0].phase).toBe('running');
    expect(derive(row, [launched, a0]).status).toBe('done');
  });
});

describe('several children', () => {
  it('two missions in one turn resolve separately: approving one never clears the other (K3)', () => {
    const a = proposal('mA', T0, T0 + 1);
    const b = proposal('mB', T0, T0 + 2);
    const row = origin({ status: 'waiting', turnStartedAt: T0 });
    expect(derive(row, [a, b]).wait?.ref?.missionId).toBe('mB'); // both ask; the newest shows
    const bRunning = launch(approve(b, T0 + 3), T0 + 4);
    const d = derive(row, [a, b, bRunning]);
    expect(d.status).toBe('waiting');
    expect(d.wait).toMatchObject({ reason: 'awaiting-approval', ref: { missionId: 'mA' } });
    const aRunning = launch(approve(a, T0 + 5), T0 + 6);
    expect(derive(row, [a, b, bRunning, aRunning]).status).toBe('done');
  });

  it('a planned mission of several tasks: progress counts required tasks only, and a task needing you is named', () => {
    const m = mission({
      id: 'mP',
      origin: { ...ORIGIN, turnStartedAt: T0 },
      planned: true,
      planApprovedAt: T0 + 1,
      state: 'running',
      tasks: [
        task('t1', { state: 'done', attemptIds: ['a1'] }),
        task('t2', { state: 'running', attemptIds: ['a2'] }),
        task('t3', { state: 'skipped' }),
        task('t4', { state: 'pending' }),
      ],
      attempts: [attempt('a1', 't1', { state: 'succeeded' }), attempt('a2', 't2', { state: 'running' })],
    });
    const p = missionPhase(m);
    expect(p).toMatchObject({ phase: 'running', text: 'running · 1/3 done', progress: { done: 1, required: 3 } });
    // The Missions header reads the same counts (L4).
    expect(missionMetrics(m)).toMatchObject({ done: 1, total: 4, skipped: 1 });

    const asks = write(m, T0 + 9, { tasks: m.tasks.map((t) => (t.id === 't2' ? { ...t, state: 'needs-human' as const, stateReason: 'unverified' } : t)) });
    expect(missionPhase(asks)).toMatchObject({ phase: 'needs-you', text: 't2 needs you', ref: { taskId: 't2' } });
    // A worker's own ask is counted on the worker's row, not the mission's (A3).
    const worker = write(m, T0 + 10, { attempts: [m.attempts[0], attempt('a2', 't2', { state: 'waiting-human' })] });
    expect(missionPhase(worker)).toMatchObject({ phase: 'awaiting-children', needsYou: false });
  });

  it('the row chip shows the most urgent entry, then +N (A4)', () => {
    const running = launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3);
    const asking = proposal('mB', T0, T0 + 4);
    const h = headlineOf(linkedWorkFor(origin(), [running, asking], T0 + 5));
    expect(h?.entry.missionId).toBe('mB');
    expect(h?.more).toBe(1);
  });
});

describe('retries, cancellation and failure', () => {
  it('a retry after a failed attempt is running again, on the same mission key', () => {
    const running = launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3);
    const failed = withTask(running, { state: 'needs-human', stateReason: 'tests failed' }, T0 + 4, {}, [attempt('a1', 't1', { state: 'failed', endedAt: T0 + 4 })]);
    expect(missionPhase(failed).phase).toBe('needs-you');
    const retried = withTask(failed, { state: 'running', attemptIds: ['a1', 'a2'] }, T0 + 5, {}, [failed.attempts[0], attempt('a2', 't1', { n: 2, state: 'running' })]);
    expect(missionPhase(retried)).toMatchObject({ phase: 'running', ref: { missionId: 'mA' } });
    expect(taskPhase(retried, retried.tasks[0]).phase).toBe('running');
  });

  it('cancellation ends the mission and its key leaves the wait set', () => {
    const a = proposal('mA', T0, T0 + 1);
    const row = origin({ status: 'waiting', turnStartedAt: T0 });
    const cancelled = write(a, T0 + 2, { state: 'cancelled', stateReason: 'Cancelled by the user' });
    const d = derive(row, [a, cancelled]);
    expect(d.status).toBe('done');
    expect(d.linked[0]).toMatchObject({ phase: 'cancelled', terminal: true, needsYou: false });
    expect(toastAllowed(withDerivedState(row, [cancelled], T0 + 3))).toBe(true);
  });

  it('failure needs you once, on the mission; the origin\'s Waiting points at it', () => {
    const failed = write(launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3), T0 + 4, { state: 'failed', stateReason: 'could not commit' });
    const d = derive(origin({ status: 'waiting', turnStartedAt: T0 }), [failed]);
    expect(d).toMatchObject({ status: 'waiting', wait: { reason: 'user-reply', ref: { missionId: 'mA' } } });
    expect(attentionCount([withDerivedState(origin({ status: 'waiting', turnStartedAt: T0 }), [failed], T0 + 5)], [failed])).toBe(1);
  });
});

describe('stale and duplicate events', () => {
  it('a duplicate snapshot changes nothing; a stale one is ignored for the newer record', () => {
    const a = proposal('mA', T0, T0 + 1);
    const running = launch(approve(a, T0 + 2), T0 + 3);
    const row = origin({ status: 'waiting', turnStartedAt: T0 });
    const once = derive(row, [a, running]);
    expect(derive(row, [a, running, running, running])).toEqual(once);
    expect(derive(row, [running, a, a])).toEqual(once);
    expect(latestMissions([running, a]).map((m) => m.updatedAt)).toEqual([T0 + 3]);
  });

  it('re-deriving a derived row gives the same row (idempotent)', () => {
    const running = launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3);
    const row = origin({ status: 'waiting', turnStartedAt: T0 });
    const once = withDerivedState(row, [running], T0 + 4);
    // The store always re-derives from the provider's raw reading, but even
    // the derived row carries no state that would drift if fed back.
    expect(withDerivedState({ ...once, status: row.status }, [running], T0 + 4)).toEqual(once);
  });

  it('the integrated notice is sent once per mission, and never for a state that held at startup (N1)', () => {
    const merged = merge(review(launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3), T0 + 4), T0 + 5);
    const boot = linkedNotices([merged], new Set(), { initial: true });
    expect(boot.notices).toEqual([]);
    expect(linkedNotices([merged, merged], boot.seen).notices).toEqual([]);

    const b = merge(review(launch(approve(proposal('mB', T0, T0 + 6), T0 + 7), T0 + 8), T0 + 9), T0 + 10);
    const first = linkedNotices([merged, b], boot.seen, { sinceMs: T0 });
    expect(first.notices).toEqual([
      { key: 'mB:integrated', missionId: 'mB', title: 'Delegated work finished: Mission mB', body: 'Merged; not verified; issue not closed by Agent Wrangler.' },
    ]);
    expect(linkedNotices([merged, b, b], first.seen, { sinceMs: T0 }).notices).toEqual([]);
    // Loaded from disk after startup, but finished before it: not news.
    expect(linkedNotices([b], new Set(), { sinceMs: T0 + 11 }).notices).toEqual([]);
  });
});

describe('completed, verified and closed out are different facts (C1–C3)', () => {
  it('merged but unverified, with no checks configured, and closeout left to you', () => {
    const merged = merge(review(launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3), T0 + 4), T0 + 5);
    expect(missionPhase(merged)).toMatchObject({
      phase: 'integrated',
      text: 'merged · unverified (no checks configured) · closeout: yours',
      outcome: { integrated: true, finish: 'merge-local', mergeCommit: 'def456', verification: 'unverified', noChecks: true, closeout: 'yours' },
    });
  });

  it('verified only when every required check passed', () => {
    const base = merge(review(launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3), T0 + 4), T0 + 5);
    const checked: Mission = {
      ...base,
      tasks: [{ ...base.tasks[0], verification: { stages: [{ strategy: 'command:test', required: true }] } }],
      attempts: [{ ...base.attempts[0], verification: [{ strategy: 'command:test', state: 'finished', outcome: 'passed', startedAt: T0 }] }],
    };
    expect(missionPhase(checked)).toMatchObject({ text: 'merged · verified · closeout: yours', outcome: { verification: 'verified', closeout: 'yours' } });
    const red: Mission = { ...checked, attempts: [{ ...checked.attempts[0], verification: [{ strategy: 'command:test', state: 'finished', outcome: 'failed', startedAt: T0 }] }] };
    expect(missionPhase(red).outcome?.verification).toBe('failed');
  });

  it('a pull request and a discard are told apart from a merge', () => {
    const reviewed = review(launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3), T0 + 4);
    expect(missionPhase(write(reviewed, T0 + 5, { state: 'completed', finish: 'pull-request', finishResult: { pullRequestUrl: 'https://example.invalid/pr/1' } })).short).toBe('PR opened');
    expect(missionPhase(write(reviewed, T0 + 5, { state: 'completed', finish: 'discard' }))).toMatchObject({ phase: 'cancelled', text: 'discarded' });
  });

  it('no source file closes a GitHub issue', () => {
    const root = path.resolve(__dirname, '../../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    const offenders = files.filter((f) => /gh['",\s]+issue['",\s]+close|issue\s+close|state:\s*['"]closed['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('restart recovery', () => {
  it('re-derives the same answer from persisted records with no turn stamp to go on (estimated)', () => {
    const a = approve(proposal('mA', T0, T0 + 1), T0 + 2);
    const launched = launch(a, T0 + 3);
    // Before the restart: a hook-reported turn start.
    const before = derive(origin({ status: 'waiting', turnStartedAt: T0 }), [launched]);
    // After: the backlog replay cannot date the prompt, so the provider reports none.
    const after = derive(origin({ status: 'waiting' }), [launched]);
    expect(after.status).toBe(before.status);
    expect(after.wait?.reason).toBe(before.wait?.reason);
    expect(after.wait?.ref).toEqual(before.wait?.ref);
    expect(after.linked[0].keyedEstimated).toBe(true);
  });

  it('a mission recorded before #101 (no turn stamp) is keyed by its creation time', () => {
    const legacy = proposal('mA', undefined, T0 + 5);
    expect(linkedWorkFor(origin({ turnStartedAt: T0 }), [legacy], T0 + 6)[0].keyed).toBe(true);
    expect(linkedWorkFor(origin({ turnStartedAt: T0 + 10 }), [legacy], T0 + 11)[0].keyed).toBe(false);
  });

  it('terminal work leaves the summary after a day (L1)', () => {
    const merged = merge(review(launch(approve(proposal('mA', T0, T0 + 1), T0 + 2), T0 + 3), T0 + 4), T0 + 5);
    expect(linkedWorkFor(origin(), [merged], T0 + 23 * 60 * MIN)).toHaveLength(1);
    expect(linkedWorkFor(origin(), [merged], T0 + 25 * 60 * MIN)).toHaveLength(0);
  });
});

describe('the full sequence: proposal-only → corrective → approval → execution → merge → reconciliation', () => {
  it('keeps both missions on the one origin, resolves every wait to the right mission id, and matches the Missions view', () => {
    const records: Mission[] = [];
    const put = (m: Mission) => {
      records.push(m);
      return m;
    };
    const snapshot = (row: SessionEvidence, now: number) => derive(row, records, now);

    // Turn 1: the user asks; the agent proposes a first task (`aw task`).
    const turn1 = T0;
    let a = put(proposal('mA', turn1, turn1 + 1, 'Investigate the gameplay bug'));
    let s = snapshot(origin({ status: 'waiting', turnStartedAt: turn1 }), turn1 + 2);
    expect(s).toMatchObject({ status: 'waiting', wait: { reason: 'awaiting-approval', ref: { missionId: 'mA' } } });

    // The user starts it; it runs and finishes as proposal-only work: kept on its branch, not merged.
    a = put(approve(a, turn1 + 3));
    a = put(launch(a, turn1 + 4));
    s = snapshot(origin({ status: 'waiting', turnStartedAt: turn1 }), turn1 + 5);
    expect(s).toMatchObject({ status: 'done', wait: { reason: 'awaiting-children', ref: { missionId: 'mA' } } });
    a = put(review(a, turn1 + 6));
    a = put(write(a, turn1 + 7, { state: 'completed', finish: 'keep', finishResult: { note: 'kept on its branch' } }));

    // Turn 2: a new prompt; the agent proposes the corrective task. Its reply says it awaits approval.
    const turn2 = T0 + 30 * MIN;
    let b = put(proposal('mB', turn2, turn2 + 1, 'Fix the gameplay bug'));
    const row2 = origin({ status: 'waiting', turnStartedAt: turn2, lastActivityAt: turn2 + 2 });
    s = snapshot(row2, turn2 + 2);
    expect(s.status).toBe('waiting');
    expect(s.wait).toMatchObject({ reason: 'awaiting-approval', ref: { missionId: 'mB', taskId: 't1' } });
    expect(s.linked.map((w) => [w.missionId, w.phase, w.keyed])).toEqual([
      ['mA', 'integrated', false],
      ['mB', 'awaiting-approval', true],
    ]);
    // One ask, counted once: on the row, which is keyed to mB (A3).
    expect(attentionCount([withDerivedState(row2, records, turn2 + 2)], records)).toBe(1);

    // Approval, execution, local merge. The origin's transcript does not change at all.
    b = put(approve(b, turn2 + 3));
    expect(snapshot(row2, turn2 + 3)).toMatchObject({ status: 'done', wait: { reason: 'awaiting-children', ref: { missionId: 'mB' } } });
    b = put(launch(b, turn2 + 4));
    b = put(workerAsks(b, turn2 + 5));
    expect(snapshot(row2, turn2 + 5)).toMatchObject({ status: 'done', needsUser: false, wait: { ref: { missionId: 'mB' } } });
    b = put(verifying(b, turn2 + 6));
    expect(snapshot(row2, turn2 + 6).wait).toMatchObject({ reason: 'verifying', ref: { missionId: 'mB' } });
    b = put(review(b, turn2 + 7));
    expect(snapshot(row2, turn2 + 7).wait).toMatchObject({ reason: 'user-reply', ref: { missionId: 'mB' } });
    b = put(merge(b, turn2 + 8));

    // Reconciliation: Done, no wait, both missions terminal and told apart.
    s = snapshot(row2, turn2 + 9);
    expect(s.status).toBe('done');
    expect(s.wait).toBeUndefined();
    expect(s.linked.map((w) => [w.missionId, w.phase, w.short])).toEqual([
      ['mA', 'integrated', 'Kept'],
      ['mB', 'integrated', 'Merged'],
    ]);
    expect(s.linked[1].outcome).toMatchObject({ integrated: true, mergeCommit: 'def456', verification: 'unverified', closeout: 'yours' });
    expect(attentionCount([withDerivedState(row2, records, turn2 + 9)], records)).toBe(0);

    // Switching to Missions: the same phases, from the same derivation.
    for (const m of latestMissions(records)) {
      const v = missionViewOf(m, { actions: () => [] });
      expect(v.phase).toEqual(missionPhase(m));
      expect(v.originKey).toBe(`codex:${ORIGIN.sessionId}`);
    }

    // Restart: the same records, replayed out of order with duplicates, and no turn stamp.
    const replay = [...records].reverse().concat(records);
    const restarted = derive(origin({ status: 'waiting', lastActivityAt: turn2 + 2 }), replay, turn2 + 10);
    expect(restarted.status).toBe('done');
    expect(restarted.linked.map((w) => w.missionId)).toEqual(['mA', 'mB']);

    // Restart mid-way (mB awaiting approval): still Waiting on mB, never on mA.
    const midway = records.filter((m) => m.id === 'mA' || m.updatedAt <= turn2 + 1);
    const mid = derive(origin({ status: 'waiting' }), [...midway].reverse(), turn2 + 2);
    expect(mid.wait).toMatchObject({ reason: 'awaiting-approval', ref: { missionId: 'mB' } });

    // Another conversation's missions never land on this origin.
    const foreign = proposal('mC', turn2, turn2 + 1);
    foreign.origin = { ...OTHER, turnStartedAt: turn2 };
    expect(derive(row2, [...records, foreign], turn2 + 9).linked.map((w) => w.missionId)).toEqual(['mA', 'mB']);
  });
});
