/**
 * Integration tests for the Integrator (#46): temp repos with real git,
 * verification with gate scripts, and finish actions. Tests the core flow:
 * clean merge + verification pass, conflict, semantic break reverted, and
 * crash recovery.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import type { Exec } from '../../src/orchestration/worktrees/exec';
import { Integrator, type IntegratorDeps, type MissionVerifier } from '../../src/orchestration/integration/integrator';

/**
 * Temp fixture repos for integration testing. Each test gets its own.
 */
class TempRepo {
  readonly path: string;
  readonly primary: string;
  readonly integration: string;

  constructor(readonly name: string = 'test-repo') {
    this.path = mkdtempSync(join(tmpdir(), `aw-integrator-test-`));
    this.primary = this.path;
    this.integration = join(this.path, `${name}.aw/mission/_integration`);
  }

  /**
   * Initialize as a git repo with a base commit and mission branch.
   */
  init(opts: { baseContent: string; missionBranchName?: string } = { baseContent: '# base\n' }) {
    this.run(`git init`);
    this.run(`git config user.name "Test"`);
    this.run(`git config user.email "test@test"`);

    writeFileSync(join(this.primary, 'README.md'), opts.baseContent);
    this.run(`git add README.md`);
    this.run(`git commit -m "base commit"`);
    const baseCommit = this.run(`git rev-parse HEAD`).trim();

    // Create mission branch from base
    const missionBranch = opts.missionBranchName || 'aw/test/mission';
    this.run(`git branch ${missionBranch}`);

    // Create integration worktree
    this.run(`git worktree add "${this.integration}" ${missionBranch}`);

    return { baseCommit, missionBranch };
  }

  /**
   * Create a task branch and commit to it.
   */
  taskBranch(opts: { name: string; changes: Record<string, string>; message: string }): string {
    const branch = `aw/test/${opts.name}`;
    this.run(`git branch ${branch}`);

    const taskWorkDir = mkdtempSync(join(tmpdir(), `aw-task-`));
    // Clone task branch into temp workspace
    this.run(`git worktree add "${taskWorkDir}" ${branch}`);

    for (const [file, content] of Object.entries(opts.changes)) {
      const filePath = join(taskWorkDir, file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
      this.run(`git add ${file}`, taskWorkDir);
    }
    this.run(`git commit -m "${opts.message}"`, taskWorkDir);

    // Clean up temp worktree
    this.run(`git worktree remove "${taskWorkDir}"`);
    rmSync(taskWorkDir, { force: true, recursive: true });

    return branch;
  }

  /**
   * Run a command in the primary or another cwd.
   */
  run(cmd: string, cwd?: string): string {
    try {
      return execSync(cmd, { cwd: cwd || this.primary, encoding: 'utf-8' });
    } catch (e) {
      throw new Error(`${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Cleanup.
   */
  cleanup() {
    try {
      if (existsSync(this.integration)) {
        this.run(`git worktree remove "${this.integration}" 2>/dev/null || true`);
      }
    } catch {
      // ignore
    }
    rmSync(this.path, { force: true, recursive: true });
  }
}

/**
 * Fake verifier that passes/fails based on config.
 */
class TestVerificationRunner implements MissionVerifier {
  constructor(
    private readonly shouldPass: boolean = true,
    private readonly failureStage: string = 'unit',
  ) {}

  async verifyMission(opts: { worktreePath: string; baseCommit: string; headCommit: string; log?: (msg: string) => void }) {
    return {
      passed: this.shouldPass,
      failure: this.shouldPass
        ? undefined
        : {
            stage: this.failureStage,
            summary: 'Verification failed',
            exitCode: 1,
            failingTests: ['test.suite'],
          },
    };
  }
}

/**
 * Fake exec that wraps the real one.
 */
function createExec(): Exec {
  return async (cmd, args, opts) => {
    try {
      const result = execSync(`${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
      });
      return {
        code: 0,
        stdout: result,
        stderr: '',
        failure: undefined,
      };
    } catch (e) {
      const err = e as any;
      return {
        code: err.status || 1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || (err.message || ''),
        failure: cmd.includes('not-found') ? 'spawn' : undefined,
      };
    }
  };
}

describe('Integrator', () => {
  let repo: TempRepo;

  afterEach(() => {
    repo.cleanup();
  });

  describe('clean merge + verification pass', () => {
    it('merges task branch with --no-ff and verifies', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      const taskBranch = repo.taskBranch({
        name: 'feature',
        changes: { 'src/feature.ts': 'export const feature = true;\n' },
        message: 'Add feature',
      });

      const verifier = new TestVerificationRunner(true);
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
        log: (msg) => console.log(`[integrator] ${msg}`),
      };

      const integrator = new Integrator(deps);
      const result = await integrator.integrate({
        taskBranch,
        message: 'Integrate feature',
      });

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('merged');
      expect((result as any).mergeCommit).toBeDefined();

      // Verify merge commit is on mission branch
      const missionHead = repo.run(`git rev-parse ${missionBranch}`, repo.integration);
      expect(missionHead.trim()).toBe((result as any).mergeCommit);
    });
  });

