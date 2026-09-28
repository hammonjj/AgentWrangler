/**
 * The status line beside a local model's tier picker, and the harness-pin
 * warning (plan §19.9). Pure: no service, no server.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, UNKNOWN, known, type CatalogEntry, type Known } from '../../src/shared/orchestration/catalog';
import { localHarnessWarning, localModelStatus, type LocalModelFacts } from '../../src/shared/orchestration/localReadiness';
import type { ExecutionPolicy } from '../../src/shared/orchestration/types';

const TIERS = [...DEFAULT_TIERS];

function entry(opts: { enabled?: boolean; tier?: string; toolCalling?: Known<'reliable' | 'basic' | 'none'> } = {}): Pick<CatalogEntry, 'enabled' | 'tier' | 'descriptor'> {
  return {
    enabled: opts.enabled ?? true,
    tier: opts.tier,
    descriptor: { source: 'local:box', modelId: 'm', toolCalling: opts.toolCalling ?? UNKNOWN } as unknown as CatalogEntry['descriptor'],
  };
}

const UP: LocalModelFacts = { endpointOn: true, health: 'reachable', responses: true };

describe('localModelStatus', () => {
  it('not enabled: every kind of work needs it enabled', () => {
    const s = localModelStatus({ entry: entry({ enabled: false, tier: 'basic' }), tiers: TIERS, facts: UP });
    expect(s.completions).toEqual({ ready: false, needs: ['enabling'] });
    expect(s.planning.needs[0]).toBe('enabling');
    expect(s.agentic.needs[0]).toBe('enabling');
    expect(s.text).toMatch(/^Completions needs enabling/);
  });

  it('no tier: completions ask for the weakest, planning for standard or above, agentic for any', () => {
    const s = localModelStatus({ entry: entry(), tiers: TIERS, facts: UP });
    expect(s.completions.needs).toEqual(['tier basic']);
    expect(s.planning.needs).toEqual(['tier standard or above']);
    expect(s.agentic.needs).toEqual(['measured tool calling (run Qualify)', 'a tier']);
    expect(s.completions.ready || s.planning.ready || s.agentic.ready).toBe(false);
  });

  it('not the weakest tier: no completions, as pickCompletion takes only tiers[0]', () => {
    const s = localModelStatus({ entry: entry({ tier: 'standard' }), tiers: TIERS, facts: UP });
    expect(s.completions).toEqual({ ready: false, needs: ['the weakest tier, basic (it has standard)'] });
    expect(s.planning.ready).toBe(true);
    expect(s.text).toMatch(/^Ready for planning · Completions needs the weakest tier, basic \(it has standard\)/);
  });

  it('endpoint off, or down: nothing is ready', () => {
    const off = localModelStatus({ entry: entry({ tier: 'basic' }), tiers: TIERS, facts: { ...UP, endpointOn: false } });
    expect(off.completions).toEqual({ ready: false, needs: ['its endpoint turned on'] });
    const down = localModelStatus({ entry: entry({ tier: 'basic' }), tiers: TIERS, facts: { ...UP, health: 'down' } });
    expect(down.completions).toEqual({ ready: false, needs: ['its endpoint back up (it is down)'] });
    expect(down.planning.needs).toContain('its endpoint back up (it is down)');
    // Degraded is not down: pickCompletion still uses it.
    expect(localModelStatus({ entry: entry({ tier: 'basic' }), tiers: TIERS, facts: { ...UP, health: 'degraded' } }).completions.ready).toBe(true);
  });

  it('completion-only by stage-1 qualification: shown as that, with the measured count, not as needs', () => {
    const s = localModelStatus({
      entry: entry({ tier: 'basic', toolCalling: known('none', 'measured') }),
      tiers: TIERS,
      facts: { ...UP, stage1: { verdict: 'completion-only', toolCalls: { ok: 0, runs: 10 } } },
    });
    expect(s.agentic).toEqual({ ready: false, needs: [], completionOnly: 'stage-1 qualification: tool calls 0/10 (measured)' });
    expect(s.completions.ready).toBe(true);
    expect(s.text).toBe('Ready for completions · Completion only: stage-1 qualification: tool calls 0/10 (measured) · Planning needs tier standard or above (it has basic)');
  });

  it('completion-only because the server has no /v1/responses', () => {
    const s = localModelStatus({ entry: entry({ tier: 'standard' }), tiers: TIERS, facts: { ...UP, responses: false } });
    expect(s.agentic.completionOnly).toBe('the server has no /v1/responses, which Codex needs');
  });

  it('ready for completions: enabled, the weakest tier, endpoint on and up', () => {
    const s = localModelStatus({ entry: entry({ tier: 'basic' }), tiers: TIERS, facts: { ...UP, responses: undefined } });
    expect(s.completions).toEqual({ ready: true, needs: [] });
    expect(s.agentic.needs).toEqual(['/v1/responses probed on its server', 'measured tool calling (run Qualify)']);
  });

  it('ready for agentic work: /v1/responses probed, tool calling measured, a tier', () => {
    const s = localModelStatus({
      entry: entry({ tier: 'standard', toolCalling: known('reliable', 'measured') }),
      tiers: TIERS,
      facts: { ...UP, stage1: { verdict: 'agentic', toolCalls: { ok: 10, runs: 10 } } },
    });
    expect(s.agentic).toEqual({ ready: true, needs: [] });
    expect(s.planning.ready).toBe(true);
    expect(s.text).toMatch(/^Ready for planning, agentic work · Completions needs/);
  });

  it('declared tool calling counts, and says it was not measured', () => {
    const s = localModelStatus({ entry: entry({ tier: 'standard', toolCalling: known('basic', 'declared') }), tiers: TIERS, facts: UP });
    expect(s.agentic.ready).toBe(true);
    expect(s.text).toMatch(/tool calling declared, not measured/);
  });

  it('planning needs a window a repository excerpt fits in', () => {
    const s = localModelStatus({ entry: entry({ tier: 'standard' }), tiers: TIERS, facts: { ...UP, plannerWindowFits: false } });
    expect(s.planning.needs).toEqual(['a context window a repository excerpt fits in']);
  });

  it('routing defaults that rule out Codex block agentic work', () => {
    const s = localModelStatus({
      entry: entry({ tier: 'standard', toolCalling: known('reliable', 'measured') }),
      tiers: TIERS,
      facts: UP,
      harnessBlocked: 'pinned',
    });
    expect(s.agentic).toEqual({ ready: false, needs: ['routing defaults that allow Codex'] });
  });

  it('with a custom tier list, completions follow tiers[0]', () => {
    const tiers = [{ name: 'small', reachableBy: 'route' as const }, { name: 'big', reachableBy: 'route' as const }];
    expect(localModelStatus({ entry: entry({ tier: 'small' }), tiers, facts: UP }).completions.ready).toBe(true);
    // No `standard`: the planner needs rank 1.
    expect(localModelStatus({ entry: entry({ tier: 'big' }), tiers, facts: UP }).planning.ready).toBe(true);
    expect(localModelStatus({ entry: entry({ tier: 'small' }), tiers, facts: UP }).planning.needs).toEqual(['tier big or above (it has small)']);
  });
});

describe('localHarnessWarning', () => {
  const warns = (policy: ExecutionPolicy, enabled = true) => localHarnessWarning(policy, enabled);

  it('warns when routing pins or prefers Claude Code, or excludes Codex, and local models are enabled', () => {
    expect(warns({ pins: { harness: 'claude-code' } })).toMatch(/pin the harness to Claude Code\. That rules out the Codex path, so local models cannot get agentic work/);
    expect(warns({ preferences: { harness: 'claude-code' } })).toMatch(/prefer Claude Code\. That rules out the Codex path/);
    expect(warns({ exclusions: { harnesses: ['codex'] } })).toMatch(/exclude Codex\. That rules out the Codex path/);
  });

  it('says nothing when no local model is enabled, or the policy leaves Codex open', () => {
    expect(warns({ pins: { harness: 'claude-code' } }, false)).toBeUndefined();
    expect(warns({})).toBeUndefined();
    expect(warns({ pins: { harness: 'codex' } })).toBeUndefined();
    expect(warns({ preferences: { harness: 'codex' } })).toBeUndefined();
    expect(warns({ exclusions: { harnesses: ['claude-code'] } })).toBeUndefined();
    expect(localHarnessWarning(undefined, true)).toBeUndefined();
  });
});
