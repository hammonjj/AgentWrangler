/**
 * Scoped agent mission control (docs/plans/agent-mission-control.md): the
 * read-only inspection agents get, the grant decision, the service that
 * audits and runs it, the one confirmation path for a local merge, and the
 * access policy for an agent principal. Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ACTIONS, ACTIONS, CHILD_ACTIONS, agentContext, authorize, createAccessGate, ownerContext, type AccessAuditRecord, type ActionName } from '../../src/core/access';
import { createMissionGrants, MISSION_GRANTS_KEY, type GrantAgent, type GrantMissionRunner } from '../../src/app/missionGrants';
import { runInRequest } from '../../src/core/requestScope';
import { agentActivityOf, grantDecision, missionInspection, missionWait, type AgentMissionAct } from '../../src/shared/orchestration/missionGrant';
import type { ExecutionAttempt, Mission, MissionFinish, Task, WorktreeAssignment } from '../../src/shared/orchestration/types';
import { missionViewOf } from '../../src/orchestration/view/missionViews';
import type { MissionOp } from '../../src/shared/orchestration/missionView';
import { missionsHtml, newMissionsUiState, pendingKeyOf } from '../../src/webview/dashboard/missions';
import { attempt, mission, T0, task } from './fixtures';

const PO: GrantAgent = { id: 'agent-po', name: 'Synthetic PO' };
const OTHER: GrantAgent = { id: 'agent-other', name: 'Other agent' };
const PO_SESSION = { provider: 'claude' as const, sessionId: 'po-session-1' };
const OTHER_SESSION = { provider: 'claude' as const, sessionId: 'other-session-1' };

const TEST_STAGE = { strategy: 'command:test', required: true };

function wt(id: string, branch: string): WorktreeAssignment {
  return { id, purpose: 'task', taskId: 't1', path: '/Users/test/proj.aw/t1', branch, baseCommit: 'abc123', state: 'retained', createdAt: T0 };
}

function finishedAttempt(outcome: 'passed' | 'failed' | undefined, over: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return attempt('a1', 't1', {
    state: 'succeeded',
    worktreeId: 'w1',
    verification: outcome ? [{ strategy: 'command:test', state: 'finished', outcome, startedAt: T0, summary: `test ${outcome}` }] : [],
    git: { baseCommit: 'abc123', headCommit: 'def456', commits: 2, filesChanged: 3, insertions: 40, deletions: 5 },
    ...over,
  });
}

/** A single task whose attempt finished and waits for Accept. `checks`: what its one required check said (none: no checks configured). */
function awaitingAccept(checks: 'passed' | 'failed' | 'none' = 'passed', over: Partial<Mission> = {}): Mission {
  const t: Task = task('t1', { state: 'needs-human', attemptIds: ['a1'], verification: { stages: checks === 'none' ? [] : [TEST_STAGE] } });
  return mission({
    state: 'running',
    origin: PO_SESSION,
    startApproval: { at: T0, by: 'user' },
    tasks: [t],
    attempts: [finishedAttempt(checks === 'none' ? undefined : checks)],
    worktrees: [wt('w1', 'aw/synthetic/t1')],
    ...over,
  });
}

/** The same, accepted: ready for review, waiting for its finish choice. */
function inReview(checks: 'passed' | 'none' = 'passed', over: Partial<Mission> = {}): Mission {
  const m = awaitingAccept(checks);
  return {
    ...m,
    state: 'review',
    tasks: [{ ...m.tasks[0], state: 'done', result: { branch: 'aw/synthetic/t1', commit: 'def456', acceptedBy: 'user' } }],
    ...over,
  };
}

const decide = (m: Mission, act: AgentMissionAct, opts: { granted?: boolean; caller?: string | null; owner?: string | undefined } = {}) =>
  grantDecision({
    caller: opts.caller === null ? undefined : { agentId: opts.caller ?? PO.id, granted: opts.granted ?? true },
    missionAgentId: 'owner' in opts ? opts.owner : PO.id,
    mission: m,
    act,
  });

