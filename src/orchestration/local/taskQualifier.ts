/**
 * Stage 2 of local-model qualification (`docs/plans/intelligent-orchestration.md`
 * §19.6, built §19.9): run each scratch-repo fixture k = 3 times through the
 * harness and endpoint the model would be routed through, and judge each run
 * on what is in the repo afterwards.
 *
 * - **Same path as an attempt.** A run is `AgentHarness.launch` with a
 *   `local:<id>` target, so its native provider and permission policy are
 *   applied exactly as they are for a routed attempt (§19.7.1), with
 *   `attemptPrompt`'s framing.
 * - **A scratch repo per run.** The fixture's `repo/` is copied into a fresh
 *   temp dir, `git init`ed and committed, so the diff is exactly the run's.
 *   The dir is removed afterwards, whatever happened.
 * - **The checks are ours** (`shared/orchestration/localQualification.ts`):
 *   the fixture's check command, run by AW after the session ends; the paths
 *   `git status` reports changed against the protected and allowed lists.
 * - **A question is a failure.** Nobody is there to answer it: a run that asks
 *   for approval or asks the user something is ended and fails.
 *
 * Fixtures live in `qualification-fixtures/<id>/` (`fixture.json` + `repo/`),
 * copied into the app bundle by the build.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SessionHandle, SessionViewEvent } from '../../core/session/sessionHandle';
import { claudeTurnUsage, codexTurnUsage, type SegmentState } from '../../core/telemetry/turnUsage';
import { changedPaths, judgeRun, parseFixture, type TaskFixture, type TaskRun } from '../../shared/orchestration/localQualification';
import { DEFAULT_REPO_POLICY } from '../../shared/orchestration/repoPolicy';
import type { ModelSourceId } from '../../shared/orchestration/types';
import { attemptLaunchPolicy, attemptPrompt } from '../engine/attemptPolicy';
import type { AgentHarness } from '../harness/types';
import type { TaskQualifier } from './localEndpointService';
import { nodeExec, type Exec } from '../worktrees/exec';

/** Runs per fixture (§19.6). */
export const TASK_QUALIFICATION_K = 3;
const RUN_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const POLL_MS = 500;
/** Idle this long after a turn ended before the run counts as finished: Codex may start another turn. */
const SETTLE_MS = 1_500;
const BRANCH = 'qualify';

export interface TaskQualifierDeps {
  /** The selected harness, with its endpoint provider. */
  harness: Pick<AgentHarness, 'launch'> & Partial<Pick<AgentHarness, 'id'>>;
  fixturesDir: string;
  exec?: Exec;
  /** Where scratch repos go. Default: the system temp dir. */
  tmpRoot?: string;
  now?: () => number;
  /** The Node that runs a check whose argv starts with `node`. Default: this process's, as Node. */
  nodePath?: string;
  runTimeoutMs?: number;
  checkTimeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  log?: (msg: string) => void;
}

