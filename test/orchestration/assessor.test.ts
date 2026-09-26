/**
 * The assessor as a whole (plan §8.3, #37): the deterministic pass, one
 * simulated completion, the combination, the cache, and every way the model
 * can let it down.
 *
 * No network and no repository: the completion is `SimulatedCompletion` over
 * scripted answers, and the file system is a plain object.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { ASSESSOR_VERSION, type ModelAnswer } from '../../src/orchestration/policy/assessment';
import { ASSESSOR_EFFORT, Assessor, scopeFacts, type AssessRequest, type AssessorFs } from '../../src/orchestration/policy/assessor';
import { DEFAULT_REPO_POLICY, type RepoPolicy } from '../../src/shared/orchestration/repoPolicy';

const T0 = 1_790_000_000_000;

const ANSWER: ModelAnswer = {
  complexity: { value: 'involved', confidence: 'high', evidence: 'several call sites' },
  breadth: { value: 'few-files', confidence: 'medium', evidence: 'one module' },
  risk: { value: 'low', confidence: 'high', evidence: 'easy to change back' },
  ambiguity: { value: 'clear', confidence: 'high', evidence: 'the criteria are testable' },
  verifiability: { value: 'strong', confidence: 'high', evidence: 'the suite covers it' },
  kind: { value: 'feature', confidence: 'high', evidence: 'it adds behaviour' },
  domains: ['typescript'],
  requires: ['edit'],
};

/** A repository the walk can see: directories are objects, files are byte counts. */
type Tree = { [name: string]: Tree | number };

function fakeFs(tree: Tree): AssessorFs {
  const at = (p: string): Tree | number | undefined => {
    const parts = p.split('/').filter((x) => x !== '' && x !== '.');
    let node: Tree | number | undefined = tree;
    for (const part of parts) {
      if (typeof node !== 'object' || node === null) return undefined;
      node = node[part];
    }
    return node;
  };
  return {
    readdirSync(dir) {
      const node = at(dir.replace(/^\/repo\/?/, ''));
      if (typeof node !== 'object') throw new Error(`ENOENT: ${dir}`);
      return Object.entries(node).map(([name, child]) => ({
        name,
        isDirectory: () => typeof child === 'object',
        isFile: () => typeof child === 'number',
      }));
    },
    statSync(file) {
      const node = at(file.replace(/^\/repo\/?/, ''));
      if (typeof node !== 'number') throw new Error(`ENOENT: ${file}`);
      return { size: node, isFile: () => true };
    },
  };
}

const TREE: Tree = {
  src: { core: { 'store.ts': 4_000, 'config.ts': 2_000 }, host: { 'protocol.ts': 9_000 } },
  test: { 'store.test.ts': 1_000 },
  node_modules: { junk: { 'huge.ts': 9_000_000 } },
  '.git': { 'HEAD': 20 },
  'README.md': 500,
};

function request(overrides: Partial<AssessRequest> = {}): AssessRequest {
  return {
    taskId: 'task-1',
    taskRevision: 1,
    task: {
      objective: 'Add a setting for the idle timeout',
      acceptanceCriteria: ['the setting is read at launch'],
      scope: { paths: ['src/core/**'], subsystems: [], confidence: 'medium' },
      verification: { stages: [] },
      createdBy: 'user',
    },
    repoRoot: '/repo',
    policy: DEFAULT_REPO_POLICY,
    repoPolicyVersion: 'default',
    ...overrides,
  };
}

function assessorWith(responses: ConstructorParameters<typeof SimulatedCompletion>[0], tree: Tree = TREE) {
  const completion = new SimulatedCompletion(responses);
  let n = 0;
  const assessor = new Assessor({
    completion,
    fs: fakeFs(tree),
    now: () => T0,
    id: () => `id-${++n}`,
  });
  return { assessor, completion };
}

describe('scopeFacts', () => {
  it('finds what the globs name, sizes it, and never walks into node_modules or .git', () => {
    const f = scopeFacts('/repo', ['src/**'], fakeFs(TREE));
    expect(f.known).toBe(true);
    expect(f.files).toEqual(['src/core/store.ts', 'src/core/config.ts', 'src/host/protocol.ts']);
    expect(f.bytes).toBe(15_000);
    expect(f.directories).toEqual(['src/core', 'src/host']);
    expect(f.extensions).toEqual(['.ts']);
  });

  it('counts the tests it found, and the top-level areas the scope spans', () => {
    const f = scopeFacts('/repo', ['src/core/**', 'test/**'], fakeFs(TREE));
    expect(f.testFiles).toBe(1);
    expect(f.topLevels).toEqual(['src', 'test']);
  });

  it('says nothing is known when no glob was predicted, rather than that nothing is touched', () => {
    expect(scopeFacts('/repo', [], fakeFs(TREE))).toMatchObject({ known: false, files: [] });
  });

  it('survives a repository it cannot read', () => {
    const broken: AssessorFs = {
      readdirSync() {
        throw new Error('EACCES');
      },
      statSync() {
        throw new Error('EACCES');
      },
    };
    expect(scopeFacts('/repo', ['src/**'], broken)).toMatchObject({ known: false, files: [], bytes: 0 });
  });

  it('does not claim a scope that named nothing is known: it is indistinguishable from unreadable', () => {
    expect(scopeFacts('/repo', ['nothing/**'], fakeFs(TREE)).known).toBe(false);
  });
});

