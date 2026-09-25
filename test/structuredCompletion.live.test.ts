import { execFileSync } from 'node:child_process';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { resolveClaudeBinary } from '../src/claude/binary';
import { validateJson, type JsonSchema } from '../src/orchestration/completion/jsonSchema';
import { ClaudeStructuredCompletion, type CompletionQueryFn } from '../src/orchestration/completion/structuredCompletion';

/**
 * A structured completion against the real `claude`, on the cheapest model
 * (#30). Opt-in (`AW_LIVE_CLAUDE=1`): it spends one tiny call. It asserts
 * only shapes, never content; do not paste its output anywhere public.
 *
 * A completion is not a session: afterwards no `claude` this process
 * started may still be running (there is no registry or host involved at all).
 */
const live = process.env.AW_LIVE_CLAUDE === '1';
const d = live ? describe : describe.skip;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['trivial', 'routine', 'involved', 'hard'] },
    files: { type: 'integer', minimum: 0 },
  },
  required: ['complexity', 'files'],
  additionalProperties: false,
};

/** Pids of this process's children, and theirs. */
function descendants(pid = process.pid): number[] {
  let out: string;
  try {
    out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const kids = out.split('\n').filter(Boolean).map(Number);
  return kids.flatMap((k) => [k, ...descendants(k)]);
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

d('structured completion, live', () => {
  it('returns schema-valid JSON on haiku and leaves no claude process behind', async () => {
    const completion = new ClaudeStructuredCompletion({
      query: sdkQuery as CompletionQueryFn,
      binary: () => resolveClaudeBinary(''),
    });
    const r = await completion.complete<{ complexity: string; files: number }>({
      schema: SCHEMA,
      instructions: 'You assess coding tasks. Answer only with the requested JSON.',
      input: 'Task: rename one local variable in a single small file.',
      timeoutMs: 90_000,
    });
    expect(r.ok, r.ok ? '' : `${r.reason}: ${r.message}`).toBe(true);
    if (!r.ok) return;
    expect(validateJson(SCHEMA, r.value)).toEqual([]);
    expect(r.model).toBe('haiku');
    await new Promise((res) => setTimeout(res, 500));
    const leftover = descendants().map(commandOf).filter((c) => /claude/i.test(c));
    expect(leftover).toEqual([]);
  }, 120_000);
});