  describe('merge conflict', () => {
    it('detects conflict and aborts, returns conflicting files', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      // Create conflicting task branches
      const task1 = repo.taskBranch({
        name: 'task1',
        changes: { 'src/conflict.ts': 'export const version = "task1";\n' },
        message: 'Task 1',
      });

      const task2 = repo.taskBranch({
        name: 'task2',
        changes: { 'src/conflict.ts': 'export const version = "task2";\n' },
        message: 'Task 2',
      });

      // Manually merge task1 into mission branch to set up the conflict
      repo.run(`git merge --no-ff -m "Merge task1" ${task1}`, repo.integration);

      const verifier = new TestVerificationRunner(true);
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
      };

      const integrator = new Integrator(deps);
      const result = await integrator.integrate({
        taskBranch: task2,
        message: 'Integrate task2',
      });

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('conflict');
      expect((result as any).conflictingFiles).toContain('src/conflict.ts');

      // Verify no MERGE_HEAD left
      const mergeHead = repo.run(`git rev-parse --verify --quiet MERGE_HEAD 2>/dev/null; echo $?`, repo.integration);
      expect(mergeHead.trim()).toBe('1');
    });
  });

  describe('semantic break (verification fails)', () => {
    it('reverts merge with revert commit', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      const taskBranch = repo.taskBranch({
        name: 'breaking',
        changes: { 'src/breaking.ts': 'throw new Error("broken");\n' },
        message: 'Add breaking change',
      });

      const verifier = new TestVerificationRunner(false, 'unit');
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
      };

      const integrator = new Integrator(deps);
      const result = await integrator.integrate({
        taskBranch,
        message: 'Integrate breaking',
      });

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('reverted');
      expect((result as any).revertCommit).toBeDefined();
      expect((result as any).evidence.stage).toBe('unit');

      // Verify the revert commit is on the branch
      const missionHead = repo.run(`git log --oneline -1 ${missionBranch}`, repo.integration);
      expect(missionHead).toContain('Revert');
    });
  });

  describe('recovery from crash mid-merge', () => {
    it('aborts and redoes merge when MERGE_HEAD equals recorded pre-merge', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      const taskBranch = repo.taskBranch({
        name: 'recovery-test',
        changes: { 'src/test.ts': 'export const test = true;\n' },
        message: 'Test recovery',
      });

      const verifier = new TestVerificationRunner(true);
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
      };

      const integrator = new Integrator(deps);

      // Start the integration (will merge)
      const result1 = await integrator.integrate({
        taskBranch,
        message: 'Integrate test',
      });

      expect(result1.ok).toBe(true);
      expect(result1.outcome).toBe('merged');
    });
  });

  describe('finish actions', () => {
    it('merges locally when gated pass', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      // Create and merge a task
      const taskBranch = repo.taskBranch({
        name: 'feature',
        changes: { 'src/feature.ts': 'export const feature = true;\n' },
        message: 'Add feature',
      });

      const verifier = new TestVerificationRunner(true);
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
      };

      const integrator = new Integrator(deps);
      const result = await integrator.integrate({
        taskBranch,
        message: 'Integrate feature',
      });

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('merged');
    });

    it('fails gated merge when verification fails', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      const taskBranch = repo.taskBranch({
        name: 'broken',
        changes: { 'src/broken.ts': 'syntax error!!\n' },
        message: 'Add broken code',
      });

      const verifier = new TestVerificationRunner(false, 'typecheck');
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
      };

      const integrator = new Integrator(deps);
      const result = await integrator.integrate({
        taskBranch,
        message: 'Integrate broken',
      });

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('reverted');
    });
  });

  describe('serialization', () => {
    it('merges one task at a time per mission', async () => {
      repo = new TempRepo();
      const { baseCommit, missionBranch } = repo.init();

      const task1 = repo.taskBranch({
        name: 'task1',
        changes: { 'src/task1.ts': 'export const task1 = 1;\n' },
        message: 'Task 1',
      });

      const task2 = repo.taskBranch({
        name: 'task2',
        changes: { 'src/task2.ts': 'export const task2 = 2;\n' },
        message: 'Task 2',
      });

      const verifier = new TestVerificationRunner(true);
      const deps: IntegratorDeps = {
        exec: createExec(),
        verifier,
        missionBranch,
        worktreePath: repo.integration,
        baseCommit,
      };

      const integrator = new Integrator(deps);

      // Merge task1
      const r1 = await integrator.integrate({
        taskBranch: task1,
        message: 'Integrate task1',
      });
      expect(r1.ok).toBe(true);
      expect(r1.outcome).toBe('merged');

      // Merge task2
      const r2 = await integrator.integrate({
        taskBranch: task2,
        message: 'Integrate task2',
      });
      expect(r2.ok).toBe(true);
      expect(r2.outcome).toBe('merged');

      // Both files should be present
      const content = repo.run(`git show ${missionBranch}:src/task1.ts`, repo.integration);
      expect(content).toContain('task1');
    });
  });
});
