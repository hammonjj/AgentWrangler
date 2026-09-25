/**
 * Creates, sets up, inspects and removes the worktrees and branches that tasks
 * run in (`docs/plans/intelligent-orchestration.md` §13.1–13.2, §23.2–23.3).
 *
 * Rules, enforced here rather than hoped for:
 * - **Only trees AW created are touched.** Every path must be inside the
 *   configured root, and every branch must be under `aw/`; a registered
 *   worktree at our path on someone else's branch is not ours.
 * - **Never `--force`.** Removal is `git worktree remove` without it, and a
 *   branch goes only once it is reachable from the branch it was merged into.
 * - **Refuse without changing anything.** `remove` checks everything first
 *   (dirty, unmerged, in use, locked, not ours) and acts only if all pass.
 * - **Write-ahead.** `create` records the assignment as `creating` before any
 *   git work, so a crash leaves something `reconcile` can find and finish.
 * - **No rebases, merges or pushes.** Those are the Integrator's (P9, #46).
 *
 * The primary checkout is only ever the directory git commands run from;
 * nothing is written into its working tree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SetupStep as WorktreeSetupStep } from '../../shared/orchestration/repoPolicy';
import type { Millis, WorktreeAssignment, WorktreeState } from '../../shared/orchestration/types';
import { transitionWorktree } from '../domain/lifecycles';
import { lsofProcessesUsing, nodeExec, type Exec, type ExecResult } from './exec';
import {
  BRANCH_PREFIX,
  INTEGRATION_DIR,
  WorktreeNameError,
  checkRoot,
  checkSetupPath,
  isInside,
  missionBranch,
  resolveWorktreeRoot,
  taskBranch,
  taskLeaf,
  worktreePath,
} from './naming';
import { parseStatus, parseWorktreeList, type GitWorktree } from './porcelain';

export type WorktreeFailureCategory =
  | 'invalid-name'
  | 'invalid-state'
  | 'not-a-repository'
  | 'bad-base'
  | 'path-occupied'
  | 'branch-exists'
  | 'branch-in-use'
  | 'branch-missing'
  | 'unexpected-commits'
  | 'locked'
  | 'git-failed'
  | 'setup-not-allowed'
  | 'setup-failed'
  | 'missing'
  | 'refused-dirty'
  | 'refused-unmerged'
  | 'refused-in-use'
  | 'refused-locked'
  | 'refused-not-ours';

export class WorktreeError extends Error {
  constructor(
    readonly category: WorktreeFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export type RefusalReason = 'dirty' | 'unmerged' | 'in-use' | 'locked' | 'not-ours';

export interface Refusal {
  reason: RefusalReason;
  detail: string;
}

export type RemoveOutcome = { removed: true; assignment: WorktreeAssignment } | { removed: false; refusals: Refusal[] };

export interface WorktreeHealth {
  /** Registered on its branch, and its directory is there. */
  present: boolean;
  /** The branch's head, when the branch exists. */
  branchHead?: string;
  locked?: string;
  /** Commits on the branch since `lastKnownHead`, made while no attempt held the tree (newest first). */
  unexpectedCommits: string[];
  /** The branch no longer contains `lastKnownHead`: its history was rewritten outside any attempt. */
  rewritten: boolean;
}

export type ReconcileAction =
  /** Present and as expected. */
  | 'ok'
  /** A half-created worktree was finished. */
  | 'finished'
  /** Was `missing`, is back where it should be. */
  | 'restored'
  /** Its directory or registration is gone; now `missing`. */
  | 'missing'
  /** Commits appeared on its branch outside any attempt. */
  | 'unexpected-commits'
  /** Could not be finished or checked; left as it was. */
  | 'failed';

export interface ReconcileItem {
  assignment: WorktreeAssignment;
  action: ReconcileAction;
  /** For `missing`: the branch survives, so "recreate from branch" is possible. */
  recreatable?: boolean;
  unexpectedCommits?: string[];
  rewritten?: boolean;
  error?: string;
}

