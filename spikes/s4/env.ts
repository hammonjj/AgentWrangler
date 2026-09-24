// Spike S4 (#8): shared setup. Every Codex process the spike starts runs with an isolated
// CODEX_HOME under /tmp/aw-spike-s4, pointed at the mock model server, so nothing touches
// ~/.codex (auth, sessions, daemon socket, launchd) or any Codex process James runs.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const ROOT = '/tmp/aw-spike-s4';
export const PROJ = path.join(ROOT, 'proj');

/** The two extension-bundled binaries found on this machine, newest first. */
export function codexBinaries(): string[] {
  const root = path.join(os.homedir(), '.vscode', 'extensions');
  return fs.readdirSync(root)
    .filter((n) => /^openai\.chatgpt-\d/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((n) => path.join(root, n, 'bin', 'macos-aarch64', 'codex'))
    .filter((p) => fs.existsSync(p));
}

export function makeHome(name: string, mockPort: number): string {
  const home = path.join(ROOT, name);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "mock-model"',
    'model_provider = "mock"',
    'check_for_update_on_startup = false',
    '[model_providers.mock]',
    'name = "mock"',
    `base_url = "http://127.0.0.1:${mockPort}/v1"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    `[projects."${PROJ}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  return home;
}

export function codexEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: process.env.RUST_LOG ?? 'warn' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  return env;
}

export async function startMock(logPath: string, slowMs = 20000): Promise<{ port: number; child: ChildProcess }> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'mockResponses.ts')], {
    env: { ...process.env, MOCK_LOG: logPath, SLOW_MS: String(slowMs) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve) => {
    child.stdout!.setEncoding('utf8');
    child.stdout!.once('data', (d) => resolve(Number(String(d).trim())));
  });
  return { port, child };
}

/**
 * Option (a): an AW-owned app-server on a Unix socket, detached into its own session so it
 * would outlive the process that started it. stdout/stderr go to a log file, never a pipe.
 */
export async function startListener(binary: string, home: string, sock: string, logFile: string): Promise<ChildProcess> {
  try { fs.unlinkSync(sock); } catch { /* none */ }
  const fd = fs.openSync(logFile, 'a');
  // UNLOAD_DELAY sets `thread_unload_delay_secs`: how long a thread with no subscribers stays
  // loaded (and holds its writer lock) after going idle.
  const extra = process.env.UNLOAD_DELAY ? ['-c', `thread_unload_delay_secs=${process.env.UNLOAD_DELAY}`] : [];
  const child = spawn(binary, [...extra, 'app-server', '--listen', `unix://${sock}`], {
    env: codexEnv(home), detached: true, stdio: ['ignore', fd, fd], cwd: PROJ,
  });
  child.unref();
  fs.closeSync(fd);
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(sock)) throw new Error(`listener did not create ${sock}`);
  return child;
}

export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
