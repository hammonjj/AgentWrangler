/**
 * Scoped agent mission control, as the application runs it
 * (`docs/plans/agent-mission-control.md`).
 *
 * - Every durable agent's grant is **off** until the user turns it on in
 *   Preferences. The grant is stored here, by agent id, in Agent Wrangler's
 *   own state; never in a repository, never in the agent's memory.
 * - A granted agent may accept, finish or cancel a mission whose origin
 *   conversation is its own, and only once that mission (or task) passed its
 *   verification checks (`grantDecision`). A local merge is never done on its
 *   word: it is recorded as a request the user confirms in the Missions page,
 *   answered through `createMissionConfirmations` (`src/app/approvals.ts`).
 * - Every attempt, allowed or refused, and every answer is written to an
 *   audit trail the Missions page shows under the mission.
 *
 * The dispatcher (the control socket's backend) has already passed the
 * request through `authorize()` as the agent's principal (`mission.agent`)
 * before calling `act`; this is the scoped half of that decision.
 */
import { randomUUID } from 'node:crypto';
import { Emitter, type Disposable } from '../core/events';
import type { HostStorage } from '../host/hostServices';
import {
  agentActivityOf,
  grantDecision,
  missionInspection,
  needsUserConfirmation,
  type AgentMissionAct,
  type GrantRefusal,
  type MissionAgentActivityView,
  type MissionConfirmationRequest,
  type MissionGrantAgentView,
  type MissionGrantAuditEntry,
  type MissionGrantRecord,
  type MissionInspection,
} from '../shared/orchestration/missionGrant';
import { missionVerification } from '../shared/orchestration/delegatedState';
import type { Mission, MissionFinish } from '../shared/orchestration/types';
import { createMissionConfirmations, type MissionConfirmations } from './approvals';

export const MISSION_GRANTS_KEY = 'missionGrants.v1';
/** Audit lines kept, newest last. Enough for weeks of one user's missions; the access log keeps the rest. */
export const MAX_AUDIT = 500;
/** Answered requests kept, for the "already answered" check. */
const MAX_ANSWERED = 100;

interface StoredDoc {
  grants: MissionGrantRecord[];
  audit: MissionGrantAuditEntry[];
  requests: MissionConfirmationRequest[];
}

/** The runner's half, as this needs it. `TaskRunner` satisfies it. */
export interface GrantMissionRunner {
  get(id: string): Mission | undefined;
  list(): Mission[];
  accept(missionId: string, taskId?: string): Promise<void>;
  finishMission(missionId: string, how: MissionFinish): Promise<Mission>;
  cancel(missionId: string): Promise<void>;
}

export interface GrantAgent {
  id: string;
  name: string;
  role?: string;
  archived?: boolean;
}

export interface MissionGrantDeps {
  storage: HostStorage;
  /** Undefined while orchestration is off: every act is refused, every list is empty. */
  missions: () => GrantMissionRunner | undefined;
  agents: {
    list(): readonly GrantAgent[];
    get(id: string): GrantAgent | undefined;
    /** The durable agent a conversation belongs to (current or earlier), or undefined. */
    holderOf(provider: string, sessionId: string): GrantAgent | undefined;
    /** An agent was added, renamed or removed: Preferences' list follows. */
    onDidChange?(listener: () => void): Disposable;
  };
  /** A line for the client whose click this is. */
  flash(message: string, timeoutMs?: number): void;
  /** An OS notice for the user: a merge is waiting for their confirmation. */
  notify?(title: string, body: string, missionId: string): void;
  log(line: string): void;
  now?: () => number;
  id?: () => string;
}

export interface MissionActResult {
  /** `done`: carried out. `requested`: a local merge waits for the user. `refused`: the grant said no. `failed`: allowed, but it did not go through. */
  outcome: 'done' | 'requested' | 'refused' | 'failed';
  code?: GrantRefusal;
  message: string;
  mission?: MissionInspection;
}

