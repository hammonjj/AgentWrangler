/**
 * The outcome classifier (#41, plan §15.1) as a table: evidence shaped like
 * what the harnesses and #4 actually hand over → category and signature.
 * Synthetic throughout.
 */
import { describe, expect, it } from 'vitest';
import { classifyOutcome, classifyTurn, REPEATED_DENIALS, type OutcomeEvidence } from '../../src/orchestration/policy/outcome';

/** A Claude SDK `result` message, as `turnEnd` carries it untranslated. */
function result(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1200,
    num_turns: 3,
    result: 'Done.',
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20 },
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: '00000000-0000-4000-8000-000000000002',
    ...over,
  };
}

/** A Codex `turn/completed` notification's params. */
function codexTurn(status: string, error?: unknown): Record<string, unknown> {
  return { threadId: 'th1', turn: { id: 'tu1', status, ...(error !== undefined ? { error } : {}) } };
}

const denial = { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'rm -rf /tmp/x' } };

describe('classifyTurn: the last turn result', () => {
  const table: [string, unknown, { category: string; signature: string; retryable?: boolean } | undefined][] = [
    ['a successful result', result(), undefined],
    ['nothing at all', undefined, undefined],
    ['a 429', result({ subtype: 'error_during_execution', is_error: true, api_error_status: 429, terminal_reason: 'api_error' }), { category: 'capacity', signature: 'api-429' }],
    ['a rate-limit terminal reason without a status', result({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'rate_limit' }), { category: 'capacity', signature: 'api-rate-limit' }],
    ['max turns', result({ subtype: 'error_max_turns', is_error: true }), { category: 'budget', signature: 'max-turns' }],
    ['max budget', result({ subtype: 'error_max_budget_usd', is_error: true }), { category: 'budget', signature: 'max-budget' }],
    ['budget exhausted', result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'budget_exhausted' }), { category: 'budget', signature: 'max-budget' }],
    ['prompt too long', result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'prompt_too_long' }), { category: 'context', signature: 'context-overflow' }],
    ['a context error in the CLI’s own error line', result({ subtype: 'error_during_execution', is_error: true, result: 'API Error: prompt is too long: 210000 tokens > 200000 maximum' }), { category: 'context', signature: 'context-overflow' }],
    ['a 401', result({ subtype: 'error_during_execution', is_error: true, api_error_status: 401 }), { category: 'infra', signature: 'api-401', retryable: false }],
    ['a 529 overload', result({ subtype: 'error_during_execution', is_error: true, api_error_status: 529 }), { category: 'infra', signature: 'api-529' }],
    ['a 500', result({ subtype: 'error_during_execution', is_error: true, api_error_status: 500, terminal_reason: 'api_error' }), { category: 'infra', signature: 'api-500' }],
    ['a model error', result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error' }), { category: 'infra', signature: 'model-error' }],
    ['an execution error', result({ subtype: 'error_during_execution', is_error: true }), { category: 'infra', signature: 'error_during_execution' }],
    ['a Codex turn that completed', codexTurn('completed'), undefined],
    ['a Codex context overflow', codexTurn('failed', { message: 'x', codexErrorInfo: 'contextWindowExceeded' }), { category: 'context', signature: 'context-overflow' }],
    ['a Codex usage limit', codexTurn('failed', { message: 'x', codexErrorInfo: 'usageLimitExceeded' }), { category: 'capacity', signature: 'usage-limit' }],
    ['a Codex login refused', codexTurn('failed', { message: 'x', codexErrorInfo: 'unauthorized' }), { category: 'infra', signature: 'codex-unauthorized', retryable: false }],
    ['a Codex connection failure (an object code)', codexTurn('failed', { message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }), { category: 'infra', signature: 'codex-httpconnectionfailed' }],
    ['a Codex failure with no code', codexTurn('failed', { message: 'x' }), { category: 'infra', signature: 'codex-turn-failed' }],
  ];
  for (const [name, raw, want] of table) {
    it(name, () => {
      const got = classifyTurn(raw);
      if (!want) expect(got).toBeUndefined();
      else expect(got).toMatchObject(want);
    });
  }
});

describe('classifyOutcome: the whole attempt', () => {
  const table: [string, OutcomeEvidence, string | undefined, string?][] = [
    ['a cap refused the next attempt', { refusal: 'The mission caps attempts at 3.' }, 'budget', 'cap'],
    ['the session was lost', { session: { state: 'interrupted', endedReason: 'host lost' } }, 'lost', 'host lost'],
    ['it ran past its wall clock', { overran: { activeMs: 50 * 60_000, limitMs: 45 * 60_000 } }, 'stuck', 'wall-clock'],
    ['its local server went away', { localServerLost: true, lastTurn: result({ is_error: true, subtype: 'error_during_execution' }) }, 'infra', 'local-server-lost'],
    ['the launch failed', { launchFailed: 'spawn ENOENT' }, 'infra', 'launch-failed'],
    ['the agent failed (#4 `failed`)', { session: { state: 'failed', endedReason: 'agent error' } }, 'infra', 'agent-error'],
    ['a turn error beats a missing diff', { lastTurn: result({ is_error: true, api_error_status: 429 }), filesChanged: 0 }, 'capacity', 'api-429'],
    ['it ended asking something', { pendingAsk: true }, 'ambiguity', 'question'],
    ['a plan-first task that failed its checks', { gates: ['plan-first'], filesChanged: 2, verification: { verdict: 'failed', signature: 'command:check:x' } }, 'ambiguity', 'plan-first'],
    [
      'repeated permission denials and nothing done',
      { lastTurn: result({ permission_denials: Array(REPEATED_DENIALS).fill(denial) }), filesChanged: 0 },
      'policy',
      'permission-denied',
    ],
    ['one denial is not a policy failure', { lastTurn: result({ permission_denials: [denial] }), filesChanged: 0 }, 'empty', 'no-diff'],
    ['no diff', { lastTurn: result(), filesChanged: 0 }, 'empty', 'no-diff'],
    ['a new verification failure', { filesChanged: 1, verification: { verdict: 'failed', signature: 'command:check:test/a.test.ts' }, previousSignature: 'command:check:test/b.test.ts' }, 'quality-new', 'command:check:test/a.test.ts'],
    ['the same verification failure again', { filesChanged: 1, verification: { verdict: 'failed', signature: 'command:check:test/a.test.ts' }, previousSignature: 'command:check:test/a.test.ts' }, 'quality-repeat', 'command:check:test/a.test.ts'],
    ['a failure with no signature is still a signature', { filesChanged: 1, verification: { verdict: 'failed' } }, 'quality-new', 'verification-failed'],
    ['a pass is not a failure', { filesChanged: 1, verification: { verdict: 'passed' }, lastTurn: result() }, undefined],
    ['unverified is not a failure', { filesChanged: 1, verification: { verdict: 'unverified' } }, undefined],
  ];
  for (const [name, evidence, category, signature] of table) {
    it(name, () => {
      const got = classifyOutcome(evidence);
      if (category === undefined) {
        expect(got).toBeUndefined();
        return;
      }
      expect(got?.category).toBe(category);
      if (signature !== undefined) expect(got?.signature).toBe(signature);
      expect(got?.detail).toBeTruthy();
    });
  }

  it('never puts agent prose in the detail', () => {
    const got = classifyOutcome({ lastTurn: result({ is_error: true, subtype: 'error_during_execution', result: 'Synthetic agent text that must not leak' }) });
    expect(got?.detail).not.toContain('Synthetic agent text');
  });
});
