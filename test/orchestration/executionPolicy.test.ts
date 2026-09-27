/**
 * Effective policy (#40, plan §10.2): precedence across the four scopes,
 * caps that only tighten, and every conflict named — as tables, because the
 * rules are the kind a reader checks row by row.
 */
import { describe, expect, it } from 'vitest';
import {
  admissionRefusal,
  checkPolicyEdit,
  conflictText,
  diffText,
  missionLayers,
  parseRoutingSettings,
  pinnedDimensions,
  policyContextFor,
  policyDiff,
  resolveEffectivePolicy,
  routingSettingsValue,
  validateExecutionPolicy,
  withField,
  type ConflictKind,
  type PolicyLayer,
} from '../../src/shared/orchestration/executionPolicy';
import { validateRepoPolicyFile, resolveRepoPolicy } from '../../src/shared/orchestration/repoPolicy';
import { routingPolicyUpdate } from '../../src/shared/preferences';
import type { ExecutionPolicy, PolicyScope } from '../../src/shared/orchestration/types';
import { catalog } from './routingFixtures';

const ctx = policyContextFor(catalog());

function layers(spec: Partial<Record<PolicyScope, ExecutionPolicy>>): PolicyLayer[] {
  return (Object.entries(spec) as [PolicyScope, ExecutionPolicy][]).map(([scope, policy]) => ({ scope, policy }));
}

describe('resolveEffectivePolicy: precedence', () => {
  it.each<[string, Partial<Record<PolicyScope, ExecutionPolicy>>, string, unknown, PolicyScope | undefined]>([
    ['a global pin applies when nothing narrower sets one', { global: { pins: { effort: 'medium' } } }, 'pins.effort', 'medium', 'global'],
    ['the repository pin wins over the global one', { global: { pins: { effort: 'medium' } }, repo: { pins: { effort: 'high' } } }, 'pins.effort', 'high', 'repo'],
    ['the mission pin wins over the repository one', { repo: { pins: { effort: 'high' } }, mission: { pins: { effort: 'low' } } }, 'pins.effort', 'low', 'mission'],
    ['the task pin wins over every other', { global: { pins: { effort: 'medium' } }, mission: { pins: { effort: 'high' } }, task: { pins: { effort: 'low' } } }, 'pins.effort', 'low', 'task'],
    ['pins merge by dimension: a task effort pin keeps the mission harness pin', { mission: { pins: { harness: 'codex' } }, task: { pins: { effort: 'low' } } }, 'pins.harness', 'codex', 'mission'],
    ['preferences: more specific wins', { global: { preferences: { harness: 'codex' } }, mission: { preferences: { harness: 'claude-code' } } }, 'preferences.harness', 'claude-code', 'mission'],
    ['a switch (mode): more specific wins', { global: { mode: 'manual' }, mission: { mode: 'assisted' } }, 'mode', 'assisted', 'mission'],
    ['layer order in the input does not matter', { task: { pins: { effort: 'low' } }, global: { pins: { effort: 'high' } } } as Partial<Record<PolicyScope, ExecutionPolicy>>, 'pins.effort', 'low', 'task'],
  ])('%s', (_name, spec, field, value, from) => {
    const eff = resolveEffectivePolicy(layers(spec), ctx);
    const [g, k] = field.split('.');
    const got = k ? (eff.policy as Record<string, Record<string, unknown>>)[g]?.[k] : (eff.policy as Record<string, unknown>)[g];
    expect(got).toEqual(value);
    expect(eff.from[field]).toBe(from);
    expect(eff.conflicts).toEqual([]);
  });
});

