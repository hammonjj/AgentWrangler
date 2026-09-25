/**
 * Structured completion (#30, plan §6.1): the real `ClaudeStructuredCompletion`
 * over scripted answers. Schema validation, one retry, errors reported as they
 * are, and the one-shot, no-tools, unrecorded call shape.
 */
import { describe, expect, it } from 'vitest';
import { validateJson, type JsonSchema } from '../../src/orchestration/completion/jsonSchema';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { DEFAULT_COMPLETION_MODEL } from '../../src/orchestration/completion/structuredCompletion';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['trivial', 'routine', 'involved', 'hard'] },
    files: { type: 'integer', minimum: 0 },
    reasons: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['complexity', 'files', 'reasons'],
  additionalProperties: false,
};
const GOOD = { complexity: 'routine', files: 2, reasons: ['one module'] };
const ask = { schema: SCHEMA, instructions: 'Assess the task.', input: 'Fix the parser.' };

describe('validateJson', () => {
  it('accepts a matching value and names every problem in one that does not', () => {
    expect(validateJson(SCHEMA, GOOD)).toEqual([]);
    expect(validateJson(SCHEMA, { complexity: 'epic', files: 1.5, reasons: [], extra: true })).toEqual([
      '$.complexity: must be one of ["trivial","routine","involved","hard"]',
      '$.files: expected integer, got number',
      '$.reasons: fewer than 1 items',
      '$: unexpected property extra',
    ]);
    expect(validateJson(SCHEMA, [])).toEqual(['$: expected object, got array']);
    expect(validateJson({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 3)).toEqual(['$: matches none of anyOf']);
  });
});

describe('StructuredCompletion', () => {
  it('returns schema-valid output from a one-shot, no-tools, unrecorded call on the cheapest model', async () => {
    const c = new SimulatedCompletion([{ output: GOOD, usage: { in: 300, out: 40 }, costUsd: 0.0004 }]);
    const r = await c.complete<typeof GOOD>(ask);
    expect(r).toMatchObject({ ok: true, value: GOOD, attempts: 1, model: DEFAULT_COMPLETION_MODEL, usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.0004 } });
    expect(c.calls).toHaveLength(1);
    const o = c.calls[0].options;
    expect(o).toMatchObject({
      model: 'haiku',
      systemPrompt: 'Assess the task.',
      tools: [],
      maxTurns: 1,
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      persistSession: false,
      settingSources: [],
      pathToClaudeCodeExecutable: '/simulated/claude',
    });
    // Not a session: nothing to resume, no id chosen, no hooks.
    expect(o.resume).toBeUndefined();
    expect(o.sessionId).toBeUndefined();
    expect(o.canUseTool).toBeUndefined();
    expect(c.calls[0].prompt).toBe('Fix the parser.');
  });

  it('retries invalid output once, naming the problems, and succeeds', async () => {
    const c = new SimulatedCompletion([{ output: { complexity: 'epic', files: 1, reasons: ['x'] } }, { output: GOOD }]);
    const r = await c.complete(ask);
    expect(r).toMatchObject({ ok: true, value: GOOD, attempts: 2 });
    expect(c.calls[1].prompt).toContain('did not match the required JSON schema');
    expect(c.calls[1].prompt).toContain('$.complexity: must be one of');
    // Usage covers both calls.
    expect(r.usage.inputTokens).toBe(600);
  });

  it('reports invalid output after the retry, with the last output and its problems', async () => {
    const c = new SimulatedCompletion([{ raw: 'not json' }, { output: { complexity: 'routine' } }]);
    const r = await c.complete(ask);
    expect(r).toMatchObject({ ok: false, reason: 'invalid-output', attempts: 2, raw: { complexity: 'routine' } });
    expect(r.ok ? [] : r.problems).toEqual(['$: missing files', '$: missing reasons']);
    expect(c.calls).toHaveLength(2);
  });

  it('treats the CLI giving up on the schema as invalid output, and parses fenced JSON text', async () => {
    const c = new SimulatedCompletion([{ retriesExhausted: true }, { raw: '```json\n' + JSON.stringify(GOOD) + '\n```' }]);
    expect(await c.complete(ask)).toMatchObject({ ok: true, value: GOOD, attempts: 2 });
  });

  it('reports an API error at once, without retrying', async () => {
    const c = new SimulatedCompletion([{ error: 'rate-limit' }, { output: GOOD }]);
    const r = await c.complete(ask);
    expect(r).toMatchObject({ ok: false, reason: 'error', apiErrorStatus: 429, attempts: 1 });
    expect(c.calls).toHaveLength(1);
  });

  it('times out a call that never answers, and honours an abort', async () => {
    const hung = new SimulatedCompletion([{ hang: true }]);
    expect(await hung.complete({ ...ask, timeoutMs: 30 })).toMatchObject({ ok: false, reason: 'timeout', attempts: 1 });

    const aborted = new SimulatedCompletion([{ hang: true }]);
    const ac = new AbortController();
    const p = aborted.complete({ ...ask, signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('passes the model and effort it is asked for', async () => {
    const c = new SimulatedCompletion([{ output: GOOD }]);
    await c.complete({ ...ask, model: 'sonnet', effort: 'low' });
    expect(c.calls[0].options).toMatchObject({ model: 'sonnet', effort: 'low' });
  });
});
