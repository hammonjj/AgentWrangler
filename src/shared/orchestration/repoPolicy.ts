/**
 * The per-repository orchestration policy (`docs/plans/intelligent-orchestration.md`
 * §13.6): what orchestration must not guess about a repository — where its
 * worktrees go and how they are set up, which commands verify it, which paths
 * are risky, which resources are exclusive, and how a mission finishes.
 *
 * Pure: schema, validation, layering and a canonical form for versioning.
 * Loading from disk is `src/orchestration/policy/repoPolicyStore.ts`. This
 * lives in `src/shared/**` so the Preferences page can validate an edit with
 * the same code the core loads it with.
 *
 * Two rules shape the schema:
 * - **Commands are argv arrays, never shell strings.** There is no field a
 *   shell ever sees.
 * - **The policy is user-authored.** A model may reference a verification
 *   command by name (`command:<name>`), but nothing a model produces is ever
 *   parsed as a policy.
 */
import type { MissionFinish, Risk } from './types';

export const REPO_POLICY_VERSION = 1;

/** A worktree setup step, run after AW creates a worktree (§13.2). */
export type SetupStep =
  /** Symlink `<primary>/<path>` into the new worktree at the same relative path. */
  | { link: string }
  /** Copy `<primary>/<path>` (typically an ignored file such as `.env`) into the new worktree. */
  | { copy: string }
  /** Run a command in the new worktree. */
  | { run: string[]; timeoutSec?: number };

export interface VerificationCommand {
  /** argv. `run[0]` is looked up on PATH; nothing is passed through a shell. */
  run: string[];
  timeoutSec: number;
}

export interface RiskRule {
  /** Globs relative to the repository root. */
  paths: string[];
  level: Risk;
  why: string;
}

/** Something outside the repository's files that only one attempt may use at a time (§13.5). */
export interface ExclusiveResource {
  /** The lease name, e.g. `unity-editor:Game` or `app-install`. */
  id: string;
  /** Changes to these paths need the resource. Absent: every attempt in the repository does. */
  paths?: string[];
  why?: string;
}

export type FinishDefault = Exclude<MissionFinish, 'discard'>;

export interface RepoPolicy {
  worktrees: {
    /** Where AW puts worktrees, relative to the primary checkout. `<repo>` is its folder name. */
    root: string;
    setup: SetupStep[];
  };
  verification: {
    /** Named commands. A verification stage refers to one as `command:<name>`. */
    commands: Record<string, VerificationCommand>;
    /** What runs on the mission branch after each merge (§14.4). */
    missionDefault: string[];
  };
  risk: RiskRule[];
  exclusive: ExclusiveResource[];
  finish: {
    default: FinishDefault;
    /** Commands the merged result must pass before a local merge moves the base (§13.3). */
    gate: string[];
  };
}

/** A policy file as written: every section optional, laid over the defaults field by field. */
export interface RepoPolicyFile {
  v?: number;
  worktrees?: { root?: string; setup?: SetupStep[] };
  /** Named commands, plus `missionDefault` (the file format of §13.6). */
  verification?: { missionDefault?: string[] } & Record<string, { run: string[]; timeoutSec?: number } | string[] | undefined>;
  risk?: RiskRule[];
  exclusive?: ExclusiveResource[];
  finish?: { default?: FinishDefault; gate?: string[] };
}

/** What a repository gets with no policy: no verification (so results are `unverified`), no risk paths, sibling worktrees. */
export const DEFAULT_REPO_POLICY: RepoPolicy = Object.freeze({
  worktrees: { root: '../<repo>.aw', setup: [] },
  verification: { commands: {}, missionDefault: [] },
  risk: [],
  exclusive: [],
  finish: { default: 'merge-local', gate: [] },
}) as RepoPolicy;

export const DEFAULT_COMMAND_TIMEOUT_SEC = 600;
/** A day. Anything longer is a typo, not a test suite. */
export const MAX_TIMEOUT_SEC = 86_400;

export interface PolicyError {
  /** Where in the file, e.g. `verification.unit.run[0]`. Empty for the document itself. */
  path: string;
  message: string;
}

export type ParseResult = { ok: true; file: RepoPolicyFile } | { ok: false; errors: PolicyError[] };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const RISK_LEVELS: readonly Risk[] = ['low', 'moderate', 'high', 'critical'];
const FINISH_DEFAULTS: readonly FinishDefault[] = ['merge-local', 'pull-request', 'keep'];
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/**
 * Validate a parsed policy file. Every problem is reported, each with its
 * path; a file with any error is rejected whole, never half-applied.
 */