describe('resolveEffectivePolicy: caps only tighten', () => {
  it.each<[string, Partial<Record<PolicyScope, ExecutionPolicy>>, string, unknown, PolicyScope, ConflictKind[]]>([
    ['a narrower, tighter tier cap wins', { global: { caps: { maxTier: 'expert' } }, task: { caps: { maxTier: 'standard' } } }, 'maxTier', 'standard', 'task', []],
    ['a narrower, looser tier cap is refused; the tighter stays', { mission: { caps: { maxTier: 'standard' } }, task: { caps: { maxTier: 'expert' } } }, 'maxTier', 'standard', 'mission', ['cap-loosened']],
    ['an equal cap is no conflict and stays with the wider scope', { global: { caps: { maxTier: 'standard' } }, mission: { caps: { maxTier: 'standard' } } }, 'maxTier', 'standard', 'global', []],
    ['effort caps order by level', { repo: { caps: { maxEffort: 'high' } }, mission: { caps: { maxEffort: 'medium' } } }, 'maxEffort', 'medium', 'mission', []],
    ['a looser effort cap is refused', { repo: { caps: { maxEffort: 'medium' } }, task: { caps: { maxEffort: 'max' } } }, 'maxEffort', 'medium', 'repo', ['cap-loosened']],
    ['attempts: the smaller count wins', { global: { caps: { maxAttempts: 5 } }, mission: { caps: { maxAttempts: 2 } } }, 'maxAttempts', 2, 'mission', []],
    ['attempts: a larger count below is refused', { global: { caps: { maxAttempts: 2 } }, task: { caps: { maxAttempts: 9 } } }, 'maxAttempts', 2, 'global', ['cap-loosened']],
    ['concurrency', { global: { caps: { maxConcurrentAgents: 4 } }, repo: { caps: { maxConcurrentAgents: 1 } } }, 'maxConcurrentAgents', 1, 'repo', []],
    ['spend', { global: { caps: { maxEstimatedCostUsd: 10 } }, mission: { caps: { maxEstimatedCostUsd: 2.5 } } }, 'maxEstimatedCostUsd', 2.5, 'mission', []],
    ['usage-window share', { global: { caps: { maxUsageWindowPercent: 80 } }, task: { caps: { maxUsageWindowPercent: 90 } } }, 'maxUsageWindowPercent', 80, 'global', ['cap-loosened']],
    ['a location set once applies below', { repo: { caps: { location: 'hosted-only' } }, task: {} }, 'location', 'hosted-only', 'repo', []],
    ['opposite locations conflict; the wider stays', { global: { caps: { location: 'local-only' } }, mission: { caps: { location: 'hosted-only' } } }, 'location', 'local-only', 'global', ['location-conflict']],
    ['a tier that does not exist is reported, not applied', { global: { caps: { maxTier: 'standard' } }, mission: { caps: { maxTier: 'gold' } } }, 'maxTier', 'standard', 'global', ['cap-unknown']],
  ])('%s', (_name, spec, cap, value, from, kinds) => {
    const eff = resolveEffectivePolicy(layers(spec), ctx);
    expect((eff.policy.caps as Record<string, unknown>)[cap]).toEqual(value);
    expect(eff.from[`caps.${cap}`]).toBe(from);
    expect(eff.conflicts.map((c) => c.kind)).toEqual(kinds);
  });

  it('exclusions accumulate: a narrower scope can add one, never take one away', () => {
    const eff = resolveEffectivePolicy(layers({ global: { exclusions: { harnesses: ['codex'] } }, task: { exclusions: { sources: ['openai'], disableLocal: true } } }), ctx);
    expect(eff.policy.exclusions).toEqual({ harnesses: ['codex'], sources: ['openai'], disableLocal: true });
    expect(eff.from['exclusions.harnesses']).toBe('global');
  });

  it('says why a looser cap was refused, naming both scopes', () => {
    const eff = resolveEffectivePolicy(layers({ mission: { caps: { maxTier: 'standard' } }, task: { caps: { maxTier: 'expert' } } }), ctx);
    expect(eff.conflicts[0].message).toBe('This task sets max tier expert; the mission is capped at standard, and a narrower scope can only tighten a cap.');
  });
});

