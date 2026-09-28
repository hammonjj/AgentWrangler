/**
 * The local planner through the task runner (plan §11.5): real git in a
 * temporary repository, so the excerpt comes from a real `git ls-files`, and
 * the mission's policy decides whether the local path is tried at all.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import type { CompletionRequest, CompletionResult, StructuredCompletion } from '../../src/orchestration/completion/structuredCompletion';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { TaskRunner } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { Planner, type PlannerOutput } from '../../src/orchestration/policy/planner';
import { gatherRepoContext } from '../../src/orchestration/policy/repoContext';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { missionViewOf } from '../../src/orchestration/view/missionViews';
import { nodeExec } from '../../src/orchestration/worktrees/exec';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import type { ExecutionPolicy } from '../../src/shared/orchestration/types';

const savedEnv: Record<string, string | undefined> = {};
let gitConfig: string;

beforeAll(() => {
  gitConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gitcfg-')), 'config');
  fs.writeFileSync(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(path.dirname(gitConfig), { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PLAN: PlannerOutput = {
  decomposition: 'single',
  risks: [],
  tasks: [
    {
      key: 't1',
      title: 'Synthetic task',
      objective: 'Synthetic objective.',
      acceptanceCriteria: ['it works'],
      scope: { paths: ['src/billing/**'], subsystems: ['billing'] },
      dependsOn: [],
      verification: ['check'],
      assessmentHints: { kind: 'feature', complexity: 'involved', risk: 'low' },
      whySeparate: '',
    },
  ],
};

class RecordingLocal implements StructuredCompletion {
  readonly calls: CompletionRequest[] = [];
  constructor(private answer: 'plan' | 'lost') {}
  async complete<T>(req: CompletionRequest): Promise<CompletionResult<T>> {
    this.calls.push(req);
    const base = { model: 'local-model', attempts: 1, usage: {}, durationMs: 1, local: { source: 'local:box' } };
    return this.answer === 'plan' ? { ok: true, value: PLAN as T, ...base } : { ok: false, reason: 'error', message: 'connection refused', infra: true, ...base };
  }
}

let tmp: string;
let repo: string;
let dataDir: string;
let runners: TaskRunner[];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-localplan-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(repo, 'src', 'billing'), { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Synthetic\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(repo, 'src', 'billing', 'invoice.ts'), 'export function renderInvoice() {}\n');
  fs.mkdirSync(path.join(repo, 'ignored'));
  fs.writeFileSync(path.join(repo, 'ignored', 'secret.ts'), 'nope\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  expect(new RepoPolicyStore(path.join(dataDir, 'repos')).save(identityFor(repo), { verification: { check: { run: ['/bin/sh', '-c', 'true'] } }, review: { when: 'never' } }).ok).toBe(true);
  runners = [];
});

afterEach(() => {
  for (const r of runners) r.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function rig(policy: ExecutionPolicy, answer: 'plan' | 'lost' = 'plan') {
  const registry = new SessionRegistry(memento());
  const executors = createSimulatedExecutors({ registry });
  const harness = new SimulatedHarness({ scenario: { tasks: {} }, sessions: executors.sessions });
  const hosted = new SimulatedCompletion([{ output: PLAN }]);
  const local = new RecordingLocal(answer);
  const planner = new Planner({
    completion: hosted,
    local: {
      pick: () => ({ completion: local, model: 'local-model', source: 'local:box', tier: 'standard', contextWindow: 65_536 }),
      gather: (r, l) => gatherRepoContext(r, l, { exec: nodeExec }),
    },
  });
  const runner = new TaskRunner({
    store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')),
    harnesses: new Map([['claude-code', harness]]),
    sessions: executors.sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) => WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: [] }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    planner,
    globalPolicy: () => policy,
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    previewDelayMs: 10,
  });
  runners.push(runner);
  return { runner, hosted, local };
}

describe('the local planner through the task runner', () => {
  it('preferLocal in the policy: the local model plans from a git-listed excerpt, and review says so', async () => {
    const r = rig({ preferences: { preferLocal: true } });
    const m = await r.runner.planMission({ folder: repo, objective: 'Fix the invoice total.' });
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');
    expect(r.hosted.calls).toHaveLength(0);
    expect(r.local.calls).toHaveLength(1);
    const input = r.local.calls[0].input;
    expect('workspace' in r.local.calls[0]).toBe(false);
    expect(input).toContain('from git ls-files');
    expect(input).toContain('## src/billing/invoice.ts');
    expect(input).not.toContain('ignored/secret.ts');
    const run = r.runner.get(m.id)!.planning![0];
    expect(run).toMatchObject({ state: 'proposed', model: 'local-model', source: 'local:box' });
    const v = missionViewOf(r.runner.get(m.id)!, { actions: () => [], canPlan: true });
    expect(v.planner?.text).toMatch(/^Planned by local-model \(local\)/);
  });

  it('strategy prefer-local counts too; a lost server falls back to the hosted planner, recorded on the run', async () => {
    const r = rig({ preferences: { strategy: 'prefer-local' } }, 'lost');
    const m = await r.runner.planMission({ folder: repo, objective: 'Fix the invoice total.' });
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');
    expect(r.local.calls).toHaveLength(1);
    expect(r.hosted.calls[0].options).toMatchObject({ cwd: repo, permissionMode: 'plan', tools: ['Read', 'Grep', 'Glob'] });
    const run = r.runner.get(m.id)!.planning![0];
    expect(run).toMatchObject({ model: 'opus', fellBack: { from: 'local-model' } });
    expect(run.source).toBeUndefined();
  });

  it('no preference, or local ruled out: hosted only, the local model never asked', async () => {
    for (const policy of [{}, { preferences: { preferLocal: true }, exclusions: { disableLocal: true } }, { preferences: { preferLocal: true }, caps: { location: 'hosted-only' as const } }]) {
      const r = rig(policy);
      const m = await r.runner.planMission({ folder: repo, objective: 'Fix the invoice total.' });
      await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');
      expect(r.local.calls).toHaveLength(0);
      expect(r.hosted.calls).toHaveLength(1);
      expect(r.runner.get(m.id)!.planning![0].fellBack).toBeUndefined();
    }
  });
});