describe('grant decision', () => {
  it('grant off (the default): every act is refused', () => {
    for (const act of [{ kind: 'accept' }, { kind: 'finish', how: 'keep' }, { kind: 'cancel' }] as AgentMissionAct[]) {
      const d = decide(act.kind === 'accept' ? awaitingAccept() : inReview(), act, { granted: false });
      expect(d).toMatchObject({ ok: false, code: 'grant-off' });
    }
  });

  it('grant on, own verified mission: accept, finish (keep, PR, discard) and cancel are allowed without a confirmation', () => {
    expect(decide(awaitingAccept(), { kind: 'accept' })).toEqual({ ok: true, needsConfirmation: false, taskId: 't1' });
    for (const how of ['pull-request', 'keep', 'discard'] as MissionFinish[]) {
      expect(decide(inReview(), { kind: 'finish', how })).toEqual({ ok: true, needsConfirmation: false });
    }
    expect(decide(inReview(), { kind: 'cancel' })).toEqual({ ok: true, needsConfirmation: false });
  });

  it('a conversation that is not a durable agent is refused', () => {
    expect(decide(awaitingAccept(), { kind: 'accept' }, { caller: null })).toMatchObject({ ok: false, code: 'not-an-agent' });
  });

  it('wrong origin: another agent’s mission, or one with no agent behind it, is refused even with the grant on', () => {
    expect(decide(inReview(), { kind: 'finish', how: 'keep' }, { caller: OTHER.id })).toMatchObject({ ok: false, code: 'wrong-origin' });
    expect(decide(inReview(), { kind: 'cancel' }, { owner: undefined })).toMatchObject({ ok: false, code: 'wrong-origin' });
  });

  it('unverified: a failed or unconfigured check is never acted on by an agent', () => {
    expect(decide(awaitingAccept('none'), { kind: 'accept' })).toMatchObject({ ok: false, code: 'unverified' });
    expect(decide(awaitingAccept('failed'), { kind: 'accept' })).toMatchObject({ ok: false, code: 'unverified' });
    expect(decide(inReview('none'), { kind: 'finish', how: 'keep' })).toMatchObject({ ok: false, code: 'unverified' });
    expect(decide(inReview('none'), { kind: 'cancel' })).toMatchObject({ ok: false, code: 'unverified' });
    // A running mission has nothing verified yet: cancel is the user's.
    const running = awaitingAccept('passed', { tasks: [task('t1', { state: 'running', attemptIds: [] })], attempts: [] });
    expect(decide(running, { kind: 'cancel' })).toMatchObject({ ok: false, code: 'unverified' });
  });

  it('merge-local always needs the user’s confirmation, alone or chosen with accept', () => {
    expect(decide(inReview(), { kind: 'finish', how: 'merge-local' })).toEqual({ ok: true, needsConfirmation: true });
    expect(decide(awaitingAccept(), { kind: 'accept', finish: 'merge-local' })).toEqual({ ok: true, needsConfirmation: true, taskId: 't1' });
    expect(decide(awaitingAccept(), { kind: 'accept', finish: 'pull-request' })).toMatchObject({ ok: true, needsConfirmation: false });
  });

  it('not available: finishing before review, or while a finish is under way; accepting with nothing to accept', () => {
    expect(decide(awaitingAccept(), { kind: 'finish', how: 'keep' })).toMatchObject({ ok: false, code: 'not-available' });
    expect(decide(inReview('passed', { pendingFinish: { how: 'keep', at: T0 } as Mission['pendingFinish'] }), { kind: 'finish', how: 'keep' })).toMatchObject({ ok: false, code: 'not-available' });
    expect(decide(inReview(), { kind: 'accept' })).toMatchObject({ ok: false, code: 'not-available' });
    expect(decide(inReview('passed', { state: 'completed', finish: 'keep' }), { kind: 'cancel' })).toMatchObject({ ok: false, code: 'not-available' });
  });
});