describe('resolveEffectivePolicy: a pin that breaks a cap', () => {
  it.each<[string, Partial<Record<PolicyScope, ExecutionPolicy>>, ConflictKind, string]>([
    [
      'a task model pin above the mission tier cap',
      { mission: { caps: { maxTier: 'standard' } }, task: { pins: { harness: 'claude-code', model: 'opus' } } },
      'pin-above-cap',
      'This task pins Opus 5.5 (expert); the mission is capped at standard.',
    ],
    [
      'a mission model pin above a global tier cap',
      { global: { caps: { maxTier: 'basic' } }, mission: { pins: { model: 'sonnet', harness: 'claude-code' } } },
      'pin-above-cap',
      'The mission pins Sonnet 5 (standard); the global default is capped at basic.',
    ],
    [
      'a task effort pin above the repository effort cap',
      { repo: { caps: { maxEffort: 'medium' } }, task: { pins: { effort: 'max' } } },
      'pin-above-cap',
      'This task pins max effort; the repository policy caps effort at medium.',
    ],
    [
      'a pinned harness the global default excludes',
      { global: { exclusions: { harnesses: ['codex'] } }, task: { pins: { harness: 'codex' } } },
      'pin-excluded',
      'This task pins Codex; the global default excludes Codex.',
    ],
    [
      'a pinned model whose source is excluded',
      { mission: { exclusions: { sources: ['openai'] } }, task: { pins: { harness: 'codex', model: 'gpt-6-sol' } } },
      'pin-excluded',
      'This task pins gpt-6-sol; the mission excludes the openai source.',
    ],
    [
      'a hosted model pinned under a local-only cap',
      { mission: { caps: { location: 'local-only' } }, task: { pins: { harness: 'claude-code', model: 'sonnet' } } },
      'pin-location',
      'This task pins Sonnet 5, a hosted model; the mission is local-only.',
    ],
  ])('%s', (_name, spec, kind, message) => {
    const eff = resolveEffectivePolicy(layers(spec), ctx);
    expect(eff.conflicts.map((c) => c.kind)).toEqual([kind]);
    expect(eff.conflicts[0].message).toBe(message);
  });

  it('a pin within the cap is fine, and a model the catalog has not seen cannot be checked', () => {
    expect(resolveEffectivePolicy(layers({ mission: { caps: { maxTier: 'standard' } }, task: { pins: { harness: 'claude-code', model: 'sonnet' } } }), ctx).conflicts).toEqual([]);
    expect(resolveEffectivePolicy(layers({ mission: { caps: { maxTier: 'basic' } }, task: { pins: { harness: 'claude-code', model: 'claude-simulated' } } }), ctx).conflicts).toEqual([]);
  });
});

describe('checkPolicyEdit', () => {
  const base = layers({ mission: { caps: { maxTier: 'standard' } }, task: { pins: { harness: 'claude-code', model: 'sonnet' } } });

  it('refuses a task pin above the mission cap, naming both', () => {
    const c = checkPolicyEdit(base, 'task', { pins: { harness: 'claude-code', model: 'opus' } }, ctx);
    expect(conflictText(c)).toBe('This task pins Opus 5.5 (expert); the mission is capped at standard.');
  });

  it('refuses a mission cap that would leave the task pin above it', () => {
    const c = checkPolicyEdit(base, 'mission', { caps: { maxTier: 'basic' } }, ctx);
    expect(conflictText(c)).toBe('This task pins Sonnet 5 (standard); the mission is capped at basic.');
  });

  it('does not block an edit on a conflict between two other scopes', () => {
    const l = layers({ global: { caps: { maxEffort: 'low' } }, repo: { pins: { effort: 'high' } } });
    expect(resolveEffectivePolicy(l, ctx).conflicts).toHaveLength(1);
    expect(checkPolicyEdit(l, 'task', { caps: { maxAttempts: 2 } }, ctx)).toEqual([]);
  });

  it('allows clearing the scope entirely', () => {
    expect(checkPolicyEdit(base, 'task', undefined, ctx)).toEqual([]);
  });
});

describe('pinnedDimensions', () => {
  it.each<[ExecutionPolicy, string[]]>([
    [{}, []],
    [{ pins: { effort: 'high' } }, ['effort']],
    [{ pins: { model: 'sonnet' } }, ['model', 'tier']],
    [{ pins: { harness: 'codex', model: 'gpt-6-sol', effort: 'low' } }, ['harness', 'model', 'tier', 'effort']],
  ])('%j freezes %j', (p, dims) => {
    expect(pinnedDimensions(p)).toEqual(dims);
  });
});

