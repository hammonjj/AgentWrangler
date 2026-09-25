import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_TIMEOUT_SEC,
  DEFAULT_REPO_POLICY,
  canonicalPolicy,
  commandForStrategy,
  hasVerification,
  parseRepoPolicy,
  resolveRepoPolicy,
  validateRepoPolicyFile,
  worktreeRootFor,
  type RepoPolicyFile,
} from '../../src/shared/orchestration/repoPolicy';

function errorsOf(doc: unknown): string[] {
  const r = validateRepoPolicyFile(doc);
  return r.ok ? [] : r.errors.map((e) => e.path);
}

describe('validateRepoPolicyFile', () => {
  it.each<[string, unknown]>([
    ['an empty file', {}],
    ['the plan §13.6 example', {
      worktrees: { root: '../<repo>.aw', setup: [{ link: 'node_modules' }] },
      verification: {
        typecheck: { run: ['npm', 'run', 'typecheck'], timeoutSec: 300 },
        unit: { run: ['npm', 'test'], timeoutSec: 900 },
        missionDefault: ['typecheck', 'unit'],
      },
      risk: [{ paths: ['src/shared/sessionProtocol.ts'], level: 'critical', why: 'wire protocol' }],
      exclusive: [],
      finish: { default: 'merge-local' },
    }],
    ['an absolute worktree root', { worktrees: { root: '/Volumes/work/aw' } }],
    ['every setup step kind', { worktrees: { setup: [{ link: 'node_modules' }, { copy: '.env' }, { run: ['npm', 'ci'], timeoutSec: 60 }] } }],
    ['an exclusive resource with paths', { exclusive: [{ id: 'unity-editor:Game', paths: ['Assets/**'], why: 'one Editor per project' }] }],
    ['a version and a $schema', { v: 1, $schema: 'x' }],
  ])('accepts %s', (_name, doc) => {
    expect(validateRepoPolicyFile(doc)).toMatchObject({ ok: true });
  });

  it.each<[string, unknown, string[]]>([
    ['a non-object', [], ['']],
    ['an unknown top-level field', { verifcation: {} }, ['verifcation']],
    ['a future version', { v: 2 }, ['v']],
    ['a shell string command', { verification: { unit: { run: 'npm test' } } }, ['verification.unit.run']],
    ['an empty argv', { verification: { unit: { run: [] } } }, ['verification.unit.run']],
    ['a non-string argument', { verification: { unit: { run: ['npm', 3] } } }, ['verification.unit.run[1]']],
    ['an empty program name', { verification: { unit: { run: [' '] } } }, ['verification.unit.run[0]']],
    ['a command with an unknown field', { verification: { unit: { run: ['npm'], shell: true } } }, ['verification.unit.shell']],
    ['a bad command name', { verification: { Unit_Tests: { run: ['npm'] } } }, ['verification.Unit_Tests']],
    ['a zero timeout', { verification: { unit: { run: ['npm'], timeoutSec: 0 } } }, ['verification.unit.timeoutSec']],
    ['a fractional timeout', { verification: { unit: { run: ['npm'], timeoutSec: 1.5 } } }, ['verification.unit.timeoutSec']],
    ['missionDefault not a list', { verification: { missionDefault: 'unit' } }, ['verification.missionDefault']],
    ['a worktree root inside the checkout', { worktrees: { root: 'wt' } }, ['worktrees.root']],
    ['the parent as worktree root', { worktrees: { root: '..' } }, ['worktrees.root']],
    ['a ~ worktree root', { worktrees: { root: '~/wt' } }, ['worktrees.root']],
    ['a setup step with two kinds', { worktrees: { setup: [{ link: 'a', copy: 'b' }] } }, ['worktrees.setup[0]']],
    ['a setup step with none', { worktrees: { setup: [{}] } }, ['worktrees.setup[0]']],
    ['a link escaping the repo', { worktrees: { setup: [{ link: '../other/node_modules' }] } }, ['worktrees.setup[0].link']],
    ['an absolute copy', { worktrees: { setup: [{ copy: '/etc/passwd' }] } }, ['worktrees.setup[0].copy']],
    ['a setup run as a string', { worktrees: { setup: [{ run: 'npm ci' }] } }, ['worktrees.setup[0].run']],
    ['a risk rule without why', { risk: [{ paths: ['a'], level: 'high' }] }, ['risk[0].why']],
    ['a risk rule with a bad level', { risk: [{ paths: ['a'], level: 'severe', why: 'x' }] }, ['risk[0].level']],
    ['a risk rule without paths', { risk: [{ paths: [], level: 'high', why: 'x' }] }, ['risk[0].paths']],
    ['a duplicate exclusive id', { exclusive: [{ id: 'db' }, { id: 'db' }] }, ['exclusive[1].id']],
    ['a bad exclusive id', { exclusive: [{ id: 'has space' }] }, ['exclusive[0].id']],
    ['finish discard as default', { finish: { default: 'discard' } }, ['finish.default']],
    ['several problems at once', { risk: 'x', finish: { default: 'yolo', gate: [1] } }, ['risk', 'finish.default', 'finish.gate[0]']],
  ])('rejects %s with a precise path', (_name, doc, paths) => {
    expect(errorsOf(doc)).toEqual(paths);
  });

  it('explains a shell string plainly', () => {
    const r = validateRepoPolicyFile({ verification: { unit: { run: 'npm test' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/argv array.*not a shell string/);
  });

  it('reports JSON syntax errors as one document-level error', () => {
    const r = parseRepoPolicy('{ "risk": [ }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([{ path: '', message: expect.stringMatching(/^not valid JSON/) }]);
  });
});

describe('resolveRepoPolicy', () => {
  const resolve = (...layers: RepoPolicyFile[]) => {
    const r = resolveRepoPolicy(layers);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.policy;
  };

  it('gives the documented defaults with no policy: no verification, no risk, sibling worktrees', () => {
    const p = resolve();
    expect(p).toEqual(DEFAULT_REPO_POLICY);
    expect(hasVerification(p)).toBe(false);
    expect(p.risk).toEqual([]);
    expect(worktreeRootFor(p, 'proj')).toBe('../proj.aw');
  });

  it('overrides field by field, keeping every default a file does not set', () => {
    const p = resolve({ finish: { default: 'pull-request' } });
    expect(p.finish).toEqual({ default: 'pull-request', gate: [] });
    expect(p.worktrees).toEqual(DEFAULT_REPO_POLICY.worktrees);
    const q = resolve({ worktrees: { setup: [{ link: 'node_modules' }] } });
    expect(q.worktrees).toEqual({ root: '../<repo>.aw', setup: [{ link: 'node_modules' }] });
  });

  it('lets a later layer replace one command and keep the others', () => {
    const p = resolve(
      { verification: { unit: { run: ['npm', 'test'], timeoutSec: 900 }, lint: { run: ['npm', 'run', 'lint'] } } },
      { verification: { unit: { run: ['npx', 'vitest', 'run'] } } },
    );
    expect(p.verification.commands).toEqual({
      unit: { run: ['npx', 'vitest', 'run'], timeoutSec: DEFAULT_COMMAND_TIMEOUT_SEC },
      lint: { run: ['npm', 'run', 'lint'], timeoutSec: DEFAULT_COMMAND_TIMEOUT_SEC },
    });
  });

  it('replaces lists instead of appending, so a layer can empty one', () => {
    const p = resolve(
      { risk: [{ paths: ['a'], level: 'high', why: 'x' }], worktrees: { setup: [{ link: 'node_modules' }] } },
      { risk: [], worktrees: { setup: [] } },
    );
    expect(p.risk).toEqual([]);
    expect(p.worktrees.setup).toEqual([]);
  });

  it('rejects missionDefault or gate naming a command that does not exist', () => {
    const r = resolveRepoPolicy([{ verification: { unit: { run: ['npm', 'test'] }, missionDefault: ['unit', 'e2e'] }, finish: { gate: ['build'] } }]);
    expect(r).toEqual({
      ok: false,
      errors: [
        { path: 'verification.missionDefault[1]', message: 'no verification command named "e2e"' },
        { path: 'finish.gate[0]', message: 'no verification command named "build"' },
      ],
    });
  });

  it('does not let a resolved policy alias its input', () => {
    const file: RepoPolicyFile = { verification: { unit: { run: ['npm', 'test'] } } };
    const p = resolve(file);
    p.verification.commands.unit.run.push('--watch');
    expect(file.verification?.unit).toEqual({ run: ['npm', 'test'] });
    expect(DEFAULT_REPO_POLICY.verification.commands).toEqual({});
  });
});

describe('using a policy', () => {
  const p = (() => {
    const r = resolveRepoPolicy([{ verification: { unit: { run: ['npm', 'test'] } } }]);
    if (!r.ok) throw new Error('fixture');
    return r.policy;
  })();

  it('maps command:<name> to the policy command and nothing else', () => {
    expect(commandForStrategy(p, 'command:unit')).toEqual({ run: ['npm', 'test'], timeoutSec: DEFAULT_COMMAND_TIMEOUT_SEC });
    expect(commandForStrategy(p, 'command:e2e')).toBeUndefined();
    expect(commandForStrategy(p, 'command:toString')).toBeUndefined();
    expect(commandForStrategy(p, 'unit')).toBeUndefined();
    expect(commandForStrategy(p, 'command:unit; rm -rf /')).toBeUndefined();
  });

  it('canonicalises independent of key order', () => {
    const a = resolveRepoPolicy([{ finish: { default: 'keep' }, risk: [{ paths: ['a'], level: 'high', why: 'x' }] }]);
    const b = resolveRepoPolicy([{ risk: [{ why: 'x', level: 'high', paths: ['a'] }], finish: { default: 'keep' } }]);
    if (!a.ok || !b.ok) throw new Error('fixture');
    expect(canonicalPolicy(a.policy)).toBe(canonicalPolicy(b.policy));
  });
});

describe("this repository's policy", () => {
  it('is valid and resolves with its gate and mission checks', () => {
    const text = fs.readFileSync(path.join(__dirname, '../../docs/repo-policies/agentwrangler.json'), 'utf8');
    const parsed = parseRepoPolicy(text);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const r = resolveRepoPolicy([parsed.file]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.worktrees.setup).toEqual([{ link: 'node_modules' }]);
    expect(r.policy.verification.missionDefault).toEqual(['typecheck', 'unit']);
    expect(r.policy.finish).toEqual({ default: 'merge-local', gate: ['typecheck', 'unit', 'build'] });
    expect(r.policy.risk.some((x) => x.paths.includes('src/claude/hookInstall.ts'))).toBe(true);
  });
});