export function validateRepoPolicyFile(doc: unknown): ParseResult {
  const errors: PolicyError[] = [];
  const err = (p: string, message: string): void => void errors.push({ path: p, message });

  if (!isObject(doc)) {
    err('', 'a policy must be a JSON object');
    return { ok: false, errors };
  }
  unknownKeys(doc, ['$schema', 'v', 'worktrees', 'verification', 'risk', 'exclusive', 'finish'], '', err);
  if ('v' in doc && doc.v !== REPO_POLICY_VERSION) err('v', `unsupported version ${JSON.stringify(doc.v)}; this build reads ${REPO_POLICY_VERSION}`);

  if ('worktrees' in doc) {
    const w = doc.worktrees;
    if (!isObject(w)) err('worktrees', 'must be an object');
    else {
      unknownKeys(w, ['root', 'setup'], 'worktrees', err);
      if ('root' in w) worktreeRoot(w.root, 'worktrees.root', err);
      if ('setup' in w) {
        if (!Array.isArray(w.setup)) err('worktrees.setup', 'must be an array of steps');
        else w.setup.forEach((s, i) => setupStep(s, `worktrees.setup[${i}]`, err));
      }
    }
  }

  const commandNames = new Set<string>();
  if ('verification' in doc) {
    const v = doc.verification;
    if (!isObject(v)) err('verification', 'must be an object');
    else {
      for (const [name, value] of Object.entries(v)) {
        if (name === 'missionDefault') continue;
        const p = `verification.${name}`;
        if (!COMMAND_NAME.test(name)) {
          err(p, 'a command name is lowercase letters, digits and dashes, starting with a letter');
          continue;
        }
        commandNames.add(name);
        command(value, p, err);
      }
      if ('missionDefault' in v) nameList(v.missionDefault, 'verification.missionDefault', err);
    }
  }

  if ('risk' in doc) {
    if (!Array.isArray(doc.risk)) err('risk', 'must be an array of rules');
    else doc.risk.forEach((r, i) => riskRule(r, `risk[${i}]`, err));
  }

  if ('exclusive' in doc) {
    if (!Array.isArray(doc.exclusive)) err('exclusive', 'must be an array of resources');
    else {
      const seen = new Set<string>();
      doc.exclusive.forEach((r, i) => {
        const id = exclusive(r, `exclusive[${i}]`, err);
        if (id && seen.has(id)) err(`exclusive[${i}].id`, `duplicate resource ${JSON.stringify(id)}`);
        if (id) seen.add(id);
      });
    }
  }

  if ('finish' in doc) {
    const f = doc.finish;
    if (!isObject(f)) err('finish', 'must be an object');
    else {
      unknownKeys(f, ['default', 'gate'], 'finish', err);
      if ('default' in f && !FINISH_DEFAULTS.includes(f.default as FinishDefault)) {
        err('finish.default', `must be one of ${FINISH_DEFAULTS.map((x) => JSON.stringify(x)).join(', ')}`);
      }
      if ('gate' in f) nameList(f.gate, 'finish.gate', err);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, file: doc as RepoPolicyFile };
}

function command(value: unknown, p: string, err: Err): void {
  if (!isObject(value)) {
    err(p, 'a verification command is an object with `run` (an argv array)');
    return;
  }
  unknownKeys(value, ['run', 'timeoutSec'], p, err);
  argv(value.run, `${p}.run`, err);
  if ('timeoutSec' in value) timeout(value.timeoutSec, `${p}.timeoutSec`, err);
}

function setupStep(value: unknown, p: string, err: Err): void {
  if (!isObject(value)) {
    err(p, 'a setup step is `{ "link": path }`, `{ "copy": path }` or `{ "run": argv }`');
    return;
  }
  const kinds = ['link', 'copy', 'run'].filter((k) => k in value);
  if (kinds.length !== 1) {
    err(p, kinds.length === 0 ? 'a setup step needs one of `link`, `copy` or `run`' : `a setup step has one kind, not ${kinds.join(' and ')}`);
    return;
  }
  const kind = kinds[0];
  if (kind === 'run') {
    unknownKeys(value, ['run', 'timeoutSec'], p, err);
    argv(value.run, `${p}.run`, err);
    if ('timeoutSec' in value) timeout(value.timeoutSec, `${p}.timeoutSec`, err);
  } else {
    unknownKeys(value, [kind], p, err);
    relativePath(value[kind], `${p}.${kind}`, err);
  }
}

function riskRule(value: unknown, p: string, err: Err): void {
  if (!isObject(value)) {
    err(p, 'a risk rule is `{ "paths": [...], "level": ..., "why": ... }`');
    return;
  }
  unknownKeys(value, ['paths', 'level', 'why'], p, err);
  globList(value.paths, `${p}.paths`, err, true);
  if (!RISK_LEVELS.includes(value.level as Risk)) err(`${p}.level`, `must be one of ${RISK_LEVELS.map((x) => JSON.stringify(x)).join(', ')}`);
  if (typeof value.why !== 'string' || value.why.trim() === '') err(`${p}.why`, 'say why these paths are risky');
}

function exclusive(value: unknown, p: string, err: Err): string | undefined {
  if (!isObject(value)) {
    err(p, 'an exclusive resource is `{ "id": ..., "paths"?: [...], "why"?: ... }`');
    return undefined;
  }
  unknownKeys(value, ['id', 'paths', 'why'], p, err);
  let id: string | undefined;
  if (typeof value.id !== 'string' || !RESOURCE_ID.test(value.id)) {
    err(`${p}.id`, 'a resource id is letters, digits and `._:-`, e.g. "unity-editor:Game"');
  } else id = value.id;
  if ('paths' in value) globList(value.paths, `${p}.paths`, err, true);
  if ('why' in value && typeof value.why !== 'string') err(`${p}.why`, 'must be a string');
  return id;
}

function argv(value: unknown, p: string, err: Err): void {
  if (typeof value === 'string') {
    err(p, 'must be an argv array such as ["npm", "test"], not a shell string');
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    err(p, 'must be a non-empty argv array such as ["npm", "test"]');
    return;
  }
  value.forEach((a, i) => {
    if (typeof a !== 'string') err(`${p}[${i}]`, 'must be a string');
    else if (i === 0 && a.trim() === '') err(`${p}[0]`, 'the program name is empty');
    else if (a.includes('\0')) err(`${p}[${i}]`, 'contains a NUL character');
  });
}

function timeout(value: unknown, p: string, err: Err): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_SEC) {
    err(p, `must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SEC}`);
  }
}