describe('inspection (read-only)', () => {
  it('reports state, task state, checks, branch, diff stat and what it waits on', () => {
    const v = missionInspection(awaitingAccept(), { missionAgentId: PO.id, callerAgentId: PO.id });
    expect(v).toMatchObject({
      state: 'running',
      repo: 'proj',
      baseRef: 'main',
      branch: 'aw/synthetic/t1',
      diff: { commits: 2, filesChanged: 3, insertions: 40, deletions: 5 },
      verification: { verdict: 'verified', noChecks: false },
      waitingOn: { kind: 'ready-for-review', taskKey: 't1' },
      origin: 'yours',
    });
    expect(v.tasks[0]).toMatchObject({
      key: 't1',
      state: 'needs-human',
      attempt: { n: 1, state: 'succeeded' },
      verification: { verdict: 'passed', stages: [{ strategy: 'command:test', required: true, outcome: 'passed' }] },
    });
    expect(JSON.stringify(v)).not.toContain('/Users/test');
  });

  it('says no checks are configured, and whose mission it is', () => {
    const v = missionInspection(awaitingAccept('none'), { missionAgentId: PO.id, callerAgentId: OTHER.id });
    expect(v.verification).toEqual({ verdict: 'unverified', noChecks: true });
    expect(v.tasks[0].verification.stages).toEqual([]);
    expect(v.origin).toBe('other');
    expect(missionInspection(awaitingAccept()).origin).toBe('none');
  });

  it('waits on: route proposed, plan proposal, attempt failed, ready for review, merge confirmation, nothing', () => {
    const proposal = mission({ tasks: [task('t1', { state: 'routed', recommendation: { verdict: 'route' } as Task['recommendation'] })] });
    expect(missionWait(proposal).kind).toBe('route-proposed');
    const plan = mission({ state: 'plan-review', planned: true, delegation: { at: T0, acceptanceCriteria: [] }, tasks: [task('t1'), task('t2')] });
    expect(missionWait(plan)).toMatchObject({ kind: 'plan-proposal' });
    const failed = awaitingAccept('passed', { attempts: [finishedAttempt('failed', { state: 'failed' })] });
    expect(missionWait(failed)).toMatchObject({ kind: 'attempt-failed', taskKey: 't1' });
    expect(missionWait(inReview()).kind).toBe('ready-for-review');
    expect(missionWait(inReview()).text).toContain('not merged yet');
    expect(missionWait(inReview(), true).kind).toBe('merge-confirmation');
    expect(missionWait(inReview('passed', { state: 'completed', finish: 'keep' })).kind).toBe('nothing');
  });
});

// ---------------------------------------------------------------------------
// The service: audited, and a merge only on the user's confirmation
// ---------------------------------------------------------------------------

function rig(initial: Mission[], opts: { granted?: string[] } = {}) {
  const missions = new Map(initial.map((m) => [m.id, m]));
  const calls: string[] = [];
  const flashes: string[] = [];
  const notices: string[] = [];
  const store = new Map<string, unknown>();
  let n = 0;
  const runner: GrantMissionRunner = {
    get: (id) => missions.get(id),
    list: () => [...missions.values()],
    accept: async (id, taskId) => {
      calls.push(`accept ${taskId}`);
      const m = missions.get(id)!;
      missions.set(id, inReview('passed', { id: m.id, origin: m.origin }));
    },
    finishMission: async (id, how) => {
      calls.push(`finish ${how}`);
      const m = { ...missions.get(id)!, state: 'completed' as const, finish: how, finishResult: how === 'merge-local' ? { mergeCommit: 'fff000' } : {} };
      missions.set(id, m);
      return m;
    },
    cancel: async () => {
      calls.push('cancel');
    },
  };
  const sessions: Record<string, GrantAgent> = { [PO_SESSION.sessionId]: PO, [OTHER_SESSION.sessionId]: OTHER };
  const grants = createMissionGrants({
    storage: { get: <T,>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d), update: (k, v) => void store.set(k, v) },
    missions: () => runner,
    agents: { list: () => [PO, OTHER], get: (id) => [PO, OTHER].find((a) => a.id === id), holderOf: (_p, s) => sessions[s] },
    flash: (m) => void flashes.push(m),
    notify: (title) => void notices.push(title),
    log: () => undefined,
    now: () => T0 + 1000,
    id: () => `id-${++n}`,
  });
  for (const a of opts.granted ?? []) grants.setGrant(a, true);
  return { grants, missions, calls, flashes, notices, store };
}

