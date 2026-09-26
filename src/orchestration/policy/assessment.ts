/**
 * What the work is like: the assessor's rules, its schema and prompt, and the
 * step that combines the two (`docs/plans/intelligent-orchestration.md` §8;
 * #37).
 *
 * Pure. No fs, no clock, no model: the facts a rule needs about the repository
 * arrive as `ScopeFacts`, gathered by `assessor.ts`, and the model's answer
 * arrives as already-validated JSON. That is what lets every rule and every
 * combination in §8.3 be a table in a test.
 *
 * Three rules shape what is here:
 *
 * - **The assessor never answers "which model?"** (§8.1). Nothing in this file
 *   knows a model name, a tier or an effort level. It describes the work, and
 *   the router (#38) turns that into a requirement.
 * - **A rule beats the model where a rule can know** (§8.3). Risk takes the
 *   higher of the two, because a path rule is a fact about this repository and
 *   the model is guessing from a sentence. Verifiability takes the lower,
 *   because a verifier that is not configured cannot be imagined into
 *   existence. The rest take the model's answer unless a rule had one.
 * - **The code is never sent.** The completion sees the objective, the
 *   criteria, the scope globs and the deterministic facts — a classifier that
 *   reads the repository costs more than the task it is classifying (§8.3).
 */
import type { JsonSchema } from '../completion/jsonSchema';
import type { RepoPolicy } from '../../shared/orchestration/repoPolicy';
import type {
  Ambiguity,
  Assessed,
  AssessmentDimensions,
  Breadth,
  Complexity,
  Confidence,
  ContextLoad,
  Provenance,
  Risk,
  TaskKind,
  TaskScope,
  Verifiability,
  VerificationPlan,
} from '../../shared/orchestration/types';
import { matchesAny, overlapping } from './globs';

/**
 * The prompt and schema below, and the rules in this file, as one version.
 * It is recorded on every assessment, so an assessment made by an older
 * assessor is never mistaken for one this build would make.
 */
export const ASSESSOR_VERSION = 'asm-1';

// ---------------------------------------------------------------------------
// Ordinals
// ---------------------------------------------------------------------------

export const COMPLEXITY_LEVELS: readonly Complexity[] = ['trivial', 'routine', 'involved', 'hard'];
export const BREADTH_LEVELS: readonly Breadth[] = ['single-file', 'few-files', 'subsystem', 'cross-cutting'];
export const RISK_LEVELS: readonly Risk[] = ['low', 'moderate', 'high', 'critical'];
export const AMBIGUITY_LEVELS: readonly Ambiguity[] = ['clear', 'minor-gaps', 'underspecified', 'open-ended'];
export const VERIFIABILITY_LEVELS: readonly Verifiability[] = ['none', 'weak', 'partial', 'strong'];
export const CONTEXT_LOAD_LEVELS: readonly ContextLoad[] = ['small', 'medium', 'large', 'very-large'];
export const CONFIDENCE_LEVELS: readonly Confidence[] = ['low', 'medium', 'high'];

export const TASK_KINDS: readonly TaskKind[] = [
  'docs',
  'test',
  'bugfix',
  'feature',
  'refactor',
  'migration',
  'architecture',
  'investigation',
  'review',
  'chore',
  'conflict-resolution',
  'plan',
];

/** The tool needs a route may have to satisfy (§8.2). `exclusive:<id>` comes from repo policy, never from a model. */
export const REQUIREMENT_TOKENS: readonly string[] = ['edit', 'shell', 'network', 'vision', 'browser'];

function rank<T extends string>(levels: readonly T[], value: T): number {
  const i = levels.indexOf(value);
  return i < 0 ? 0 : i;
}

function higher<T extends string>(levels: readonly T[], a: T, b: T): T {
  return rank(levels, a) >= rank(levels, b) ? a : b;
}

function lower<T extends string>(levels: readonly T[], a: T, b: T): T {
  return rank(levels, a) <= rank(levels, b) ? a : b;
}

/** The weakest of some confidences; an assessment is only as sure as its least sure dimension. */
export function weakest(values: readonly Confidence[]): Confidence {
  return values.reduce<Confidence>((acc, c) => lower(CONFIDENCE_LEVELS, acc, c), 'high');
}

