/**
 * Simulated structured completions (plan §26.3, #30): the real
 * `ClaudeStructuredCompletion`, validation and retry included, over a
 * scripted `query` that answers from scenario data instead of running
 * `claude`. No network, no process.
 */
import { randomUUID } from 'node:crypto';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { parseSimCompletion, type SimCompletionResponse } from '../../shared/orchestration/simulation';
import { ClaudeStructuredCompletion, type CompletionQueryFn } from './structuredCompletion';

/** One call the simulated completion received: the prompt and the options it was asked with. */
export interface SimulatedCompletionCall {
  prompt: string;
  options: Options;
}

/** A `query` that answers each call with the next scripted response. */
export function scriptedCompletionQuery(
  responses: SimCompletionResponse[],
  calls: SimulatedCompletionCall[] = [],
): CompletionQueryFn {
  const script = responses.map((r, i) => parseSimCompletion(r, `completions[${i}]`));
  let next = 0;
  return ({ prompt, options }) => {
    calls.push({ prompt: typeof prompt === 'string' ? prompt : '(stream)', options });
    const response = script[next++];
    const model = options.model ?? 'claude-simulated';
    const signal = options.abortController?.signal;
    const stream = (async function* () {
      if (!response) throw new Error(`simulated completion: no scripted response for call ${next}`);
      if ('hang' in response) {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        return;
      }
      yield resultFor(response, model);
    })();
    return Object.assign(stream, { close: () => undefined, interrupt: async () => undefined }) as unknown as Query;
  };
}

function resultFor(r: Exclude<SimCompletionResponse, { hang: true }>, model: string): Record<string, unknown> {
  const u = 'output' in r && r.usage ? r.usage : { in: 300, out: 40 };
  const cost = 'output' in r && r.costUsd !== undefined ? r.costUsd : 0.0005;
  const base = {
    type: 'result',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: cost,
    usage: { input_tokens: u.in, output_tokens: u.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: u.in, outputTokens: u.out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } },
    permission_denials: [],
    uuid: randomUUID(),
    session_id: randomUUID(),
  };
  if ('output' in r) return { ...base, subtype: 'success', is_error: false, result: JSON.stringify(r.output), structured_output: r.output };
  if ('raw' in r) return { ...base, subtype: 'success', is_error: false, result: r.raw };
  if ('retriesExhausted' in r) return { ...base, subtype: 'error_max_structured_output_retries', is_error: true, errors: ['structured output retries exhausted'] };
  const status = r.error === 'rate-limit' ? 429 : r.error === 'overloaded' ? 529 : r.error === 'context-overflow' ? 400 : 500;
  const text = r.error === 'context-overflow' ? 'Prompt is too long' : `API Error: ${status} ${r.error}`;
  return { ...base, subtype: 'success', is_error: true, result: text, api_error_status: status, stop_reason: null };
}

/** `StructuredCompletion` over scripted answers. `calls` records what each call was asked with. */
export class SimulatedCompletion extends ClaudeStructuredCompletion {
  readonly calls: SimulatedCompletionCall[];

  constructor(responses: SimCompletionResponse[]) {
    const calls: SimulatedCompletionCall[] = [];
    super({ query: scriptedCompletionQuery(responses, calls), binary: () => '/simulated/claude' });
    this.calls = calls;
  }
}
