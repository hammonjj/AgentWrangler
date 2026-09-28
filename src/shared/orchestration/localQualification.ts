/**
 * Stage 2 of local-model qualification (`docs/plans/intelligent-orchestration.md`
 * §19.6, built §19.9): scratch-repo tasks, each run k = 3 times through the
 * harness and endpoint the model would be routed through. This file is the
 * part with rules in it: what a fixture declares, the three checks a run must
 * pass, and how runs become the result shown beside the tier picker.
 *
 * The three checks, all on what is in the scratch repo after the run, never
 * on what the agent says:
 * 1. **Tests pass**: the fixture's check command exits 0.
 * 2. **Tests untouched**: no protected path was modified, added or deleted.
 * 3. **Diff inside the allowed paths**: every changed path matches one of them.
 *
 * Results are `measured` facts, like stage 1's. They never set a tier.
 *
 * Pure and shared: the runner applies these, Preferences renders the text.
 */
import type { Millis } from './types';

/** `fixture.json` beside a fixture's `repo/`. */
export interface TaskFixture {
  /** `[a-z0-9-]`, the fixture directory's name. */
  id: string;
  title: string;
  /** The task, as the agent is given it. Synthetic. */
  prompt: string;
  /** argv, run in the repo root. `node` is run as the app's own Node. */
  check: string[];
  /** Paths the agent must not change (the tests). Patterns as in `pathMatches`. */
  protected: string[];
  /** Paths the agent may change. Anything else changed fails the run. */
  allowed: string[];
}

/** Why a fixture manifest cannot be used, or the fixture. */
export function parseFixture(raw: unknown, id: string): { ok: true; fixture: TaskFixture } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${id}: fixture.json is not an object` };
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim() !== '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: `${id}: the directory name is not a fixture id` };
  if (typeof r.title !== 'string' || !r.title.trim()) return { ok: false, error: `${id}: no title` };
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) return { ok: false, error: `${id}: no prompt` };
  if (!strings(r.check)) return { ok: false, error: `${id}: check must be a non-empty argv` };
  if (!strings(r.protected)) return { ok: false, error: `${id}: protected must list the test paths` };
  if (!strings(r.allowed)) return { ok: false, error: `${id}: allowed must list the paths the agent may change` };
  const all = [...(r.protected as string[]), ...(r.allowed as string[])];
  if (all.some((p) => p.startsWith('/') || p.split('/').includes('..'))) return { ok: false, error: `${id}: paths are relative to the repo, without ..` };
  return {
    ok: true,
    fixture: { id, title: r.title.trim(), prompt: r.prompt.trim(), check: r.check as string[], protected: r.protected as string[], allowed: r.allowed as string[] },
  };
}

/**
 * Whether a repo-relative path matches a pattern: an exact path, `dir/**`
 * (everything under `dir`), or `*` within one segment (`src/*.js`).
 */
