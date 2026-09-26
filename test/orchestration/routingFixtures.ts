/**
 * Shared fixtures for the router, resolver and explanation tests (#38):
 * assessments built from named levels, and a catalog built the way
 * `CapabilityCatalog` builds one, from model lists shaped like the ones the
 * two harnesses report. Synthetic throughout.
 */
import { buildCatalog, type CapabilityCatalogView, type ModelPolicy, type ObservedLimits } from '../../src/shared/orchestration/catalog';
import type { ModelChoice } from '../../src/shared/conversation';
import type { SourceStatus } from '../../src/shared/orchestration/sourceHealth';
import type {
  Ambiguity,
  Breadth,
  Complexity,
  Confidence,
  ContextLoad,
  Risk,
  TaskAssessment,
  TaskKind,
  Verifiability,
} from '../../src/shared/orchestration/types';
import type { ResolverSnapshot } from '../../src/orchestration/policy/resolver';
import { assessment, T0 } from './fixtures';

export interface Levels {
  complexity: Complexity;
  breadth: Breadth;
  risk: Risk;
  verifiability: Verifiability;
  ambiguity?: Ambiguity;
  contextLoad?: ContextLoad;
  kind?: TaskKind;
  requires?: string[];
  /** Confidence for every dimension (default high). */
  confidence?: Confidence;
  /** Per-dimension confidence overrides. */
  complexityConfidence?: Confidence;
  riskConfidence?: Confidence;
}

/** An assessment with exactly these levels, every dimension at `high` confidence unless said otherwise. */
export function assessed(l: Levels, id = 'asm1'): TaskAssessment {
  const c = l.confidence ?? 'high';
  const d = <T extends string>(value: T, confidence: Confidence = c) => ({ value, confidence, from: 'model' as const, evidence: `synthetic ${value}` });
  return assessment(id, 't1', {
    dimensions: {
      complexity: d(l.complexity, l.complexityConfidence ?? c),
      breadth: d(l.breadth),
      risk: d(l.risk, l.riskConfidence ?? c),
      ambiguity: d(l.ambiguity ?? 'clear'),
      verifiability: d(l.verifiability),
      contextLoad: d(l.contextLoad ?? 'small'),
    },
    kind: d(l.kind ?? 'feature'),
    requires: l.requires ?? ['edit', 'shell'],
    confidence: c,
  });
}

const CLAUDE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORT = ['minimal', 'low', 'medium', 'high', 'xhigh'];

export const ANTHROPIC_MODELS: ModelChoice[] = [
  { value: 'default', label: 'Default', resolved: 'claude-opus-5-5', effortLevels: CLAUDE_EFFORT },
  { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5', effortLevels: [] },
  { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: CLAUDE_EFFORT },
  { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', effortLevels: CLAUDE_EFFORT },
  { value: 'fable', label: 'Fable', resolved: 'claude-fable-5-1', effortLevels: CLAUDE_EFFORT },
];

export const OPENAI_MODELS: ModelChoice[] = [
  { value: 'gpt-6-luna', label: 'gpt-6-luna', effortLevels: CODEX_EFFORT, inputModalities: ['text', 'image'] },
  { value: 'gpt-6-sol', label: 'gpt-6-sol', effortLevels: CODEX_EFFORT, inputModalities: ['text', 'image'] },
  { value: 'gpt-6-astra', label: 'gpt-6-astra', effortLevels: CODEX_EFFORT, inputModalities: ['text', 'image'] },
  { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol', effortLevels: CODEX_EFFORT },
];

export function catalog(opts: { policy?: ModelPolicy; observed?: Record<string, ObservedLimits>; openai?: boolean } = {}): CapabilityCatalogView {
  return buildCatalog({
    reported: [
      { source: 'anthropic', models: ANTHROPIC_MODELS, at: T0 },
      ...(opts.openai === false ? [] : [{ source: 'openai' as const, models: OPENAI_MODELS, at: T0 }]),
    ],
    observed: opts.observed,
    policy: opts.policy,
  });
}

export function status(source: string, state: SourceStatus['health']['state'], percent?: number, backoffUntil?: number): SourceStatus {
  return {
    source,
    health: { state, reason: percent !== undefined ? `5-hour window at ${percent}%` : state },
    capacity: {
      windowPercent: percent !== undefined ? { value: percent, from: 'reported' } : { unknown: true },
      freeSlots: { unknown: true },
      ...(backoffUntil !== undefined ? { backoffUntil } : {}),
    },
  };
}

export function snapshot(over: Partial<ResolverSnapshot> = {}): ResolverSnapshot {
  return {
    catalog: catalog(),
    sources: { anthropic: status('anthropic', 'reachable', 20), openai: status('openai', 'reachable', 20) },
    now: T0,
    ...over,
  };
}
