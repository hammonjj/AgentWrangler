/**
 * Answering what an agent asks: the three `SessionActions` that settle a
 * permission, a question or a plan (#132, plan §8 "Approvals").
 *
 * This is the one place an ask is answered from outside the agent. The table
 * row, the conversation card (either provider), Discord and `aw` all come
 * through here, however many browsers are open, so the "is this still the ask
 * the button was drawn from?" check and what the user is told when it is not
 * are written once. A second client pressing a button the first already
 * answered gets `stale` and a line saying so; nothing reaches the agent twice.
 *
 * Out of `createApp` so it can be driven with fakes: the multi-client tests
 * run it under real pane hosts and real browser connections.
 */
import { currentRequest } from '../core/requestScope';
import type { CommandOutcome, SessionHandle } from '../core/session/sessionHandle';
import { displayLabel, type AgentSession } from '../shared/model';
import type { PermissionDecisionOutcome, SessionActions } from '../ui/actions';
import type { MissionConfirmationRequest } from '../shared/orchestration/missionGrant';
import type { MissionFinish } from '../shared/orchestration/types';

export type ApprovalActions = Pick<SessionActions, 'decidePermission' | 'answerQuestion' | 'decidePlan'>;

export interface ApprovalDeps {
  store: { get(key: string): AgentSession | undefined };
  /**
   * The live handle running this session id, either provider
   * (`SessionExecutors.get`). Its asks are answered through it: a Claude
   * session's host (the hook does not wait for hosted sessions), a Codex
   * thread's app server.
   */
  live(sessionId: string): SessionHandle | undefined;
  /**
   * A Claude session nothing here runs (a terminal's): answer through the
   * `PermissionRequest` hook, which re-checks `expectedRequestId` against the
   * id it read off the event stream. False when there was nothing to answer.
   */
  decideByHook(sessionId: string, behavior: 'allow' | 'deny' | 'always', expectedRequestId: string | undefined): Promise<boolean>;
  /** A line for the client whose click this is (`HostDialogs.flash`, scoped by #126). */
  flash(message: string, timeoutMs?: number): void;
  log(line: string): void;
}

/** The permission cards a live session still shows as pending, oldest first. */
export function pendingPermissions(handle: Pick<SessionHandle, 'blocks'>): string[] {
  return handle.blocks.flatMap((b) => (b.kind === 'permission' && b.state === 'pending' ? [b.requestId] : []));
}

export function createApprovalActions(deps: ApprovalDeps): ApprovalActions {
  /**
   * Feedback on an answer goes to the client that gave it, and only there. With
   * no client behind the request (Discord, `aw`, the app itself) there is
   * nobody to tell: the caller gets the outcome, and every other browser must
   * not be shown a toast about a button it never pressed.
   */
  const tell = (message: string, timeoutMs: number) => {
    if (currentRequest()?.connectionId !== undefined) deps.flash(message, timeoutMs);
    else deps.log(message);
  };

  /** The row, or for a session the store has not listed yet, what its key says. */
  const lookup = (key: string) => {
    const s = deps.store.get(key);
    const sessionId = s?.sessionId ?? key.slice(key.indexOf(':') + 1);
    const provider = s?.provider ?? key.slice(0, key.indexOf(':'));
    const live = deps.live(sessionId);
    return {
      s,
      sessionId,
      label: s ? displayLabel(s) : 'The session',
      name: s?.name ?? sessionId,
      live: live?.provider === provider ? live : undefined,
    };
  };

  /** What a handle said, as `SessionActions` says it, and the line for anything but success. */
  const settled = (outcome: CommandOutcome, label: string, what: string): PermissionDecisionOutcome => {
    if (outcome === 'applied' || outcome === 'unsupported') return outcome;
    if (outcome === 'stale') tell(`Agent Wrangler: that ${what} for ${label} has already been answered.`, 4000);
    else tell(`Agent Wrangler: ${label} is no longer waiting on that ${what}.`, 4000);
    return outcome;
  };

  return {
    async decidePermission(key, behavior, opts) {
      const { s, sessionId, label, name, live } = lookup(key);
      const expected = opts?.expectedRequestId;
      if (live) {
        // A session this app runs is answered through its handle: a Claude
        // session's host (§6.1), whose ask waits for days where the hook gives
        // up after ~28 minutes, and which the hook does not wait for at all
        // since Stage 4 (`AGENTWRANGLER_HOSTED`); a Codex thread's app server.
        // The request named is answered; with none named, only a lone pending
        // one, so the answer cannot land on the wrong prompt.
        const pending = pendingPermissions(live);
        const target = expected !== undefined ? pending.find((id) => id === expected) : pending.length === 1 ? pending[0] : undefined;
        if (!target) return settled(expected !== undefined ? 'stale' : 'gone', label, 'prompt');
        const outcome = await live.decide(target, behavior);
        if (outcome === 'applied') deps.log(`permission ${behavior} sent to the ${live.provider} session ${name}`);
        return settled(outcome, label, 'prompt');
      }
      if (!s || s.provider !== 'claude') return 'unsupported';
      // Caught here only to say the right thing: this snapshot can be a poll
      // behind, so `HookLog.decide` re-checks against the id it read off the
      // event stream, which is the one that actually decides.
      if (expected !== undefined && s.permissionRequestId !== expected) return settled('stale', label, 'prompt');
      const sent = await deps.decideByHook(sessionId, behavior, expected);
      if (sent) {
        deps.log(`permission ${behavior} sent to ${name}`);
        if (behavior === 'always' && s.alwaysAllow) {
          tell(`Agent Wrangler: allowed ${s.alwaysAllow.rules.join(', ')} in ${s.alwaysAllow.destination}.`, 5000);
        }
        return 'applied';
      }
      // The prompt was answered in Claude Code first, or the hook gave up
      // waiting; either way there is nothing left to decide from here.
      return settled('gone', label, 'prompt');
    },

    // A question or a plan is settled by resolving a promise only the session's
    // own process holds, so only a session this app runs can be answered. The
    // handle is the authority on whether `requestId` is still open: it says
    // `stale` for one already answered, by this client or another.
    async answerQuestion(key, requestId, answers) {
      const { label, name, live } = lookup(key);
      if (!live) return 'unsupported';
      const outcome = await live.answer(requestId, answers);
      if (outcome === 'applied') deps.log(`question answered for ${name}`);
      return settled(outcome, label, 'question');
    },

    async decidePlan(key, requestId, approve, feedback) {
      const { label, name, live } = lookup(key);
      if (!live) return 'unsupported';
      const outcome = await live.decidePlan(requestId, approve, feedback);
      if (outcome === 'applied') deps.log(`plan ${approve ? 'approved' : 'rejected'} for ${name}`);
      return settled(outcome, label, 'plan');
    },
  };
}

