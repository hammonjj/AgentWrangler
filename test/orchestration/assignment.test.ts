/**
 * Tests for the assignment function (#54).
 */
import { describe, it, expect } from 'vitest';
import { decideAssignment, type WarmSession, type RouteRequirement, type AssignmentContext } from '../../src/orchestration/engine/assignment';

const defaultContext: AssignmentContext = {
  tierOrder: ['basic', 'standard', 'expert'],
  forkEnabled: true,
};

const standardRequirement: RouteRequirement = {
  minTier: 'standard',
  harness: 'claude-code',
  model: 'claude-3-5-sonnet-20241022',
  tierOrder: ['basic', 'standard', 'expert'],
};

describe('assignment function', () => {
  it('cold when no warm sessions', () => {
    const result = decideAssignment(standardRequirement, [], defaultContext);
    expect(result.mode).toBe('cold');
  });

  it('cold when warm session harness mismatches', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'codex',
        model: 'gpt-4',
        tier: 'standard',
        lastWorktreeId: 'wt-1',
        lastBranch: 'feat/foo',
      },
    ];
    const result = decideAssignment(standardRequirement, sessions, defaultContext);
    expect(result.mode).toBe('cold');
  });

  it('cold when warm session model mismatches', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-haiku-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-1',
        lastBranch: 'feat/foo',
      },
    ];
    const result = decideAssignment(standardRequirement, sessions, defaultContext);
    expect(result.mode).toBe('cold');
  });

  it('cold when warm session tier is below requirement', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'basic',
        lastWorktreeId: 'wt-1',
        lastBranch: 'feat/foo',
      },
    ];
    const result = decideAssignment(standardRequirement, sessions, defaultContext);
    expect(result.mode).toBe('cold');
  });

  it('cold when warm session tier is ambiguous', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'unknown-tier',
        lastWorktreeId: 'wt-1',
        lastBranch: 'feat/foo',
      },
    ];
    const result = decideAssignment(standardRequirement, sessions, defaultContext);
    expect(result.mode).toBe('cold');
  });

  it('reuse when warm session matches and on same worktree lineage', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-same',
        lastBranch: 'aw/mission/t1',
      },
    ];
    const context: AssignmentContext = {
      ...defaultContext,
      worktreeId: 'wt-same',
      branch: 'aw/mission/t2', // Different task branch, same worktree
    };
    const result = decideAssignment(standardRequirement, sessions, context);
    expect(result.mode).toBe('reuse');
    expect(result.sessionId).toBe('sess-1');
  });

  it('fork when warm session matches but on different lineage and fork enabled', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-other',
        lastBranch: 'feat/baz',
      },
    ];
    const context: AssignmentContext = {
      ...defaultContext,
      forkEnabled: true,
      worktreeId: 'wt-new',
      branch: 'feat/bar',
    };
    const result = decideAssignment(standardRequirement, sessions, context);
    expect(result.mode).toBe('fork');
    expect(result.sessionId).toBe('sess-1');
  });

  it('cold when warm session on different lineage and fork not enabled', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-other',
        lastBranch: 'feat/baz',
      },
    ];
    const context: AssignmentContext = {
      ...defaultContext,
      forkEnabled: false,
      worktreeId: 'wt-new',
      branch: 'feat/bar',
    };
    const result = decideAssignment(standardRequirement, sessions, context);
    expect(result.mode).toBe('cold');
  });

  it('prefers reuse over fork when both are possible', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-reuse',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-same',
        lastBranch: 'feat/bar',
      },
      {
        sessionId: 'sess-fork',
        attemptId: 'att-2',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-other',
        lastBranch: 'feat/other',
      },
    ];
    const context: AssignmentContext = {
      ...defaultContext,
      forkEnabled: true,
      worktreeId: 'wt-same',
      branch: 'feat/bar',
    };
    const result = decideAssignment(standardRequirement, sessions, context);
    expect(result.mode).toBe('reuse');
    expect(result.sessionId).toBe('sess-reuse');
  });

  it('respects tier ordering: candidate at exactly min tier is acceptable', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'standard',
        lastWorktreeId: 'wt-1',
        lastBranch: 'feat/foo',
      },
    ];
    const context: AssignmentContext = {
      ...defaultContext,
      worktreeId: 'wt-1',
      branch: 'feat/foo',
    };
    const result = decideAssignment(standardRequirement, sessions, context);
    expect(result.mode).toBe('reuse');
  });

  it('respects tier ordering: candidate above min tier is acceptable', () => {
    const sessions: WarmSession[] = [
      {
        sessionId: 'sess-1',
        attemptId: 'att-1',
        harness: 'claude-code',
        model: 'claude-3-5-sonnet-20241022',
        tier: 'expert',
        lastWorktreeId: 'wt-1',
        lastBranch: 'feat/foo',
      },
    ];
    const context: AssignmentContext = {
      ...defaultContext,
      worktreeId: 'wt-1',
      branch: 'feat/foo',
    };
    const result = decideAssignment(standardRequirement, sessions, context);
    expect(result.mode).toBe('reuse');
  });

  it('simulated chain: A→B→C on one mission worktree reuses', () => {
    // Note: reuse is based on worktree lineage only (same mission tree).
    // Task branches may differ (t1, t2, t3 etc.) but they share the mission worktree.

    // A creates session with tier standard in mission worktree
    const sessionA: WarmSession = {
      sessionId: 'sess-a',
      attemptId: 'att-a',
      harness: 'claude-code',
      model: 'claude-3-5-sonnet-20241022',
      tier: 'standard',
      lastWorktreeId: 'wt-mission',
      lastBranch: 'aw/mission/t1',
    };

    // B same requirement, same mission worktree → reuse
    // Even though branch differs (t2 vs t1), same worktree is enough
    const reqB = standardRequirement;
    const contextB: AssignmentContext = {
      ...defaultContext,
      worktreeId: 'wt-mission', // Same mission worktree
      branch: 'aw/mission/t2',  // Different task branch, but same lineage (worktree)
    };
    const resultB = decideAssignment(reqB, [sessionA], contextB);
    expect(resultB.mode).toBe('reuse');

    // C same requirement, same mission worktree → would reuse session from B
    const sessionB: WarmSession = {
      ...sessionA,
      sessionId: 'sess-b',
      attemptId: 'att-b',
      lastBranch: 'aw/mission/t2',
    };
    const contextC: AssignmentContext = {
      ...defaultContext,
      worktreeId: 'wt-mission',
      branch: 'aw/mission/t3',
    };
    const resultC = decideAssignment(reqB, [sessionB], contextC);
    expect(resultC.mode).toBe('reuse');
    expect(resultC.sessionId).toBe('sess-b');
  });

  it('simulated chain: tier change mid-chain goes cold', () => {
    // A on standard
    const sessionA: WarmSession = {
      sessionId: 'sess-a',
      attemptId: 'att-a',
      harness: 'claude-code',
      model: 'claude-3-5-sonnet-20241022',
      tier: 'standard',
      lastWorktreeId: 'wt-mission',
      lastBranch: 'aw/mission/t1',
    };

    // B requires expert: session from A (tier standard) doesn't satisfy
    const reqB: RouteRequirement = {
      ...standardRequirement,
      minTier: 'expert',
    };
    const contextB: AssignmentContext = {
      ...defaultContext,
      worktreeId: 'wt-mission',
      branch: 'aw/mission/t2',
    };
    const resultB = decideAssignment(reqB, [sessionA], contextB);
    expect(resultB.mode).toBe('cold');
  });
});
