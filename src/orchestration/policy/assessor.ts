/**
 * The assessor (`docs/plans/intelligent-orchestration.md` §8; #37): rules
 * first, then one cheap structured call, then the combination of the two, so
 * every task carries a description of what the work is like.
 *
 * What this file adds to the pure rules in `assessment.ts` is the three things
 * they cannot have: the repository on disk (to size a scope), the model (one
 * `basic`-tier, `low`-effort completion) and a cache.
 *
 * Two promises it keeps:
 *
 * - **Assessment never blocks a task** (§8.3). Every failure — no completion
 *   configured, an API error, output that is not schema-valid after the
 *   retry, a timeout, an unreadable repository — ends in a rules-only
 *   assessment at `confidence: low`, which routes conservatively. `assess`
 *   does not reject.
 * - **The model never lowers a risk a rule raised, and never invents a
 *   verifier.** That is `combine`'s job, and it is why the rule pass runs
 *   first and is passed in whole.
 */
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type { RepoPolicy } from '../../shared/orchestration/repoPolicy';
import type { TaskAssessment } from '../../shared/orchestration/types';
import type { StructuredCompletion } from '../completion/structuredCompletion';
import { ulid } from '../domain/ids';
import {
  ASSESSOR_INSTRUCTIONS,
  ASSESSOR_VERSION,
  NO_SCOPE_FACTS,
  assessmentSchema,
  assessorInput,
  combine,
  deterministicPass,
  inputsHash,
  type AssessedTask,
  type ModelAnswer,
  type RuleInput,
  type ScopeFacts,
  type UserEdits,
} from './assessment';
import { matchesAny } from './globs';

/** The effort an assessment runs at: the cheapest deliberation, on the cheapest model (§8.3). */
export const ASSESSOR_EFFORT = 'low';
/** A classifier that takes longer than this has already cost more than the answer is worth. */
const DEFAULT_TIMEOUT_MS = 45_000;
/** Enough files to size a scope; past this the counts are reported as a floor. */
const MAX_FILES = 2_000;
/** How deep into a repository the walk goes before it stops looking. */
const MAX_DEPTH = 12;
/** Assessments kept by inputs hash. A mission has a handful of tasks; this is generous. */
const CACHE_LIMIT = 64;

/** Directories a scope walk never descends into: none of them is source. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'Library',
  'Temp',
  'obj',
  'bin',
  '__pycache__',
  '.venv',
  'venv',
]);

const TEST_FILE = /(^|[./\\-])(test|tests|spec|__tests__)([./\\-]|$)/i;

export interface AssessorFs {
  readdirSync(dir: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean; isFile(): boolean }[];
  statSync(file: string): { size: number; isFile(): boolean };
}

export interface AssessorDeps {
  /** How the one structured call is made. Absent: every assessment is rules-only (§8.3). */
  completion?: StructuredCompletion;
  fs?: AssessorFs;
  /** The model the call runs on. Absent: the completion's own cheapest default. */
  model?: string;
  effort?: string;
  timeoutMs?: number;
  now?: () => number;
  id?: () => string;
  log?: (msg: string) => void;
}

export interface AssessRequest {
  taskId: string;
  taskRevision: number;
  task: AssessedTask;
  /** The primary checkout, which the scope globs are relative to. */
  repoRoot: string;
  policy: RepoPolicy;
  /** `LoadedRepoPolicy.version`: part of the inputs, so a policy edit re-assesses. */
  repoPolicyVersion: string;
  /** Result commits of this task's upstream: a changed upstream is a changed input (§8.3). */
  upstream?: string[];
  /** What a person set in plan review. Wins over both a rule and the model. */
  edits?: UserEdits;
  signal?: AbortSignal;
}

/**
 * Sizes a scope against the repository: which files its globs name, how big
 * they are, and where they live. A scope with no globs is not walked at all —
 * `known: false` says "nobody has predicted what this touches", which is a
 * different thing from "it touches nothing".
 */
