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
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
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
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof (err as { code?: unknown }).code === 'number' && !err.killed ? ((err as { code: number }).code) : -1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message });
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