describe('admissionRefusal', () => {
  const eff = (caps: ExecutionPolicy['caps'], scope: PolicyScope = 'mission') => resolveEffectivePolicy(layers({ [scope]: { caps } }), ctx);
  it.each<[string, ReturnType<typeof eff>, Parameters<typeof admissionRefusal>[1], string | undefined]>([
    ['no caps: always admitted', eff({}), { attemptsSoFar: 9, liveAgents: 9 }, undefined],
    ['attempts under the cap', eff({ maxAttempts: 3 }), { attemptsSoFar: 2, liveAgents: 0 }, undefined],
    ['attempts at the cap', eff({ maxAttempts: 3 }), { attemptsSoFar: 3, liveAgents: 0 }, 'This would be attempt 4; the mission caps attempts at 3.'],
    ['concurrency at the global cap', eff({ maxConcurrentAgents: 2 }, 'global'), { attemptsSoFar: 0, liveAgents: 2 }, '2 task agents are running; the global default caps concurrent agents at 2.'],
    ['spend reached', eff({ maxEstimatedCostUsd: 1 }), { attemptsSoFar: 1, liveAgents: 0, spentUsd: 1.2 }, 'This task has spent an estimated $1.20; the mission caps estimated spend at $1.00.'],
    ['spend unknown is not spend reached', eff({ maxEstimatedCostUsd: 1 }), { attemptsSoFar: 1, liveAgents: 0 }, undefined],
    ['usage window at the share', eff({ maxUsageWindowPercent: 80 }, 'task'), { attemptsSoFar: 0, liveAgents: 0, windowPercent: 83 }, 'The usage window is at 83%; this task stops starting work at 80%.'],
  ])('%s', (_name, e, facts, want) => {
    expect(admissionRefusal(e, facts)).toBe(want);
  });
});

describe('validateExecutionPolicy', () => {
  it('accepts every control and drops empty groups', () => {
    const r = validateExecutionPolicy({
      mode: 'assisted',
      pins: { harness: 'claude-code', model: 'sonnet', effort: 'high' },
      caps: { maxTier: 'standard', maxEffort: 'high', maxAttempts: 3, maxConcurrentAgents: 2, maxEstimatedCostUsd: 5, maxUsageWindowPercent: 90, location: 'hosted-only' },
      preferences: {},
      exclusions: { harnesses: [], disableLocal: false },
    }, { tiers: ctx.tiers });
    expect(r.ok && r.policy).toEqual({
      mode: 'assisted',
      pins: { harness: 'claude-code', model: 'sonnet', effort: 'high' },
      caps: { maxTier: 'standard', maxEffort: 'high', maxAttempts: 3, maxConcurrentAgents: 2, maxEstimatedCostUsd: 5, maxUsageWindowPercent: 90, location: 'hosted-only' },
    });
  });

  it.each<[string, unknown, string[]]>([
    ['an unknown group', { budget: {} }, ['budget']],
    ['an effort that is not a level', { pins: { effort: 'huge' } }, ['pins.effort']],
    ['a tier the catalog lacks', { caps: { maxTier: 'gold' } }, ['caps.maxTier']],
    ['zero attempts', { caps: { maxAttempts: 0 } }, ['caps.maxAttempts']],
    ['fractional agents', { caps: { maxConcurrentAgents: 1.5 } }, ['caps.maxConcurrentAgents']],
    ['a percentage over 100', { caps: { maxUsageWindowPercent: 120 } }, ['caps.maxUsageWindowPercent']],
    ['a negative spend', { caps: { maxEstimatedCostUsd: -1 } }, ['caps.maxEstimatedCostUsd']],
    ['a location that is not one', { caps: { location: 'moon' } }, ['caps.location']],
    ['exclusions that are not names', { exclusions: { harnesses: [3] } }, ['exclusions.harnesses']],
  ])('refuses %s', (_name, doc, paths) => {
    const r = validateExecutionPolicy(doc, { tiers: ctx.tiers });
    expect(r.ok ? [] : r.errors.map((e) => e.path)).toEqual(paths);
  });
});