// ---------------------------------------------------------------------------
// What the rules are given
// ---------------------------------------------------------------------------

/** What the deterministic pass knows about the files a task's scope names (§8.2). */
export interface ScopeFacts {
  /**
   * False when the scope could not be resolved: it is empty (nothing has
   * predicted what this task touches yet) or the repository could not be read.
   * Rules that depend on files stay quiet, rather than claiming `single-file`
   * about a task whose scope nobody has written down.
   */
  known: boolean;
  /** Repository-relative paths the scope matched. Capped; `truncated` says so. */
  files: string[];
  truncated: boolean;
  /** Total size of those files. */
  bytes: number;
  /** Distinct directories they live in, and the distinct first segments of those. */
  directories: string[];
  topLevels: string[];
  /** Lowercase, with the dot: `.ts`, `.md`. */
  extensions: string[];
  /** Of `files`, how many look like tests. */
  testFiles: number;
}

export const NO_SCOPE_FACTS: ScopeFacts = Object.freeze({
  known: false,
  files: [],
  truncated: false,
  bytes: 0,
  directories: [],
  topLevels: [],
  extensions: [],
  testFiles: 0,
}) as ScopeFacts;

/** The part of a task the assessor reads. Never the whole `Task`: nothing here may depend on its state. */
export interface AssessedTask {
  objective: string;
  acceptanceCriteria: string[];
  scope: TaskScope;
  kindHint?: TaskKind;
  verification: VerificationPlan;
  createdBy: 'user' | 'planner';
}

export interface RuleInput {
  task: AssessedTask;
  policy: RepoPolicy;
  facts: ScopeFacts;
}

/** What the deterministic pass concluded. Every value here is `from: 'rule'`. */
export interface RulePass {
  /** The dimensions a rule could answer on its own. The rest are the model's to answer. */
  dimensions: Partial<AssessmentDimensions>;
  /** Risk can only ever be raised by the model, never lowered below this (§8.3). */
  riskFloor: Assessed<Risk>;
  /** What the repository is actually configured to check. The ceiling on verifiability (§8.3). */
  configuredVerifiability: Assessed<Verifiability>;
  kind?: Assessed<TaskKind>;
  domains: string[];
  requires: string[];
  evidence: string[];
}

// ---------------------------------------------------------------------------
// The deterministic pass (§8.3 step 1)
// ---------------------------------------------------------------------------

/** Roughly four characters to a token; enough for a band, and never claimed as more. */
const BYTES_PER_TOKEN = 4;
/**
 * What a session spends before it has read a single file in scope: system
 * prompt, memory, tool definitions, and the reading-around every real task
 * does. A fixed allowance, because guessing it per task would be false
 * precision.
 */
const CONTEXT_ALLOWANCE_TOKENS = 20_000;
const CONTEXT_BANDS: readonly { under: number; level: ContextLoad }[] = [
  { under: 30_000, level: 'small' },
  { under: 100_000, level: 'medium' },
  { under: 250_000, level: 'large' },
];

/** Estimated tokens to read everything in scope, plus the fixed allowance. */
export function contextTokens(facts: ScopeFacts): number {
  return Math.round(facts.bytes / BYTES_PER_TOKEN) + CONTEXT_ALLOWANCE_TOKENS;
}

function contextLoadOf(facts: ScopeFacts): Assessed<ContextLoad> {
  if (!facts.known) {
    return {
      value: 'medium',
      confidence: 'low',
      from: 'rule',
      evidence: 'nothing says which files this touches, so its context load is a guess',
    };
  }
  const tokens = contextTokens(facts);
  const band = CONTEXT_BANDS.find((b) => tokens < b.under)?.level ?? 'very-large';
  const about = `${facts.files.length} file${facts.files.length === 1 ? '' : 's'} in scope, about ${Math.round(tokens / 1000)}k tokens to read`;
  return {
    value: band,
    confidence: facts.truncated ? 'medium' : 'high',
    from: 'rule',
    evidence: facts.truncated ? `${about} (scope matched more files than were measured)` : about,
  };
}