/** Every fixture under `dir`, and the ones that could not be read. A directory without `fixture.json` is skipped. */
export async function loadFixtures(dir: string): Promise<{ fixtures: TaskFixture[]; errors: string[] }> {
  const fixtures: TaskFixture[] = [];
  const errors: string[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (e) {
    return { fixtures, errors: [`fixtures not found: ${String((e as Error).message ?? e)}`] };
  }
  for (const name of names) {
    const manifest = path.join(dir, name, 'fixture.json');
    try {
      if (!(await stat(path.join(dir, name))).isDirectory()) continue;
      const text = await readFile(manifest, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const r = parseFixture(JSON.parse(text), name);
      if (!r.ok) errors.push(r.error);
      else if (!(await stat(path.join(dir, name, 'repo'))).isDirectory()) errors.push(`${name}: no repo/`);
      else fixtures.push(r.fixture);
    } catch (e) {
      errors.push(`${name}: ${String((e as Error).message ?? e)}`);
    }
  }
  return { fixtures, errors };
}

export interface TaskQualificationRequest {
  source: ModelSourceId;
  model: string;
  fixtures: readonly TaskFixture[];
  k?: number;
  /** Each run as it finishes, for telemetry and the progress line. */
  onRun?: (run: TaskRun) => void;
  signal?: AbortSignal;
}

type Outcome = 'finished' | 'asked' | 'ended' | 'error' | 'timeout' | 'aborted';

const OUTCOME_TEXT: Record<Exclude<Outcome, 'finished'>, string> = {
  asked: 'it asked for approval or input, and nobody answers during qualification',
  ended: 'the session ended before its turn did',
  error: 'the session failed',
  timeout: 'it ran past the time limit',
  aborted: 'cancelled',
};

/**
 * Run every fixture `k` times. Stops early, keeping the runs so far, when a
 * run could not be started at all (the endpoint is off, the harness is
 * missing) or on abort; any other failure is that run's.
 */
export async function runTaskQualification(req: TaskQualificationRequest, deps: TaskQualifierDeps): Promise<{ runs: TaskRun[]; error?: string }> {
  const k = req.k ?? TASK_QUALIFICATION_K;
  const runs: TaskRun[] = [];
  for (const fixture of req.fixtures) {
    for (let n = 1; n <= k; n++) {
      if (req.signal?.aborted) return { runs, error: 'cancelled' };
      const r = await runOnce(req, fixture, n, deps);
      if ('fatal' in r) return { runs, error: r.fatal };
      runs.push(r.run);
      req.onRun?.(r.run);
    }
  }
  return { runs };
}

/**
 * `LocalEndpointService.useTaskQualifier`'s runner: the shipped fixtures,
 * read on each run (so a bad one is reported, not fatal), k = 3 each.
 */
export function taskQualifier(deps: TaskQualifierDeps & { k?: number }): TaskQualifier {
  return async ({ source, model, onStart, onRun }) => {
    const k = deps.k ?? TASK_QUALIFICATION_K;
    const { fixtures, errors } = await loadFixtures(deps.fixturesDir);
    for (const e of errors) deps.log?.(`local: qualification fixture skipped: ${e}`);
    if (fixtures.length === 0) return { runs: [], k, error: errors[0] ?? 'no fixtures found' };
    onStart(fixtures.length * k);
    const r = await runTaskQualification({ source, model, fixtures, k, onRun }, deps);
    return { ...r, k };
  };
}

async function runOnce(
  req: TaskQualificationRequest,
  fixture: TaskFixture,
  n: number,
  deps: TaskQualifierDeps,
): Promise<{ run: TaskRun } | { fatal: string }> {
  const exec = deps.exec ?? nodeExec;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const dir = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), 'aw-qualify-'));
  try {
    await copyTree(path.join(deps.fixturesDir, fixture.id, 'repo'), dir);
    const git = (args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, timeoutMs: 30_000 });
    for (const args of [
      ['init', '-q', '-b', BRANCH],
      ['add', '-A'],
      ['-c', 'user.name=Agent Wrangler', '-c', 'user.email=qualify@agentwrangler.invalid', 'commit', '-q', '-m', 'Fixture baseline'],
    ]) {
      const r = await git(args);
      if (r.code !== 0) return { fatal: `could not set up the scratch repo: git ${args[0]}: ${r.stderr.trim().split('\n')[0]}` };
    }

    const started = now();
    let handle: SessionHandle;
    try {
      handle = await deps.harness.launch({
        cwd: dir,
        prompt: attemptPrompt(
          {
            title: fixture.title,
            objective: fixture.prompt,
            acceptanceCriteria: [`\`${fixture.check.join(' ')}\` exits 0`, `Nothing matching ${fixture.protected.join(', ')} is changed`],
          },
            { harness: deps.harness.id === 'claude-code' ? 'claude-code' : 'codex', branch: BRANCH },
        ),
        target: { harness: deps.harness.id === 'claude-code' ? 'claude-code' : 'codex', model: req.model, source: req.source, effortNative: 'none' },
        origin: { kind: 'orchestration', missionId: 'qualification', taskId: fixture.id, attemptId: `qualification:${started}:${fixture.id}:${n}` },
        policy: attemptLaunchPolicy({ harness: deps.harness.id === 'claude-code' ? 'claude-code' : 'codex', primaryRoot: dir, repoPolicy: DEFAULT_REPO_POLICY }),
      });
    } catch (e) {
      return { fatal: `could not start a run: ${String((e as Error).message ?? e)}` };
    }

    const watched = await watch(handle, deps, req.signal);
    const wallMs = Math.max(0, now() - started);
    const toolCalls = handle.blocks.filter((b) => b.kind === 'tool').length;
    await Promise.race([handle.end().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);

    const check = await exec(checkFile(fixture.check[0], deps), fixture.check.slice(1), {
      cwd: dir,
      timeoutMs: deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
      env: checkEnv(),
    });
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const changed = status.code === 0 ? changedPaths(status.stdout) : [];
    const verdict = judgeRun(fixture, { check, changed });
    const tokens = sumTokens(watched.turnEnds, now());
    const stopped = watched.outcome !== 'finished' ? OUTCOME_TEXT[watched.outcome] : undefined;
    const run: TaskRun = {
      fixture: fixture.id,
      n,
      ...verdict,
      ...(status.code !== 0 ? { pass: false, failure: 'git status failed, so the diff could not be checked' } : {}),
      ...(stopped && !verdict.pass ? { failure: stopped } : {}),
      ...(watched.outcome === 'error' ? { infra: true } : {}),
      turns: watched.turnEnds.length,
      toolCalls,
      wallMs,
      ...tokens,
    };
    log(`local: qualification ${fixture.id} #${n}: ${run.pass ? 'pass' : `fail (${run.failure})`}`);
    if (watched.outcome === 'aborted') return { fatal: 'cancelled' };
    return { run };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Copy a fixture's files. By hand with `readdir`/`readFile`, not `fs.cp`:
 * in the packaged app the fixtures are inside `app.asar`, which Electron
 * serves through those calls and not necessarily through `cp`.
 */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(src, dst);
    else if (e.isFile()) await writeFile(dst, await readFile(src));
  }
}