const ID = '01J0000000000000000000000A';

describe('mission grants service', () => {
  it('grants are off by default, per agent, and persisted', () => {
    const r = rig([inReview()]);
    expect(r.grants.grantsView().map((g) => [g.agentId, g.granted])).toEqual([
      [PO.id, false],
      [OTHER.id, false],
    ]);
    r.grants.setGrant(PO.id, true);
    expect(r.grants.isGranted(PO.id)).toBe(true);
    expect(r.grants.isGranted(OTHER.id)).toBe(false);
    expect((r.store.get(MISSION_GRANTS_KEY) as { grants: unknown[] }).grants).toHaveLength(1);
    expect(r.grants.setGrant('agent-gone', true)).toEqual({ ok: false, error: 'No such agent.' });
  });

  it('grant off: refused, nothing runs, and the refusal is audited and shown under the mission', async () => {
    const r = rig([inReview()]);
    const out = await r.grants.act(PO, ID, { kind: 'finish', how: 'keep' });
    expect(out).toMatchObject({ outcome: 'refused', code: 'grant-off' });
    expect(r.calls).toEqual([]);
    expect(r.grants.audit().at(-1)).toMatchObject({ missionId: ID, agentId: PO.id, act: 'finish', how: 'keep', outcome: 'refused', code: 'grant-off' });
    expect(r.grants.activityFor(ID)?.audit[0]).toMatchObject({ agentName: PO.name, tone: 'refused' });
  });

  it('wrong origin: another agent with its own grant on cannot touch the PO’s mission', async () => {
    const r = rig([inReview()], { granted: [OTHER.id] });
    expect(await r.grants.act(OTHER, ID, { kind: 'cancel' })).toMatchObject({ outcome: 'refused', code: 'wrong-origin' });
    expect(r.calls).toEqual([]);
  });

  it('unverified: refused and audited, never acted on', async () => {
    const r = rig([awaitingAccept('none')], { granted: [PO.id] });
    expect(await r.grants.act(PO, ID, { kind: 'accept', finish: 'keep' })).toMatchObject({ outcome: 'refused', code: 'unverified' });
    expect(r.calls).toEqual([]);
    expect(r.grants.audit().at(-1)).toMatchObject({ outcome: 'refused', code: 'unverified' });
  });

  it('grant on: accept with a finish choice accepts and finishes in one guarded step (no "accepted — branch kept")', async () => {
    const r = rig([awaitingAccept()], { granted: [PO.id] });
    const out = await r.grants.act(PO, ID, { kind: 'accept', finish: 'pull-request' });
    expect(out.outcome).toBe('done');
    expect(r.calls).toEqual(['accept t1', 'finish pull-request']);
    expect(r.grants.audit().at(-1)).toMatchObject({ act: 'accept', how: 'pull-request', outcome: 'done' });
  });

  it('merge-local needs confirmation: nothing merges until the user confirms, through the one confirmation path', async () => {
    const r = rig([inReview()], { granted: [PO.id] });
    const out = await r.grants.act(PO, ID, { kind: 'finish', how: 'merge-local' });
    expect(out.outcome).toBe('requested');
    expect(out.mission?.waitingOn.kind).toBe('merge-confirmation');
    expect(r.calls).toEqual([]);
    expect(r.notices).toHaveLength(1);
    const pending = r.grants.activityFor(ID)?.pending;
    expect(pending).toMatchObject({ agentName: PO.name, how: 'merge-local' });
    // Asking again joins the one request there is.
    await r.grants.act(PO, ID, { kind: 'finish', how: 'merge-local' });
    expect(r.grants.audit().filter((e) => e.outcome === 'requested')).toHaveLength(2);
    expect(r.notices).toHaveLength(1);

    // Two clients press Confirm at once: one merge, the other is told it was answered.
    const [first, second] = await Promise.all([
      runInRequest(ownerContext('browser', { connectionId: 'c1' }), () => r.grants.confirm(pending!.requestId, true)),
      runInRequest(ownerContext('browser', { connectionId: 'c2' }), () => r.grants.confirm(pending!.requestId, true)),
    ]);
    expect([first, second].sort()).toEqual(['applied', 'stale']);
    expect(r.calls).toEqual(['finish merge-local']);
    expect(r.grants.activityFor(ID)?.pending).toBeUndefined();
    expect(r.grants.audit().map((e) => e.outcome)).toContain('confirmed');
  });

  it('decline leaves the branch alone; a request the mission no longer allows is withdrawn, not run', async () => {
    const r = rig([inReview()], { granted: [PO.id] });
    await r.grants.act(PO, ID, { kind: 'finish', how: 'merge-local' });
    const id = r.grants.activityFor(ID)!.pending!.requestId;
    expect(await r.grants.confirm(id, false)).toBe('applied');
    expect(r.calls).toEqual([]);
    expect(r.grants.audit().at(-1)).toMatchObject({ act: 'confirm', outcome: 'declined' });

    const s = rig([inReview()], { granted: [PO.id] });
    await s.grants.act(PO, ID, { kind: 'finish', how: 'merge-local' });
    const req = s.grants.activityFor(ID)!.pending!.requestId;
    s.missions.set(ID, { ...s.missions.get(ID)!, state: 'cancelled' });
    expect(await s.grants.confirm(req, true)).toBe('stale');
    expect(s.calls).toEqual([]);
    expect(await s.grants.confirm('no-such-request', true)).toBe('gone');
  });

  it('turning the grant off withdraws the agent’s unanswered merge requests', async () => {
    const r = rig([inReview()], { granted: [PO.id] });
    await r.grants.act(PO, ID, { kind: 'finish', how: 'merge-local' });
    r.grants.setGrant(PO.id, false);
    expect(r.grants.hasPendingConfirmation(ID)).toBe(false);
    expect(r.grants.audit().map((e) => [e.act, e.outcome])).toContainEqual(['confirm', 'stale']);
    expect(r.grants.audit().map((e) => [e.act, e.outcome])).toContainEqual(['grant', 'off']);
  });

  it('every grant act is audited by ids and names only', async () => {
    const r = rig([inReview()], { granted: [PO.id] });
    await r.grants.act(PO, ID, { kind: 'finish', how: 'keep' });
    await r.grants.act(PO, 'missing', { kind: 'cancel' });
    const outcomes = r.grants.audit().map((e) => [e.act, e.outcome]);
    expect(outcomes).toEqual([
      ['grant', 'on'],
      ['finish', 'done'],
      ['cancel', 'refused'],
    ]);
    expect(JSON.stringify(r.grants.audit())).not.toContain('/Users/test');
  });

  it('read-only inspection marks the caller’s own missions and can filter to them', () => {
    const own = inReview();
    const theirs = inReview('passed', { id: '01J0000000000000000000000B', origin: OTHER_SESSION });
    const r = rig([own, theirs]);
    expect(r.grants.inspect({ caller: PO }).map((v) => v.origin).sort()).toEqual(['other', 'yours']);
    expect(r.grants.inspect({ caller: PO, mine: true }).map((v) => v.missionId)).toEqual([own.id]);
  });
});