export function pathMatches(path: string, pattern: string): boolean {
  const p = path.replace(/^\.\//, '');
  const pat = pattern.replace(/^\.\//, '');
  if (pat.endsWith('/**')) {
    const dir = pat.slice(0, -3);
    return p === dir || p.startsWith(`${dir}/`);
  }
  if (!pat.includes('*')) return p === pat;
  const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return re.test(p);
}

/**
 * Paths changed in a work tree, from `git status --porcelain=v1 -z
 * --untracked-files=all`. A rename or copy contributes both paths: moving a
 * test away is touching it.
 */
export function changedPaths(porcelainZ: string): string[] {
  const out = new Set<string>();
  const fields = porcelainZ.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    out.add(f.slice(3));
    // In -z form the source of a rename or copy is the next field.
    if ((xy.includes('R') || xy.includes('C')) && i + 1 < fields.length) out.add(fields[++i]);
  }
  return [...out].sort();
}

export interface CheckResult {
  ok: boolean;
  /** Why not, when not. Paths only: they are the fixture's, never a real project's. */
  detail?: string;
}

/** Check 1: the fixture's check command exited 0. A command that never ran or timed out is not a pass. */
export function testsPass(r: { code: number; failure?: 'timeout' | 'spawn' }): CheckResult {
  if (r.failure === 'timeout') return { ok: false, detail: 'the check timed out' };
  if (r.failure === 'spawn') return { ok: false, detail: 'the check could not be started' };
  return r.code === 0 ? { ok: true } : { ok: false, detail: `the check exited ${r.code}` };
}

/** Check 2: no protected path is among the changed ones. */
export function testsUntouched(changed: readonly string[], protectedPaths: readonly string[]): CheckResult {
  const hit = changed.filter((c) => protectedPaths.some((p) => pathMatches(c, p)));
  return hit.length === 0 ? { ok: true } : { ok: false, detail: `changed a test file: ${hit.join(', ')}` };
}

/** Check 3: every changed path is inside the allowed ones. */
export function diffInsideAllowed(changed: readonly string[], allowed: readonly string[]): CheckResult {
  const outside = changed.filter((c) => !allowed.some((a) => pathMatches(c, a)));
  return outside.length === 0 ? { ok: true } : { ok: false, detail: `changed outside the allowed paths: ${outside.join(', ')}` };
}

/** One run of one fixture. */
export interface TaskRun {
  fixture: string;
  /** 1…k. */
  n: number;
  pass: boolean;
  testsPass: boolean;
  testsUntouched: boolean;
  diffInside: boolean;
  /** Why it failed: the first failed check's detail, or what stopped the run. */
  failure?: string;
  /** The run was stopped by something that is not the model: the server went away, the harness failed. */
  infra?: boolean;
  /** Harness turns that ended. */
  turns: number;
  /** Tool calls the agent made. */
  toolCalls: number;
  wallMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Stage 2's result for one model, as stored beside stage 1's. */
export type TaskQualification =
  | {
      model: string;
      at: Millis;
      runnable: true;
      k: number;
      runs: TaskRun[];
      passed: number;
      /** Mean per run. */
      avgTurns: number;
      avgWallMs: number;
      inputTokens: number;
      outputTokens: number;
      /** Why it stopped early, when it did. Runs up to then are kept. */
      error?: string;
    }
  | {
      model: string;
      at: Millis;
      runnable: false;
      /** "no /v1/responses". No pass rate is recorded. */
      reason: string;
    };

/** The three checks applied to one run's evidence. */
export function judgeRun(
  fixture: TaskFixture,
  evidence: { check: { code: number; failure?: 'timeout' | 'spawn' }; changed: readonly string[] },
): Pick<TaskRun, 'pass' | 'testsPass' | 'testsUntouched' | 'diffInside' | 'failure'> {
  const t = testsPass(evidence.check);
  const u = testsUntouched(evidence.changed, fixture.protected);
  const d = diffInsideAllowed(evidence.changed, fixture.allowed);
  const failure = [t, u, d].find((c) => !c.ok)?.detail;
  return { pass: t.ok && u.ok && d.ok, testsPass: t.ok, testsUntouched: u.ok, diffInside: d.ok, ...(failure ? { failure } : {}) };
}

/** Runs into the stored result. */
export function summariseTaskRuns(model: string, at: Millis, k: number, runs: readonly TaskRun[], error?: string): TaskQualification {
  const n = runs.length;
  const mean = (f: (r: TaskRun) => number) => (n === 0 ? 0 : Math.round(runs.reduce((s, r) => s + f(r), 0) / n));
  return {
    model,
    at,
    runnable: true,
    k,
    runs: [...runs],
    passed: runs.filter((r) => r.pass).length,
    avgTurns: n === 0 ? 0 : Math.round((runs.reduce((s, r) => s + r.turns, 0) / n) * 10) / 10,
    avgWallMs: mean((r) => r.wallMs),
    inputTokens: runs.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
    ...(error ? { error } : {}),
  };
}

function secs(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 100) / 10} s`;
}

/** "Tasks 7/12 passed (measured) · per fixture 3/3, 2/3, … · 4.3 turns · 48 s · 81k tokens", or why it could not run. */
export function taskQualificationText(q: TaskQualification): string {
  if (!q.runnable) return `Tasks: not runnable: ${q.reason}`;
  const byFixture = new Map<string, { pass: number; runs: number }>();
  for (const r of q.runs) {
    const f = byFixture.get(r.fixture) ?? { pass: 0, runs: 0 };
    f.runs++;
    if (r.pass) f.pass++;
    byFixture.set(r.fixture, f);
  }
  const parts = [
    `Tasks ${q.passed}/${q.runs.length} passed (k=${q.k}, measured)`,
    ...(byFixture.size > 0 ? [[...byFixture].map(([id, f]) => `${id} ${f.pass}/${f.runs}`).join(', ')] : []),
    `${q.avgTurns} turns`,
    secs(q.avgWallMs),
    `${q.inputTokens + q.outputTokens} tokens`,
  ];
  const first = q.runs.find((r) => !r.pass && r.failure);
  const tail = q.error ? ` · stopped: ${q.error}` : first ? ` · first failure: ${first.fixture} #${first.n}, ${first.failure}` : '';
  return `${parts.join(' · ')}${tail}`;
}

/** A stored result read back: trust nothing. */
export function parseTaskQualification(raw: unknown): TaskQualification | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.model !== 'string' || typeof q.at !== 'number') return undefined;
  if (q.runnable === false) return typeof q.reason === 'string' ? { model: q.model, at: q.at, runnable: false, reason: q.reason } : undefined;
  if (q.runnable !== true || !Array.isArray(q.runs) || typeof q.k !== 'number' || typeof q.passed !== 'number') return undefined;
  return raw as TaskQualification;
}