describe('Assessor', () => {
  it('asks once, cheaply, and returns an assessment that says where each value came from', async () => {
    const { assessor, completion } = assessorWith([{ output: ANSWER }]);
    const a = await assessor.assess(request());
    expect(completion.calls).toHaveLength(1);
    expect(completion.calls[0].options.effort).toBe(ASSESSOR_EFFORT);
    expect(a).toMatchObject({
      taskId: 'task-1',
      taskRevision: 1,
      assessorVersion: ASSESSOR_VERSION,
      createdAt: T0,
      confidence: 'high',
    });
    expect(a.dimensions.complexity).toMatchObject({ value: 'involved', from: 'model' });
    expect(a.dimensions.contextLoad).toMatchObject({ value: 'small', from: 'rule' });
    expect(a.llm?.model).toBeTruthy();
    expect(a.inputsHash).toMatch(/^asm-/);
  });

  it('sends the objective and the facts, and no code', async () => {
    const { assessor, completion } = assessorWith([{ output: ANSWER }]);
    await assessor.assess(request());
    const prompt = completion.calls[0].prompt;
    expect(prompt).toContain('Add a setting for the idle timeout');
    expect(prompt).toContain('src/core/store.ts');
    expect(prompt).not.toContain('export ');
  });

  it('keeps a risk a path rule raised whatever the model answers', async () => {
    const policy: RepoPolicy = {
      ...DEFAULT_REPO_POLICY,
      risk: [{ paths: ['src/core/**'], level: 'critical', why: 'the store format is persisted' }],
    };
    const { assessor } = assessorWith([{ output: ANSWER }]);
    const a = await assessor.assess(request({ policy, repoPolicyVersion: 'v1-risk' }));
    expect(a.dimensions.risk).toMatchObject({ value: 'critical', from: 'rule' });
  });

  it('gives a rules-only assessment at low confidence when the output is never schema-valid', async () => {
    // The completion itself retries once; a second bad answer is the end of it (§8.3).
    const { assessor, completion } = assessorWith([{ raw: 'not json at all' }, { raw: '{"complexity": "banana"}' }]);
    const a = await assessor.assess(request());
    expect(completion.calls).toHaveLength(2);
    expect(a.confidence).toBe('low');
    expect(a.llm).toBeUndefined();
    expect(a.dimensions.risk).toMatchObject({ from: 'rule' });
    expect(a.evidence.join(' ')).toContain('rules-only');
  });

  it.each([['rate-limit'], ['overloaded'], ['context-overflow']] as const)('carries on after a %s error', async (error) => {
    const { assessor } = assessorWith([{ error }]);
    const a = await assessor.assess(request());
    expect(a.confidence).toBe('low');
    expect(a.dimensions.contextLoad.value).toBe('small');
  });

  it('assesses from rules alone when there is no way to reach a model at all', async () => {
    const assessor = new Assessor({ fs: fakeFs(TREE), now: () => T0, id: () => 'id-1' });
    const a = await assessor.assess(request());
    expect(a.confidence).toBe('low');
    expect(a.kind.value).toBe('feature');
  });

  it('answers a second time from the cache, without paying for another call', async () => {
    const { assessor, completion } = assessorWith([{ output: ANSWER }]);
    const first = await assessor.assess(request());
    const second = await assessor.assess(request());
    expect(completion.calls).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('asks again when the task, its scope or the repository policy changed', async () => {
    const { assessor, completion } = assessorWith([{ output: ANSWER }, { output: ANSWER }, { output: ANSWER }]);
    await assessor.assess(request());
    await assessor.assess(request({ task: { ...request().task, objective: 'Something else entirely' } }));
    await assessor.assess(request({ repoPolicyVersion: 'v1-changed' }));
    expect(completion.calls).toHaveLength(3);
  });

  it('asks again for a new revision of the same task, and records the revision it assessed', async () => {
    const { assessor, completion } = assessorWith([{ output: ANSWER }, { output: ANSWER }]);
    await assessor.assess(request());
    const next = await assessor.assess(request({ taskRevision: 2 }));
    expect(completion.calls).toHaveLength(2);
    expect(next.taskRevision).toBe(2);
  });

  it('never serves a user’s edit from the cache, and records it as the user’s', async () => {
    const { assessor } = assessorWith([{ output: ANSWER }, { output: ANSWER }]);
    const plain = await assessor.assess(request());
    const edited = await assessor.assess(request({ edits: { risk: 'high' } }));
    expect(edited.id).not.toBe(plain.id);
    expect(edited.dimensions.risk).toMatchObject({ value: 'high', from: 'user' });
  });
});