describe('agent activity view', () => {
  it('newest first, at most six lines, with the pending request', () => {
    const audit = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, at: T0 + i, missionId: 'm', agentId: PO.id, agentName: PO.name, act: 'finish' as const, how: 'keep' as const, outcome: 'refused' as const, code: 'unverified' as const }));
    const v = agentActivityOf('m', audit, [{ id: 'r1', missionId: 'm', agentId: PO.id, agentName: PO.name, how: 'merge-local', at: T0, state: 'pending' }]);
    expect(v?.audit).toHaveLength(6);
    expect(v?.audit[0].at).toBe(T0 + 7);
    expect(v?.pending?.requestId).toBe('r1');
    expect(agentActivityOf('other', audit, [])).toBeUndefined();
  });
});

describe('the Missions page shows the grant', () => {
  it('a pending merge request has Confirm merge and Decline through the pending-action pattern, and the audit is listed', async () => {
    const r = rig([inReview()], { granted: [PO.id] });
    await r.grants.act(PO, ID, { kind: 'finish', how: 'merge-local' });
    const m = r.missions.get(ID)!;
    const view = { ...missionViewOf(m, { actions: () => [] }), agentActivity: r.grants.activityFor(ID) };
    const html = missionsHtml({ missions: [view], tiers: [], harnesses: [] }, newMissionsUiState(), T0);
    expect(html).toContain('Merge requested');
    expect(html).toContain('asks to merge this mission locally');
    expect(html).toMatch(/data-mission-op="agent-request:confirm"[^>]*>Confirm merge</);
    expect(html).toMatch(/data-mission-op="agent-request:decline"[^>]*>Decline</);
    // The grant switching on is the agent's, not the mission's: one line here.
    expect(html).toContain('Agent activity (1)');
    expect(html).toContain('waiting for your confirmation');
    const op: MissionOp = { kind: 'agent-request', requestId: 'r1', approve: true };
    expect(pendingKeyOf(ID, op)).toEqual({ key: `mission:${ID}:agent-request:confirm`, label: 'Merging…' });
  });
});

