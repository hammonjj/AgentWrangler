/**
 * Planned missions (#43, §29 P8) end to end: real git in a temporary
 * repository, the real worktree manager and repo policy store, and attempts
 * played by the simulated harness through the real launch path.
 *
 * What these hold to: a hand-written plan is validated and reviewed, nothing
 * runs before Approve and start, and then the tasks run one at a time in
 * dependency order in **one** mission worktree on `aw/<mission>/mission`,
 * each attempt starting from the head the task before it left.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { TaskRunner, type TaskRunnerDeps } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import { missionViewOf } from '../../src/orchestration/view/missionViews';
import type { SimAttempt, SimScenario } from '../../src/shared/orchestration/simulation';
import type { AttemptRecord, IntegrationRecord, TaskFinalRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
import type { ExecutionAttempt, Mission, Task } from '../../src/shared/orchestration/types';
import type { PlanTaskDraft } from '../../src/shared/orchestration/plan';
import type { Exec } from '../../src/orchestration/worktrees/exec';
import { snapshot, status } from './routingFixtures';

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

let tmp: string;
let repo: string;
let dataDir: string;
let runners: TaskRunner[];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mission-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  // The repository's one check: fails when `check.flag` is there.
  fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nif [ -f check.flag ]; then echo " FAIL  test/a.test.ts"; exit 1; fi\nexit 0\n', { mode: 0o755 });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  const saved = new RepoPolicyStore(path.join(dataDir, 'repos')).save(identityFor(repo), {
    worktrees: { setup: [{ link: 'node_modules' }] },
    verification: { check: { run: ['/bin/sh', 'check.sh'] } },
    // No reviewer here: the command check is the whole verdict.
    review: { when: 'never' },
  });
  expect(saved.ok).toBe(true);
  runners = [];
});

afterEach(() => {
  for (const r of runners) r.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Rig {
  runner: TaskRunner;
  harness: SimulatedHarness;
  scenario: SimScenario;
  telemetry: TelemetryRecord[];
  notices: { title: string; body: string }[];
  registry: SessionRegistry;
}

function rig(overrides: Partial<TaskRunnerDeps> = {}): Rig {
  const registry = new SessionRegistry(memento());
  const executors = createSimulatedExecutors({ registry });
  // Mutable: a test scripts each task by id once the plan has given them ids.
  const scenario: SimScenario = { tasks: {} };
  const harness = new SimulatedHarness({ scenario, sessions: executors.sessions });
  const telemetry: TelemetryRecord[] = [];
  const notices: { title: string; body: string }[] = [];
  const runner = new TaskRunner({
    store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')),
    harnesses: new Map([['claude-code', harness]]),
    sessions: executors.sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) =>
      WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: loaded.policy.worktrees.setup }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    telemetry: { append: (r) => (telemetry.push(r), true) },
    notify: (n) => notices.push(n),
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    previewDelayMs: 10,
    ...overrides,
  });
  runners.push(runner);
  return { runner, harness, scenario, telemetry, notices, registry };
}

const ROUTE = { harness: 'claude-code', model: 'claude-simulated', effort: 'low' } as const;

/** Written out of run order on purpose: t1 needs t3, t3 needs t2. They should run t2, t3, t1. */
const PLAN: PlanTaskDraft[] = [
  { title: 'Document the constant', objective: 'Synthetic: write docs for it.', acceptanceCriteria: ['docs mention a'], dependsOn: [{ key: 't3', kind: 'order' }] },
  { title: 'Add a constant', objective: 'Synthetic: add a.', acceptanceCriteria: ['a.ts exports a'] },
  { title: 'Use the constant', objective: 'Synthetic: use a.', acceptanceCriteria: ['b.ts uses a'], dependsOn: [{ key: 't2', kind: 'code' }] },
];

const edit = (files: Record<string, string>): SimAttempt => ({ behaviour: 'edit', files });

function byKey(m: Mission, key: string): Task {
  return m.tasks.find((t) => t.key === key)!;
}

/** Script each task's attempts by key. */
function script(r: Rig, m: Mission, attempts: Record<string, SimAttempt[]>): void {
  for (const [key, list] of Object.entries(attempts)) r.scenario.tasks![byKey(m, key).id] = list;
}

describe('planned missions: escalation (#41)', () => {
  const SONNET = { harness: 'claude-code', model: 'sonnet', effort: 'low' } as const;
  const FAILS = { behaviour: 'fail-verification', files: { 'a.txt': 'bad\n', 'check.flag': '1\n' } } as const;
  const one = (title: string): PlanTaskDraft[] => [{ title, objective: 'Synthetic.', acceptanceCriteria: ['a'] }];

  it('a mission capped at standard never runs expert, and the task says which cap stopped it', async () => {
    const r = rig({ routing: { snapshot: () => snapshot() } });
    const m = await r.runner.createMission({ folder: repo, title: 'Capped mission', objective: 'Synthetic.', tasks: one('Capped'), policy: { caps: { maxTier: 'standard', maxEffort: 'low' } } });
    script(r, m, { t1: [FAILS] });
    await r.runner.approvePlan(m.id, SONNET);
    await until(() => byKey(r.runner.get(m.id)!, 't1').escalations.at(-1)?.action === 'needs-human', 20_000, 'the ladder to end');
    const cur = r.runner.get(m.id)!;
    const t1 = byKey(cur, 't1');
    expect(t1.escalations.map((d) => [d.action, d.blockedBy ?? null])).toEqual([
      ['continue-with-feedback', null],
      ['raise-effort', 'cap'],
      ['raise-tier', 'cap'],
      ['switch-harness', 'limit'],
      ['needs-human', null],
    ]);
    expect(t1.escalations[2].reason).toBe('Would raise tier to expert; the mission is capped at standard.');
    expect(t1.stateReason).toContain('the mission is capped at standard');
    // Nothing ran above the cap.
    for (const a of cur.attempts) expect(cur.decisions.find((d) => d.id === a.routingDecisionId)!.resolution.target.tier).toBe('standard');
  });

  it('a repeated failure raises effort once (a planned route is not pinned), and a fresh attempt passes', async () => {
    const r = rig({ routing: { snapshot: () => snapshot() } });
    const m = await r.runner.createMission({ folder: repo, title: 'Effort mission', objective: 'Synthetic.', tasks: one('Effort') });
    script(r, m, { t1: [FAILS, edit({ 'a.txt': 'good\n' })] });
    await r.runner.approvePlan(m.id, SONNET);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
    const cur = r.runner.get(m.id)!;
    const t1 = byKey(cur, 't1');
    expect(t1.escalations.map((d) => d.action)).toEqual(['continue-with-feedback', 'raise-effort']);
    const last = cur.attempts.find((a) => a.id === t1.attemptIds.at(-1))!;
    expect(last).toMatchObject({ n: 3, escalation: { action: 'raise-effort', step: 2 } });
    expect(cur.decisions.find((d) => d.id === last.routingDecisionId)!.resolution.target).toMatchObject({ model: 'sonnet', tier: 'standard', effortNative: 'medium' });
    expect(t1.result?.acceptedBy).toBe('verification');
  });
});

