/**
 * Scenario data for the simulated harness and simulated completions
 * (`docs/plans/intelligent-orchestration.md` §26.3, #30). Pure: no Node, no DOM.
 *
 * A scenario says what each attempt at each task does. The simulated agent
 * plays it through the real launch path (`SessionExecutors` → the Claude
 * executor → an in-process session or a fake session host), so everything
 * above the SDK boundary runs exactly as it does for a real agent, and nothing
 * touches the network or costs anything.
 */

/** Every behaviour a simulated attempt can have (§26.3). */
export const SIM_BEHAVIOURS = [
  /** Writes `files` into the worktree, then succeeds. */
  'edit',
  /** Ends the turn as an execution error (`error_during_execution`). */
  'fail',
  /** Never produces a result; only an interrupt ends the turn. */
  'timeout',
  /** A 429: a `rate_limit_event`, an assistant `rate_limit` error and an error result. */
  'rate-limit',
  /** Succeeds, but its final output is not the JSON asked for. */
  'bad-structured-output',
  /** Streams its reply at `outTokPerSec`, then succeeds. */
  'slow',
  /** `prompt_too_long`: the context overflowed. */
  'context-overflow',
  /** A tool call fails (`is_error` tool result); the turn still ends. */
  'tool-failure',
  /** Writes `files` meant to fail the repo's checks, then reports success. */
  'fail-verification',
  /** Reports success without changing anything. */
  'no-diff',
  /** Writes `files` (if any), then the agent process dies mid-turn. */
  'crash',
  /** Asks the user a question (`AskUserQuestion`) and waits for the answer. */
  'question',
  /** Asks permission for a tool and waits for the decision. */
  'permission',
] as const;

export type SimBehaviour = (typeof SIM_BEHAVIOURS)[number];

