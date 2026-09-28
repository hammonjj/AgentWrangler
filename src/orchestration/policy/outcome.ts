/**
 * The outcome classifier (`docs/plans/intelligent-orchestration.md` §15.1, #41):
 * structured evidence about how an attempt ended → one category and a
 * signature. The escalation policy (`escalation.ts`) decides what to do with it.
 *
 * Pure and deterministic. No LLM, no text a person or an agent wrote beyond
 * the harness's own error fields: every input is a status, a code, a count or
 * a signature the verifier already normalised.
 *
 * Evidence, in the order it is believed (the first that applies wins):
 *
 * 1. a cap that refused the next attempt → `budget`;
 * 2. the session was lost (#4's `interrupted`) → `lost`;
 * 3. the attempt ran past its wall clock → `stuck`;
 * 4. the launch itself failed → `infra`;
 * 5. the last turn's result: Claude `subtype` / `terminal_reason` /
 *    `api_error_status`, Codex `turn/completed` status and error;
 * 6. the session record failed (#4's `failed`, handle `error`) → `infra`;
 * 7. it ended asking something, or the task had a `plan-first` gate → `ambiguity`;
 * 8. repeated permission denials with nothing to show → `policy`;
 * 9. no diff → `empty`;
 * 10. verification failed → `quality-new`, or `quality-repeat` when its
 *     signature is the previous failed attempt's.
 */
import type { OutcomeCategory, RouteGate } from '../../shared/orchestration/types';
import type { VerificationVerdict } from '../../shared/orchestration/verification';
import { classifyClaudeRateLimit, classifyCodexRateLimit, type RateLimitStoppage } from '../../shared/rateLimitClassification';

/** What the classifier concluded. `retryable: false`: trying again unchanged cannot help (a refused login). */
export interface Classification {
  category: OutcomeCategory;
  signature: string;
  retryable?: boolean;
  /** One line for the strip; never agent-written text. */
  detail: string;
  /**
   * A `capacity` classification's classified rate-limit stoppage (#75): which
   * provider, which window when known, the reported reset time if any, and
   * raw evidence. Absent for every other category — this never replaces
   * `category`/`signature`, which the escalation policy already keys on.
   */
  rateLimit?: RateLimitStoppage;
}

export interface OutcomeEvidence {
  /** The last turn result this core saw end (Claude `result`, Codex `turn/completed`). */
  lastTurn?: unknown;
  /** How #4's registry left the session, when that is how the attempt ended. */
  session?: { state: 'failed' | 'interrupted'; endedReason?: string };
  /** The harness could not start the session. */
  launchFailed?: string;
  /** Active time ran past the attempt's wall clock (§15.3). */
  overran?: { activeMs: number; limitMs: number };
  /** A question, plan or permission was pending when it ended. */
  pendingAsk?: boolean;
  /** The routing requirement's gates. */
  gates?: readonly RouteGate[];
  /** Files the attempt changed, measured from where it started. */
  filesChanged?: number;
  verification?: { verdict: VerificationVerdict; signature?: string; summary?: string };
  /** A cap refused the next attempt: the sentence that says which. */
  refusal?: string;
  /** The signature of the task's previous failed attempt, if it had one. */
  previousSignature?: string;
  /** A local model's server went away mid-attempt (#51). */
  localServerLost?: boolean;
}

/** Permission denials in one turn that count as "repeated" (§15.2 `policy`). */
export const REPEATED_DENIALS = 3;

/**
 * The category and signature of a failed attempt, or undefined when nothing
 * in the evidence says it failed.
 */
export function classifyOutcome(e: OutcomeEvidence): Classification | undefined {
  if (e.refusal) return { category: 'budget', signature: 'cap', detail: e.refusal };
  if (e.session?.state === 'interrupted') {
    const why = e.session.endedReason ?? 'interrupted';
    return { category: 'lost', signature: why, detail: `its session was lost (${why})` };
  }
  if (e.overran) {
    return { category: 'stuck', signature: 'wall-clock', detail: `no end after ${Math.round(e.overran.activeMs / 60_000)} min of work (limit ${Math.round(e.overran.limitMs / 60_000)} min)` };
  }
  // Not retried as is: the same endpoint is down. Failover (§9.4, #51) has already had its chance.
  if (e.localServerLost) return { category: 'infra', signature: 'local-server-lost', retryable: false, detail: 'its local model server stopped answering' };
  if (e.launchFailed !== undefined) return { category: 'infra', signature: 'launch-failed', detail: `it could not start (${e.launchFailed})` };
  const turn = classifyTurn(e.lastTurn);
  if (turn) return turn;
  if (e.session?.state === 'failed') {
    return { category: 'infra', signature: 'agent-error', detail: `its agent failed (${e.session.endedReason ?? 'agent error'})` };
  }
  if (e.pendingAsk) return { category: 'ambiguity', signature: 'question', detail: 'it ended asking something' };
  const failedWork = e.filesChanged === 0 || e.verification?.verdict === 'failed';
  if (failedWork && e.gates?.includes('plan-first')) {
    return { category: 'ambiguity', signature: 'plan-first', detail: 'the task needs clarifying or planning before an agent edits anything' };
  }
  const denials = permissionDenials(e.lastTurn);
  if (failedWork && denials >= REPEATED_DENIALS) {
    return { category: 'policy', signature: 'permission-denied', detail: `${denials} tool calls were refused by the attempt's permissions` };
  }
  if (e.filesChanged === 0) return { category: 'empty', signature: 'no-diff', detail: 'it changed nothing' };
  if (e.verification?.verdict === 'failed') {
    const signature = e.verification.signature ?? 'verification-failed';
    const repeat = e.previousSignature !== undefined && e.previousSignature === signature;
    return {
      category: repeat ? 'quality-repeat' : 'quality-new',
      signature,
      detail: `verification failed${repeat ? ' the same way again' : ''}: ${e.verification.summary ?? signature}`,
    };
  }
  return undefined;
}

