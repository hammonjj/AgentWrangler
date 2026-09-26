/**
 * The one way the worktree manager runs a program: argv, never a shell, and a
 * result instead of a throw for a non-zero exit, so callers decide what an
 * exit code means. Injected, so tests can watch or replace it.
 */
import { execFile } from 'node:child_process';
import { parseLsofCwds } from './porcelain';

export interface ExecResult {
  /** The exit code; -1 when the program could not be started or was killed (timeout). */
  code: number;
  stdout: string;
  stderr: string;
  /**
   * Why there is no exit code, when there is none.
   *
   * A non-zero exit and a program that never ran are the same `-1` to
   * `execFile`, and verification has to tell them apart: a test suite that
   * failed is the agent's problem, while a command that timed out or was not
   * found is ours (§14.3, `error` rather than `failed`). Absent when the
   * program ran and exited on its own, whatever it exited with.
   */
  failure?: 'timeout' | 'spawn';
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  /**
   * The child's environment, replacing (not extending) the default.
   *
   * Git is run with the parent's environment plus a few forced settings, which
   * is right for git and wrong for a repository's own commands: those get the
   * stripped environment an agent gets (`agentEnv`), so a test suite never
   * inherits `ELECTRON_*` and decides it is running inside Electron.
   */
  env?: Record<string, string>;
}

export type Exec = (file: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

export const nodeExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        // Never wait on a credential prompt; English messages; no background lock-taking by `status`.
        env: opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const numeric = typeof (err as { code?: unknown }).code === 'number' && !err.killed;
        const code = numeric ? (err as { code: number }).code : -1;
        // `killed` is how a timeout arrives; a string `code` (ENOENT, EACCES)
        // is a program that never started. Anything else with no numeric code
        // is treated as a spawn failure too: it did not run, so it did not fail.
        const failure = numeric ? undefined : err.killed ? 'timeout' : 'spawn';
        resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message, failure });
      },
    );
  });

/**
 * Pids of processes whose working directory is `dir` or inside it, from
 * `lsof`. Throws when that cannot be found out: "don't know" must not read as
 * "nobody".
 */
export function lsofProcessesUsing(exec: Exec = nodeExec): (dir: string) => Promise<number[]> {
  return async (dir) => {
    const r = await exec('/usr/sbin/lsof', ['-w', '-d', 'cwd', '-F', 'pn'], { cwd: '/', timeoutMs: 15_000 });
    // lsof exits 1 when some process could not be inspected, with the rest still listed.
    if (r.code !== 0 && !(r.code === 1 && r.stdout.length > 0)) throw new Error(`lsof failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return parseLsofCwds(r.stdout, dir).filter((pid) => pid !== process.pid);
  };
}