/** Tokens for one turn. Summed into the running totals a real `result` carries. */
export interface SimUsage {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** What one turn of a simulated attempt does. */
export interface SimStep {
  behaviour: SimBehaviour;
  /** Paths relative to the worktree → content to write, or `null` to delete. */
  files?: Record<string, string | null>;
  /** The final assistant text. */
  text?: string;
  /** This turn's tokens (default: a small fixed amount, so telemetry has something). */
  usage?: SimUsage;
  /** This turn's estimated cost in USD (default 0.001). */
  costUsd?: number;
  /** Model round trips reported as `num_turns` (default 1). */
  turns?: number;
  /** Wait this long before the turn ends. */
  delayMs?: number;
  /** `slow`: tokens per second for the streamed reply (default 50). */
  outTokPerSec?: number;
  /** `rate-limit`: the HTTP status (default 429) and when to retry. */
  status?: number;
  retryAfterSec?: number;
  /** `fail`, `fail-verification`: the failure signature a classifier would see. */
  signature?: string;
  /** `permission`, `tool-failure`: the tool (default `Bash`) and its input. */
  tool?: { name: string; input: Record<string, unknown> };
  /** `question`: what is asked. */
  question?: { question: string; header?: string; options?: string[] };
  /** `bad-structured-output`: the `structured_output` returned, if any. */
  structured?: unknown;
  /** `bad-structured-output`: the raw result text (default: not JSON). */
  raw?: string;
}

/** One attempt: its first turn, then what any later message to the session does. */
export interface SimAttempt extends SimStep {
  followUps?: SimStep[];
}

/** One scripted answer to a structured completion. */
export type SimCompletionResponse =
  /** Returns this as `structured_output` (valid or not: the validator decides). */
  | { output: unknown; usage?: SimUsage; costUsd?: number }
  /** Returns this text and no `structured_output`. */
  | { raw: string }
  /** The CLI gave up producing schema-valid output (`error_max_structured_output_retries`). */
  | { retriesExhausted: true }
  /** An API error on the result (`rate-limit` is a 429). */
  | { error: 'rate-limit' | 'overloaded' | 'context-overflow' | string }
  /** Never answers; only the timeout or an abort ends the call. */
  | { hang: true };

export interface SimScenario {
  /** Attempts per task id, in launch order. */
  tasks?: Record<string, SimAttempt[]>;
  /** What an attempt with no script of its own does. Absent: launching one is an error. */
  default?: SimAttempt;
  /** Answers for `SimulatedCompletion`, in call order. */
  completions?: SimCompletionResponse[];
}

/** Marks the scenario for a session inside its first prompt, so hosted and in-process sessions read it the same way. */
const DIRECTIVE = /^<aw-sim>(.*?)<\/aw-sim>\n?/s;

/** The first prompt of a simulated attempt: the script, then the real prompt. */
export function withSimDirective(attempt: SimAttempt, prompt: string): string {
  return `<aw-sim>${JSON.stringify(attempt)}</aw-sim>\n${prompt}`;
}

/** The script a prompt carries, if it carries one. Throws on a malformed script. */
export function readSimDirective(text: string): { attempt: SimAttempt; prompt: string } | undefined {
  const m = DIRECTIVE.exec(text);
  if (!m) return undefined;
  const attempt = parseSimAttempt(JSON.parse(m[1]), 'directive');
  return { attempt, prompt: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// Parsing: scenario files are data, so they are checked like data.
// ---------------------------------------------------------------------------

function fail(where: string, what: string): never {
  throw new Error(`simulation scenario: ${where}: ${what}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function optNumber(o: Record<string, unknown>, key: string, where: string): void {
  if (o[key] !== undefined && (typeof o[key] !== 'number' || !Number.isFinite(o[key]) || (o[key] as number) < 0)) {
    fail(where, `${key} must be a non-negative number`);
  }
}

function optString(o: Record<string, unknown>, key: string, where: string): void {
  if (o[key] !== undefined && typeof o[key] !== 'string') fail(where, `${key} must be a string`);
}

/** A worktree-relative path that stays inside the worktree. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '..' && seg !== '') && !p.split('/').includes('.git');
}

export function parseSimStep(raw: unknown, where: string): SimStep {
  if (!isObject(raw)) fail(where, 'must be an object');
  if (!SIM_BEHAVIOURS.includes(raw.behaviour as SimBehaviour)) {
    fail(where, `unknown behaviour ${JSON.stringify(raw.behaviour)} (one of ${SIM_BEHAVIOURS.join(', ')})`);
  }
  if (raw.files !== undefined) {
    if (!isObject(raw.files)) fail(where, 'files must be an object of path → content');
    for (const [p, c] of Object.entries(raw.files)) {
      if (!isSafeRelativePath(p)) fail(where, `file path ${JSON.stringify(p)} must be relative and inside the worktree`);
      if (c !== null && typeof c !== 'string') fail(where, `file ${p} must be a string or null`);
    }
  }
  if (raw.usage !== undefined) {
    if (!isObject(raw.usage)) fail(where, 'usage must be an object');
    for (const k of ['in', 'out']) if (typeof raw.usage[k] !== 'number') fail(where, `usage.${k} must be a number`);
    optNumber(raw.usage, 'cacheRead', where);
    optNumber(raw.usage, 'cacheWrite', where);
  }
  for (const k of ['costUsd', 'turns', 'delayMs', 'outTokPerSec', 'status', 'retryAfterSec']) optNumber(raw, k, where);
  for (const k of ['text', 'signature', 'raw']) optString(raw, k, where);
  if (raw.tool !== undefined && (!isObject(raw.tool) || typeof raw.tool.name !== 'string' || !isObject(raw.tool.input))) {
    fail(where, 'tool must be {name, input}');
  }
  if (raw.question !== undefined && (!isObject(raw.question) || typeof raw.question.question !== 'string')) {
    fail(where, 'question must be {question, header?, options?}');
  }
  return raw as unknown as SimStep;
}

export function parseSimAttempt(raw: unknown, where: string): SimAttempt {
  const step = parseSimStep(raw, where) as SimAttempt;
  if (step.followUps !== undefined) {
    if (!Array.isArray(step.followUps)) fail(where, 'followUps must be an array');
    step.followUps.forEach((f, i) => parseSimStep(f, `${where}.followUps[${i}]`));
  }
  return step;
}

export function parseSimCompletion(raw: unknown, where: string): SimCompletionResponse {
  if (!isObject(raw)) fail(where, 'must be an object');
  const keys = ['output', 'raw', 'retriesExhausted', 'error', 'hang'].filter((k) => k in raw);
  if (keys.length !== 1) fail(where, 'needs exactly one of output, raw, retriesExhausted, error, hang');
  if ('raw' in raw && typeof raw.raw !== 'string') fail(where, 'raw must be a string');
  if ('error' in raw && typeof raw.error !== 'string') fail(where, 'error must be a string');
  return raw as SimCompletionResponse;
}

/** Check a scenario read from JSON. Throws with the path of the first problem. */
export function parseSimScenario(raw: unknown): SimScenario {
  if (!isObject(raw)) fail('scenario', 'must be an object');
  if (raw.tasks !== undefined) {
    if (!isObject(raw.tasks)) fail('tasks', 'must be an object of task id → attempts');
    for (const [task, attempts] of Object.entries(raw.tasks)) {
      if (!Array.isArray(attempts)) fail(`tasks.${task}`, 'must be an array of attempts');
      attempts.forEach((a, i) => parseSimAttempt(a, `tasks.${task}[${i}]`));
    }
  }
  if (raw.default !== undefined) parseSimAttempt(raw.default, 'default');
  if (raw.completions !== undefined) {
    if (!Array.isArray(raw.completions)) fail('completions', 'must be an array');
    raw.completions.forEach((c, i) => parseSimCompletion(c, `completions[${i}]`));
  }
  return raw as SimScenario;
}
