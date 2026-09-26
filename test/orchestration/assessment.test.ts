/**
 * The assessor's rules and the step that combines them with the model
 * (plan §8, #37), as tables: every rule that can decide a route is here with
 * the input that fires it.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSESSOR_VERSION,
  NO_SCOPE_FACTS,
  assessmentSchema,
  assessorInput,
  combine,
  configuredVerifiabilityOf,
  contextTokens,
  deterministicPass,
  inputsHash,
  riskFloorOf,
  weakest,
  type AssessedTask,
  type ModelAnswer,
  type RuleInput,
  type ScopeFacts,
} from '../../src/orchestration/policy/assessment';
import { globToRegExp, globsOverlap, matchGlob, overlapping } from '../../src/orchestration/policy/globs';
import { validateJson } from '../../src/orchestration/completion/jsonSchema';
import { DEFAULT_REPO_POLICY, type RepoPolicy } from '../../src/shared/orchestration/repoPolicy';

function task(overrides: Partial<AssessedTask> = {}): AssessedTask {
  return {
    objective: 'Add a setting for the idle timeout',
    acceptanceCriteria: ['the setting is read at launch'],
    scope: { paths: [], subsystems: [], confidence: 'low' },
    verification: { stages: [] },
    createdBy: 'user',
    ...overrides,
  };
}

function facts(files: string[], bytes = 2_000): ScopeFacts {
  const dirs = new Set<string>();
  const tops = new Set<string>();
  const exts = new Set<string>();
  let testFiles = 0;
  for (const f of files) {
    const at = f.lastIndexOf('/');
    dirs.add(at < 0 ? '' : f.slice(0, at));
    tops.add(f.split('/')[0]);
    const dot = f.lastIndexOf('.');
    if (dot > 0) exts.add(f.slice(dot).toLowerCase());
    if (/(^|[./-])(test|tests|spec)([./-]|$)/i.test(f)) testFiles++;
  }
  return {
    known: true,
    files,
    truncated: false,
    bytes,
    directories: [...dirs].sort(),
    topLevels: [...tops].sort(),
    extensions: [...exts].sort(),
    testFiles,
  };
}

function policyWith(overrides: Partial<RepoPolicy>): RepoPolicy {
  return {
    ...DEFAULT_REPO_POLICY,
    ...overrides,
    verification: { ...DEFAULT_REPO_POLICY.verification, ...(overrides.verification ?? {}) },
  };
}

const MODEL: ModelAnswer = {
  complexity: { value: 'involved', confidence: 'medium', evidence: 'several call sites' },
  breadth: { value: 'few-files', confidence: 'medium', evidence: 'one module' },
  risk: { value: 'low', confidence: 'high', evidence: 'a setting is easy to change back' },
  ambiguity: { value: 'clear', confidence: 'high', evidence: 'the criteria are testable' },
  verifiability: { value: 'strong', confidence: 'high', evidence: 'the suite covers settings' },
  kind: { value: 'feature', confidence: 'high', evidence: 'it adds behaviour' },
  domains: ['TypeScript', 'ui'],
  requires: ['edit', 'vision'],
};

describe('globs', () => {
  it.each([
    ['src/core/store.ts', 'src/**', true],
    ['src/core/store.ts', 'src/*', false],
    ['src/store.ts', 'src/*', true],
    ['src/core/store.ts', 'src/core', true],
    ['src/core2/store.ts', 'src/core', false],
    ['README.md', '**/*.md', true],
    ['docs/plans/a.md', '**/*.md', true],
    ['docs/a.mdx', '**/*.md', false],
    ['a/b/c.ts', 'a/**/c.ts', true],
    ['a/c.ts', 'a/**/c.ts', true],
    ['src/x.ts', 'src/?.ts', true],
    ['src/xy.ts', 'src/?.ts', false],
  ])('matches %s against %s', (file, glob, expected) => {
    expect(matchGlob(file, glob)).toBe(expected);
  });

  it('anchors the regular expression it builds', () => {
    expect(globToRegExp('src/*.ts').test('a/src/x.ts')).toBe(false);
  });

  it.each([
    ['src/**', 'src/core/*.ts', true],
    ['src/core/**', 'src/remote/**', false],
    ['src/**', 'test/**', false],
    ['**/*.json', 'package.json', true],
    ['package.json', 'package.json', true],
    ['src/shared/protocol.ts', 'src/shared/**', true],
  ])('decides whether %s could touch %s', (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });

  it('keeps only the globs that could touch a scope', () => {
    expect(overlapping(['src/host/**', 'docs/**'], ['src/host/protocol.ts'])).toEqual(['src/host/**']);
  });
});