function nameList(value: unknown, p: string, err: Err): void {
  if (!Array.isArray(value)) {
    err(p, 'must be an array of command names');
    return;
  }
  value.forEach((n, i) => {
    if (typeof n !== 'string' || !COMMAND_NAME.test(n)) err(`${p}[${i}]`, 'must be a command name');
  });
}

function globList(value: unknown, p: string, err: Err, nonEmpty: boolean): void {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    err(p, 'must be a non-empty array of paths or globs');
    return;
  }
  value.forEach((g, i) => relativePath(g, `${p}[${i}]`, err));
}

/** Relative to the repository and staying inside it. */
function relativePath(value: unknown, p: string, err: Err): void {
  if (typeof value !== 'string' || value.trim() === '') {
    err(p, 'must be a non-empty path');
    return;
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)) {
    err(p, 'must be relative to the repository');
    return;
  }
  if (value.split(/[\\/]/).includes('..')) err(p, 'must stay inside the repository (no `..`)');
}

/** Relative to the primary checkout; `..` is allowed, since worktrees are siblings. */
function worktreeRoot(value: unknown, p: string, err: Err): void {
  if (typeof value !== 'string' || value.trim() === '') {
    err(p, 'must be a non-empty path');
    return;
  }
  if (value.startsWith('~')) {
    err(p, 'use an absolute path or one relative to the primary checkout; `~` is not expanded');
    return;
  }
  const normal = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normal === '' || normal === '.' || normal === '..' || normal === '/') {
    err(p, 'must be a directory of its own, not the checkout or its parent');
  } else if (!normal.startsWith('/') && !normal.startsWith('../')) {
    // Inside the primary checkout: its file watchers would see every worktree (§13.2).
    err(p, 'must be outside the primary checkout, e.g. "../<repo>.aw"');
  }
}

type Err = (path: string, message: string) => void;