/** Follow a run's session until it is finished, asks something, ends, or runs out of time. */
function watch(handle: SessionHandle, deps: TaskQualifierDeps, signal?: AbortSignal): Promise<{ outcome: Outcome; turnEnds: unknown[] }> {
  const turnEnds: unknown[] = [];
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.runTimeoutMs ?? RUN_TIMEOUT_MS);
  const settle = deps.settleMs ?? SETTLE_MS;
  let idleSince: number | undefined;
  return new Promise((resolve) => {
    let sub: { dispose(): void } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const done = (outcome: Outcome) => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      sub?.dispose();
      signal?.removeEventListener('abort', onAbort);
      if (outcome === 'timeout' || outcome === 'aborted') void handle.interrupt().catch(() => undefined);
      resolve({ outcome, turnEnds });
    };
    const onAbort = () => done('aborted');
    const tick = () => {
      const asked =
        !!handle.pendingQuestion || !!handle.pendingPlan || handle.blocks.some((b) => b.kind === 'permission' && (b as { state?: string }).state === 'pending');
      if (asked) return done('asked');
      if (handle.lifecycle === 'ended') return done(turnEnds.length > 0 ? 'finished' : 'ended');
      if (handle.lifecycle === 'error') return done('error');
      if (handle.lifecycle === 'idle' && turnEnds.length > 0) {
        idleSince ??= now();
        if (now() - idleSince >= settle) return done('finished');
      } else idleSince = undefined;
      if (now() >= deadline) return done('timeout');
    };
    timer = setInterval(tick, deps.pollMs ?? POLL_MS);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    sub = handle.subscribe(0, (e: SessionViewEvent) => {
      if (e.type === 'turnEnd') turnEnds.push(e.raw);
    });
  });
}

/** Tokens over the run's turns, from Codex's thread totals (`codexTurnUsage`). Absent when none were reported. */
function sumTokens(turnEnds: readonly unknown[], at: number): { inputTokens?: number; outputTokens?: number } {
  let state: SegmentState | undefined;
  let input = 0;
  let output = 0;
  let any = false;
  for (const raw of turnEnds) {
    const u = 'modelUsage' in (raw as Record<string, unknown> ?? {}) ? claudeTurnUsage(state, raw, at) : codexTurnUsage(state, raw, at);
    if (u.kind === 'duplicate') continue;
    state = u.next;
    if (u.kind !== 'usage') continue;
    for (const m of Object.values(u.modelsUsed)) {
      any = true;
      input += m.in ?? 0;
      output += m.out ?? 0;
    }
  }
  return any ? { inputTokens: input, outputTokens: output } : {};
}

/** `node` is this app's own Node, so a check never depends on what is on PATH. */
function checkFile(argv0: string, deps: TaskQualifierDeps): string {
  return argv0 === 'node' ? (deps.nodePath ?? process.execPath) : argv0;
}

/** A plain environment for the check: no `ELECTRON_*` but the one that makes the app's binary act as Node. */
function checkEnv(): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', LC_ALL: 'C' };
  for (const k of ['PATH', 'HOME', 'TMPDIR']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}