/**
 * Why a turn's result means the attempt failed, or undefined when it did not.
 * Claude: an error `result`. Codex: a `turn/completed` whose turn failed.
 */
export function classifyTurn(raw: unknown): Classification | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type === 'result') return classifyClaudeResult(r);
  const turn = (r as { turn?: { status?: unknown; error?: unknown } }).turn;
  if (turn && (turn.status === 'failed' || turn.error)) return classifyCodexError(turn.error);
  return undefined;
}

function classifyClaudeResult(r: Record<string, unknown>): Classification | undefined {
  const subtype = typeof r.subtype === 'string' ? r.subtype : '';
  if (r.is_error !== true && subtype === 'success') return undefined;
  const status = typeof r.api_error_status === 'number' ? r.api_error_status : undefined;
  const reason = typeof r.terminal_reason === 'string' ? r.terminal_reason : '';
  // The result text is the CLI's own error line here, not the agent's prose.
  const text = typeof r.result === 'string' ? r.result.slice(0, 500) : '';
  if (status === 429 || /rate.?limit|usage.?limit/i.test(reason)) {
    // A bare API-level 429 (or a rate-limit terminal reason with no status)
    // names no window: `classifyClaudeRateLimit`'s `generic-429` always comes
    // back `unknown`, never a guessed five-hour or weekly reset.
    const rateLimit = status === 429 ? classifyClaudeRateLimit({ kind: 'generic-429', raw: r }) : undefined;
    return { category: 'capacity', signature: `api-${status ?? 'rate-limit'}`, detail: 'rate limited', rateLimit };
  }
  if (subtype.startsWith('error_max_turns') || reason === 'max_turns') {
    return { category: 'budget', signature: 'max-turns', detail: 'it reached its turn limit' };
  }
  if (subtype.startsWith('error_max_budget') || reason === 'budget_exhausted') {
    return { category: 'budget', signature: 'max-budget', detail: 'it reached its spending limit' };
  }
  if (reason === 'prompt_too_long' || /prompt.?(is.?)?too.?long|context.?(window|length|overflow)/i.test(`${reason} ${subtype} ${text}`)) {
    return { category: 'context', signature: 'context-overflow', detail: 'its context overflowed' };
  }
  if (status === 401 || status === 403) {
    return { category: 'infra', signature: `api-${status}`, retryable: false, detail: `the provider refused the request (${status})` };
  }
  if (status !== undefined && status >= 500) return { category: 'infra', signature: `api-${status}`, detail: `a provider error (${status})` };
  if (reason === 'api_error' || reason === 'model_error') return { category: 'infra', signature: reason.replace('_', '-'), detail: `a provider error (${reason})` };
  const signature = subtype || (status !== undefined ? `api-${status}` : 'error');
  return { category: 'infra', signature, detail: `its last turn ended in an error (${signature})` };
}

/** Codex's turn error: `{message, codexErrorInfo}` as the app-server sends it. Matched on its codes, never its prose. */
function classifyCodexError(error: unknown): Classification {
  const info = error && typeof error === 'object' ? (error as { codexErrorInfo?: unknown }).codexErrorInfo : undefined;
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info as object)[0] ?? '' : '';
  if (/contextWindowExceeded/i.test(code)) return { category: 'context', signature: 'context-overflow', detail: 'its context overflowed' };
  if (/usageLimitExceeded/i.test(code)) {
    return {
      category: 'capacity',
      signature: 'usage-limit',
      detail: 'rate limited',
      rateLimit: classifyCodexRateLimit({ kind: 'codex-error-code', code, raw: error }),
    };
  }
  if (/unauthori[sz]ed/i.test(code)) return { category: 'infra', signature: 'codex-unauthorized', retryable: false, detail: 'the provider refused the request' };
  const signature = code ? `codex-${code.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}` : 'codex-turn-failed';
  return { category: 'infra', signature, detail: `its last turn failed (${signature})` };
}

/** How many tool calls the turn's permissions refused (Claude `result.permission_denials`). */
export function permissionDenials(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const d = (raw as { permission_denials?: unknown }).permission_denials;
  return Array.isArray(d) ? d.length : 0;
}