describe('parseRoutingSettings (the global scope)', () => {
  it('reads the nested form, and #38’s flat caps', () => {
    expect(parseRoutingSettings({ mode: 'assisted', maxTier: 'standard', pins: { effort: 'high' }, caps: { maxAttempts: 2 } })).toEqual({
      mode: 'assisted',
      policy: { pins: { effort: 'high' }, caps: { maxTier: 'standard', maxAttempts: 2 } },
      errors: [],
    });
  });

  it('drops a malformed group whole, and says so, keeping the others', () => {
    const r = parseRoutingSettings({ caps: { maxAttempts: 'three' }, pins: { effort: 'low' } });
    expect(r.policy).toEqual({ pins: { effort: 'low' } });
    expect(r.errors.map((e) => e.path)).toEqual(['caps.maxAttempts']);
    expect(parseRoutingSettings('nonsense')).toEqual({ mode: 'manual', policy: {}, errors: [] });
  });

  it('writes back what it reads', () => {
    const value = routingSettingsValue('manual', { caps: { maxTier: 'expert' }, pins: {} });
    expect(value).toEqual({ mode: 'manual', caps: { maxTier: 'expert' } });
    expect(parseRoutingSettings(value).policy).toEqual({ caps: { maxTier: 'expert' } });
  });
});

describe('routingPolicyUpdate (Preferences)', () => {
  const cat = catalog();
  it('refuses a global pin above a global cap, immediately and in words', () => {
    const r = routingPolicyUpdate({ type: 'routingPolicy', mode: 'manual', policy: { caps: { maxTier: 'standard' }, pins: { harness: 'claude-code', model: 'opus' } } }, cat);
    expect(r).toEqual({ ok: false, errors: ['The global default pins Opus 5.5 (expert); the global default is capped at standard.'] });
  });
  it('refuses a malformed value, naming the field', () => {
    const r = routingPolicyUpdate({ type: 'routingPolicy', mode: 'manual', policy: { caps: { maxAttempts: 0 } } }, cat);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/^max attempts: /);
  });
  it('accepts a good one and gives the settings value', () => {
    expect(routingPolicyUpdate({ type: 'routingPolicy', mode: 'assisted', policy: { caps: { maxEffort: 'high' } } }, cat)).toEqual({
      ok: true,
      value: { mode: 'assisted', caps: { maxEffort: 'high' } },
    });
  });
  it('refuses a message that is not one', () => {
    expect(routingPolicyUpdate({ type: 'routingPolicy', mode: 'auto', policy: {} }, cat).ok).toBe(false);
  });
});

describe('diffs and layers', () => {
  it('describes a change field by field', () => {
    const d = policyDiff({ caps: { maxTier: 'expert' }, pins: { effort: 'high' } }, { caps: { maxTier: 'standard' } });
    expect(d).toEqual([
      { field: 'caps.maxTier', from: 'expert', to: 'standard' },
      { field: 'pins.effort', from: 'high' },
    ]);
    expect(diffText(d)).toBe('max tier expert → standard; pinned effort cleared (was high)');
  });

  it('withField sets and clears without touching the input', () => {
    const p: ExecutionPolicy = { caps: { maxTier: 'expert' } };
    expect(withField(p, 'caps.maxAttempts', 2)).toEqual({ caps: { maxTier: 'expert', maxAttempts: 2 } });
    expect(withField(p, 'caps.maxTier', undefined)).toEqual({});
    expect(p).toEqual({ caps: { maxTier: 'expert' } });
  });

  it('reads a mission from before #40 as its mission layer', () => {
    expect(missionLayers({ policy: { caps: { maxTier: 'basic' } } }, { overrides: { pins: { effort: 'low' } } })).toEqual([
      { scope: 'mission', policy: { caps: { maxTier: 'basic' } } },
      { scope: 'task', policy: { pins: { effort: 'low' } } },
    ]);
  });
});

describe('repository scope: the policy file’s routing section', () => {
  it('validates it with the same rules', () => {
    expect(validateRepoPolicyFile({ routing: { caps: { maxTier: 'standard', maxAttempts: 2 } } }).ok).toBe(true);
    const bad = validateRepoPolicyFile({ routing: { caps: { maxAttempts: 0 }, pins: { effort: 'huge' } } });
    expect(bad.ok ? [] : bad.errors.map((e) => e.path)).toEqual(['routing.pins.effort', 'routing.caps.maxAttempts']);
  });

  it('carries it into the effective repository policy, and leaves a file without one as it was', () => {
    const r = resolveRepoPolicy([{ routing: { caps: { maxTier: 'standard' } } }]);
    expect(r.ok && r.policy.routing).toEqual({ caps: { maxTier: 'standard' } });
    const none = resolveRepoPolicy([{}]);
    expect(none.ok && 'routing' in none.policy).toBe(false);
  });
});
