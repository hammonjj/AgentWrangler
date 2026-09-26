/**
 * The routing evaluation corpus (`docs/plans/intelligent-orchestration.md`
 * §27; #39): loading the cards, turning a card into the inputs the assessor
 * and the router take, and checking a route against a card's expectations.
 *
 * A card is a synthetic task — objective, criteria, scope, and a tiny made-up
 * repository (file sizes, verification commands, risk paths, exclusive
 * resources) — with **labels** (what the work is like, as a careful human
 * would assess it) and **expectations** (the routes that are acceptable, as
 * ranges plus "never" lists, because routing has no single right answer).
 *
 * Everything in the corpus is invented. Real tasks never go in: the repo is
 * public (§27.2).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AMBIGUITY_LEVELS,
  BREADTH_LEVELS,
  COMPLEXITY_LEVELS,
  CONFIDENCE_LEVELS,
  RISK_LEVELS,
  TASK_KINDS,
  VERIFIABILITY_LEVELS,
  combine,
  deterministicPass,
  type AssessedTask,
  type Combined,
  type ModelAnswer,
  type RuleInput,
} from '../../src/orchestration/policy/assessment';
import { scopeFacts, type AssessorFs } from '../../src/orchestration/policy/assessor';
import { DEFAULT_TIERS, tierRank } from '../../src/shared/orchestration/catalog';
import { DEFAULT_REPO_POLICY, type RepoPolicy, type RiskRule } from '../../src/shared/orchestration/repoPolicy';
import {
  EFFORT_LEVELS,
  type Ambiguity,
  type Breadth,
  type Complexity,
  type Confidence,
  type EffortLevel,
  type Risk,
  type RouteGate,
  type RouteRequirement,
  type TaskKind,
  type TierName,
  type Verifiability,
} from '../../src/shared/orchestration/types';

export const CORPUS_DIR = path.join(__dirname, '..', 'fixtures', 'routing-corpus');
export const RECORDINGS_DIR = path.join(CORPUS_DIR, 'recorded');

/** The ordinal dimensions a card labels and the live evaluation scores. */
export const LABELLED_DIMENSIONS = ['complexity', 'breadth', 'risk', 'ambiguity', 'verifiability'] as const;
export type LabelledDimension = (typeof LABELLED_DIMENSIONS)[number];

export const LEVELS: Record<LabelledDimension, readonly string[]> = {
  complexity: COMPLEXITY_LEVELS,
  breadth: BREADTH_LEVELS,
  risk: RISK_LEVELS,
  ambiguity: AMBIGUITY_LEVELS,
  verifiability: VERIFIABILITY_LEVELS,
};

export interface CardRepo {
  /** The made-up repository: repo-relative path → size in bytes. Scope globs are matched against it. */
  files: Record<string, number>;
  /** Names of the verification commands the repository policy configures. */
  verification: string[];
  risk?: RiskRule[];
  exclusive?: { id: string; paths?: string[] }[];
}

export interface CardLabels {
  complexity: Complexity;
  breadth: Breadth;
  risk: Risk;
  ambiguity: Ambiguity;
  verifiability: Verifiability;
  kind: TaskKind;
  domains?: string[];
  /** How sure the labeller is, per dimension. Absent: high. Low is how a card exercises §9.3 rule 5. */
  confidence?: Partial<Record<LabelledDimension | 'kind', Confidence>>;
}

export interface RouteShape {
  tier?: TierName;
  effort?: EffortLevel;
}

export interface CardExpectations {
  /** `minTier` must be one of these. */
  tierIn: TierName[];
  /** `effort` must be one of these. */
  effortIn: EffortLevel[];
  /** Every one of these must be in `needs`. */
  requires?: string[];
  /** Every one of these gates must be present. */
  gates?: RouteGate[];
  /** None of these gates may be present. */
  notGates?: RouteGate[];
  /** Routes that are wrong for this card. A shape with both fields matches only when both do. */
  never?: RouteShape[];
}

