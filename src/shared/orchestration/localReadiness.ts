/**
 * What a local model still needs before it can be picked, per kind of work
 * (`docs/plans/intelligent-orchestration.md` §19.9), and whether the routing
 * defaults shut local models out of agentic work.
 *
 * One status per kind, because the three are picked by different rules:
 *
 * - **Completions** (assessment): `LocalEndpointService.pickCompletion`. An
 *   enabled model at exactly the weakest tier (`tiers[0]`, §6.1), on an
 *   endpoint that is on and not down.
 * - **Planning** (§11.5): `pickPlannerEntry`. The same, but at
 *   `PLANNER_LOCAL_MIN_TIER` or above, with a context window a repository
 *   excerpt fits in.
 * - **Agentic work**: the resolver (§19.7). A tier, an endpoint serving
 *   `/v1/responses` (Codex's wire), and tool calling that something has said
 *   parses: stage 1 of qualification measures it.
 *
 * A model whose stage-1 verdict is completion-only is shown as that, with the
 * measured count, rather than as a list of needs it can never meet.
 *
 * Nothing here assigns a tier. Pure and shared: Preferences renders it.
 */

import { isKnown, tierRank, type CatalogEntry, type TierDef } from './catalog';
import type { HealthState } from './sourceHealth';
import type { ExecutionPolicy } from './types';

/**
 * The tier a local model must have to plan (§11.5): `standard` or above.
 * With a tier list that has no `standard`, the weakest tier is the one left out.
 */
export const PLANNER_LOCAL_MIN_TIER = 'standard';

/** The rank a planner needs in `tiers`: `standard`'s, or 1 when there is no `standard`. */
export function plannerMinRank(tiers: readonly TierDef[]): number {
  const std = tierRank(tiers, PLANNER_LOCAL_MIN_TIER);
  return std >= 0 ? std : 1;
}

/** What the host knows about one local model beyond its catalog entry. */
export interface LocalModelFacts {
  /** The endpoint is on (loopback by default; external once turned on). */
  endpointOn: boolean;
  health: HealthState;
  /** `/v1/responses` as probed. Undefined: not probed, or the probe could not say. */
  responses?: boolean;
  /** Stage 1 of qualification, when it has run. */
  stage1?: { verdict: 'agentic' | 'completion-only'; toolCalls: { ok: number; runs: number }; error?: string };
  /** The window fits a repository excerpt (`contextLimits`). Undefined: taken as fitting, as the planner does with an unknown window. */
  plannerWindowFits?: boolean;
}

export interface Readiness {
  ready: boolean;
  /** What is missing, in the order to fix it. Empty when ready. */
  needs: string[];
}

export interface LocalModelStatus {
  completions: Readiness;
  planning: Readiness;
  agentic: Readiness & {
    /** It can never do agentic work as things stand, and why. */
    completionOnly?: string;
  };
  /** One line for beside the tier picker. */
  text: string;
}

export interface LocalStatusInput {
  entry: Pick<CatalogEntry, 'enabled' | 'tier' | 'descriptor'>;
  tiers: readonly TierDef[];
  facts: LocalModelFacts;
  /** The routing defaults rule out Codex (`localHarnessWarning`). */
  harnessBlocked?: string;
}

function endpointNeeds(facts: LocalModelFacts): string[] {
  if (!facts.endpointOn) return ['its endpoint turned on'];
  if (facts.health === 'down') return ['its endpoint back up (it is down)'];
  return [];
}