export interface MissionGrants {
  /** The durable agent a conversation belongs to, or undefined. */
  callerOf(origin: { provider: string; sessionId: string } | undefined): GrantAgent | undefined;
  isGranted(agentId: string): boolean;
  /** The user turned an agent's grant on or off (Preferences). The caller has authorised `mission.grant`. */
  setGrant(agentId: string, on: boolean): { ok: true } | { ok: false; error: string };
  grantsView(): MissionGrantAgentView[];
  /** Read-only, for any caller: missions, newest first. `all`: finished ones too. `mine`: only the caller's own. */
  inspect(opts: { all?: boolean; mine?: boolean; caller?: GrantAgent }): MissionInspection[];
  inspectOne(missionId: string, caller?: GrantAgent): MissionInspection | undefined;
  /** A granted agent's request. The caller has authorised `mission.agent` as the agent's principal. */
  act(caller: GrantAgent, missionId: string, act: AgentMissionAct): Promise<MissionActResult>;
  /** The user's answer to a merge request (the Missions page). The caller has authorised `mission.act`. */
  confirm(requestId: string, approve: boolean): Promise<'applied' | 'stale' | 'gone'>;
  /** What the Missions page shows under a mission. */
  activityFor(missionId: string): MissionAgentActivityView | undefined;
  hasPendingConfirmation(missionId: string): boolean;
  audit(): readonly MissionGrantAuditEntry[];
  onDidChange(listener: () => void): Disposable;
}

function parseDoc(raw: unknown): StoredDoc {
  const doc = raw && typeof raw === 'object' ? (raw as Partial<StoredDoc>) : {};
  const arr = <T>(v: unknown, ok: (x: Record<string, unknown>) => boolean): T[] =>
    Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object' && ok(x as Record<string, unknown>)) as T[]) : [];
  return {
    grants: arr<MissionGrantRecord>(doc.grants, (g) => typeof g.agentId === 'string' && typeof g.grantedAt === 'number'),
    audit: arr<MissionGrantAuditEntry>(doc.audit, (e) => typeof e.id === 'string' && typeof e.at === 'number' && typeof e.agentId === 'string'),
    requests: arr<MissionConfirmationRequest>(doc.requests, (r) => typeof r.id === 'string' && typeof r.missionId === 'string' && typeof r.state === 'string'),
  };
}

