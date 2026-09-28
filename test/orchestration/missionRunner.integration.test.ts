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
import type { TaskFinalRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
import type { Mission, Task } from '../../src/shared/orchestration/types';
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
