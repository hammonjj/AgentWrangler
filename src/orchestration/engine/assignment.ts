/**
 * Pure assignment function for #54: decide between cold, reuse, or fork for a new attempt.
 *
 * Inputs: task requirement, and a set of idle, fully stopped warm sessions.
 * Outputs: cold, reuse(id), or fork(id), with a reason.
 *
 * Rules (§22):
 * - reuse: sequential tasks on the same lineage (same branch/worktree); session must satisfy the route
 * - fork: only where a spike said it works (#54); into a new worktree on a different branch
 * - HARD RULE: a session whose tier, harness or model does not satisfy the requirement is never used
 * - ambiguous tier → cold
 */

import type { HarnessId, TierName } from '../../shared/orchestration/types';

export type AssignmentMode = 'cold' | 'reuse' | 'fork';

export interface AssignmentResult {
  mode: AssignmentMode;
  sessionId?: string;
  reason: string;
}

export interface WarmSession {
  sessionId: string;
  attemptId: string;
  harness: HarnessId;
  model: string;
  tier: TierName;
  /** Session's last known worktree/branch, for lineage check */
  lastWorktreeId?: string;
  lastBranch?: string;
}

export interface RouteRequirement {
  minTier: TierName;
  harness: HarnessId;
  model: string;
  /** Ordered list of tiers from weakest to strongest */
  tierOrder: TierName[];
}

export interface AssignmentContext {
  /** The task's current worktree, for lineage check on reuse */
  worktreeId?: string;
  /** The task's branch (mission or task branch), for lineage check on reuse */
  branch?: string;
  /** Ordered list of tiers, so we can check tier satisfaction */
  tierOrder: TierName[];
  /** Whether fork is enabled by harness capabilities */
  forkEnabled: boolean;
}

/**
 * Check if a tier satisfies a requirement (tier ≥ minTier in the ordering).
 * Returns false for ambiguous tiers (not in the tier order).
 */
function tierSatisfies(candidateTier: TierName, minTier: TierName, tierOrder: TierName[]): boolean {
  const candIdx = tierOrder.indexOf(candidateTier);
  const minIdx = tierOrder.indexOf(minTier);
  if (candIdx < 0) return false; // Ambiguous tier: reject
  if (minIdx < 0) return false; // Shouldn't happen: minTier must be in the order
  return candIdx >= minIdx; // Candidate must be at or above min
}

/**
 * Decide the assignment mode for a new attempt.
 *
 * @param requirement What the work needs (tier, harness, model)
 * @param warmSessions Idle, fully stopped sessions available for reuse/fork
 * @param context Where the task is running, and what's enabled
 * @returns The assignment mode and a human-readable reason
 */
export function decideAssignment(
  requirement: RouteRequirement,
  warmSessions: WarmSession[],
  context: AssignmentContext,
): AssignmentResult {
  // Rule 1: Session must satisfy the requirement (harness, model, tier)
  // Rule 2: reuse only on same lineage
  // Rule 3: fork only if enabled and on different lineage
  // Rule 4: ambiguous tier always → cold

  // Find warm sessions that satisfy the requirement
  const candidates = warmSessions.filter((session) => {
    // Harness must match exactly
    if (session.harness !== requirement.harness) return false;

    // Model must match exactly
    if (session.model !== requirement.model) return false;

    // Tier must satisfy requirement (or session is ambiguous → cold)
    if (!tierSatisfies(session.tier, requirement.minTier, context.tierOrder)) return false;

    return true;
  });

  if (candidates.length === 0) {
    return { mode: 'cold', reason: 'no warm session satisfies the requirement' };
  }

  // Try reuse first (cheaper than fork, same lineage).
  // Lineage is determined by worktree only (within a mission, tasks share the worktree but have different branches).
  const reuseCandidate = candidates.find((session) => session.lastWorktreeId === context.worktreeId);

  if (reuseCandidate) {
    return {
      mode: 'reuse',
      sessionId: reuseCandidate.sessionId,
      reason: `reuse warm session from attempt ${reuseCandidate.attemptId}`,
    };
  }

  // Try fork (if enabled, different lineage allowed)
  if (context.forkEnabled) {
    // Pick the first candidate on a different lineage (any will do, they all satisfy the requirement)
    const forkCandidate = candidates[0];
    return {
      mode: 'fork',
      sessionId: forkCandidate.sessionId,
      reason: `fork from attempt ${forkCandidate.attemptId} into new worktree`,
    };
  }

  // No reuse (different lineage) and fork not enabled
  return { mode: 'cold', reason: 'warm session on different lineage, fork not enabled' };
}