export interface WorktreeManagerOptions {
  /** The primary checkout. Must be the repository's main worktree, not a linked one. */
  repoRoot: string;
  /** Repo policy's `worktrees.root`; default `../<repo>.aw`. */
  root?: string;
  /** Repo policy's `worktrees.setup`. Steps re-run when a half-created tree is finished, so each must be safe to repeat. */
  setup?: WorktreeSetupStep[];
  /**
   * Commands a `run` step may use, as exact argv. The caller derives it from
   * the user's own repo policy; anything else (a policy changed mid-mission,
   * a planner's suggestion) is refused.
   */
  allowedCommands?: string[][];
}

export interface WorktreeManagerDeps {
  exec?: Exec;
  /** Persist an assignment. Called with the intent before git work, and with every state change after. */
  record: (assignment: WorktreeAssignment) => void | Promise<void>;
  /** Pids with a working directory inside a tree. Must throw when it cannot tell. */
  processesUsing?: (dir: string) => Promise<number[]>;
  now?: () => Millis;
  log?: (msg: string) => void;
  /** Telemetry: one call per failure, by category. */
  onFailure?: (category: WorktreeFailureCategory, detail: string) => void;
}

export interface PlanRequest {
  id: string;
  missionSlug: string;
  purpose: 'task' | 'integration';
  /** Required for a task worktree. */
  taskKey?: string;
  taskId?: string;
  /** 1 for the first attempt; later attempts get `-a<n>`. */
  attempt?: number;
  /** A full commit id (see `resolveCommit`). */
  baseCommit: string;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Git's own lock reason while `worktree add` is still populating the tree. */
const INITIALIZING = 'initializing';
const ADD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RUN_TIMEOUT_SEC = 10 * 60;
const MAX_LISTED = 5;

/** A path with every existing prefix resolved through symlinks, so it compares equal to what git reports. */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function listed(items: string[]): string {
  const head = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${head} and ${items.length - MAX_LISTED} more` : head;
}

interface SetupArtifact {
  rel: string;
  kind: 'link' | 'copy';
  /** Still exactly what setup made, so removing it loses nothing. */
  intact: boolean;
}

export class WorktreeManager {
  private readonly exec: Exec;
  private readonly processesUsing: (dir: string) => Promise<number[]>;
  private readonly now: () => Millis;
  private readonly log: (msg: string) => void;
  private readonly counts = new Map<WorktreeFailureCategory, number>();

  private constructor(
    /** Canonical path of the primary checkout. */
    readonly repoRoot: string,
    /** Canonical path of the directory AW's worktrees live under. */
    readonly root: string,
    private readonly setupSteps: readonly WorktreeSetupStep[],
    private readonly allowedCommands: readonly string[][],
    private readonly deps: WorktreeManagerDeps,
  ) {
    this.exec = deps.exec ?? nodeExec;
    this.processesUsing = deps.processesUsing ?? lsofProcessesUsing(this.exec);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /** Check that `repoRoot` is a primary checkout and the root is a safe place, then return a manager for it. */
  static async open(opts: WorktreeManagerOptions, deps: WorktreeManagerDeps): Promise<WorktreeManager> {
    const exec = deps.exec ?? nodeExec;
    const repo = canonicalPath(opts.repoRoot);
    const r = await exec('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd: repo });
    const [top, gitDir, commonDir] = r.stdout.trim().split('\n');
    const fail = (why: string): never => {
      deps.onFailure?.('not-a-repository', why);
      throw new WorktreeError('not-a-repository', `${repo}: ${why}`);
    };
    if (r.code !== 0) fail(r.stderr.trim() || 'not a git repository');
    if (canonicalPath(top) !== repo) fail(`not the top of its checkout (that is ${top})`);
    if (canonicalPath(gitDir) !== canonicalPath(commonDir)) fail('a linked worktree, not the primary checkout');
    const root = canonicalPath(resolveWorktreeRoot(repo, opts.root));
    try {
      checkRoot(repo, root);
    } catch (e) {
      deps.onFailure?.('invalid-name', (e as Error).message);
      throw new WorktreeError('invalid-name', (e as Error).message);
    }
    return new WorktreeManager(repo, root, opts.setup ?? [], opts.allowedCommands ?? [], deps);
  }

  /** Failures so far, by category. */
  failureCounts(): Partial<Record<WorktreeFailureCategory, number>> {
    return Object.fromEntries(this.counts);
  }

  // ---- Planning ----

  /** The full commit id `ref` names in the repository, or throws `bad-base`. */
  async resolveCommit(ref: string): Promise<string> {
    if (ref.startsWith('-')) throw this.fail('bad-base', `bad ref "${ref}"`);
    const r = await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    const sha = r.stdout.trim();
    if (r.code !== 0 || !FULL_SHA.test(sha)) throw this.fail('bad-base', `no commit named "${ref}"`);
    return sha;
  }

  /**
   * The assignment for a new worktree, in `creating`, with its path and branch
   * decided. Nothing happens on disk: persist it, then call `create`.
   */
  plan(req: PlanRequest): WorktreeAssignment {
    try {
      if (!FULL_SHA.test(req.baseCommit)) throw new WorktreeNameError(`base must be a full commit id, not "${req.baseCommit}"`);
      let leaf: string;
      let branch: string;
      if (req.purpose === 'integration') {
        leaf = INTEGRATION_DIR;
        branch = missionBranch(req.missionSlug);
      } else {
        if (!req.taskKey) throw new WorktreeNameError('a task worktree needs a task key');
        leaf = taskLeaf(req.taskKey, req.attempt ?? 1);
        branch = taskBranch(req.missionSlug, req.taskKey, req.attempt ?? 1);
      }
      return {
        id: req.id,
        purpose: req.purpose,
        taskId: req.taskId,
        path: worktreePath(this.root, req.missionSlug, leaf),
        branch,
        baseCommit: req.baseCommit,
        state: 'creating',
        lastKnownHead: req.baseCommit,
        createdAt: this.now(),
      };
    } catch (e) {
      if (e instanceof WorktreeNameError) throw this.fail('invalid-name', e.message);
      throw e;
    }
  }

  // ---- Creation ----

  /**
   * Make the worktree and branch for a `creating` assignment, apply setup, and
   * return it `ready`. Records the intent first. Safe to call again on the
   * same assignment after a crash: it finishes whatever was left half done.
   */
  async create(a: WorktreeAssignment): Promise<WorktreeAssignment> {
    if (a.state !== 'creating') throw this.fail('invalid-state', `${a.id} is ${a.state}, not creating`);
    this.assertOurs(a);
    await this.deps.record(a);
    await this.attach(a, 'create');
    await this.applySetup(a.path);
    const ready: WorktreeAssignment = { ...transitionWorktree(a, 'ready', { now: this.now() }), lastKnownHead: a.baseCommit };
    await this.deps.record(ready);
    this.log(`worktree ${a.branch} ready at ${a.path}`);
    return ready;
  }

  /**
   * Put a `missing` worktree back from its surviving branch, set it up, and
   * return it `ready`. Its branch head becomes the last known head.
   */
  async recreate(a: WorktreeAssignment): Promise<WorktreeAssignment> {
    if (a.state !== 'missing') throw this.fail('invalid-state', `${a.id} is ${a.state}, not missing`);
    this.assertOurs(a);
    await this.attach(a, 'recreate');
    await this.applySetup(a.path);
    const head = await this.branchHead(a.branch);
    const ready: WorktreeAssignment = { ...transitionWorktree(a, 'ready', { now: this.now() }), lastKnownHead: head };
    await this.deps.record(ready);
    this.log(`worktree ${a.branch} recreated at ${a.path}`);
    return ready;
  }

  /**
   * Get a registered, fully checked-out worktree for `a` at its path, from
   * whatever state a previous try left behind.
   */
  private async attach(a: WorktreeAssignment, mode: 'create' | 'recreate'): Promise<void> {
    if (mode === 'create') {
      const base = await this.git(['rev-parse', '--verify', '--quiet', `${a.baseCommit}^{commit}`]);
      if (base.code !== 0 || base.stdout.trim() !== a.baseCommit) throw this.fail('bad-base', `base ${a.baseCommit} is not a commit in ${this.repoRoot}`);
    }
    let list = await this.worktrees();
    const atPath = list.find((w) => w.path === a.path);
    if (atPath) {
      if (atPath.branch !== a.branch) throw this.fail('path-occupied', `${a.path} is a worktree on ${atPath.branch ?? 'a detached HEAD'}, not ${a.branch}`);
      if (atPath.locked === INITIALIZING) {
        // `git worktree add` was cut off while populating the tree. Nothing has
        // run in it (git still held it), so clear the partial checkout and redo.
        this.log(`worktree ${a.branch}: clearing a half-created tree at ${a.path}`);
        await this.gitOk(['worktree', 'unlock', a.path], 'git-failed');
        fs.rmSync(a.path, { recursive: true, force: true });
        await this.gitOk(['worktree', 'remove', a.path], 'git-failed');
      } else if (atPath.locked !== undefined) {
        throw this.fail('locked', `${a.path} is locked${atPath.locked ? `: ${atPath.locked}` : ''}`);
      } else if (atPath.prunable !== undefined || !fs.existsSync(a.path)) {
        // Registered, directory gone: clear the stale registration (ours: our path, our branch).
        await this.gitOk(['worktree', 'remove', a.path], 'git-failed');
      } else {
        if (mode === 'create' && atPath.head !== a.baseCommit) {
          throw this.fail('unexpected-commits', `${a.branch} moved to ${atPath.head} before its worktree was ready`);
        }
        return; // git finished; only setup (idempotent) may be outstanding
      }
      list = await this.worktrees();
    }
    const elsewhere = list.find((w) => w.branch === a.branch);
    if (elsewhere) throw this.fail('branch-in-use', `${a.branch} is checked out at ${elsewhere.path}`);

    const st = lstat(a.path);
    if (st && !(st.isDirectory() && fs.readdirSync(a.path).length === 0)) {
      throw this.fail('path-occupied', `${a.path} already exists and is not an empty directory`);
    }
    const head = await this.branchHeadOrUndefined(a.branch);
    fs.mkdirSync(path.dirname(a.path), { recursive: true });
    if (head === undefined) {
      if (mode === 'recreate') throw this.fail('branch-missing', `${a.branch} no longer exists; nothing to recreate from`);
      await this.gitOk(['worktree', 'add', '--quiet', '-b', a.branch, a.path, a.baseCommit], 'git-failed', ADD_TIMEOUT_MS);
    } else {
      // A crash after `-b` made the branch but before the tree: reuse it only if it has nothing new.
      if (mode === 'create' && head !== a.baseCommit) throw this.fail('branch-exists', `${a.branch} already exists at ${head}`);
      await this.gitOk(['worktree', 'add', '--quiet', a.path, a.branch], 'git-failed', ADD_TIMEOUT_MS);
    }
  }

  // ---- Setup ----

  private async applySetup(tree: string): Promise<void> {
    for (const step of this.setupSteps) {
      if ('link' in step) {
        const rel = this.setupPath(step.link);
        const src = path.join(this.repoRoot, rel);
        const dst = path.join(tree, rel);
        if (!fs.existsSync(src)) {
          this.log(`worktree setup: nothing to link at ${rel} in the primary checkout; skipped`);
          continue;
        }
        const st = lstat(dst);
        if (st?.isSymbolicLink() && fs.readlinkSync(dst) === src) continue;
        if (st) throw this.fail('setup-failed', `cannot link ${rel}: something is already there`);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(src, dst);
      } else if ('copy' in step) {
        const rel = this.setupPath(step.copy);
        const src = path.join(this.repoRoot, rel);
        const dst = path.join(tree, rel);
        const srcSt = lstat(src);
        if (!srcSt) {
          this.log(`worktree setup: nothing to copy at ${rel} in the primary checkout; skipped`);
          continue;
        }
        if (!srcSt.isFile()) throw this.fail('setup-failed', `cannot copy ${rel}: not a regular file`);
        if (lstat(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      } else {
        const argv = step.run;
        if (argv.length === 0 || !this.allowedCommands.some((c) => sameArgv(c, argv))) {
          throw this.fail('setup-not-allowed', `setup command is not allowlisted: ${JSON.stringify(argv)}`);
        }
        const r = await this.exec(argv[0], argv.slice(1), { cwd: tree, timeoutMs: (step.timeoutSec ?? DEFAULT_RUN_TIMEOUT_SEC) * 1000 });
        if (r.code !== 0) throw this.fail('setup-failed', `${argv.join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 500)}`);
      }
    }
  }

  private setupPath(rel: string): string {
    try {
      return checkSetupPath(rel);
    } catch (e) {
      throw this.fail('setup-failed', (e as Error).message);
    }
  }

  /** What setup left in `tree`, and whether each is still exactly what setup made. */
  private setupArtifacts(tree: string): SetupArtifact[] {
    const out: SetupArtifact[] = [];
    for (const step of this.setupSteps) {
      if ('run' in step) continue;
      let rel: string;
      try {
        rel = checkSetupPath('link' in step ? step.link : step.copy);
      } catch {
        continue;
      }
      const src = path.join(this.repoRoot, rel);
      const dst = path.join(tree, rel);
      const st = lstat(dst);
      if (!st) continue;
      if ('link' in step) out.push({ rel, kind: 'link', intact: st.isSymbolicLink() && fs.readlinkSync(dst) === src });
      else out.push({ rel, kind: 'copy', intact: st.isFile() && sameFile(src, dst) });
    }
    return out;
  }

  // ---- State changes that are not git work ----

  /** An attempt takes the tree. */
  async markInUse(a: WorktreeAssignment): Promise<WorktreeAssignment> {
    return this.move(a, 'in-use');
  }

  /**
   * An attempt lets the tree go: `ready` for the next attempt, `retained` to
   * keep it (a failed attempt's tree, for comparison). The branch head now is
   * the last known head; commits after it were made outside any attempt.
   */
  async release(a: WorktreeAssignment, to: 'ready' | 'retained'): Promise<WorktreeAssignment> {
    const head = await this.branchHeadOrUndefined(a.branch);
    return this.move({ ...a, lastKnownHead: head ?? a.lastKnownHead }, to);
  }

  /** Accept the branch's current head as known, e.g. after the Integrator merged into it. */
  async noteHead(a: WorktreeAssignment): Promise<WorktreeAssignment> {
    const head = await this.branchHead(a.branch);
    const next = { ...a, lastKnownHead: head };
    await this.deps.record(next);
    return next;
  }

  private async move(a: WorktreeAssignment, to: WorktreeState): Promise<WorktreeAssignment> {
    let next: WorktreeAssignment;
    try {
      next = transitionWorktree(a, to, { now: this.now() });
    } catch (e) {
      throw this.fail('invalid-state', (e as Error).message);
    }
    await this.deps.record(next);
    return next;
  }

  // ---- Inspection ----

  /** Every worktree git knows for this repository, flagged when it is under AW's root. */
  async list(): Promise<(GitWorktree & { ours: boolean })[]> {
    return (await this.worktrees()).map((w) => ({ ...w, ours: isInside(this.root, w.path) }));
  }

  /** Whether the assignment's tree is registered on its branch and on disk. */
  async exists(a: WorktreeAssignment): Promise<boolean> {
    return (await this.inspect(a)).present;
  }

  async inspect(a: WorktreeAssignment): Promise<WorktreeHealth> {
    const entry = (await this.worktrees()).find((w) => w.path === a.path);
    const branchHead = await this.branchHeadOrUndefined(a.branch);
    const present = !!entry && entry.branch === a.branch && entry.prunable === undefined && fs.existsSync(a.path);
    const health: WorktreeHealth = { present, branchHead, locked: entry?.locked, unexpectedCommits: [], rewritten: false };
    const idle = a.state === 'ready' || a.state === 'retained';
    if (idle && a.lastKnownHead && branchHead && branchHead !== a.lastKnownHead) {
      const anc = await this.git(['merge-base', '--is-ancestor', a.lastKnownHead, branchHead]);
      if (anc.code === 0) {
        const revs = await this.gitOk(['rev-list', `${a.lastKnownHead}..${branchHead}`], 'git-failed');
        health.unexpectedCommits = revs.stdout.split('\n').filter(Boolean);
      } else {
        health.rewritten = true;
      }
    }
    return health;
  }

  /**
   * The start-up pass (§23.3 step 5): finish half-created worktrees, mark the
   * ones that disappeared `missing` (saying whether their branch survives),
   * put back ones that reappeared, and report commits made outside any
   * attempt. Records every state change.
   */
  async reconcile(assignments: readonly WorktreeAssignment[]): Promise<ReconcileItem[]> {
    const out: ReconcileItem[] = [];
    for (const a of assignments) {
      if (a.state === 'removed') continue;
      try {
        if (a.state === 'creating') {
          out.push({ assignment: await this.create(a), action: 'finished' });
          continue;
        }
        const h = await this.inspect(a);
        if (!h.present) {
          if (a.state !== 'missing') this.fail('missing', `${a.branch} at ${a.path} has gone`);
          const next = a.state === 'missing' ? a : await this.move(a, 'missing');
          out.push({ assignment: next, action: 'missing', recreatable: h.branchHead !== undefined });
          continue;
        }
        if (a.state === 'missing') {
          out.push({ assignment: await this.move(a, 'ready'), action: 'restored' });
          continue;
        }
        if (h.unexpectedCommits.length > 0 || h.rewritten) {
          this.fail('unexpected-commits', `${a.branch} changed outside any attempt`);
          out.push({ assignment: a, action: 'unexpected-commits', unexpectedCommits: h.unexpectedCommits, rewritten: h.rewritten });
          continue;
        }
        out.push({ assignment: a, action: 'ok' });
      } catch (e) {
        out.push({ assignment: a, action: 'failed', error: (e as Error).message });
      }
    }
    return out;
  }

  // ---- Removal ----

  /**
   * Remove the tree and, by default, its branch. Refuses, changing nothing,
   * when the tree is in use (by an attempt or any process), dirty, locked or
   * not ours, or its branch is not reachable from `mergedInto`.
   */
  async remove(a: WorktreeAssignment, opts: { mergedInto: string; deleteBranch?: boolean }): Promise<RemoveOutcome> {
    if (a.state === 'removed') return { removed: true, assignment: a };
    const refusals: Refusal[] = [];
    const refuse = (reason: RefusalReason, detail: string) => refusals.push({ reason, detail });

    if (a.state === 'in-use') refuse('in-use', 'an attempt holds it');
    if (!isInside(this.root, a.path)) refuse('not-ours', `${a.path} is outside ${this.root}`);
    if (!a.branch.startsWith(`${BRANCH_PREFIX}/`)) refuse('not-ours', `${a.branch} is not an AW branch`);

    const entry = (await this.worktrees()).find((w) => w.path === a.path);
    if (entry && entry.branch !== a.branch) refuse('not-ours', `${a.path} is on ${entry.branch ?? 'a detached HEAD'}, not ${a.branch}`);
    if (entry?.locked !== undefined) refuse('locked', `locked${entry.locked ? `: ${entry.locked}` : ''}`);
    const present = !!entry && entry.prunable === undefined && fs.existsSync(a.path);
    const stray = !entry && fs.existsSync(a.path);
    if (stray) refuse('not-ours', `${a.path} exists but is not a registered worktree`);

    let artifacts: SetupArtifact[] = [];
    if (present && refusals.length === 0) {
      artifacts = this.setupArtifacts(a.path);
      const ignorable = new Set(artifacts.filter((x) => x.intact).map((x) => x.rel));
      const st = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], a.path);
      if (st.code !== 0) refuse('dirty', `could not read its status: ${st.stderr.trim()}`);
      else {
        const dirty = parseStatus(st.stdout)
          .map((e) => e.path.replace(/\/$/, ''))
          .filter((p) => !ignorable.has(p));
        if (dirty.length > 0) refuse('dirty', `uncommitted changes: ${listed(dirty)}`);
      }
      try {
        const pids = await this.processesUsing(a.path);
        if (pids.length > 0) refuse('in-use', `processes working in it: ${listed(pids.map(String))}`);
      } catch (e) {
        refuse('in-use', `could not check for processes using it: ${(e as Error).message}`);
      }
    }

    const head = await this.branchHeadOrUndefined(a.branch);
    if (head !== undefined) {
      const target = await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${opts.mergedInto}^{commit}`]);
      if (opts.mergedInto.startsWith('-') || target.code !== 0) refuse('unmerged', `cannot tell: "${opts.mergedInto}" is not a commit`);
      else {
        const anc = await this.git(['merge-base', '--is-ancestor', head, target.stdout.trim()]);
        if (anc.code === 1) refuse('unmerged', `${a.branch} has commits not in ${opts.mergedInto}`);
        else if (anc.code !== 0) refuse('unmerged', `cannot tell: ${anc.stderr.trim()}`);
      }
    }

    if (refusals.length > 0) {
      for (const r of refusals) this.fail(`refused-${r.reason}`, `${a.branch}: ${r.detail}`);
      return { removed: false, refusals };
    }

    if (present) {
      const undone = artifacts.filter((x) => x.intact);
      for (const x of undone) fs.rmSync(path.join(a.path, x.rel));
      const r = await this.git(['worktree', 'remove', a.path]);
      if (r.code !== 0) {
        // Something changed between the checks and the removal. Put setup back; report, change nothing else.
        await this.applySetup(a.path).catch(() => undefined);
        this.fail('git-failed', r.stderr.trim());
        return { removed: false, refusals: [{ reason: 'dirty', detail: `git refused: ${r.stderr.trim()}` }] };
      }
    } else if (entry) {
      await this.gitOk(['worktree', 'remove', a.path], 'git-failed');
    }
    if (head !== undefined && opts.deleteBranch !== false) {
      // Delete only if it still points where it did when we checked it was merged.
      await this.gitOk(['update-ref', '-d', `refs/heads/${a.branch}`, head], 'git-failed');
    }
    const removed = transitionWorktree(a, 'removed', { now: this.now() });
    await this.deps.record(removed);
    this.log(`worktree ${a.branch} removed from ${a.path}`);
    return { removed: true, assignment: removed };
  }

  // ---- Helpers ----

  private assertOurs(a: WorktreeAssignment): void {
    if (!isInside(this.root, a.path)) throw this.fail('invalid-name', `${a.path} is outside ${this.root}`);
    if (!a.branch.startsWith(`${BRANCH_PREFIX}/`)) throw this.fail('invalid-name', `${a.branch} is not an AW branch`);
  }

  private async worktrees(): Promise<GitWorktree[]> {
    const r = await this.gitOk(['worktree', 'list', '--porcelain', '-z'], 'git-failed');
    return parseWorktreeList(r.stdout);
  }

  private async branchHeadOrUndefined(branch: string): Promise<string | undefined> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private async branchHead(branch: string): Promise<string> {
    const head = await this.branchHeadOrUndefined(branch);
    if (head === undefined) throw this.fail('branch-missing', `${branch} does not exist`);
    return head;
  }

  private git(args: string[], cwd = this.repoRoot, timeoutMs?: number): Promise<ExecResult> {
    return this.exec('git', args, { cwd, timeoutMs });
  }

  private async gitOk(args: string[], category: WorktreeFailureCategory, timeoutMs?: number): Promise<ExecResult> {
    const r = await this.git(args, this.repoRoot, timeoutMs);
    if (r.code !== 0) throw this.fail(category, `git ${args[0]} ${args[1] ?? ''} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r;
  }

  /** Count a failure and return the error for it (thrown or not, as the caller decides). */
  private fail(category: WorktreeFailureCategory, detail: string): WorktreeError {
    this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
    this.deps.onFailure?.(category, detail);
    this.log(`worktree ${category}: ${detail}`);
    return new WorktreeError(category, detail);
  }
}