function breadthOf(facts: ScopeFacts): Assessed<Breadth> | undefined {
  if (!facts.known || facts.files.length === 0) return undefined;
  const n = facts.files.length;
  const value: Breadth =
    n === 1 ? 'single-file' : facts.topLevels.length > 1 || facts.directories.length > 6 ? 'cross-cutting' : n <= 4 ? 'few-files' : 'subsystem';
  return {
    value,
    confidence: facts.truncated ? 'medium' : 'high',
    from: 'rule',
    evidence: `${n} file${n === 1 ? '' : 's'} across ${facts.directories.length} director${facts.directories.length === 1 ? 'y' : 'ies'}`,
  };
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);

function docsOnly(facts: ScopeFacts): boolean {
  return facts.known && facts.files.length > 0 && facts.extensions.every((e) => DOC_EXTENSIONS.has(e));
}

/** The one complexity a rule may claim: prose, and nothing but prose (§8.2). */
function complexityOf(facts: ScopeFacts): Assessed<Complexity> | undefined {
  if (!docsOnly(facts)) return undefined;
  return { value: 'trivial', confidence: 'medium', from: 'rule', evidence: 'every file in scope is documentation' };
}

function ambiguityOf(task: AssessedTask): Assessed<Ambiguity> | undefined {
  if (task.acceptanceCriteria.length > 0) return undefined;
  return {
    value: 'underspecified',
    confidence: 'medium',
    from: 'rule',
    evidence: 'the task has no acceptance criteria, so nothing says when it is done',
  };
}

/** Risk floors from the repository's own path rules. The highest rule that could touch the scope wins. */
export function riskFloorOf(policy: RepoPolicy, task: AssessedTask, facts: ScopeFacts): Assessed<Risk> {
  let best: { level: Risk; why: string } | undefined;
  let exact = false;
  for (const rule of policy.risk) {
    const hitFile = facts.known && facts.files.some((f) => matchesAny(f, rule.paths));
    const hitGlob = !hitFile && overlapping(rule.paths, task.scope.paths).length > 0;
    if (!hitFile && !hitGlob) continue;
    if (!best || rank(RISK_LEVELS, rule.level) > rank(RISK_LEVELS, best.level)) {
      best = { level: rule.level, why: rule.why };
      exact = hitFile;
    } else if (rule.level === best.level && hitFile) {
      exact = true;
    }
  }
  if (!best) return { value: 'low', confidence: 'low', from: 'rule', evidence: 'no repository risk path matches this scope' };
  return {
    value: best.level,
    confidence: exact ? 'high' : 'medium',
    from: 'rule',
    evidence: `repository risk path: ${best.why}`,
  };
}

/** Does this command look like it actually checks behaviour, rather than formatting it? */
const TEST_COMMAND = /(^|-)(test|tests|spec|e2e|integration|check|verify)(-|$)/;

/**
 * What the repository is configured to check, which is the ceiling on
 * verifiability (§8.3). A task whose plan names commands is judged on those;
 * a task with no plan of its own is judged on what the repository has, one
 * band lower, because nothing has said those commands cover this work.
 */