export interface CorpusCard {
  id: string;
  /** Which of the §27.1 cases this card covers, in a few words. */
  case: string;
  card: {
    objective: string;
    acceptanceCriteria: string[];
    scope: string[];
    kindHint?: TaskKind;
    /** Verification commands the task itself plans (`command:<name>` stages). */
    verification: string[];
    repo: CardRepo;
  };
  labels: CardLabels;
  expect: CardExpectations;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const TIER_NAMES = DEFAULT_TIERS.map((t) => t.name);
const GATES: readonly RouteGate[] = ['plan-first', 'human-review'];

/** Structural problems with a card, as `<field>: <problem>` lines. Empty when it is well formed. */
export function cardProblems(c: CorpusCard, file: string): string[] {
  const out: string[] = [];
  const bad = (field: string, msg: string): void => {
    out.push(`${field}: ${msg}`);
  };
  const oneOf = (field: string, v: unknown, allowed: readonly string[]): void => {
    if (typeof v !== 'string' || !allowed.includes(v)) bad(field, `${JSON.stringify(v)} is not one of ${allowed.join(', ')}`);
  };
  if (c.id !== path.basename(file, '.json')) bad('id', `must match the file name (${path.basename(file)})`);
  if (!c.case) bad('case', 'missing');
  if (!c.card?.objective?.trim()) bad('card.objective', 'missing');
  if (!Array.isArray(c.card?.acceptanceCriteria)) bad('card.acceptanceCriteria', 'must be an array');
  if (!Array.isArray(c.card?.scope)) bad('card.scope', 'must be an array');
  if (!Array.isArray(c.card?.verification)) bad('card.verification', 'must be an array');
  if (c.card?.kindHint !== undefined) oneOf('card.kindHint', c.card.kindHint, TASK_KINDS);
  const repo = c.card?.repo;
  if (!repo || typeof repo.files !== 'object') bad('card.repo.files', 'missing');
  if (!Array.isArray(repo?.verification)) bad('card.repo.verification', 'must be an array');
  for (const v of c.card?.verification ?? []) {
    if (!repo?.verification?.includes(v)) bad('card.verification', `plans "${v}", which the repo does not configure`);
  }
  for (const [i, r] of (repo?.risk ?? []).entries()) oneOf(`card.repo.risk[${i}].level`, r.level, RISK_LEVELS);
  for (const d of LABELLED_DIMENSIONS) oneOf(`labels.${d}`, c.labels?.[d], LEVELS[d]);
  oneOf('labels.kind', c.labels?.kind, TASK_KINDS);
  for (const [k, v] of Object.entries(c.labels?.confidence ?? {})) oneOf(`labels.confidence.${k}`, v, CONFIDENCE_LEVELS);
  const e = c.expect;
  if (!e || !Array.isArray(e.tierIn) || e.tierIn.length === 0) bad('expect.tierIn', 'must be a non-empty array');
  if (!e || !Array.isArray(e.effortIn) || e.effortIn.length === 0) bad('expect.effortIn', 'must be a non-empty array');
  for (const t of e?.tierIn ?? []) oneOf('expect.tierIn', t, TIER_NAMES);
  for (const x of e?.effortIn ?? []) oneOf('expect.effortIn', x, EFFORT_LEVELS);
  for (const g of [...(e?.gates ?? []), ...(e?.notGates ?? [])]) oneOf('expect.gates', g, GATES);
  for (const [i, n] of (e?.never ?? []).entries()) {
    if (n.tier === undefined && n.effort === undefined) bad(`expect.never[${i}]`, 'names neither a tier nor an effort');
    if (n.tier !== undefined) oneOf(`expect.never[${i}].tier`, n.tier, TIER_NAMES);
    if (n.effort !== undefined) oneOf(`expect.never[${i}].effort`, n.effort, EFFORT_LEVELS);
  }
  // A card whose ranges and never-list overlap can never pass; that is a corpus bug.
  for (const n of e?.never ?? []) {
    const tiers = n.tier === undefined ? e.tierIn : e.tierIn.filter((t) => t === n.tier);
    const efforts = n.effort === undefined ? e.effortIn : e.effortIn.filter((x) => x === n.effort);
    if (n.tier !== undefined && n.effort === undefined && tiers.length > 0) bad('expect', `tierIn allows "${n.tier}", which never forbids`);
    if (n.effort !== undefined && n.tier === undefined && efforts.length > 0) bad('expect', `effortIn allows "${n.effort}", which never forbids`);
  }
  return out;
}

/** Every card in the corpus, sorted by id. Throws on a malformed card, naming it. */
export function loadCorpus(dir = CORPUS_DIR): CorpusCard[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => {
    const full = path.join(dir, f);
    let card: CorpusCard;
    try {
      card = JSON.parse(fs.readFileSync(full, 'utf8')) as CorpusCard;
    } catch (e) {
      throw new Error(`${f}: not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const problems = cardProblems(card, full);
    if (problems.length > 0) throw new Error(`${f}:\n  ${problems.join('\n  ')}`);
    return card;
  });
}

// ---------------------------------------------------------------------------
// A card as the assessor's input
// ---------------------------------------------------------------------------

/** A read-only file system over a card's made-up repository, rooted at `/repo`. */
export const CARD_ROOT = '/repo';

export function cardFs(repo: CardRepo): AssessorFs {
  const rel = (p: string): string => path.posix.relative(CARD_ROOT, p);
  const paths = Object.keys(repo.files);
  return {
    readdirSync(dir) {
      const prefix = rel(dir);
      const names = new Map<string, boolean>();
      for (const p of paths) {
        if (prefix && !p.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? p.slice(prefix.length + 1) : p;
        const [head, ...tail] = rest.split('/');
        names.set(head, (names.get(head) ?? false) || tail.length > 0);
      }
      return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }));
    },
    statSync(file) {
      const size = repo.files[rel(file)];
      if (size === undefined) throw new Error(`ENOENT: ${file}`);
      return { size, isFile: () => true };
    },
  };
}

export function cardPolicy(repo: CardRepo): RepoPolicy {
  const commands: RepoPolicy['verification']['commands'] = {};
  for (const name of repo.verification) commands[name] = { run: ['true'], timeoutSec: 60 };
  return {
    ...DEFAULT_REPO_POLICY,
    verification: { commands, missionDefault: [] },
    risk: (repo.risk ?? []).map((r) => ({ ...r, paths: [...r.paths] })),
    exclusive: (repo.exclusive ?? []).map((r) => ({ ...r, ...(r.paths ? { paths: [...r.paths] } : {}) })),
  } as RepoPolicy;
}

export function cardTask(c: CorpusCard): AssessedTask {
  return {
    objective: c.card.objective,
    acceptanceCriteria: [...c.card.acceptanceCriteria],
    scope: { paths: [...c.card.scope], subsystems: [], confidence: c.card.scope.length > 0 ? 'medium' : 'low' },
    ...(c.card.kindHint ? { kindHint: c.card.kindHint } : {}),
    verification: { stages: c.card.verification.map((n) => ({ strategy: `command:${n}`, required: true })) },
    createdBy: 'user',
  };
}

/** The rule pass's input for a card: its task, its policy, and its scope sized against its made-up repository. */
export function cardRuleInput(c: CorpusCard): RuleInput {
  return {
    task: cardTask(c),
    policy: cardPolicy(c.card.repo),
    facts: scopeFacts(CARD_ROOT, c.card.scope, cardFs(c.card.repo)),
  };
}

/** The labels, said the way the model would say them. */
export function labelsAsAnswer(labels: CardLabels): ModelAnswer {
  const dim = <T extends string>(d: LabelledDimension | 'kind', value: T) => ({
    value,
    confidence: labels.confidence?.[d] ?? ('high' as Confidence),
    evidence: 'corpus label',
  });
  return {
    complexity: dim('complexity', labels.complexity),
    breadth: dim('breadth', labels.breadth),
    risk: dim('risk', labels.risk),
    ambiguity: dim('ambiguity', labels.ambiguity),
    verifiability: dim('verifiability', labels.verifiability),
    kind: dim('kind', labels.kind),
    domains: labels.domains ?? [],
    requires: [],
  };
}

/** Rules plus an answer (the labels, or a recorded model answer), exactly as the assessor combines them. */
export function assessCard(c: CorpusCard, answer: ModelAnswer | undefined): Combined {
  const input = cardRuleInput(c);
  return combine(deterministicPass(input), answer);
}

/**
 * Where the rules and the labels disagree. A card is only a fair test of the
 * router if its labelled assessment is one the assessor could actually
 * produce: a label the rules override (a risk path the label ignores, a
 * verifiability the repository has no commands for) is a corpus bug, or a rule
 * bug, and either way it is worth a failing test.
 */
export function labelConflicts(c: CorpusCard): string[] {
  const combined = assessCard(c, labelsAsAnswer(c.labels));
  const out: string[] = [];
  for (const d of LABELLED_DIMENSIONS) {
    const got = combined.dimensions[d].value;
    if (got !== c.labels[d]) out.push(`${d}: labelled ${c.labels[d]}, assessed ${got} (${combined.dimensions[d].evidence ?? ''})`);
  }
  if (combined.kind.value !== c.labels.kind) out.push(`kind: labelled ${c.labels.kind}, assessed ${combined.kind.value} (${combined.kind.evidence ?? ''})`);
  return out;
}

// ---------------------------------------------------------------------------
// Checking a route
// ---------------------------------------------------------------------------

const rankTier = (t: TierName): number => tierRank(DEFAULT_TIERS, t);
const rankEffort = (e: EffortLevel): number => EFFORT_LEVELS.indexOf(e);

/** What a route was judged on: the requirement, and the assessment it was made from. */
export interface RouteCase {
  requirement: RouteRequirement;
  kind: TaskKind;
  risk: Risk;
  /** The verifiability the router saw, i.e. after the configured ceiling (§8.3). */
  verifiability: Verifiability;
}

/**
 * The misroutes no rule change may ever produce (§27.2). Every one is a
 * routing that is wrong whatever the calibration: the first three are the
 * plan's list, the fourth is §9.2's principle — the cheapest tier only where a
 * machine will catch its mistakes and a mistake is cheap.
 */
export const EGREGIOUS: readonly { id: string; text: string; test: (r: RouteCase) => boolean }[] = [
  {
    id: 'docs-expert-high',
    text: 'documentation routed to expert tier at high effort or more',
    test: (r) => r.kind === 'docs' && rankTier(r.requirement.minTier) >= rankTier('expert') && rankEffort(r.requirement.effort) >= rankEffort('high'),
  },
  {
    id: 'architecture-basic-or-low',
    text: 'architecture or planning routed to basic tier or low effort',
    test: (r) =>
      (r.kind === 'architecture' || r.kind === 'plan') &&
      (rankTier(r.requirement.minTier) <= rankTier('basic') || r.requirement.effort === 'low'),
  },
  {
    id: 'critical-below-expert',
    text: 'critical risk routed below expert tier',
    test: (r) => r.risk === 'critical' && rankTier(r.requirement.minTier) < rankTier('expert'),
  },
  {
    id: 'basic-unguarded',
    text: 'basic tier without at least partial verification, or above moderate risk',
    test: (r) =>
      rankTier(r.requirement.minTier) <= rankTier('basic') &&
      (VERIFIABILITY_LEVELS.indexOf(r.verifiability) < VERIFIABILITY_LEVELS.indexOf('partial') ||
        RISK_LEVELS.indexOf(r.risk) > RISK_LEVELS.indexOf('moderate')),
  },
];

/** The egregious misroutes a route commits, by id. */
export function egregiousMisroutes(r: RouteCase): string[] {
  return EGREGIOUS.filter((e) => e.test(r)).map((e) => e.id);
}

/** Where a requirement falls outside a card's expectations, one line per miss. Empty when it is acceptable. */
export function expectationMisses(expect: CardExpectations, req: RouteRequirement): string[] {
  const out: string[] = [];
  if (!expect.tierIn.includes(req.minTier)) out.push(`tier ${req.minTier} not in [${expect.tierIn.join(', ')}]`);
  if (!expect.effortIn.includes(req.effort)) out.push(`effort ${req.effort} not in [${expect.effortIn.join(', ')}]`);
  for (const need of expect.requires ?? []) if (!req.needs.includes(need)) out.push(`needs is missing ${need}`);
  for (const g of expect.gates ?? []) if (!req.gates.includes(g)) out.push(`gate ${g} missing`);
  for (const g of expect.notGates ?? []) if (req.gates.includes(g)) out.push(`gate ${g} present`);
  for (const n of expect.never ?? []) {
    const tierHit = n.tier === undefined || n.tier === req.minTier;
    const effortHit = n.effort === undefined || n.effort === req.effort;
    if (tierHit && effortHit) out.push(`never ${[n.tier, n.effort].filter(Boolean).join(' + ')}`);
  }
  return out;
}

/** A router, as far as the evaluation is concerned: an assessment in, a requirement out. */
export type CorpusRouter = (assessment: Combined) => RouteRequirement;

export interface CardVerdict {
  id: string;
  requirement: RouteRequirement;
  misses: string[];
  egregious: string[];
}

export function evaluateCard(c: CorpusCard, assessment: Combined, route: CorpusRouter): CardVerdict {
  const requirement = route(assessment);
  return {
    id: c.id,
    requirement,
    misses: expectationMisses(c.expect, requirement),
    egregious: egregiousMisroutes({
      requirement,
      kind: assessment.kind.value,
      risk: assessment.dimensions.risk.value,
      verifiability: assessment.dimensions.verifiability.value,
    }),
  };
}

// ---------------------------------------------------------------------------
// Assessor agreement (the live evaluation, and its replay)
// ---------------------------------------------------------------------------

export interface Agreement {
  cards: number;
  /** Per dimension: how many cards the assessor matched exactly, and within one level. */
  dimensions: Record<LabelledDimension, { exact: number; withinOne: number }>;
  kind: { exact: number };
}

export function emptyAgreement(): Agreement {
  const dims = Object.fromEntries(LABELLED_DIMENSIONS.map((d) => [d, { exact: 0, withinOne: 0 }])) as Agreement['dimensions'];
  return { cards: 0, dimensions: dims, kind: { exact: 0 } };
}

/** Adds one card's comparison of an assessment against its labels. */
export function addAgreement(acc: Agreement, labels: CardLabels, assessed: Combined): Agreement {
  acc.cards++;
  for (const d of LABELLED_DIMENSIONS) {
    const levels = LEVELS[d];
    const delta = Math.abs(levels.indexOf(assessed.dimensions[d].value) - levels.indexOf(labels[d]));
    if (delta === 0) acc.dimensions[d].exact++;
    if (delta <= 1) acc.dimensions[d].withinOne++;
  }
  if (assessed.kind.value === labels.kind) acc.kind.exact++;
  return acc;
}

/**
 * A fingerprint of what the assessor is shown for a card, so a recording made
 * against an older version of the card is noticed instead of replayed.
 */
export function cardHash(c: CorpusCard): string {
  const basis = JSON.stringify([c.card.objective, c.card.acceptanceCriteria, c.card.scope, c.card.kindHint ?? null, c.card.verification, c.card.repo]);
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A live run of the assessor over the corpus, kept for replay. `answers` are
 * the model's structured answers only; the agreement is numbers. The model's
 * evidence lines describe invented cards, so the file is public-safe.
 */
export interface Recording {
  assessorVersion: string;
  model: string;
  recordedAt: string;
  agreement: Agreement;
  /** Cards whose completion failed, with the reason: they were assessed from rules alone and are not replayed. */
  failed: Record<string, string>;
  answers: Record<string, { cardHash: string; answer: ModelAnswer }>;
}

export function recordingPath(assessorVersion: string, dir = RECORDINGS_DIR): string {
  return path.join(dir, `${assessorVersion}.json`);
}

export function loadRecording(assessorVersion: string, dir = RECORDINGS_DIR): Recording | undefined {
  const file = recordingPath(assessorVersion, dir);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Recording;
}

/** One line per dimension, numbers only: safe to print anywhere. */
export function formatAgreement(a: Agreement): string {
  const pct = (n: number): string => `${Math.round((100 * n) / Math.max(1, a.cards))}%`;
  const rows = LABELLED_DIMENSIONS.map(
    (d) => `${d.padEnd(14)} exact ${pct(a.dimensions[d].exact).padStart(4)}  within one ${pct(a.dimensions[d].withinOne).padStart(4)}`,
  );
  rows.push(`${'kind'.padEnd(14)} exact ${pct(a.kind.exact).padStart(4)}`);
  return [`${a.cards} cards`, ...rows].join('\n');
}