export function scopeFacts(repoRoot: string, globs: readonly string[], fs: AssessorFs = nodeFs): ScopeFacts {
  if (globs.length === 0) return NO_SCOPE_FACTS;
  const files: string[] = [];
  let bytes = 0;
  let truncated = false;
  const dirs = new Set<string>();
  const tops = new Set<string>();
  const exts = new Set<string>();
  let testFiles = 0;

  const take = (rel: string, size: number): void => {
    files.push(rel);
    bytes += size;
    const dir = path.posix.dirname(rel);
    dirs.add(dir === '.' ? '' : dir);
    tops.add(rel.split('/')[0]);
    const ext = path.posix.extname(rel).toLowerCase();
    if (ext) exts.add(ext);
    if (TEST_FILE.test(rel)) testFiles++;
  };

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries: ReturnType<AssessorFs['readdirSync']>;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && matchesAny(childRel, globs)) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        try {
          take(childRel, fs.statSync(path.join(dir, e.name)).size);
        } catch {
          take(childRel, 0);
        }
      }
    }
  };

  try {
    walk(repoRoot, '', 0);
  } catch {
    return NO_SCOPE_FACTS;
  }
  // Globs that named nothing we could see: "this touches no files" and "the
  // repository could not be read" look identical from here, and claiming the
  // first would let a rule call an unreadable repository a single-file task.
  if (files.length === 0) return NO_SCOPE_FACTS;
  return {
    known: true,
    files,
    truncated,
    bytes,
    directories: [...dirs].sort(),
    topLevels: [...tops].sort(),
    extensions: [...exts].sort(),
    testFiles,
  };
}

export class Assessor {
  private readonly cache = new Map<string, TaskAssessment>();

  constructor(private readonly deps: AssessorDeps = {}) {}

  private id(): string {
    return this.deps.id?.() ?? ulid(this.now(), (n) => randomBytes(n));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Assess a task. Resolves with an assessment whatever happens: a failed or
   * invalid completion gives the rules-only one at `low` confidence, and the
   * caller records it and carries on (§8.3).
   */
  async assess(req: AssessRequest): Promise<TaskAssessment> {
    const hash = inputsHash({
      objective: req.task.objective,
      acceptanceCriteria: req.task.acceptanceCriteria,
      scope: req.task.scope,
      kindHint: req.task.kindHint,
      verification: req.task.verification,
      repoPolicyVersion: req.repoPolicyVersion,
      upstream: req.upstream ?? [],
    });
    // A user edit is the user's, not the cache's: it always makes a new record.
    const edited = req.edits !== undefined && Object.keys(req.edits).length > 0;
    const hit = edited ? undefined : this.cache.get(hash);
    if (hit && hit.taskId === req.taskId && hit.taskRevision === req.taskRevision) return hit;

    const facts = this.facts(req);
    const input: RuleInput = { task: req.task, policy: req.policy, facts };
    const rules = deterministicPass(input);
    const answer = await this.ask(input, req.signal);
    const c = combine(rules, answer.value, req.edits);
    const assessment: TaskAssessment = {
      id: this.id(),
      taskId: req.taskId,
      taskRevision: req.taskRevision,
      inputsHash: hash,
      assessorVersion: ASSESSOR_VERSION,
      dimensions: c.dimensions,
      kind: c.kind,
      domains: c.domains,
      requires: c.requires,
      confidence: c.confidence,
      evidence: c.evidence,
      ...(answer.llm ? { llm: answer.llm } : {}),
      createdAt: this.now(),
    };
    if (!edited) this.remember(hash, assessment);
    return assessment;
  }

  private facts(req: AssessRequest): ScopeFacts {
    try {
      return scopeFacts(req.repoRoot, req.task.scope.paths, this.deps.fs ?? nodeFs);
    } catch (e) {
      this.deps.log?.(`assessor: could not size the scope: ${e instanceof Error ? e.message : String(e)}`);
      return NO_SCOPE_FACTS;
    }
  }

  /** The one completion. Never throws: a failure is an absent answer, and the rules stand alone. */
  private async ask(
    input: RuleInput,
    signal: AbortSignal | undefined,
  ): Promise<{ value?: ModelAnswer; llm?: { completionId: string; model: string } }> {
    const completion = this.deps.completion;
    if (!completion) return {};
    try {
      const r = await completion.complete<ModelAnswer>({
        schema: assessmentSchema(),
        instructions: ASSESSOR_INSTRUCTIONS,
        input: assessorInput(input),
        ...(this.deps.model ? { model: this.deps.model } : {}),
        effort: this.deps.effort ?? ASSESSOR_EFFORT,
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (r.ok) return { value: r.value, llm: { completionId: this.id(), model: r.model } };
      this.deps.log?.(`assessor: the completion failed (${r.reason}): ${r.message}; assessing from rules alone`);
      return {};
    } catch (e) {
      this.deps.log?.(`assessor: the completion threw: ${e instanceof Error ? e.message : String(e)}; assessing from rules alone`);
      return {};
    }
  }

  private remember(hash: string, assessment: TaskAssessment): void {
    this.cache.set(hash, assessment);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