describe('the deterministic pass', () => {
  it('sizes the context load from the files in scope, and says so', () => {
    const rules = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(['src/a.ts'], 20_000) });
    // 20k bytes ≈ 5k tokens, plus the fixed allowance: still `small`.
    expect(rules.dimensions.contextLoad).toMatchObject({ value: 'small', confidence: 'high', from: 'rule' });
    expect(contextTokens(facts(['src/a.ts'], 20_000))).toBe(25_000);
    // One token over the band's edge is the next band up: the bands are the whole claim.
    expect(deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(['src/a.ts'], 40_004) }).dimensions.contextLoad!.value).toBe(
      'medium',
    );
  });

  it('bands a large scope as large, and a huge one as very-large', () => {
    const big = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(['src/a.ts'], 600_000) });
    expect(big.dimensions.contextLoad!.value).toBe('large');
    const huge = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(['src/a.ts'], 4_000_000) });
    expect(huge.dimensions.contextLoad!.value).toBe('very-large');
  });

  it('does not claim a breadth when nothing predicts what the task touches', () => {
    const rules = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: NO_SCOPE_FACTS });
    expect(rules.dimensions.breadth).toBeUndefined();
    expect(rules.dimensions.contextLoad).toMatchObject({ value: 'medium', confidence: 'low' });
  });

  it.each([
    [['src/a.ts'], 'single-file'],
    [['src/a.ts', 'src/b.ts'], 'few-files'],
    [['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'], 'subsystem'],
    [['src/a.ts', 'test/b.ts'], 'cross-cutting'],
  ])('reads %s as %s', (files, expected) => {
    const rules = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(files) });
    expect(rules.dimensions.breadth!.value).toBe(expected);
  });

  it('calls a docs-only scope trivial documentation work', () => {
    const rules = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(['docs/a.md', 'README.md']) });
    expect(rules.dimensions.complexity).toMatchObject({ value: 'trivial', from: 'rule' });
    expect(rules.kind).toMatchObject({ value: 'docs', from: 'rule' });
  });

  it('calls a task with no acceptance criteria underspecified', () => {
    const rules = deterministicPass({ task: task({ acceptanceCriteria: [] }), policy: DEFAULT_REPO_POLICY, facts: NO_SCOPE_FACTS });
    expect(rules.dimensions.ambiguity).toMatchObject({ value: 'underspecified', confidence: 'medium', from: 'rule' });
  });

  it('takes a kind the task already carries, and says who set it', () => {
    const fromUser = deterministicPass({ task: task({ kindHint: 'migration' }), policy: DEFAULT_REPO_POLICY, facts: NO_SCOPE_FACTS });
    expect(fromUser.kind).toMatchObject({ value: 'migration', from: 'user', confidence: 'high' });
    const fromPlanner = deterministicPass({
      task: task({ kindHint: 'migration', createdBy: 'planner' }),
      policy: DEFAULT_REPO_POLICY,
      facts: NO_SCOPE_FACTS,
    });
    expect(fromPlanner.kind!.from).toBe('planner');
  });

  it('reads domains off the file types, and asks for the repository’s exclusive resources', () => {
    const policy = policyWith({ exclusive: [{ id: 'unity-editor:Game', paths: ['Assets/**'] }] });
    const rules = deterministicPass({
      task: task({ scope: { paths: ['Assets/**'], subsystems: [], confidence: 'medium' } }),
      policy,
      facts: facts(['Assets/Scenes/Main.unity', 'Assets/Shaders/water.shader']),
    });
    expect(rules.domains).toEqual(['shader', 'unity']);
    expect(rules.requires).toEqual(['edit', 'exclusive:unity-editor:Game', 'shell']);
  });

  it('asks for an exclusive resource with no paths on every task in the repository', () => {
    const policy = policyWith({ exclusive: [{ id: 'app-install' }] });
    const rules = deterministicPass({ task: task(), policy, facts: NO_SCOPE_FACTS });
    expect(rules.requires).toContain('exclusive:app-install');
  });
});

