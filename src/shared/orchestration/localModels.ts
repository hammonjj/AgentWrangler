/**
 * What a local endpoint's probe and qualification found, and how that becomes
 * ordinary `ModelDescriptor`s for the catalog (`docs/plans/intelligent-orchestration.md`
 * §19.2, §19.6; #51).
 *
 * Precedence per field: **measured** (the qualification probe) over
 * **probed** (the server said) over **declared** (the user said), and
 * **unknown** when nobody knows. Two facts start unknown on purpose (§19.6):
 * tool calling is per model, not per runtime, so only a qualification run
 * sets it; and a harness endpoint counts only when the probe found it
 * (`/v1/responses` for Codex), because AW ships no protocol translator.
 *
 * Pure and shared: the main process builds these, Preferences renders them.
 */

import { UNKNOWN, known, type Known, type ModelDescriptor } from './catalog';
import {
  DATA_LEAVES_MACHINE,
  endpointEnabled,
  endpointLocation,
  endpointSource,
  type LocalEndpointConfig,
  type LocalRuntime,
  type StructuredOutputLevel,
  type ToolCallingLevel,
} from './localEndpoints';
import type { HarnessId, Millis } from './types';

/** One model as the server listed it, with what the server said about it. */
export interface ProbedModel {
  id: string;
  contextWindow: Known<number>;
  vision: Known<boolean>;
  /** Ollama's `capabilities` has `tools`: the template can emit calls. Not the same as calls that parse (§19.6). */
  toolTemplate?: boolean;
}

/** The result of probing one endpoint. */
export interface EndpointProbe {
  at: Millis;
  reachable: boolean;
  /** Why it could not be probed. Never a response body. */
  error?: string;
  runtime: Known<LocalRuntime>;
  models: ProbedModel[];
  /** Server slots (llama.cpp `total_slots`). */
  slots: Known<number>;
  /** Harness wire protocols the server serves natively (§19.6 point 1). */
  routes: { responses: Known<boolean>; messages: Known<boolean> };
  /** Constrained decoding the runtime offers for `chat/completions`. */
  structuredOutput: Known<StructuredOutputLevel>;
  /** The health route the runtime answers, for the periodic check. */
  healthPath: string;
}

/** What the qualification probe measured for one model (§19.6 stage 1). */
export interface Qualification {
  model: string;
  at: Millis;
  toolCalls: { ok: number; runs: number };
  roundTrips: { ok: number; runs: number };
  json: { ok: number; runs: number };
  /** Client-measured from the stream. */
  throughput?: { outTokPerSec: number; ttftMs: number };
  toolCalling: ToolCallingLevel;
  structuredOutput: StructuredOutputLevel;
  /** Streaming worked (the measurements came from a stream). */
  streaming: boolean;
  /** Any miss means completion-only (§19.6). */
  verdict: 'agentic' | 'completion-only';
  /** Why it could not finish, when it could not. */
  error?: string;
}

/** A local model, ready for the catalog. */
export interface LocalModelReport {
  descriptor: ModelDescriptor;
  /** Harnesses that can drive it: `codex` only where `/v1/responses` was probed. */
  harnesses: HarnessId[];
  /** Its endpoint is on. Off: listed, never routed and never called. */
  endpointEnabled: boolean;
  /** Not on this machine: "data leaves this machine". */
  external: boolean;
  /** Why no harness can drive it, when none can. */
  completionOnlyBecause?: string;
  reportedAt?: Millis;
}

/** The part of a model id worth showing: MLX lists the weights path as its id. */
export function shortModelName(id: string): string {
  const parts = id.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : id;
}

function first<T>(...candidates: Known<T>[]): Known<T> {
  return candidates.find((k) => !('unknown' in k)) ?? UNKNOWN;
}

function declaredOr<T>(v: T | undefined): Known<T> {
  return v !== undefined ? known(v, 'declared') : UNKNOWN;
}

/** Every model an endpoint reported, as descriptors with provenance. */
export function localModelReports(
  cfg: LocalEndpointConfig,
  probe: EndpointProbe | undefined,
  qualifications: Record<string, Qualification> = {},
): LocalModelReport[] {
  if (!probe) return [];
  const source = endpointSource(cfg.id);
  const location = endpointLocation(cfg);
  const external = location !== 'local';
  const runtime = 'value' in probe.runtime ? probe.runtime.value : 'openai-compatible';
  const responses = 'value' in probe.routes.responses && probe.routes.responses.value === true;
  return probe.models.map((m) => {
    const declared = cfg.models?.[m.id] ?? {};
    const q = qualifications[m.id];
    const measuredTools: Known<ToolCallingLevel> = q ? known(q.toolCalling, 'measured') : UNKNOWN;
    const measuredJson: Known<StructuredOutputLevel> = q ? known(q.structuredOutput, 'measured') : UNKNOWN;
    const descriptor: ModelDescriptor = {
      source,
      modelId: m.id,
      label: `${shortModelName(m.id)} · ${cfg.name}`,
      description: external ? `External endpoint (${runtime}): ${DATA_LEAVES_MACHINE}` : `Local (${runtime})`,
      location,
      contextWindow: first(m.contextWindow, declaredOr(declared.contextWindow)),
      maxOutputTokens: declaredOr(declared.maxOutputTokens),
      toolCalling: first(measuredTools, declaredOr(declared.toolCalling)),
      structuredOutput: first(measuredJson, probe.structuredOutput, declaredOr(declared.structuredOutput)),
      vision: first(m.vision, declaredOr(declared.vision)),
      streaming: q ? known(q.streaming, 'measured') : UNKNOWN,
      // Over the OpenAI API a local runtime offers reasoning on/off at most, no levels (§19.2).
      nativeEffort: known([], 'probed'),
      maxConcurrency: first(probe.slots, declaredOr(cfg.maxConcurrency)),
      throughput: q?.throughput ? known(q.throughput, 'measured') : UNKNOWN,
      // `$0 API cost` by rule (§19.4). An external endpoint may bill, but AW has no price for it.
      costBasis: 'none',
      ...(cfg.device ? { hardware: { device: cfg.device } } : {}),
    };
    return {
      descriptor,
      harnesses: responses ? ['codex'] : [],
      endpointEnabled: endpointEnabled(cfg),
      external,
      ...(responses ? {} : { completionOnlyBecause: 'Completion only: the server has no /v1/responses, which Codex needs' }),
      reportedAt: probe.at,
    };
  });
}
