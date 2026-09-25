import { describe, expect, it } from 'vitest';
import { attemptLaunchPolicy, attemptPermissionMode, attemptPrompt } from '../../src/orchestration/engine/attemptPolicy';
import { addTurnUsage, attemptRecord } from '../../src/orchestration/engine/attemptRecord';
import { DEFAULT_REPO_POLICY, type RepoPolicy } from '../../src/shared/orchestration/repoPolicy';
import type { TurnRecord } from '../../src/shared/orchestration/telemetry';
import { attempt, mission, T0 } from './fixtures';

describe('attemptPermissionMode (§24.1)', () => {
  it('defaults to auto, capped by the app default, never bypass', () => {
    expect(attemptPermissionMode(undefined, 'auto')).toBe('auto');
    expect(attemptPermissionMode(undefined, 'default')).toBe('default');
    expect(attemptPermissionMode(undefined, 'acceptEdits')).toBe('acceptEdits');
    expect(attemptPermissionMode('auto', 'plan')).toBe('plan');
    expect(attemptPermissionMode('bypassPermissions', 'bypassPermissions')).toBe('auto');
    expect(attemptPermissionMode(undefined, 'bypassPermissions')).toBe('auto');
    expect(attemptPermissionMode('default', 'auto')).toBe('default');
  });
});

describe('attemptLaunchPolicy', () => {
  const repoPolicy: RepoPolicy = {
    ...DEFAULT_REPO_POLICY,
    verification: {
      commands: {
        typecheck: { run: ['npm', 'run', 'typecheck'], timeoutSec: 60 },
        odd: { run: ['sh', '-c', 'rm -rf /'], timeoutSec: 60 },
        install: { run: ['npm', 'run', 'app:install'], timeoutSec: 60 },
      },
      missionDefault: [],
    },
  };

  it('Claude: the repo’s checks and worktree git are allowed; pushes, installs and the primary checkout are denied', () => {
    const p = attemptLaunchPolicy({ harness: 'claude-code', primaryRoot: '/Users/test/proj', repoPolicy });
    expect(p.codex).toBeUndefined();
    expect(p.claude?.allowedTools).toContain('Bash(npm run typecheck:*)');
    expect(p.claude?.allowedTools).toContain('Bash(git commit:*)');
    // A command a rule cannot say exactly is left to the agent's own prompt, never widened.
    expect(p.claude?.allowedTools?.some((r) => r.includes('rm -rf'))).toBe(false);
    // A hard deny is never allowed by name, even if the policy lists it.
    expect(p.claude?.allowedTools).not.toContain('Bash(npm run app:install:*)');
    expect(p.claude?.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(npm run app:install:*)', 'Edit(//Users/test/proj/**)', 'Write(//Users/test/proj/**)']),
    );
  });

  it('Codex: sandboxed to the worktree, asks only to leave it, told not to commit', () => {
    const p = attemptLaunchPolicy({ harness: 'codex', primaryRoot: '/Users/test/proj', repoPolicy });
    expect(p.claude).toBeUndefined();
    expect(p.codex).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    expect(p.codex?.developerInstructions).toMatch(/Do not commit/);
  });
});

describe('attemptPrompt', () => {
  it('carries the objective, the criteria and the worktree rules', () => {
    const text = attemptPrompt({ title: 'T', objective: 'Do the thing.', acceptanceCriteria: ['it works', ' '] }, { harness: 'claude-code', branch: 'aw/x/t1' });
    expect(text).toContain('Do the thing.');
    expect(text).toContain('- it works');
    expect(text).toContain('`aw/x/t1`');
    expect(text).toMatch(/never run `npm run app:install`/);
    expect(attemptPrompt({ title: 'T', objective: 'x', acceptanceCriteria: [] }, { harness: 'codex', branch: 'b' })).toMatch(/Do not commit/);
  });
});

describe('attempt usage and record (§16.2)', () => {
  const turn = (id: string, extra: Partial<TurnRecord> = {}): TurnRecord => ({
    v: 1,
    type: 'turn',
    at: T0,
    id,
    sessionId: 's',
    harness: 'claude-code',
    source: 'anthropic',
    modelsUsed: { m: { in: 10, out: 2, costUsd: 0.01 } },
    effort: {},
    isError: false,
    costBasis: 'harness-estimate',
    costUsd: 0.01,
    ...extra,
  });

  it('sums turns once each, per model', () => {
    let u = addTurnUsage(undefined, turn('a'));
    u = addTurnUsage(u, turn('a'));
    u = addTurnUsage(u, turn('b'));
    expect(u).toMatchObject({ turns: 2, inputTokens: 20, outputTokens: 4, costUsd: 0.02, costBasis: 'harness-estimate', byModel: { m: { in: 20, out: 4, costUsd: 0.02 } } });
  });

  it('builds a metadata-only record with timings; partial when interrupted', () => {
    const m = mission({
      decisions: [
        {
          id: 'd1',
          taskId: 't1',
          attemptN: 1,
          mode: 'manual',
          policyVersion: 'manual',
          requirement: { minTier: 'unassigned', maxTier: 'unassigned', effort: 'low', needs: [], gates: [] },
          reasons: [],
          overrides: [],
          resolution: { target: { harness: 'claude-code', source: 'anthropic', model: 'x', tier: 'unassigned', effortNative: 'low', location: 'hosted' }, candidates: [], catalogVersion: 'manual' },
          decidedBy: 'user',
          decidedAt: T0,
        },
      ],
    });
    const a = attempt('a1', 't1', {
      routingDecisionId: 'd1',
      state: 'interrupted',
      launchedAt: T0 + 1000,
      endedAt: T0 + 11_000,
      timing: { queuedAt: T0, waitedOnHumanMs: 2000 },
      outcome: { status: 'interrupted', category: 'lost' },
      usage: addTurnUsage(undefined, turn('a')),
    });
    const rec = attemptRecord(m, a, T0 + 12_000)!;
    expect(rec).toMatchObject({ id: 'attempt:a1', outcome: 'interrupted', partial: true, activeMs: 8000, queueMs: 1000, waitedOnHumanMs: 2000, turns: 1, cost: { usd: 0.01, basis: 'harness-estimate' } });
    expect(JSON.stringify(rec)).not.toContain('Synthetic objective');
  });
});