describe('risk floors from repository path rules', () => {
  const policy = policyWith({
    risk: [
      { paths: ['src/host/**'], level: 'critical', why: 'the host protocol is a format other processes depend on' },
      { paths: ['src/ui/**'], level: 'moderate', why: 'user-visible' },
    ],
  });

  it('is low, at low confidence, when no rule matches', () => {
    expect(riskFloorOf(policy, task(), NO_SCOPE_FACTS)).toMatchObject({ value: 'low', confidence: 'low', from: 'rule' });
  });

  it('is high confidence when a file in scope matches, and quotes the rule', () => {
    const t = task({ scope: { paths: ['src/host/**'], subsystems: [], confidence: 'high' } });
    const floor = riskFloorOf(policy, t, facts(['src/host/protocol.ts']));
    expect(floor).toMatchObject({ value: 'critical', confidence: 'high' });
    expect(floor.evidence).toContain('the host protocol');
  });

  it('is medium confidence when only the globs overlap, because no file list exists yet', () => {
    const t = task({ scope: { paths: ['src/host/**'], subsystems: [], confidence: 'low' } });
    expect(riskFloorOf(policy, t, NO_SCOPE_FACTS)).toMatchObject({ value: 'critical', confidence: 'medium' });
  });

  it('takes the highest rule that could fire', () => {
    const t = task({ scope: { paths: ['src/**'], subsystems: [], confidence: 'low' } });
    expect(riskFloorOf(policy, t, NO_SCOPE_FACTS).value).toBe('critical');
  });
});

describe('configured verifiability', () => {
  const commands = {
    typecheck: { run: ['npm', 'run', 'typecheck'], timeoutSec: 600 },
    test: { run: ['npm', 'test'], timeoutSec: 600 },
    lint: { run: ['npm', 'run', 'lint'], timeoutSec: 600 },
  };

  it('is none when the repository configures nothing', () => {
    expect(configuredVerifiabilityOf(DEFAULT_REPO_POLICY, task())).toMatchObject({ value: 'none', confidence: 'high' });
  });

  it('is weak when the repository has commands but the task plans none', () => {
    const policy = policyWith({ verification: { commands: { lint: commands.lint }, missionDefault: [] } });
    expect(configuredVerifiabilityOf(policy, task())).toMatchObject({ value: 'weak', confidence: 'medium' });
  });

  it('is partial when the repository has a behavioural command the task has not planned', () => {
    const policy = policyWith({ verification: { commands, missionDefault: [] } });
    expect(configuredVerifiabilityOf(policy, task()).value).toBe('partial');
  });

  it('is strong when the task plans a behavioural check and another one', () => {
    const policy = policyWith({ verification: { commands, missionDefault: [] } });
    const t = task({ verification: { stages: [{ strategy: 'command:test', required: true }, { strategy: 'command:typecheck', required: true }] } });
    expect(configuredVerifiabilityOf(policy, t)).toMatchObject({ value: 'strong', confidence: 'high' });
  });

  it('is weak when the task plans only a command that checks formatting', () => {
    const policy = policyWith({ verification: { commands, missionDefault: [] } });
    const t = task({ verification: { stages: [{ strategy: 'command:lint', required: true }] } });
    expect(configuredVerifiabilityOf(policy, t).value).toBe('weak');
  });

  it('ignores a stage naming a command the policy does not have', () => {
    const policy = policyWith({ verification: { commands, missionDefault: [] } });
    const t = task({ verification: { stages: [{ strategy: 'command:invented', required: true }] } });
    expect(configuredVerifiabilityOf(policy, t).value).toBe('partial');
  });
});