// ---------------------------------------------------------------------------
// Merge confirmations (agent mission control)
// ---------------------------------------------------------------------------

/**
 * The user's answer to a local merge a granted agent asked for
 * (`docs/plans/agent-mission-control.md`). An agent never moves the base
 * branch on its own word: `aw mission finish <id> merge-local` records a
 * request, and this is the one path that answers it, from whichever client
 * the user pressed Confirm or Decline in. Same rule as the asks above: the
 * request is settled before anything runs, so a second client pressing the
 * same button gets `stale` and a line saying so, and the merge runs once.
 */
export interface MissionConfirmationDeps {
  /** The request, whatever its state; undefined when there is no such request. */
  get(requestId: string): MissionConfirmationRequest | undefined;
  /** Settle it (`confirmed`, `declined`, `stale`). Only ever called on a pending request. */
  settle(requestId: string, state: 'confirmed' | 'declined' | 'stale', reason?: string): void;
  /**
   * Why the merge may no longer go ahead, or undefined when it still may:
   * the mission left review, a finish is under way, it is no longer verified.
   * Re-read at the moment of the answer, never from when the agent asked.
   */
  recheck(request: MissionConfirmationRequest): string | undefined;
  /** Run the finish the agent asked for, as the user. Rejects with a message the user should read. */
  finish(missionId: string, how: MissionFinish): Promise<void>;
  flash(message: string, timeoutMs?: number): void;
  log(line: string): void;
}

export interface MissionConfirmations {
  confirm(requestId: string, approve: boolean): Promise<'applied' | 'stale' | 'gone'>;
}

export function createMissionConfirmations(deps: MissionConfirmationDeps): MissionConfirmations {
  const tell = (message: string, timeoutMs: number) => {
    if (currentRequest()?.connectionId !== undefined) deps.flash(message, timeoutMs);
    else deps.log(message);
  };
  return {
    async confirm(requestId, approve) {
      const r = deps.get(requestId);
      if (!r) return 'gone';
      if (r.state !== 'pending') {
        tell(`Agent Wrangler: ${r.agentName}'s merge request has already been answered.`, 4000);
        return 'stale';
      }
      if (!approve) {
        deps.settle(requestId, 'declined');
        deps.log(`mission ${r.missionId}: declined a merge requested by durable agent ${r.agentId}`);
        return 'applied';
      }
      const why = deps.recheck(r);
      if (why) {
        deps.settle(requestId, 'stale', why);
        tell(`Agent Wrangler: the merge can no longer go ahead: ${why}`, 6000);
        return 'stale';
      }
      // Settled before the merge starts: a second Confirm from another client is stale, never a second merge.
      deps.settle(requestId, 'confirmed');
      deps.log(`mission ${r.missionId}: the user confirmed a merge requested by durable agent ${r.agentId}`);
      await deps.finish(r.missionId, r.how);
      return 'applied';
    },
  };
}