describe('authorize(): an agent principal', () => {
  it('may read and ask for mission.agent, and nothing else — send, stop, settings, merges included', () => {
    const ctx = agentContext(PO.id);
    // The child actions (#198) need a target that is the agent's own child; with none they are refused too.
    for (const action of Object.keys(ACTIONS) as ActionName[]) {
      expect(authorize(ctx, action)).toBe(AGENT_ACTIONS.has(action) && !CHILD_ACTIONS.has(action) ? 'allow' : 'deny');
    }
    expect([...AGENT_ACTIONS].sort()).toEqual(['child.done', 'child.read', 'child.send', 'child.spawn', 'child.stop', 'mission.agent', 'view.read']);
    expect(authorize(ctx, 'session.send')).toBe('deny');
    expect(authorize(ctx, 'mission.act')).toBe('deny');
    expect(authorize(ctx, 'mission.grant')).toBe('deny');
  });

  it('a forged agent principal (id not matching its agent) is denied; the owner still may do anything', () => {
    const forged = { principal: { id: 'local-owner', kind: 'agent', agentId: PO.id }, via: 'cli' } as never;
    expect(authorize(forged, 'mission.agent')).toBe('deny');
    expect(authorize(ownerContext('cli'), 'mission.agent')).toBe('allow');
  });

  it('the gate audits an agent’s mission.agent under the agent, with the mission id', () => {
    const audit: AccessAuditRecord[] = [];
    const gate = createAccessGate({ audit: { write: (r) => audit.push(r) } });
    expect(gate.admit(agentContext(PO.id), 'mission.agent', { kind: 'mission', id: ID })).toBe(true);
    expect(gate.admit(agentContext(PO.id), 'session.send', { kind: 'session', id: 'claude:x' })).toBe(false);
    expect(audit.map((a) => [a.event, a.principal, a.action, a.resource?.id])).toEqual([
      ['authorized', `agent:${PO.id}`, 'mission.agent', ID],
      ['refused-unauthorised', `agent:${PO.id}`, 'session.send', 'claude:x'],
    ]);
  });
});