describe('combining rules with the model (§8.3)', () => {
  const riskyPolicy = policyWith({
    risk: [{ paths: ['src/host/**'], level: 'critical', why: 'the host protocol' }],
    verification: { commands: { lint: { run: ['npm', 'run', 'lint'], timeoutSec: 600 } }, missionDefault: [] },
  });
  const riskyInput: RuleInput = {
    task: task({ scope: { paths: ['src/host/**'], subsystems: [], confidence: 'high' } }),
    policy: riskyPolicy,
    facts: facts(['src/host/protocol.ts']),
  };

  it('never lets the model talk a path rule’s risk down', () => {
    const c = combine(deterministicPass(riskyInput), MODEL);
    expect(c.dimensions.risk).toMatchObject({ value: 'critical', from: 'rule', confidence: 'high' });
    expect(c.dimensions.risk.evidence).toContain('the model said low');
  });

  it('lets the model raise a risk above the floor', () => {
    const rules = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: NO_SCOPE_FACTS });
    const c = combine(rules, { ...MODEL, risk: { value: 'high', confidence: 'medium', evidence: 'touches auth' } });
    expect(c.dimensions.risk).toMatchObject({ value: 'high', from: 'model' });
  });

  it('never lets the model imagine a verifier the repository does not have', () => {
    const c = combine(deterministicPass(riskyInput), MODEL);
    expect(c.dimensions.verifiability).toMatchObject({ value: 'weak', from: 'rule' });
    expect(c.dimensions.verifiability.evidence).toContain('the model said strong');
  });

  it('takes the model’s answer when it is lower than what is configured', () => {
    const policy = policyWith({
      verification: { commands: { test: { run: ['npm', 'test'], timeoutSec: 600 } }, missionDefault: [] },
    });
    const rules = deterministicPass({ task: task(), policy, facts: NO_SCOPE_FACTS });
    const c = combine(rules, { ...MODEL, verifiability: { value: 'weak', confidence: 'medium', evidence: 'nothing covers the UI' } });
    expect(c.dimensions.verifiability).toMatchObject({ value: 'weak', from: 'model' });
  });

  it('keeps a rule’s answer for the dimensions a rule could decide', () => {
    const rules = deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: facts(['docs/a.md']) });
    const c = combine(rules, MODEL);
    expect(c.dimensions.complexity).toMatchObject({ value: 'trivial', from: 'rule' });
    expect(c.dimensions.breadth).toMatchObject({ value: 'single-file', from: 'rule' });
    // Nothing ruled on ambiguity, so the model has it.
    expect(c.dimensions.ambiguity).toMatchObject({ value: 'clear', from: 'model' });
  });

  it('merges domains, and takes only the tool needs a model is allowed to name', () => {
    // `telepathy` could only arrive from a model that ignored the schema; it is dropped, not stored.
    const c = combine(deterministicPass(riskyInput), { ...MODEL, requires: ['edit', 'vision', 'telepathy'] });
    expect(c.domains).toEqual(['typescript', 'ui']);
    expect(c.requires).toEqual(['edit', 'shell', 'vision']);
  });

  it('lets a user edit beat both the rule and the model, and records it as the user’s', () => {
    const c = combine(deterministicPass(riskyInput), MODEL, { risk: 'moderate', kind: 'chore' });
    expect(c.dimensions.risk).toMatchObject({ value: 'moderate', from: 'user', confidence: 'high' });
    expect(c.kind).toMatchObject({ value: 'chore', from: 'user' });
  });

  it('is only as sure as its least sure dimension', () => {
    const c = combine(deterministicPass({ task: task(), policy: DEFAULT_REPO_POLICY, facts: NO_SCOPE_FACTS }), MODEL);
    // `contextLoad` is a low-confidence guess without a scope.
    expect(c.confidence).toBe('low');
    expect(weakest(['high', 'medium'])).toBe('medium');
  });

  it('falls back to a rules-only assessment at low confidence with no model answer', () => {
    const c = combine(deterministicPass(riskyInput), undefined);
    expect(c.confidence).toBe('low');
    expect(c.dimensions.risk).toMatchObject({ value: 'critical', from: 'rule' });
    expect(c.dimensions.complexity).toMatchObject({ confidence: 'low', from: 'rule' });
    expect(c.evidence.join(' ')).toContain('rules-only');
  });
});