export function createMissionGrants(deps: MissionGrantDeps): MissionGrants {
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? randomUUID;
  const emitter = new Emitter<void>();
  let doc = parseDoc(deps.storage.get<unknown>(MISSION_GRANTS_KEY, undefined));

  const save = (next: StoredDoc) => {
    const answered = next.requests.filter((r) => r.state !== 'pending');
    doc = {
      grants: next.grants,
      audit: next.audit.slice(-MAX_AUDIT),
      requests: [...next.requests.filter((r) => r.state === 'pending'), ...answered.slice(-MAX_ANSWERED)],
    };
    deps.storage.update(MISSION_GRANTS_KEY, doc);
    emitter.fire();
  };

  const record = (entry: Omit<MissionGrantAuditEntry, 'id' | 'at'>) => {
    const e: MissionGrantAuditEntry = { id: newId(), at: now(), ...entry };
    save({ ...doc, audit: [...doc.audit, e] });
    deps.log(
      `mission control: ${e.act}${e.how ? ` ${e.how}` : ''} ${e.outcome}${e.code ? ` (${e.code})` : ''} by durable agent ${e.agentId}${e.missionId ? ` on mission ${e.missionId}` : ''}`,
    );
  };

  const isGranted = (agentId: string) => doc.grants.some((g) => g.agentId === agentId);

  const missionAgentOf = (m: Mission): GrantAgent | undefined => (m.origin ? deps.agents.holderOf(m.origin.provider, m.origin.sessionId) : undefined);

  const hasPendingConfirmation = (missionId: string) => doc.requests.some((r) => r.missionId === missionId && r.state === 'pending');

  const inspectionOf = (m: Mission, caller?: GrantAgent): MissionInspection =>
    missionInspection(m, {
      missionAgentId: missionAgentOf(m)?.id,
      ...(caller ? { callerAgentId: caller.id } : {}),
      pendingConfirmation: hasPendingConfirmation(m.id),
    });

  const settle = (requestId: string, state: 'confirmed' | 'declined' | 'stale', reason?: string) => {
    const r = doc.requests.find((x) => x.id === requestId);
    if (!r || r.state !== 'pending') return;
    save({ ...doc, requests: doc.requests.map((x) => (x.id === requestId ? { ...x, state, answeredAt: now() } : x)) });
    record({ missionId: r.missionId, agentId: r.agentId, agentName: r.agentName, act: 'confirm', how: r.how, outcome: state, ...(reason ? { reason } : {}) });
  };

  /** A request for the user to confirm a local merge. One pending per mission: a repeat joins the one there is. */
  const requestMerge = (caller: GrantAgent, m: Mission, how: MissionFinish): MissionConfirmationRequest => {
    const existing = doc.requests.find((r) => r.missionId === m.id && r.state === 'pending');
    if (existing) return existing;
    const r: MissionConfirmationRequest = { id: newId(), missionId: m.id, agentId: caller.id, agentName: caller.name, how, at: now(), state: 'pending' };
    save({ ...doc, requests: [...doc.requests, r] });
    deps.notify?.(`${caller.name} asks to merge “${m.title}”`, 'Its checks passed. Confirm or decline the merge in Missions.', m.id);
    return r;
  };

  const confirmations: MissionConfirmations = createMissionConfirmations({
    get: (id) => doc.requests.find((r) => r.id === id),
    settle,
    recheck: (r) => {
      const m = deps.missions()?.get(r.missionId);
      if (!m) return 'the mission no longer exists';
      if (m.state !== 'review') return `the mission is ${m.state}, no longer ready to merge`;
      if (m.pendingFinish) return 'a finish is already under way';
      if (missionVerification(m).verdict !== 'verified') return 'the mission is no longer verified';
      return undefined;
    },
    finish: async (missionId, how) => {
      const runner = deps.missions();
      if (!runner) throw new Error('Tasks are off.');
      const done = await runner.finishMission(missionId, how);
      const r = done.finishResult;
      deps.flash(`Mission merged${r?.note ? `: ${r.note}` : ''}.`);
    },
    flash: deps.flash,
    log: deps.log,
  });

  return {
    callerOf: (origin) => (origin ? deps.agents.holderOf(origin.provider, origin.sessionId) : undefined),
    isGranted,
    setGrant(agentId, on) {
      const agent = deps.agents.get(agentId);
      if (!agent) return { ok: false, error: 'No such agent.' };
      if (on === isGranted(agentId)) return { ok: true };
      save({ ...doc, grants: on ? [...doc.grants, { agentId, grantedAt: now() }] : doc.grants.filter((g) => g.agentId !== agentId) });
      record({ agentId, agentName: agent.name, act: 'grant', outcome: on ? 'on' : 'off' });
      // Turning it off withdraws what the agent asked for and the user has not answered.
      if (!on) for (const r of doc.requests.filter((x) => x.agentId === agentId && x.state === 'pending')) settle(r.id, 'stale', 'mission control was turned off');
      return { ok: true };
    },
    grantsView: () =>
      deps.agents
        .list()
        .filter((a) => !a.archived || isGranted(a.id))
        .map((a) => {
          const g = doc.grants.find((x) => x.agentId === a.id);
          return { agentId: a.id, name: a.name, ...(a.role ? { role: a.role } : {}), granted: g !== undefined, ...(g ? { grantedAt: g.grantedAt } : {}) };
        }),
    inspect({ all, mine, caller }) {
      const runner = deps.missions();
      if (!runner) return [];
      return runner
        .list()
        .filter((m) => all || !['completed', 'cancelled', 'failed'].includes(m.state))
        .map((m) => inspectionOf(m, caller))
        .filter((v) => !mine || v.origin === 'yours')
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    inspectOne(missionId, caller) {
      const m = deps.missions()?.get(missionId);
      return m ? inspectionOf(m, caller) : undefined;
    },

    async act(caller, missionId, act) {
      const runner = deps.missions();
      const m = runner?.get(missionId);
      const how = act.kind === 'finish' ? act.how : act.kind === 'accept' ? act.finish : undefined;
      const base = { missionId, agentId: caller.id, agentName: caller.name, act: act.kind, ...(how ? { how } : {}) };
      if (!runner || !m) {
        record({ ...base, outcome: 'refused', code: 'not-available', reason: 'no such mission' });
        return { outcome: 'refused', code: 'not-available', message: 'No such mission.' };
      }
      const decision = grantDecision({
        caller: { agentId: caller.id, granted: isGranted(caller.id) },
        missionAgentId: missionAgentOf(m)?.id,
        mission: m,
        act,
      });
      if (!decision.ok) {
        record({ ...base, outcome: 'refused', code: decision.code, reason: decision.reason });
        return { outcome: 'refused', code: decision.code, message: decision.reason, mission: inspectionOf(m, caller) };
      }
      try {
        if (act.kind === 'cancel') {
          await runner.cancel(missionId);
          record({ ...base, outcome: 'done' });
          deps.flash(`${caller.name} cancelled “${m.title}”. Its worktree and branches are kept.`);
          return { outcome: 'done', message: 'Cancelled. Its worktree and branches are kept.', mission: inspectionOf(runner.get(missionId) ?? m, caller) };
        }
        if (act.kind === 'accept') {
          await runner.accept(missionId, decision.taskId);
          const after = runner.get(missionId) ?? m;
          if (!act.finish) {
            record({ ...base, outcome: 'done' });
            deps.flash(`${caller.name} accepted a task of “${m.title}”`);
            const left = after.state === 'review' ? ' It is not merged yet: finish it (merge-local, pull-request, keep or discard).' : '';
            return { outcome: 'done', message: `Accepted.${left}`, mission: inspectionOf(after, caller) };
          }
          // The finish chosen with Accept, so an accepted single task does not sit "accepted — not merged".
          if (after.state !== 'review') {
            record({ ...base, outcome: 'done', reason: 'accepted; the mission is not ready to finish yet' });
            return { outcome: 'done', message: 'Accepted. The mission is not ready to finish yet (more tasks to run); finish it once it is ready for review.', mission: inspectionOf(after, caller) };
          }
          return await finishAs(caller, runner, after, act.finish, base);
        }
        return await finishAs(caller, runner, m, act.how, base);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        record({ ...base, outcome: 'failed', reason: why.slice(0, 300) });
        return { outcome: 'failed', message: why, mission: inspectionOf(runner.get(missionId) ?? m, caller) };
      }
    },

    confirm: (requestId, approve) => confirmations.confirm(requestId, approve),
    activityFor: (missionId) => agentActivityOf(missionId, doc.audit, doc.requests),
    hasPendingConfirmation,
    audit: () => doc.audit,
    onDidChange: (listener) => {
      const subs = [emitter.event(listener), ...(deps.agents.onDidChange ? [deps.agents.onDidChange(listener)] : [])];
      return { dispose: () => subs.forEach((s) => s.dispose()) };
    },
  };

  async function finishAs(
    caller: GrantAgent,
    runner: GrantMissionRunner,
    m: Mission,
    how: MissionFinish,
    base: Omit<MissionGrantAuditEntry, 'id' | 'at' | 'outcome'>,
  ): Promise<MissionActResult> {
    // Checked again on the mission as it is now: an accept just moved it.
    const blocked: GrantRefusal | undefined =
      m.state !== 'review' || m.pendingFinish ? 'not-available' : missionVerification(m).verdict !== 'verified' ? 'unverified' : undefined;
    if (blocked) {
      const message = blocked === 'unverified' ? 'The mission is not verified, so an agent cannot finish it.' : 'The mission cannot be finished now.';
      record({ ...base, outcome: 'refused', code: blocked, reason: message });
      return { outcome: 'refused', code: blocked, message, mission: inspectionOf(m, caller) };
    }
    if (needsUserConfirmation(how)) {
      requestMerge(caller, m, how);
      record({ ...base, outcome: 'requested' });
      return {
        outcome: 'requested',
        message: 'Asked the user to confirm the merge. Nothing is merged until they press Confirm merge in the Missions page; carry on without waiting.',
        mission: inspectionOf(runner.get(m.id) ?? m, caller),
      };
    }
    const done = await runner.finishMission(m.id, how);
    record({ ...base, outcome: 'done' });
    const r = done.finishResult;
    const what = how === 'pull-request' ? `opened a pull request${r?.pullRequestUrl ? `: ${r.pullRequestUrl}` : ''}` : how === 'keep' ? 'kept the branch' : 'discarded the result';
    deps.flash(`${caller.name} ${what} for “${m.title}”`);
    return { outcome: 'done', message: `Done: ${what}.`, mission: inspectionOf(done, caller) };
  }
}