function unknownKeys(obj: Record<string, unknown>, known: string[], p: string, err: Err): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) err(p ? `${p}.${k}` : k, `unknown field; expected one of ${known.join(', ')}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

/**
 * Lay validated files over the defaults, later layers winning field by field:
 * a file that sets only `finish.default` keeps every other default, and a
 * file that names one verification command adds (or replaces) that command
 * alone. Lists (`setup`, `risk`, `exclusive`, `missionDefault`, `gate`)
 * replace, never append, so a layer can always empty one.
 *
 * The result is checked as a whole: `missionDefault` and `gate` must name
 * commands that exist once all layers are applied.
 */
export function resolveRepoPolicy(
  layers: readonly RepoPolicyFile[],
  base: RepoPolicy = DEFAULT_REPO_POLICY,
): { ok: true; policy: RepoPolicy } | { ok: false; errors: PolicyError[] } {
  const policy: RepoPolicy = {
    worktrees: { root: base.worktrees.root, setup: [...base.worktrees.setup] },
    verification: { commands: { ...base.verification.commands }, missionDefault: [...base.verification.missionDefault] },
    risk: [...base.risk],
    exclusive: [...base.exclusive],
    finish: { default: base.finish.default, gate: [...base.finish.gate] },
  };
  for (const layer of layers) {
    if (layer.worktrees?.root !== undefined) policy.worktrees.root = layer.worktrees.root;
    if (layer.worktrees?.setup !== undefined) policy.worktrees.setup = layer.worktrees.setup.map(normalStep);
    if (layer.verification) {
      for (const [name, value] of Object.entries(layer.verification)) {
        if (name === 'missionDefault' || value === undefined || Array.isArray(value)) continue;
        policy.verification.commands[name] = { run: [...value.run], timeoutSec: value.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC };
      }
      if (layer.verification.missionDefault !== undefined) policy.verification.missionDefault = [...layer.verification.missionDefault];
    }
    if (layer.risk !== undefined) policy.risk = layer.risk.map((r) => ({ paths: [...r.paths], level: r.level, why: r.why }));
    if (layer.exclusive !== undefined) policy.exclusive = layer.exclusive.map((r) => ({ ...r, ...(r.paths ? { paths: [...r.paths] } : {}) }));
    if (layer.finish?.default !== undefined) policy.finish.default = layer.finish.default;
    if (layer.finish?.gate !== undefined) policy.finish.gate = [...layer.finish.gate];
  }

  const errors: PolicyError[] = [];
  const known = policy.verification.commands;
  policy.verification.missionDefault.forEach((n, i) => {
    if (!(n in known)) errors.push({ path: `verification.missionDefault[${i}]`, message: `no verification command named ${JSON.stringify(n)}` });
  });
  policy.finish.gate.forEach((n, i) => {
    if (!(n in known)) errors.push({ path: `finish.gate[${i}]`, message: `no verification command named ${JSON.stringify(n)}` });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy };
}

function normalStep(s: SetupStep): SetupStep {
  if ('run' in s) return { run: [...s.run], timeoutSec: s.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC };
  return 'link' in s ? { link: s.link } : { copy: s.copy };
}

/** Parse and validate a policy file's text. */
export function parseRepoPolicy(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  return validateRepoPolicyFile(doc);
}

// ---------------------------------------------------------------------------
// Using a policy
// ---------------------------------------------------------------------------

/** `command:<name>` → the policy's command, or undefined. The only way a stage becomes a process. */
export function commandForStrategy(policy: RepoPolicy, strategy: string): VerificationCommand | undefined {
  const m = /^command:([a-z][a-z0-9-]*)$/.exec(strategy);
  if (!m) return undefined;
  return Object.prototype.hasOwnProperty.call(policy.verification.commands, m[1]) ? policy.verification.commands[m[1]] : undefined;
}

/** True when the repository has any verification at all; without it results are `unverified` (§14.3). */
export function hasVerification(policy: RepoPolicy): boolean {
  return Object.keys(policy.verification.commands).length > 0;
}

/** The worktree root with `<repo>` filled in, still relative to the primary checkout unless absolute. */
export function worktreeRootFor(policy: RepoPolicy, repoName: string): string {
  return policy.worktrees.root.split('<repo>').join(repoName);
}

/**
 * A stable serialisation of an effective policy (sorted keys), which the
 * store hashes into a version. Two files that mean the same thing get the same
 * version; any change to what runs gets a new one.
 */
export function canonicalPolicy(policy: RepoPolicy): string {
  return JSON.stringify(sortKeys(policy));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}