export function configuredVerifiabilityOf(policy: RepoPolicy, task: AssessedTask): Assessed<Verifiability> {
  const commands = Object.keys(policy.verification.commands);
  if (commands.length === 0) {
    return {
      value: 'none',
      confidence: 'high',
      from: 'rule',
      evidence: 'the repository policy configures no verification commands',
    };
  }
  const planned = task.verification.stages
    .map((s) => /^command:([a-z][a-z0-9-]*)$/.exec(s.strategy)?.[1])
    .filter((n): n is string => Boolean(n) && commands.includes(n!));
  if (planned.length > 0) {
    const behavioural = planned.some((n) => TEST_COMMAND.test(n));
    const value: Verifiability = behavioural && planned.length > 1 ? 'strong' : behavioural ? 'partial' : 'weak';
    return { value, confidence: 'high', from: 'rule', evidence: `the task plans ${planned.map((n) => `\`${n}\``).join(', ')}` };
  }
  const behavioural = commands.some((n) => TEST_COMMAND.test(n));
  return {
    value: behavioural ? 'partial' : 'weak',
    confidence: 'medium',
    from: 'rule',
    evidence: `the repository has ${commands.length} verification command${commands.length === 1 ? '' : 's'}, but this task plans none`,
  };
}

/** Verbs in an objective that name a kind outright. Order matters: the first match wins. */
const KIND_PATTERNS: readonly { kind: TaskKind; re: RegExp }[] = [
  { kind: 'migration', re: /\b(migrat\w*|backfill|data model change|schema change)\b/i },
  { kind: 'architecture', re: /\b(architect\w*|redesign|re-?design|restructure)\b/i },
  { kind: 'investigation', re: /\b(investigat\w*|diagnos\w*|root cause|find out why|work out why|reproduce)\b/i },
  { kind: 'conflict-resolution', re: /\b(merge conflict|resolve conflicts?|rebase conflict)\b/i },
  { kind: 'refactor', re: /\b(refactor\w*|extract|rename|de-?duplicate|tidy up|clean up)\b/i },
  { kind: 'bugfix', re: /\b(fix|bug|broken|regression|crash|off-?by-?one|wrong)\b/i },
  { kind: 'test', re: /\b(add|write|cover)\w*\s+(a\s+)?(unit\s+|regression\s+)?tests?\b/i },
  { kind: 'review', re: /\b(review|audit)\b/i },
  { kind: 'docs', re: /\b(document|docs?|readme|changelog)\b/i },
  { kind: 'chore', re: /\b(bump|upgrade the dependency|lint|format|chore)\b/i },
];

function kindOf(task: AssessedTask, facts: ScopeFacts): Assessed<TaskKind> | undefined {
  if (task.kindHint) {
    return {
      value: task.kindHint,
      confidence: 'high',
      from: task.createdBy === 'planner' ? 'planner' : 'user',
      evidence: 'the kind was set on the task',
    };
  }
  if (docsOnly(facts)) {
    return { value: 'docs', confidence: 'medium', from: 'rule', evidence: 'every file in scope is documentation' };
  }
  if (facts.known && facts.files.length > 0 && facts.testFiles === facts.files.length) {
    return { value: 'test', confidence: 'medium', from: 'rule', evidence: 'every file in scope is a test' };
  }
  const hit = KIND_PATTERNS.find((p) => p.re.test(task.objective));
  // A verb is a hint, not a fact: the model sees the whole objective and may disagree.
  return hit ? { value: hit.kind, confidence: 'low', from: 'rule', evidence: `the objective says "${hit.re.source.slice(2, 20)}…"` } : undefined;
}

/** Extensions and repository tags a route may need to care about (§8.2). */
const DOMAIN_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.css': 'ui',
  '.html': 'ui',
  '.md': 'docs',
  '.mdx': 'docs',
  '.json': 'config',
  '.yml': 'config',
  '.yaml': 'config',
  '.sql': 'db',
  '.py': 'python',
  '.cs': 'csharp',
  '.shader': 'shader',
  '.hlsl': 'shader',
  '.unity': 'unity',
  '.prefab': 'unity',
  '.sh': 'shell',
  '.rs': 'rust',
  '.go': 'go',
};

function domainsOf(facts: ScopeFacts): string[] {
  const out = new Set<string>();
  for (const e of facts.extensions) {
    const d = DOMAIN_BY_EXTENSION[e];
    if (d) out.add(d);
  }
  return [...out].sort();
}

/**
 * Hard needs a rule knows: an agent that edits a repository needs to edit and
 * to run things, and the repository's own exclusive resources are needed by
 * whoever touches their paths (§13.5).
 */
function requiresOf(policy: RepoPolicy, task: AssessedTask, facts: ScopeFacts): string[] {
  const out = new Set<string>(['edit', 'shell']);
  for (const r of policy.exclusive) {
    if (!r.paths) {
      out.add(`exclusive:${r.id}`);
      continue;
    }
    const hitFile = facts.known && facts.files.some((f) => matchesAny(f, r.paths!));
    if (hitFile || overlapping(r.paths, task.scope.paths).length > 0) out.add(`exclusive:${r.id}`);
  }
  return [...out].sort();
}

/** The rules of §8.2, all of them, over facts nobody had to pay a model for. */
export function deterministicPass(input: RuleInput): RulePass {
  const { task, policy, facts } = input;
  const riskFloor = riskFloorOf(policy, task, facts);
  const configuredVerifiability = configuredVerifiabilityOf(policy, task);
  const dimensions: Partial<AssessmentDimensions> = { contextLoad: contextLoadOf(facts) };
  const breadth = breadthOf(facts);
  if (breadth) dimensions.breadth = breadth;
  const complexity = complexityOf(facts);
  if (complexity) dimensions.complexity = complexity;
  const ambiguity = ambiguityOf(task);
  if (ambiguity) dimensions.ambiguity = ambiguity;
  const kind = kindOf(task, facts);
  const evidence: string[] = [];
  if (riskFloor.value !== 'low') evidence.push(riskFloor.evidence!);
  if (facts.truncated) evidence.push('the scope matched more files than were measured; the file counts are a floor');
  return {
    dimensions,
    riskFloor,
    configuredVerifiability,
    kind,
    domains: domainsOf(facts),
    requires: requiresOf(policy, task, facts),
    evidence,
  };
}

// ---------------------------------------------------------------------------
// The completion (§8.3 step 2)
// ---------------------------------------------------------------------------

/** One dimension as the model answers it. */
export interface ModelDimension<T extends string> {
  value: T;
  confidence: Confidence;
  evidence: string;
}

export interface ModelAnswer {
  complexity: ModelDimension<Complexity>;
  breadth: ModelDimension<Breadth>;
  risk: ModelDimension<Risk>;
  ambiguity: ModelDimension<Ambiguity>;
  verifiability: ModelDimension<Verifiability>;
  kind: ModelDimension<TaskKind>;
  domains: string[];
  requires: string[];
}

function dimensionSchema(levels: readonly string[], description: string): JsonSchema {
  return {
    type: 'object',
    description,
    additionalProperties: false,
    required: ['value', 'confidence', 'evidence'],
    properties: {
      value: { type: 'string', enum: [...levels] },
      confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
      evidence: { type: 'string', minLength: 1, maxLength: 200, description: 'one short line saying why' },
    },
  };
}

/**
 * What the completion must answer with. `contextLoad` is not in it: it is
 * arithmetic over file sizes, and asking a model to guess a number it cannot
 * see would only add noise (§8.2).
 */
export function assessmentSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['complexity', 'breadth', 'risk', 'ambiguity', 'verifiability', 'kind', 'domains', 'requires'],
    properties: {
      complexity: dimensionSchema(COMPLEXITY_LEVELS, 'depth of reasoning the work needs'),
      breadth: dimensionSchema(BREADTH_LEVELS, 'how much of the repository it touches'),
      risk: dimensionSchema(RISK_LEVELS, 'cost of a mistake nobody catches'),
      ambiguity: dimensionSchema(AMBIGUITY_LEVELS, 'how underspecified the task is'),
      verifiability: dimensionSchema(VERIFIABILITY_LEVELS, 'how well a machine could check the result'),
      kind: dimensionSchema(TASK_KINDS, 'what kind of work this is'),
      domains: {
        type: 'array',
        maxItems: 8,
        description: 'lowercase tags such as typescript, ui, db, shader',
        items: { type: 'string', minLength: 1, maxLength: 32 },
      },
      requires: {
        type: 'array',
        maxItems: 5,
        description: `only from: ${REQUIREMENT_TOKENS.join(', ')}`,
        items: { type: 'string', enum: [...REQUIREMENT_TOKENS] },
      },
    },
  };
}

export const ASSESSOR_INSTRUCTIONS = [
  'You describe software tasks so an orchestrator can decide how much capability each one needs.',
  '',
  'You never choose a model, a tier or an effort level, and you never name one. You answer only the dimensions asked for.',
  'You are given a task and facts a tool already established about the repository. You are not given the code, so judge from the objective, the acceptance criteria and those facts, and say so in your evidence when you are guessing.',
  '',
  'The levels mean:',
  '- complexity: trivial (mechanical) · routine (one obvious way) · involved (design decisions) · hard (subtle, easy to get wrong)',
  '- breadth: single-file · few-files · subsystem (one area) · cross-cutting (several areas)',
  '- risk: how expensive a mistake is if nobody catches it. low · moderate · high · critical (data loss, a format others depend on, secrets, money)',
  '- ambiguity: clear · minor-gaps · underspecified · open-ended (someone must decide what to build first)',
  '- verifiability: how well a machine could check the result. none · weak · partial · strong',
  '',
  'Use `low` confidence freely: an honest "I am guessing" routes better than a confident wrong answer.',
].join('\n');

/** The completion's input: the task, and the facts. Never the code (§8.3). */
export function assessorInput(input: RuleInput): string {
  const { task, facts } = input;
  const lines: string[] = ['TASK OBJECTIVE', task.objective.trim(), ''];
  lines.push('ACCEPTANCE CRITERIA');
  lines.push(task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') : '(none given)');
  lines.push('');
  lines.push('SCOPE (globs predicted for this task)');
  lines.push(task.scope.paths.length > 0 ? task.scope.paths.map((p) => `- ${p}`).join('\n') : '(not predicted)');
  if (task.scope.subsystems.length > 0) lines.push(`Subsystems: ${task.scope.subsystems.join(', ')}`);
  lines.push('');
  lines.push('ESTABLISHED FACTS');
  const rules = deterministicPass(input);
  if (facts.known && facts.files.length > 0) {
    lines.push(
      `- ${facts.files.length}${facts.truncated ? '+' : ''} files in scope, ${facts.directories.length} directories, about ${Math.round(contextTokens(facts) / 1000)}k tokens to read`,
    );
    lines.push(`- File types: ${facts.extensions.join(', ') || 'unknown'}`);
    lines.push(`- Sample: ${facts.files.slice(0, 12).join(', ')}`);
  } else {
    lines.push('- Nothing predicts which files this touches.');
  }
  lines.push(`- Configured verification: ${rules.configuredVerifiability.value} — ${rules.configuredVerifiability.evidence}`);
  lines.push(`- Repository risk paths: ${rules.riskFloor.value === 'low' ? 'none match this scope' : rules.riskFloor.evidence}`);
  if (task.kindHint) lines.push(`- The task says its kind is ${task.kindHint}.`);
  lines.push('');
  lines.push('Answer with JSON matching the schema.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Combining (§8.3 step 3)
// ---------------------------------------------------------------------------

/** A dimension a person set in plan review. A user edit wins over both a rule and the model. */
export interface UserEdits {
  complexity?: Complexity;
  breadth?: Breadth;
  risk?: Risk;
  ambiguity?: Ambiguity;
  verifiability?: Verifiability;
  contextLoad?: ContextLoad;
  kind?: TaskKind;
  domains?: string[];
  requires?: string[];
}

export interface Combined {
  dimensions: AssessmentDimensions;
  kind: Assessed<TaskKind>;
  domains: string[];
  requires: string[];
  confidence: Confidence;
  evidence: string[];
}

function fromModel<T extends string>(d: ModelDimension<T>): Assessed<T> {
  return { value: d.value, confidence: d.confidence, from: 'model', evidence: d.evidence.slice(0, 200) };
}

function userValue<T extends string>(value: T): Assessed<T> {
  return { value, confidence: 'high', from: 'user', evidence: 'set by the user' };
}

/** The model's answer for a dimension no rule claimed, or a conservative default when there is none. */
function pick<T extends string>(
  levels: readonly T[],
  fallback: T,
  rule: Assessed<T> | undefined,
  model: ModelDimension<T> | undefined,
  user: T | undefined,
  why: string,
): Assessed<T> {
  if (user !== undefined) return userValue(user);
  if (rule) return rule;
  if (model) return fromModel(model);
  return { value: fallback, confidence: 'low', from: 'rule', evidence: why };
}

const NO_MODEL = 'no model answer; assessed from rules alone';

/**
 * Rules, the model's answer and the user's edits into one assessment (§8.3
 * step 3). Called with `model: undefined` when the completion failed, which
 * is what "an invalid answer yields a heuristics-only assessment at low
 * confidence" means: every dimension the model would have answered falls back
 * to a safe level at `low`, and the whole assessment is `low`.
 */
export function combine(rules: RulePass, model: ModelAnswer | undefined, edits: UserEdits = {}): Combined {
  const d = rules.dimensions;

  // Risk: the higher of the rule floor and the model. A path rule can never be talked down (§8.3).
  let risk: Assessed<Risk>;
  if (edits.risk !== undefined) risk = userValue(edits.risk);
  else if (!model) risk = rules.riskFloor;
  else {
    const m = fromModel(model.risk);
    const value = higher(RISK_LEVELS, rules.riskFloor.value, m.value);
    risk =
      value === rules.riskFloor.value && rules.riskFloor.value !== m.value
        ? { ...rules.riskFloor, evidence: `${rules.riskFloor.evidence} (the model said ${m.value})` }
        : { ...m, confidence: value === rules.riskFloor.value && rules.riskFloor.confidence === 'high' ? 'high' : m.confidence };
  }

  // Verifiability: the lower of what is configured and what the model imagines (§8.3).
  let verifiability: Assessed<Verifiability>;
  if (edits.verifiability !== undefined) verifiability = userValue(edits.verifiability);
  else if (!model) verifiability = rules.configuredVerifiability;
  else {
    const m = fromModel(model.verifiability);
    const value = lower(VERIFIABILITY_LEVELS, rules.configuredVerifiability.value, m.value);
    verifiability =
      value === rules.configuredVerifiability.value && value !== m.value
        ? { ...rules.configuredVerifiability, evidence: `${rules.configuredVerifiability.evidence} (the model said ${m.value})` }
        : m;
  }

  const dimensions: AssessmentDimensions = {
    complexity: pick(COMPLEXITY_LEVELS, 'involved', d.complexity, model?.complexity, edits.complexity, NO_MODEL),
    breadth: pick(BREADTH_LEVELS, 'subsystem', d.breadth, model?.breadth, edits.breadth, NO_MODEL),
    risk,
    ambiguity: pick(AMBIGUITY_LEVELS, 'minor-gaps', d.ambiguity, model?.ambiguity, edits.ambiguity, NO_MODEL),
    verifiability,
    contextLoad: edits.contextLoad !== undefined ? userValue(edits.contextLoad) : d.contextLoad ?? contextLoadOf(NO_SCOPE_FACTS),
  };

  const kind = pick(TASK_KINDS, 'feature', rules.kind, model?.kind, edits.kind, NO_MODEL);
  const domains = edits.domains ?? [...new Set([...rules.domains, ...(model?.domains ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean)])].sort();
  // A model may only add tool needs it is allowed to name; `exclusive:` comes from policy alone.
  const requires =
    edits.requires ?? [...new Set([...rules.requires, ...(model?.requires ?? []).filter((r) => REQUIREMENT_TOKENS.includes(r))])].sort();

  const evidence = [...rules.evidence];
  if (!model) evidence.push('the assessment model call did not produce a usable answer; this is a rules-only assessment');

  const confidence = model
    ? weakest(Object.values(dimensions).map((x) => x.confidence))
    : 'low';

  return { dimensions, kind, domains, requires, confidence, evidence };
}

// ---------------------------------------------------------------------------
// Caching (§8.3 step 4)
// ---------------------------------------------------------------------------

/** Everything that would change the answer. A change to any of it is a new assessment. */
export interface AssessmentInputs {
  objective: string;
  acceptanceCriteria: string[];
  scope: TaskScope;
  kindHint?: TaskKind;
  verification: VerificationPlan;
  /** The repository policy the rules ran against (`LoadedRepoPolicy.version`). */
  repoPolicyVersion: string;
  /** The results this task's upstream produced, newest state included: a changed upstream is new input. */
  upstream: string[];
}

/** FNV-1a over the inputs, in a fixed order, with the assessor's own version. */
export function inputsHash(inputs: AssessmentInputs): string {
  const basis = JSON.stringify([
    ASSESSOR_VERSION,
    inputs.objective.trim(),
    inputs.acceptanceCriteria,
    [...inputs.scope.paths].sort(),
    [...inputs.scope.subsystems].sort(),
    inputs.kindHint ?? null,
    inputs.verification.stages.map((s) => [s.strategy, s.required]),
    inputs.repoPolicyVersion,
    [...inputs.upstream].sort(),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `asm-${h.toString(16).padStart(8, '0')}`;
}

/** The provenance order the UI reads: where a value came from, in words. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  rule: 'rule',
  model: 'model',
  planner: 'planner',
  user: 'you',
};