describe('planned missions', () => {
  it('a hand-written three-task mission is validated, reviewed, approved and run in dependency order in one mission worktree', async () => {
    const r = rig();
    const created = await r.runner.createMission({ folder: repo, title: 'Constant mission', objective: 'Synthetic mission objective.', tasks: PLAN });
    const id = created.id;

    // Recorded straight into plan review, in run order, and nothing ran: no attempt, no worktree, no directory.
    expect(created.state).toBe('plan-review');
    expect(created.planned).toBe(true);
    expect(created.tasks.map((t) => t.key)).toEqual(['t2', 't3', 't1']);
    expect(created.base.ref).toBe('main');
    expect(r.harness.launches).toEqual([]);
    expect(created.worktrees).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'proj.aw'))).toBe(false);
    expect(r.runner.planIssues(id)).toEqual([]);

    // Review: a cycle is refused and shown, and the plan is left as it was.
    const t1 = byKey(created, 't1');
    const t2 = byKey(created, 't2');
    await expect(r.runner.editPlan(id, { kind: 'depend', taskId: t2.id, on: t1.id, dep: 'code' })).rejects.toThrow(/dependency cycle: t2 → t3 → t1 → t2/);
    expect(byKey(r.runner.get(id)!, 't2').dependsOn).toEqual([]);
    // An ordinary edit is kept, and bumps the revision.
    await r.runner.editPlan(id, { kind: 'update', taskId: t1.id, fields: { acceptanceCriteria: ['docs mention a', 'docs are short'] } });
    expect(byKey(r.runner.get(id)!, 't1')).toMatchObject({ revision: 2, acceptanceCriteria: ['docs mention a', 'docs are short'] });

    // The Missions view says the same thing, and offers Approve.
    const view = missionViewOf(r.runner.get(id)!, { actions: (taskId) => r.runner.actions(id, taskId) });
    expect(view).toMatchObject({ state: 'plan-review', planned: true, canApprove: true, cap: 8 });
    expect(view.tasks.map((t) => [t.key, t.editable])).toEqual([['t2', true], ['t3', true], ['t1', true]]);

    // Still nothing has run.
    expect(r.harness.launches).toEqual([]);

    script(r, r.runner.get(id)!, {
      t2: [edit({ 'src/a.ts': 'export const a = 1;\n' })],
      t3: [edit({ 'src/b.ts': "import { a } from './a';\nexport const b = a + 1;\n" })],
      t1: [edit({ 'docs/a.md': 'a is one.\n' })],
    });
    await r.runner.approvePlan(id, ROUTE);
    await until(() => r.runner.get(id)?.state === 'review', 20_000, 'the mission to reach review');
    const m = r.runner.get(id)!;

    // Ran in dependency order, one at a time.
    expect(r.harness.launches.map((l) => m.tasks.find((t) => t.id === l.request.origin.taskId)!.key)).toEqual(['t2', 't3', 't1']);
    // One worktree for the whole mission, on the mission branch; no task trees.
    expect(m.worktrees).toHaveLength(1);
    const tree = m.worktrees[0];
    expect(tree.purpose).toBe('integration');
    expect(tree.path).toMatch(/proj\.aw\/constant-mission-[a-z0-9]{6}\/_integration$/);
    expect(tree.branch).toMatch(/^aw\/constant-mission-[a-z0-9]{6}\/mission$/);
    expect(m.integration).toEqual({ branch: tree.branch, worktreeId: tree.id });
    expect(fs.lstatSync(path.join(tree.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(new Set(r.harness.launches.map((l) => l.request.cwd))).toEqual(new Set([tree.path]));

    // Each attempt started from what the task before it left: no merges needed.
    const [a2, a3, a1] = ['t2', 't3', 't1'].map((k) => m.attempts.find((a) => a.id === byKey(m, k).attemptIds[0])!);
    expect(a2.startCommit).toBe(m.base.commit);
    expect(a3.startCommit).toBe(byKey(m, 't2').result!.commit);
    expect(a1.startCommit).toBe(byKey(m, 't3').result!.commit);
    // Each attempt's diff is its own work, measured from where it started.
    expect([a2, a3, a1].map((a) => a.git?.filesChanged)).toEqual([1, 1, 1]);
    expect(m.tasks.every((t) => t.state === 'done' && t.result?.acceptedBy === 'verification' && t.result.branch === tree.branch)).toBe(true);
    expect(git(repo, 'log', '--format=%s', `${m.base.commit}..${tree.branch}`).split('\n')).toEqual([
      'aw: t1: attempt 1',
      'aw: t3: attempt 1',
      'aw: t2: attempt 1',
    ]);
    // Each later task saw the earlier work in its tree, and its prompt said so.
    expect(r.harness.launches[1].request.prompt).toContain('t2: Add a constant');

    // The primary checkout was never touched.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'branch', '--show-current')).toBe('main');

    // Telemetry: one task-final per task, metadata only; the view's aggregates add up.
    const finals = r.telemetry.filter((x): x is TaskFinalRecord => x.type === 'task-final');
    expect(finals.map((f) => [f.outcome, f.acceptedBy, f.attempts, f.firstAttemptPass, f.missionTasks])).toEqual([
      ['done', 'verification', 1, true, 3],
      ['done', 'verification', 1, true, 3],
      ['done', 'verification', 1, true, 3],
    ]);
    expect(JSON.stringify(finals)).not.toMatch(/Synthetic/);
    const done = missionViewOf(m, { actions: (taskId) => r.runner.actions(id, taskId) });
    expect(done.metrics).toMatchObject({ total: 3, done: 3, running: 0, attempts: 3, health: 'good', activeAgents: 0 });
    expect(done.review).toMatchObject({ commits: 3, finishes: ['merge-local', 'pull-request', 'keep', 'discard'] });

    // Mission review: merge locally, --no-ff, into the branch the primary checkout is on.
    const finished = await r.runner.finishMission(id, 'merge-local');
    expect(finished).toMatchObject({ state: 'completed', finish: 'merge-local' });
    expect(git(repo, 'log', '-1', '--format=%P', 'main').split(' ')).toHaveLength(2);
    expect(fs.readFileSync(path.join(repo, 'src', 'b.ts'), 'utf8')).toContain('a + 1');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // The merged tree and its branch are tidied away; nothing unmerged was touched.
    expect(finished.worktrees[0].state).toBe('removed');
    expect(fs.existsSync(tree.path)).toBe(false);
  });

  it('nothing runs before Approve and start, in any mode', async () => {
    const r = rig();
    const m = await r.runner.createMission({
      folder: repo,
      objective: 'Synthetic mission objective.',
      // Even asked for `assisted` (and, later, `auto`), a plan waits for review.
      policy: { mode: 'assisted' },
      tasks: [
        { title: 'A', objective: 'Synthetic a.', acceptanceCriteria: ['a'] },
        { title: 'B', objective: 'Synthetic b.', acceptanceCriteria: [] },
      ],
    });
    expect(m.policy.mode).toBe('manual');
    expect(m.state).toBe('plan-review');
    r.scenario.default = edit({ 'x.txt': 'x\n' });

    // No path in starts it: not the task buttons, not resume, not skip.
    await expect(r.runner.retry(m.id)).rejects.toThrow(/not waiting for a decision/);
    await expect(r.runner.accept(m.id)).rejects.toThrow(/no finished attempt/);
    await expect(r.runner.resume(m.id)).rejects.toThrow(/no interrupted attempt/);
    // Approve is refused while a task has no acceptance criteria.
    await expect(r.runner.approvePlan(m.id, ROUTE)).rejects.toThrow(/t2 has no acceptance criteria/);
    await new Promise((res) => setTimeout(res, 100));
    expect(r.harness.launches).toEqual([]);
    expect(r.runner.get(m.id)!.state).toBe('plan-review');
    expect(r.runner.get(m.id)!.planApprovedAt).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'proj.aw'))).toBe(false);

    // A restart does not start it either.
    const again = rig();
    await again.runner.recover();
    await new Promise((res) => setTimeout(res, 50));
    expect(again.runner.get(m.id)!.state).toBe('plan-review');
    expect(again.harness.launches).toEqual([]);
  });

  it('plan review assesses each task in the background, and shows the preview', async () => {
    const assessed: string[] = [];
    const r = rig({
      assessor: {
        assess: async (input) => {
          assessed.push(`${input.taskId}@${input.taskRevision}`);
          const d = <T extends string>(value: T) => ({ value, confidence: 'medium' as const, from: 'rule' as const });
          return {
            id: `asm-${input.taskId}-${input.taskRevision}`,
            taskId: input.taskId,
            taskRevision: input.taskRevision,
            inputsHash: 'h',
            assessorVersion: 'test',
            dimensions: { complexity: d('routine'), breadth: d('few-files'), risk: d('low'), ambiguity: d('clear'), verifiability: d('strong'), contextLoad: d('small') },
            kind: d('feature'),
            domains: [],
            requires: ['edit'],
            confidence: 'medium',
            evidence: [],
            createdAt: Date.now(),
          };
        },
      },
    });
    const m = await r.runner.createMission({ folder: repo, objective: 'Synthetic.', tasks: PLAN.slice(1, 2) });
    await until(() => (r.runner.get(m.id)?.assessments.length ?? 0) === 1, 5000, 'the preview assessment');
    const view = missionViewOf(r.runner.get(m.id)!, { actions: () => [] });
    expect(view.tasks[0].preview).toMatchObject({ summary: 'feature · routine · risk low', confidence: 'medium' });
    // An edit makes a new revision, and a new assessment for it — never a changed old one.
    await r.runner.editPlan(m.id, { kind: 'update', taskId: m.tasks[0].id, fields: { objective: 'Synthetic, again.' } });
    await until(() => (r.runner.get(m.id)?.assessments.length ?? 0) === 2, 5000, 'the second preview');
    expect(assessed).toEqual([`${m.tasks[0].id}@1`, `${m.tasks[0].id}@2`]);
    expect(r.harness.launches).toEqual([]);
  });

  it('a fresh retry restarts from the pre-task commit on a new -a<n> branch, in the same tree', async () => {
    // The user's own Retry: no automatic step first (one quality attempt, then the user).
    const r = rig({ escalationLimits: { qualityAttempts: 1 } });
    const m = await r.runner.createMission({
      folder: repo,
      title: 'Retry mission',
      objective: 'Synthetic.',
      tasks: [
        { title: 'Add a constant', objective: 'Synthetic: add a.', acceptanceCriteria: ['a.ts exports a'] },
        { title: 'Use the constant', objective: 'Synthetic: use a.', acceptanceCriteria: ['b.ts uses a'], dependsOn: [{ key: 't1', kind: 'code' }] },
      ],
    });
    script(r, m, {
      t1: [edit({ 'src/a.ts': 'export const a = 1;\n' })],
      t2: [
        { behaviour: 'fail-verification', files: { 'src/b.ts': 'broken\n', 'check.flag': '1\n' } },
        edit({ 'src/b.ts': "import { a } from './a';\n" }),
      ],
    });
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => byKey(r.runner.get(m.id)!, 't2').state === 'needs-human', 20_000, 't2 to fail its checks');
    let cur = r.runner.get(m.id)!;
    const tree = cur.worktrees[0];
    const missionBranch = tree.branch;
    const slug = missionBranch.split('/')[1];
    const preTask = byKey(cur, 't1').result!.commit;
    const failed = cur.attempts.find((a) => a.id === byKey(cur, 't2').attemptIds[0])!;
    expect(failed.startCommit).toBe(preTask);
    expect(r.runner.actions(m.id)).toEqual(expect.arrayContaining(['retry', 'skip', 'cancel']));
    expect(r.runner.actions(m.id)).not.toContain('accept');

    await r.runner.retry(m.id);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish after the retry');
    cur = r.runner.get(m.id)!;
    const retry = cur.attempts.find((a) => a.id === byKey(cur, 't2').attemptIds[1])!;
    // The retry started from the commit t2 started from, not from the rejected work…
    expect(retry.startCommit).toBe(preTask);
    expect(retry.n).toBe(2);
    // …on its own branch, in the same tree.
    expect(r.harness.launches[2].request.cwd).toBe(tree.path);
    expect(git(repo, 'rev-parse', `aw/${slug}/t2-a2`)).toBe(byKey(cur, 't2').result!.commit);
    // The rejected work is kept for comparison, off the mission branch.
    expect(git(repo, 'show', '--name-only', '--format=', `aw/${slug}/t2`).split('\n')).toEqual(expect.arrayContaining(['check.flag', 'src/b.ts']));
    expect(git(repo, 'ls-tree', '-r', '--name-only', missionBranch).split('\n')).not.toContain('check.flag');
    // The tree is back on the mission branch, which now holds t1 then t2's second attempt.
    expect(cur.worktrees).toHaveLength(1);
    expect(cur.worktrees[0].branch).toBe(missionBranch);
    expect(git(tree.path, 'branch', '--show-current')).toBe(missionBranch);
    expect(git(repo, 'rev-parse', missionBranch)).toBe(byKey(cur, 't2').result!.commit);
    const final = r.telemetry.filter((x): x is TaskFinalRecord => x.type === 'task-final').find((f) => f.taskId === byKey(cur, 't2').id)!;
    expect(final).toMatchObject({ outcome: 'done', attempts: 2, firstAttemptPass: false });
  });

  it('skipping a task takes its work off the mission branch; what needed it waits, what did not runs', async () => {
    const r = rig({ escalationLimits: { qualityAttempts: 1 } });
    const m = await r.runner.createMission({
      folder: repo,
      title: 'Skip mission',
      objective: 'Synthetic.',
      tasks: [
        { title: 'Flaky part', objective: 'Synthetic a.', acceptanceCriteria: ['a'] },
        { title: 'Needs it', objective: 'Synthetic b.', acceptanceCriteria: ['b'], dependsOn: [{ key: 't1', kind: 'code' }] },
        { title: 'Independent', objective: 'Synthetic c.', acceptanceCriteria: ['c'] },
      ],
    });
    script(r, m, {
      t1: [{ behaviour: 'fail-verification', files: { 'a.txt': 'bad\n', 'check.flag': '1\n' } }],
      t3: [edit({ 'c.txt': 'c\n' })],
    });
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => byKey(r.runner.get(m.id)!, 't1').state === 'needs-human', 20_000, 't1 to fail');
    const tree = r.runner.get(m.id)!.worktrees[0];
    await r.runner.skip(m.id);
    await until(() => byKey(r.runner.get(m.id)!, 't3').state === 'done', 20_000, 't3 to run');
    let cur = r.runner.get(m.id)!;
    expect(byKey(cur, 't1').state).toBe('skipped');
    expect(byKey(cur, 't2')).toMatchObject({ state: 'blocked', stateReason: 'blocked: upstream t1 skipped' });
    // t3 started from the base: t1's rejected work is not under it…
    const a3 = cur.attempts.find((a) => a.taskId === byKey(cur, 't3').id)!;
    expect(a3.startCommit).toBe(cur.base.commit);
    expect(git(repo, 'ls-tree', '-r', '--name-only', tree.branch).split('\n')).not.toContain('check.flag');
    // …but it is kept.
    expect(git(repo, 'ls-tree', '-r', '--name-only', `aw/${tree.branch.split('/')[1]}/t1`).split('\n')).toContain('a.txt');
    expect(r.runner.actions(m.id, byKey(cur, 't2').id)).toContain('skip');
    await r.runner.skip(m.id, byKey(cur, 't2').id);
    await until(() => r.runner.get(m.id)?.state === 'review', 5000, 'review');
    cur = r.runner.get(m.id)!;
    expect(cur.tasks.map((t) => t.state)).toEqual(['skipped', 'skipped', 'done']);
    // Keep: the branch stays, the mission is complete.
    const kept = await r.runner.finishMission(m.id, 'keep');
    expect(kept).toMatchObject({ state: 'completed', finish: 'keep' });
    expect(git(repo, 'rev-parse', '--verify', tree.branch)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('merge locally refuses a primary checkout that is dirty or on another branch, changing nothing', async () => {
    const r = rig();
    const m = await r.runner.createMission({ folder: repo, objective: 'Synthetic.', tasks: [{ title: 'One', objective: 'Synthetic.', acceptanceCriteria: ['x'] }] });
    script(r, m, { t1: [edit({ 'one.txt': '1\n' })] });
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'review');
    const head = git(repo, 'rev-parse', 'main');

    fs.writeFileSync(path.join(repo, 'README.md'), 'edited by the user\n');
    await expect(r.runner.finishMission(m.id, 'merge-local')).rejects.toThrow(/uncommitted changes on main/);
    git(repo, 'checkout', '-q', '--', 'README.md');
    git(repo, 'switch', '-q', '-c', 'elsewhere');
    await expect(r.runner.finishMission(m.id, 'merge-local')).rejects.toThrow(/on elsewhere, not main/);
    git(repo, 'switch', '-q', 'main');
    expect(git(repo, 'rev-parse', 'main')).toBe(head);
    expect(r.runner.get(m.id)!.state).toBe('review');

    // Discard: the tree goes, the branch stays, the mission is cancelled.
    const discarded = await r.runner.finishMission(m.id, 'discard');
    expect(discarded).toMatchObject({ state: 'cancelled', finish: 'discard' });
    expect(discarded.worktrees[0].state).toBe('removed');
    expect(git(repo, 'rev-parse', '--verify', discarded.integration !== 'none' ? discarded.integration.branch : 'x')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('open a PR pushes the one branch and opens it with gh', async () => {
    const remote = path.join(tmp, 'remote.git');
    git(tmp, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    const calls: string[][] = [];
    const real = (await import('../../src/orchestration/worktrees/exec')).nodeExec;
    const exec: Exec = async (file, args, opts) => {
      if (file === 'gh') {
        calls.push([...args]);
        return { code: 0, stdout: 'https://github.com/test/proj/pull/7\n', stderr: '' };
      }
      return real(file, args, opts);
    };
    const r = rig({ exec });
    const m = await r.runner.createMission({ folder: repo, title: 'PR mission', objective: 'Synthetic mission objective.', tasks: [{ title: 'One', objective: 'Synthetic.', acceptanceCriteria: ['x'] }] });
    script(r, m, { t1: [edit({ 'one.txt': '1\n' })] });
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'review');
    const done = await r.runner.finishMission(m.id, 'pull-request');
    const branch = done.integration !== 'none' ? done.integration.branch : '';
    expect(done).toMatchObject({ state: 'completed', finish: 'pull-request', finishResult: { pullRequestUrl: 'https://github.com/test/proj/pull/7' } });
    expect(git(remote, 'rev-parse', branch)).toBe(git(repo, 'rev-parse', branch));
    expect(calls[0]).toEqual(expect.arrayContaining(['pr', 'create', '--head', branch, '--base', 'main', '--title', 'PR mission']));
    // Nothing but the mission branch went to the remote.
    expect(git(remote, 'for-each-ref', '--format=%(refname)').split('\n')).toEqual([`refs/heads/${branch}`]);
  });
});

describe('parallel missions (#46)', () => {
  /** t1 and t2 are independent; t3 needs both. */
  const DIAMOND: PlanTaskDraft[] = [
    { title: 'Left', objective: 'Synthetic left.', acceptanceCriteria: ['left'] },
    { title: 'Right', objective: 'Synthetic right.', acceptanceCriteria: ['right'] },
    { title: 'Join', objective: 'Synthetic join.', acceptanceCriteria: ['join'], dependsOn: [{ key: 't1', kind: 'code' }, { key: 't2', kind: 'code' }] },
  ];
  const PAIR = DIAMOND.slice(0, 2);
  const slow = (files: Record<string, string | null>, followUps?: SimAttempt['followUps']): SimAttempt => ({ behaviour: 'edit', files, delayMs: 300, ...(followUps ? { followUps } : {}) });
  const integrations = (r: Rig) => r.telemetry.filter((x): x is IntegrationRecord => x.type === 'integration');
  const missionBranch = (m: Mission) => (m.integration !== 'none' ? m.integration.branch : '');
  const treeOf = (m: Mission) => m.worktrees.find((w) => w.purpose === 'integration')!;

  function setPolicy(extra: Record<string, unknown>): void {
    const saved = new RepoPolicyStore(path.join(dataDir, 'repos')).save(identityFor(repo), {
      worktrees: { setup: [{ link: 'node_modules' }] },
      verification: { check: { run: ['/bin/sh', 'check.sh'] } },
      review: { when: 'never' },
      ...extra,
    });
    expect(saved.ok).toBe(true);
  }

  it('independent tasks run at once in trees of their own, and are merged one at a time with the mission branch verified after each', async () => {
    const r = rig({ parallelTasks: () => true });
    const m0 = await r.runner.createMission({ folder: repo, title: 'Diamond', objective: 'Synthetic.', tasks: DIAMOND });
    script(r, m0, {
      t1: [slow({ 'left.txt': 'l\n' })],
      t2: [slow({ 'right.txt': 'r\n' })],
      t3: [edit({ 'join.txt': 'j\n' })],
    });
    const approved = await r.runner.approvePlan(m0.id, ROUTE);
    expect(approved.parallel).toBe(true);
    await until(() => r.runner.get(m0.id)?.state === 'review', 20_000, 'review');
    const m = r.runner.get(m0.id)!;
    const [a1, a2, a3] = ['t1', 't2', 't3'].map((k) => m.attempts.find((a) => a.id === byKey(m, k).attemptIds[0])!);

    // t1 and t2 ran at the same time, each in its own tree cut from the mission branch head (the base, then).
    expect(a1.createdAt).toBeLessThan(a2.endedAt!);
    expect(a2.createdAt).toBeLessThan(a1.endedAt!);
    const cwd = (a: ExecutionAttempt) => m.worktrees.find((w) => w.id === a.worktreeId)!;
    expect(new Set([cwd(a1).path, cwd(a2).path, cwd(a3).path]).size).toBe(3);
    expect([cwd(a1).purpose, cwd(a2).purpose]).toEqual(['task', 'task']);
    expect(a1.startCommit).toBe(m.base.commit);
    expect(a2.startCommit).toBe(m.base.commit);
    // t3 started once both were on the mission branch, from its head then.
    const merges = git(repo, 'rev-list', '--merges', '--first-parent', '--reverse', `${m.base.commit}..${missionBranch(m)}`).split('\n');
    expect(merges).toHaveLength(3);
    expect(a3.startCommit).toBe(merges[1]);
    const subjects = git(repo, 'log', '--format=%s', '--first-parent', `${m.base.commit}..${missionBranch(m)}`).split('\n');
    expect(subjects[0]).toBe('aw: merge t3: Join');
    expect(subjects.slice(1).sort()).toEqual(['aw: merge t1: Left', 'aw: merge t2: Right']);

    // Every task is done by merging; each merge was followed by the mission check, which passed.
    for (const t of m.tasks) expect(t).toMatchObject({ state: 'done', integration: { outcome: 'merged' } });
    const recs = integrations(r);
    expect(recs.filter((x) => x.event === 'merged')).toHaveLength(3);
    expect(recs.filter((x) => x.event === 'mission-verification').map((x) => x.verification)).toEqual(['passed', 'passed', 'passed']);
    expect(fs.existsSync(path.join(dataDir, 'orchestration', 'logs', `${a1.id}-mission`, 'check.log'))).toBe(true);
    expect(m.pendingMerge).toBeUndefined();
    // The base and the primary checkout were never touched.
    expect(git(repo, 'rev-parse', 'main')).toBe(m.base.commit);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // Finish: the gated local merge moves main to the checked merge of the mission branch.
    const head = git(repo, 'rev-parse', missionBranch(m));
    const done = await r.runner.finishMission(m.id, 'merge-local');
    expect(done).toMatchObject({ state: 'completed', finishResult: { note: expect.stringContaining('check passed') } });
    expect(git(repo, 'rev-parse', 'main')).toBe(done.finishResult!.mergeCommit);
    expect(git(repo, 'log', '-1', '--format=%P', 'main').split(' ')).toEqual([m.base.commit, head]);
    // Every tree was merged into main, so every tree is tidied away.
    expect(done.worktrees.every((w) => w.state === 'removed')).toBe(true);
    for (const f of ['left.txt', 'right.txt', 'join.txt']) expect(fs.existsSync(path.join(repo, f))).toBe(true);
  });

  it('a conflict becomes a conflict-resolution attempt in the task’s own tree, which resolves it and is merged', async () => {
    const r = rig({ parallelTasks: () => true });
    const m0 = await r.runner.createMission({ folder: repo, title: 'Clash', objective: 'Synthetic.', tasks: PAIR });
    script(r, m0, {
      t1: [slow({ 'README.md': 'left\n' }), edit({ 'README.md': 'resolved\n' })],
      t2: [slow({ 'README.md': 'right\n' }), edit({ 'README.md': 'resolved\n' })],
    });
    await r.runner.approvePlan(m0.id, ROUTE);
    await until(() => r.runner.get(m0.id)?.state === 'review', 20_000, 'review');
    const m = r.runner.get(m0.id)!;
    const resolving = m.attempts.filter((a) => a.resolvesConflict);
    expect(resolving).toHaveLength(1);
    const loser = m.tasks.find((t) => t.id === resolving[0].taskId)!;
    expect(resolving[0].resolvesConflict!.files).toEqual(['README.md']);
    // In the task's own tree, not a new one, with a prompt that says what conflicted.
    expect(resolving[0].worktreeId).toBe(m.attempts.find((a) => a.id === loser.attemptIds[0])!.worktreeId);
    const prompt = r.harness.launches.find((l) => l.request.origin.attemptId === resolving[0].id)!.request.prompt;
    expect(prompt).toContain('Resolve a merge conflict');
    expect(prompt).toContain('- README.md');
    expect(loser).toMatchObject({ state: 'done', integration: { outcome: 'merged' } });
    expect(git(repo, 'show', `${missionBranch(m)}:README.md`)).toBe('resolved');
    const conflict = integrations(r).find((x) => x.event === 'conflict')!;
    expect(conflict).toMatchObject({ taskId: loser.id, conflictingFiles: 1, conflictAction: 'resolve' });
    expect(JSON.stringify(integrations(r))).not.toContain('README');
  });

  it('with onConflict: needs-human, a conflict hands the task to the user with the conflicting files', async () => {
    setPolicy({ integration: { onConflict: 'needs-human' } });
    const r = rig({ parallelTasks: () => true });
    const m0 = await r.runner.createMission({ folder: repo, title: 'Clash by hand', objective: 'Synthetic.', tasks: PAIR });
    script(r, m0, { t1: [slow({ 'README.md': 'left\n' })], t2: [slow({ 'README.md': 'right\n' })] });
    await r.runner.approvePlan(m0.id, ROUTE);
    await until(() => r.runner.get(m0.id)!.tasks.some((t) => t.integration?.outcome === 'conflict' && t.state === 'needs-human'), 20_000, 'a conflict');
    const m = r.runner.get(m0.id)!;
    const loser = m.tasks.find((t) => t.integration?.outcome === 'conflict')!;
    expect(loser.integration!.conflictingFiles).toEqual(['README.md']);
    expect(loser.stateReason).toMatch(/conflicts in README\.md/);
    expect(r.harness.launches).toHaveLength(2);
    expect(m.attempts.some((a) => a.resolvesConflict)).toBe(false);
    expect(r.runner.actions(m.id, loser.id)).toEqual(expect.arrayContaining(['accept', 'retry']));
    expect(integrations(r).find((x) => x.event === 'conflict')).toMatchObject({ conflictAction: 'needs-human' });
  });

  it('two changes that pass alone and break together: the second merge is reverted and its task comes back with the evidence', async () => {
    // The repository's check fails only when both files are there.
    fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nif [ -f check.flag ] || { [ -f left.txt ] && [ -f right.txt ]; }; then echo " FAIL  test/pair.test.ts"; exit 1; fi\nexit 0\n', { mode: 0o755 });
    git(repo, 'commit', '-q', '-am', 'pair check');
    const r = rig({ parallelTasks: () => true });
    const m0 = await r.runner.createMission({ folder: repo, title: 'Semantic', objective: 'Synthetic.', tasks: PAIR });
    script(r, m0, {
      t1: [slow({ 'left.txt': 'l\n' }, [{ behaviour: 'edit', files: { 'left.txt': null, 'left-alt.txt': 'l\n' } }])],
      t2: [slow({ 'right.txt': 'r\n' }, [{ behaviour: 'edit', files: { 'right.txt': null, 'right-alt.txt': 'r\n' } }])],
    });
    await r.runner.approvePlan(m0.id, ROUTE);
    await until(() => r.runner.get(m0.id)!.tasks.some((t) => t.integration?.outcome === 'reverted'), 20_000, 'a revert');
    const at = r.runner.get(m0.id)!;
    const broke = at.tasks.find((t) => t.integration?.outcome === 'reverted')!;
    // The evidence travels with the task.
    expect(broke.integration!.evidence).toMatchObject({ stage: 'command:check', failing: ['test/pair.test.ts'] });
    const branch = missionBranch(at);
    // A revert commit, not a rewrite: the merge is still in the history.
    expect(git(repo, 'rev-parse', `${broke.integration!.revertCommit}^`)).toBe(broke.integration!.mergeCommit);
    expect(git(repo, 'merge-base', '--is-ancestor', broke.integration!.mergeCommit!, branch)).toBe('');
    // The failure went to escalation, which carried the session on with the evidence.
    await until(() => r.runner.get(m0.id)?.state === 'review', 20_000, 'review');
    const m = r.runner.get(m0.id)!;
    const again = m.attempts.find((a) => a.id === byKey(m, broke.key).attemptIds[1])!;
    expect(again).toMatchObject({ escalation: { action: 'continue-with-feedback' } });
    expect(byKey(m, broke.key).escalations[0].evidence).toMatchObject({ category: 'quality-new' });
    expect(integrations(r).map((x) => x.event)).toEqual(expect.arrayContaining(['reverted', 'mission-verification']));
    expect(integrations(r).find((x) => x.event === 'mission-verification' && x.verification === 'failed')).toMatchObject({ stage: 'command:check', taskId: broke.id });
    // Its whole change came back when it was merged again, fixed: nothing of it was lost to the revert.
    const files = git(repo, 'ls-tree', '--name-only', branch).split('\n');
    expect(files.filter((f) => /^(left|right)(-alt)?\.txt$/.test(f)).sort()).toHaveLength(2);
    expect(files.includes('left.txt') && files.includes('right.txt')).toBe(false);
    expect(execFileSync('/bin/sh', ['check.sh'], { cwd: treeOf(m).path }).toString()).toBe('');
  });

  it('a quit mid-merge leaves a record that startup recovery completes: the merge is aborted and made again', async () => {
    const real = (await import('../../src/orchestration/worktrees/exec')).nodeExec;
    let merges = 0;
    let crashed = false;
    // The core "dies" during the second merge into the mission branch: git has started it, nothing more happens.
    const exec: Exec = async (file, args, opts) => {
      if (file === 'git' && args.includes('merge') && args.includes('--no-ff') && opts.cwd.endsWith('_integration') && !args.includes('--no-commit')) {
        merges++;
        if (merges === 2) {
          const branch = args.at(-1)!;
          await real('git', ['merge', '--no-ff', '--no-commit', branch], opts);
          crashed = true;
          return new Promise(() => undefined);
        }
      }
      return real(file, args, opts);
    };
    const r1 = rig({ parallelTasks: () => true, exec });
    const m0 = await r1.runner.createMission({ folder: repo, title: 'Crash', objective: 'Synthetic.', tasks: PAIR });
    script(r1, m0, { t1: [slow({ 'left.txt': 'l\n' })], t2: [slow({ 'right.txt': 'r\n' })] });
    await r1.runner.approvePlan(m0.id, ROUTE);
    await until(() => crashed, 20_000, 'the second merge to start');
    const before = r1.runner.get(m0.id)!;
    expect(before.pendingMerge).toMatchObject({ preMergeHead: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const tree = treeOf(before).path;
    expect(git(tree, 'rev-parse', '--verify', 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/);
    r1.runner.dispose();

    // A new core over the same store, as after a relaunch.
    const r2 = rig({ parallelTasks: () => true });
    await r2.runner.recover();
    await until(() => r2.runner.get(m0.id)?.state === 'review', 20_000, 'review after recovery');
    const m = r2.runner.get(m0.id)!;
    expect(m.pendingMerge).toBeUndefined();
    expect(m.tasks.every((t) => t.state === 'done' && t.integration?.outcome === 'merged')).toBe(true);
    const log = git(repo, 'rev-list', '--merges', '--first-parent', `${m.base.commit}..${missionBranch(m)}`).split('\n');
    expect(log).toHaveLength(2);
    // The redone merge sits on the recorded pre-merge head.
    expect(git(repo, 'rev-parse', `${log[0]}^1`)).toBe(before.pendingMerge!.preMergeHead);
    expect(git(tree, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(integrations(r2).find((x) => x.event === 'merged')).toMatchObject({ recovered: true });
  });
});

/** The fleet as `PauseService` would give it, and a change signal the test fires. */
function fakeFleet() {
  let listeners: (() => void)[] = [];
  const f = {
    pausedNow: false,
    paused: [] as string[],
    resumed: [] as string[],
    fire: () => listeners.forEach((l) => l()),
    deps: {
      fleet: {
        paused: () => f.pausedNow,
        pauseSession: (id: string) => (f.paused.push(id), true),
        resumeSession: (id: string) => (f.resumed.push(id), true),
      },
      onDidChange: (l: () => void) => {
        listeners.push(l);
        return { dispose: () => (listeners = listeners.filter((x) => x !== l)) };
      },
    },
  };
  return f;
}

describe('scheduling (#45)', () => {
  const TWO: PlanTaskDraft[] = [
    { title: 'First', objective: 'Synthetic a.', acceptanceCriteria: ['a'] },
    { title: 'Second', objective: 'Synthetic b.', acceptanceCriteria: ['b'], dependsOn: [{ key: 't1', kind: 'code' }] },
  ];

  it('nothing starts while the fleet is paused, and the waiting work starts when it resumes', async () => {
    const f = fakeFleet();
    f.pausedNow = true;
    const r = rig({ scheduling: f.deps });
    const m = await r.runner.createMission({ folder: repo, title: 'Paused fleet', objective: 'Synthetic.', tasks: TWO });
    script(r, m, { t1: [edit({ 'a.txt': 'a\n' })], t2: [edit({ 'b.txt': 'b\n' })] });
    await r.runner.approvePlan(m.id, ROUTE);
    let cur = r.runner.get(m.id)!;
    expect(cur.attempts).toEqual([]);
    expect(byKey(cur, 't1')).toMatchObject({ state: 'pending', stateReason: expect.stringContaining('every agent is paused') });
    // A single task started directly waits the same way, in a running mission.
    const single = await r.runner.start({ folder: repo, title: 'Single', objective: 'Synthetic.', acceptanceCriteria: ['s'], route: ROUTE });
    expect(single).toMatchObject({ state: 'running', attempts: [] });
    expect(single.tasks[0].stateReason).toContain('every agent is paused');
    r.scenario.tasks![single.tasks[0].id] = [edit({ 's.txt': 's\n' })];
    await new Promise((res) => setTimeout(res, 100));
    expect(r.runner.get(m.id)!.attempts).toEqual([]);
    f.pausedNow = false;
    f.fire();
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
    await until(() => (r.runner.get(single.id)?.attempts.length ?? 0) > 0, 10_000, 'the single task to start');
    cur = r.runner.get(m.id)!;
    // Queue time counts the wait.
    const a1 = cur.attempts.find((a) => a.taskId === byKey(cur, 't1').id)!;
    expect(a1.timing?.queuedAt).toBeLessThanOrEqual(a1.createdAt - 100);
  });

  it('a usage window at the admission threshold (85%) holds new work; below it, work starts', async () => {
    const f = fakeFleet();
    let percent = 85;
    const r = rig({ scheduling: f.deps, routing: { snapshot: () => snapshot({ sources: { anthropic: status('anthropic', 'reachable', percent), openai: status('openai', 'reachable', 20) }, now: Date.now() }) } });
    const m = await r.runner.createMission({ folder: repo, title: 'Budget', objective: 'Synthetic.', tasks: TWO.slice(0, 1) });
    script(r, m, { t1: [edit({ 'a.txt': 'a\n' })] });
    await r.runner.approvePlan(m.id, ROUTE);
    expect(r.runner.get(m.id)!.attempts).toEqual([]);
    expect(byKey(r.runner.get(m.id)!, 't1').stateReason).toContain('usage window is at 85%');
    percent = 40;
    f.fire();
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
  });

  it('mission pause stops new starts; Pause now pauses the running session; Resume carries on', async () => {
    const f = fakeFleet();
    const r = rig({ scheduling: f.deps });
    const m = await r.runner.createMission({ folder: repo, title: 'Pause mission', objective: 'Synthetic.', tasks: TWO });
    script(r, m, { t1: [{ behaviour: 'edit', files: { 'a.txt': 'a\n' }, delayMs: 300 }], t2: [edit({ 'b.txt': 'b\n' })] });
    await r.runner.approvePlan(m.id, ROUTE);
    const paused = await r.runner.pauseMission(m.id, { now: true });
    expect(paused.state).toBe('paused');
    const a1 = paused.attempts[0];
    expect(f.paused).toEqual([a1.assignment.sessionIds.at(-1)]);
    // The running task carries on and finishes; nothing new starts.
    await until(() => byKey(r.runner.get(m.id)!, 't1').state === 'done', 20_000, 't1 to finish');
    await new Promise((res) => setTimeout(res, 100));
    let cur = r.runner.get(m.id)!;
    expect(byKey(cur, 't2').attemptIds).toEqual([]);
    expect(byKey(cur, 't2').stateReason).toContain('the mission is paused');
    await r.runner.resumeMission(m.id);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
    cur = r.runner.get(m.id)!;
    expect(cur.tasks.map((t) => t.state)).toEqual(['done', 'done']);
  });

  it('cancel ends the running attempt gracefully and keeps its worktree and branch', async () => {
    const r = rig({ scheduling: fakeFleet().deps });
    const m = await r.runner.createMission({ folder: repo, title: 'Cancel mission', objective: 'Synthetic.', tasks: TWO });
    script(r, m, { t1: [{ behaviour: 'timeout' }] });
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => r.runner.get(m.id)!.attempts[0]?.state === 'running', 10_000, 't1 to run');
    await r.runner.cancel(m.id);
    const cur = r.runner.get(m.id)!;
    expect(cur.state).toBe('cancelled');
    expect(cur.attempts[0].state).toBe('cancelled');
    expect(cur.tasks.map((t) => t.state)).toEqual(['cancelled', 'cancelled']);
    const tree = cur.worktrees[0];
    expect(tree.state).toBe('retained');
    expect(fs.existsSync(tree.path)).toBe(true);
    expect(git(repo, 'rev-parse', '--verify', tree.branch)).toMatch(/^[0-9a-f]{40}$/);
    // Every start went through the harness: one attempt, one launch.
    expect(r.harness.launches).toHaveLength(1);
  });
});

describe('warm sessions (#54)', () => {
  const CHAIN: PlanTaskDraft[] = [
    { title: 'A', objective: 'Synthetic a.', acceptanceCriteria: ['a'] },
    { title: 'B', objective: 'Synthetic b.', acceptanceCriteria: ['b'], dependsOn: [{ key: 't1', kind: 'code' }] },
    { title: 'C', objective: 'Synthetic c.', acceptanceCriteria: ['c'], dependsOn: [{ key: 't2', kind: 'code' }] },
  ];
  const first = (m: Mission, key: string) => m.attempts.find((a) => a.id === byKey(m, key).attemptIds[0])!;

  it('A → B → C on one mission tree: B and C carry A’s session on, resumed in the same tree, and telemetry says so', async () => {
    const r = rig();
    const m = await r.runner.createMission({ folder: repo, title: 'Warm chain', objective: 'Synthetic.', tasks: CHAIN });
    script(r, m, { t1: [edit({ 'a.txt': 'a\n' })], t2: [edit({ 'b.txt': 'b\n' })], t3: [edit({ 'c.txt': 'c\n' })] });
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
    const cur = r.runner.get(m.id)!;
    const [a, b, c] = ['t1', 't2', 't3'].map((k) => first(cur, k));
    const sid = a.assignment.sessionIds[0];
    expect(a.assignment).toMatchObject({ mode: 'fresh', sessionIds: [sid] });
    expect(b.assignment).toMatchObject({ mode: 'reuse', sessionIds: [sid], fromAttemptId: a.id, fromSessionId: sid });
    expect(c.assignment).toMatchObject({ mode: 'reuse', sessionIds: [sid], fromAttemptId: b.id, fromSessionId: sid });
    // Resumed through the harness in the same tree, each with its own prompt, told the old task is done.
    const [la, lb, lc] = r.harness.launches;
    expect(la.request.resume).toBeUndefined();
    expect([lb.request.resume, lc.request.resume]).toEqual([sid, sid]);
    expect(new Set(r.harness.launches.map((l) => l.request.cwd)).size).toBe(1);
    expect(lb.request.prompt).toMatch(/^Your previous task is finished/);
    expect(lb.request.prompt).toContain('# Task: B');
    // Every task passed on its own work, and the session's origin is the attempt using it now.
    expect(cur.tasks.map((t) => [t.key, t.state])).toEqual([['t1', 'done'], ['t2', 'done'], ['t3', 'done']]);
    expect([a, b, c].map((x) => x.git?.filesChanged)).toEqual([1, 1, 1]);
    expect(r.registry.get(sid)?.origin).toMatchObject({ attemptId: c.id });
    // Telemetry: the assignment mode on every attempt record.
    const recs = r.telemetry.filter((x): x is AttemptRecord => x.type === 'attempt');
    expect(recs.map((x) => [x.attemptId, x.assignmentMode, x.assignedFrom ?? null])).toEqual([
      [a.id, 'cold', null],
      [b.id, 'reuse', a.id],
      [c.id, 'reuse', b.id],
    ]);
  });

  it('a mid-chain tier change starts cold; the next task back on the first route reuses the first session', async () => {
    const r = rig({ routing: { snapshot: () => snapshot() } });
    const m = await r.runner.createMission({ folder: repo, title: 'Tier chain', objective: 'Synthetic.', tasks: CHAIN });
    // B runs on opus (expert); A and C on sonnet (standard).
    await r.runner.editPlan(m.id, { kind: 'overrides', taskId: byKey(m, 't2').id, overrides: { pins: { model: 'opus' } } });
    script(r, m, { t1: [edit({ 'a.txt': 'a\n' })], t2: [edit({ 'b.txt': 'b\n' })], t3: [edit({ 'c.txt': 'c\n' })] });
    await r.runner.approvePlan(m.id, { harness: 'claude-code', model: 'sonnet', effort: 'low' });
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
    const cur = r.runner.get(m.id)!;
    const [a, b, c] = ['t1', 't2', 't3'].map((k) => first(cur, k));
    const tier = (x: ExecutionAttempt) => cur.decisions.find((d) => d.id === x.routingDecisionId)!.resolution.target.tier;
    expect([a, b, c].map(tier)).toEqual(['standard', 'expert', 'standard']);
    expect(b.assignment.mode).toBe('fresh');
    expect(b.assignment.sessionIds[0]).not.toBe(a.assignment.sessionIds[0]);
    // The expert session is never given to a standard task; A's still satisfies C.
    expect(c.assignment).toMatchObject({ mode: 'reuse', fromAttemptId: a.id, sessionIds: [a.assignment.sessionIds[0]] });
  });
});