/** The status of one local model for completions, planning and agentic work. Pure. */
export function localModelStatus(input: LocalStatusInput): LocalModelStatus {
  const { entry, tiers, facts } = input;
  const d = entry.descriptor;
  const weakest = tiers[0]?.name;
  const rank = tierRank(tiers, entry.tier);
  const hasTier = entry.tier !== undefined && rank >= 0;
  const base: string[] = [...(entry.enabled ? [] : ['enabling']), ...endpointNeeds(facts)];

  // Completions: exactly the weakest tier.
  const c: string[] = [...base];
  if (!hasTier) c.push(weakest ? `tier ${weakest}` : 'a tier');
  else if (entry.tier !== weakest) c.push(`the weakest tier, ${weakest} (it has ${entry.tier})`);

  // Planning: `standard` or above, and a window an excerpt fits in.
  const minRank = plannerMinRank(tiers);
  const minName = tiers[minRank]?.name;
  const p: string[] = [...base];
  if (!minName) p.push('a tier list with more than one tier');
  else if (!hasTier) p.push(`tier ${minName} or above`);
  else if (rank < minRank) p.push(`tier ${minName} or above (it has ${entry.tier})`);
  if (facts.plannerWindowFits === false) p.push('a context window a repository excerpt fits in');

  // Agentic: a Codex thread on the endpoint.
  const a: string[] = [...base];
  let completionOnly: string | undefined;
  const s1 = facts.stage1;
  if (s1 && !s1.error && s1.verdict === 'completion-only') {
    completionOnly = `stage-1 qualification: tool calls ${s1.toolCalls.ok}/${s1.toolCalls.runs} (measured)`;
  } else if (facts.responses === false) {
    completionOnly = 'the server has no /v1/responses, which Codex needs';
  } else if (isKnown(d.toolCalling) && d.toolCalling.value === 'none') {
    completionOnly = `its tool calls do not parse (${d.toolCalling.from})`;
  }
  if (!completionOnly) {
    if (facts.responses !== true) a.push('/v1/responses probed on its server');
    if (!isKnown(d.toolCalling)) a.push('measured tool calling (run Qualify)');
    if (!hasTier) a.push('a tier');
    if (input.harnessBlocked) a.push('routing defaults that allow Codex');
  }

  const completions: Readiness = { ready: c.length === 0, needs: c };
  const planning: Readiness = { ready: p.length === 0, needs: p };
  const agentic = completionOnly ? { ready: false, needs: [], completionOnly } : { ready: a.length === 0, needs: a };
  return { completions, planning, agentic, text: statusText(completions, planning, agentic, d.toolCalling) };
}

function statusText(c: Readiness, p: Readiness, a: LocalModelStatus['agentic'], tools: CatalogEntry['descriptor']['toolCalling']): string {
  const ready = [c.ready && 'completions', p.ready && 'planning', a.ready && 'agentic work'].filter(Boolean) as string[];
  const parts: string[] = [];
  if (ready.length > 0) {
    const declared = a.ready && isKnown(tools) && tools.from !== 'measured' ? ` (tool calling ${tools.from}, not measured)` : '';
    parts.push(`Ready for ${ready.join(', ')}${declared}`);
  }
  if (a.completionOnly) parts.push(`Completion only: ${a.completionOnly}`);
  const needs = (label: string, r: Readiness) => (r.ready || r.needs.length === 0 ? [] : [`${label} needs ${r.needs.join(', ')}`]);
  parts.push(...needs('Completions', c), ...needs('Planning', p), ...needs('Agentic work', a));
  return parts.join(' · ');
}

/**
 * The routing defaults rule out the Codex path, which is the only one a local
 * model does agentic work through (§19.7): the harness is pinned or preferred
 * to Claude Code, or Codex is excluded. Undefined when they do not, or when no
 * local model is enabled.
 */
export function localHarnessWarning(policy: ExecutionPolicy | undefined, localModelsEnabled: boolean): string | undefined {
  if (!localModelsEnabled || !policy) return undefined;
  let cause: string | undefined;
  if (policy.pins?.harness === 'claude-code') cause = 'pin the harness to Claude Code';
  else if (policy.exclusions?.harnesses?.includes('codex')) cause = 'exclude Codex';
  else if (policy.preferences?.harness === 'claude-code') cause = 'prefer Claude Code';
  if (!cause) return undefined;
  return `The routing defaults ${cause}. That rules out the Codex path, so local models cannot get agentic work (they still answer completions and plan).`;
}