describe('the completion’s schema and prompt', () => {
  it('accepts a well-formed answer and refuses an invented level', () => {
    expect(validateJson(assessmentSchema(), MODEL)).toEqual([]);
    const bad = { ...MODEL, complexity: { value: 'impossible', confidence: 'high', evidence: 'x' } };
    expect(validateJson(assessmentSchema(), bad).join(' ')).toContain('complexity');
  });

  it('refuses a tool need that is not one of the known tokens', () => {
    const bad = { ...MODEL, requires: ['telepathy'] };
    expect(validateJson(assessmentSchema(), bad).length).toBeGreaterThan(0);
  });

  it('does not ask the model for the context load, which is arithmetic', () => {
    expect(Object.keys(assessmentSchema().properties!)).not.toContain('contextLoad');
  });

  it('sends the objective, the criteria, the scope and the facts, and never a model name', () => {
    const input: RuleInput = {
      task: task({ scope: { paths: ['src/host/**'], subsystems: ['host'], confidence: 'high' } }),
      policy: policyWith({ risk: [{ paths: ['src/host/**'], level: 'critical', why: 'the host protocol' }] }),
      facts: facts(['src/host/protocol.ts']),
    };
    const text = assessorInput(input);
    expect(text).toContain('Add a setting for the idle timeout');
    expect(text).toContain('src/host/**');
    expect(text).toContain('src/host/protocol.ts');
    expect(text).toContain('the host protocol');
    expect(text).toContain('Configured verification: none');
    expect(text.toLowerCase()).not.toMatch(/\b(haiku|sonnet|opus|gpt|tier)\b/);
  });
});

describe('the inputs hash', () => {
  const base = {
    objective: 'Add a setting',
    acceptanceCriteria: ['it is read at launch'],
    scope: { paths: ['src/**'], subsystems: [], confidence: 'low' as const },
    verification: { stages: [] },
    repoPolicyVersion: 'v1-abc',
    upstream: [],
  };

  it('is stable over formatting and over the order of globs', () => {
    expect(inputsHash(base)).toBe(inputsHash({ ...base, objective: '  Add a setting  ' }));
    expect(inputsHash({ ...base, scope: { paths: ['a', 'b'], subsystems: [], confidence: 'low' } })).toBe(
      inputsHash({ ...base, scope: { paths: ['b', 'a'], subsystems: [], confidence: 'low' } }),
    );
  });

  it.each([
    ['the objective', { objective: 'Add two settings' }],
    ['the criteria', { acceptanceCriteria: ['something else'] }],
    ['the scope', { scope: { paths: ['test/**'], subsystems: [], confidence: 'low' as const } }],
    ['the repository policy', { repoPolicyVersion: 'v1-def' }],
    ['an upstream result', { upstream: ['abc123'] }],
  ])('changes when %s changes', (_what, change) => {
    expect(inputsHash({ ...base, ...change })).not.toBe(inputsHash(base));
  });

  it('carries the assessor version, so an older assessor’s answer is never reused', () => {
    expect(inputsHash(base)).toMatch(/^asm-[0-9a-f]{8}$/);
    expect(ASSESSOR_VERSION).toBe('asm-1');
  });
});
