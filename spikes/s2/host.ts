/**
 * Spike S2 (#6): a prototype detached session host. THROWAWAY.
 *
 * Run by the spike core as `<runtime exe> host.js --id … --run … --cwd … --claude …`
 * with ELECTRON_RUN_AS_NODE=1, detached (setsid), stdout/stderr to a log file.
 *
 * - The token arrives as the first stdin line; stdin is then destroyed.
 * - Listens on `<run>/<id>.sock` (0600) and writes `<run>/<id>.json` (manifest).
 * - Runs one real SDK session with a streaming input queue, so `claude` stays up
 *   between turns and each `send` is a turn on the same `Query`.
 * - SIGTERM: end the input (stdin EOF to claude), wait up to 5 s for claude to
 *   exit, then exit. This is what logout would exercise.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

declare const S2_BUILD: string;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const hostId = arg('id');
const runDir = arg('run');
const cwd = arg('cwd');
const claudeBin = arg('claude');
const leakEnv = process.argv.includes('--leak-env');
const sockPath = path.join(runDir, `${hostId}.sock`);
const manifestPath = path.join(runDir, `${hostId}.json`);
const startedAt = Date.now();

function log(msg: string): void {
  // stdout is the log file the core opened for us; never a pipe to the core.
  process.stdout.write(`[${new Date().toISOString()}] host ${hostId} pid ${process.pid}: ${msg}\n`);
}

log(`start build=${typeof S2_BUILD === 'string' ? S2_BUILD : '?'} execPath=${process.execPath} argv0=${process.argv0} ppid=${process.ppid} leakEnv=${leakEnv}`);
log(`ELECTRON_* in host env: ${Object.keys(process.env).filter((k) => k.startsWith('ELECTRON_')).join(',') || '(none)'}`);

// ---- timer drift (App Nap / coalescing) --------------------------------------
const drift = { last: Date.now(), n: 0, max: 0, over1500: 0, sum: 0 };
setInterval(() => {
  const now = Date.now();
  const d = now - drift.last;
  drift.last = now;
  drift.n++;
  drift.sum += d;
  if (d > drift.max) drift.max = d;
  if (d > 1500) drift.over1500++;
}, 1000);
function resetDrift(): void {
  Object.assign(drift, { last: Date.now(), n: 0, max: 0, over1500: 0, sum: 0 });
}

// ---- the SDK session ---------------------------------------------------------
const pendingInput: SDKUserMessage[] = [];
let inputWake: (() => void) | undefined;
let inputEnded = false;

async function* inputStream(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (pendingInput.length) yield pendingInput.shift()!;
    if (inputEnded) return;
    await new Promise<void>((r) => (inputWake = r));
    inputWake = undefined;
  }
}
function push(text: string): void {
  pendingInput.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
  inputWake?.();
}
function endInput(): void {
  inputEnded = true;
  inputWake?.();
}

function claudeEnv(): Record<string, string> | undefined {
  if (leakEnv) return undefined; // control: SDK inherits process.env
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_') || k.startsWith('AW_')) continue;
    env[k] = v;
  }
  env.PATH = `${env.PATH ?? '/usr/bin:/bin'}:/opt/homebrew/bin`;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'aw-spike-s2/0';
  return env;
}

let sessionId: string | undefined;
let turns = 0;
let lastResult: { text: string; at: number } | undefined;
const resultWaiters: ((r: { text: string; ms: number }) => void)[] = [];
let turnStart = 0;

const q = query({
  prompt: inputStream(),
  options: {
    cwd,
    model: 'haiku',
    settingSources: [], // isolation: none of the user's hooks or settings
    pathToClaudeCodeExecutable: claudeBin,
    env: claudeEnv(),
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    stderr: (d) => log(`claude stderr: ${d.trim().slice(0, 300)}`),
  },
});

void (async () => {
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        log(`init session=${sessionId}`);
        writeManifest();
      }
      if (m.type === 'result') {
        turns++;
        const text = m.subtype === 'success' ? m.result : `error:${m.subtype}`;
        lastResult = { text, at: Date.now() };
        log(`result turn=${turns} text=${JSON.stringify(text.slice(0, 80))}`);
        const ms = Date.now() - turnStart;
        resultWaiters.splice(0).forEach((w) => w({ text, ms }));
      }
    }
    log('query iterator ended');
  } catch (err) {
    log(`query error: ${String(err)}`);
  }
})();

function claudePid(): number | undefined {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(process.pid)], { encoding: 'utf8' });
    const pids = out.trim().split(/\s+/).map(Number).filter(Boolean);
    return pids[0];
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeManifest(): void {
  const m = {
    hostId,
    pid: process.pid,
    startedAt,
    socket: sockPath,
    sessionId,
    claudePid: claudePid(),
    build: typeof S2_BUILD === 'string' ? S2_BUILD : '?',
    execPath: process.execPath,
    cwd,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), { mode: 0o600 });
}

// ---- socket server -------------------------------------------------------------
let token: string | undefined;

type Req = { id?: number; method: string; params?: Record<string, unknown> };

async function handle(req: Req, authed: { ok: boolean }): Promise<unknown> {
  const p = req.params ?? {};
  if (req.method === 'hello') {
    if (p.hostId !== hostId) throw new Error('wrong hostId');
    if (typeof p.token !== 'string' || p.token !== token) throw new Error('bad token');
    authed.ok = true;
    return { hostId, pid: process.pid, sessionId, build: typeof S2_BUILD === 'string' ? S2_BUILD : '?' };
  }
  if (!authed.ok) throw new Error('hello first');
  switch (req.method) {
    case 'status': {
      const cp = claudePid();
      return {
        pid: process.pid,
        ppid: process.ppid,
        uptimeS: Math.round((Date.now() - startedAt) / 1000),
        rssKb: Math.round(process.memoryUsage().rss / 1024),
        heapUsedKb: Math.round(process.memoryUsage().heapUsed / 1024),
        claudePid: cp,
        claudeAlive: cp ? alive(cp) : false,
        sessionId,
        turns,
        lastResult,
        execPath: process.execPath,
      };
    }
    case 'send': {
      const text = String(p.text ?? 'Reply with exactly: pong');
      const timeoutMs = Number(p.timeoutMs ?? 90000);
      turnStart = Date.now();
      const r = new Promise<{ text: string; ms: number }>((res, rej) => {
        resultWaiters.push(res);
        setTimeout(() => rej(new Error('turn timeout')), timeoutMs);
      });
      push(text);
      return await r;
    }
    case 'readdir': {
      const t0 = Date.now();
      const dir = String(p.path);
      const timeoutMs = Number(p.timeoutMs ?? 15000);
      try {
        const names = await Promise.race([
          fsp.readdir(dir),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs} ms (TCC prompt?)`)), timeoutMs)),
        ]);
        return { ok: true, count: names.length, ms: Date.now() - t0 };
      } catch (err) {
        return { ok: false, error: String(err), ms: Date.now() - t0 };
      }
    }
    case 'timers':
      if (p.reset) resetDrift();
      return { n: drift.n, maxMs: drift.max, over1500: drift.over1500, avgMs: drift.n ? Math.round(drift.sum / drift.n) : 0 };
    case 'shutdown':
      setTimeout(() => void gracefulExit('shutdown method'), 10);
      return { ok: true };
    default:
      throw new Error(`unknown method ${req.method}`);
  }
}

const server = net.createServer((sock) => {
  const authed = { ok: false };
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req: Req;
      try {
        req = JSON.parse(line) as Req;
      } catch {
        sock.write(`${JSON.stringify({ error: 'bad json' })}\n`);
        continue;
      }
      log(`rpc ${req.method}`); // op name only, never content
      handle(req, authed).then(
        (result) => sock.write(`${JSON.stringify({ id: req.id, result })}\n`),
        (err: unknown) => sock.write(`${JSON.stringify({ id: req.id, error: String(err) })}\n`),
      );
    }
  });
  sock.on('error', () => undefined);
});

// ---- token over stdin, then listen -----------------------------------------------
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c: string) => {
  stdinBuf += c;
  const nl = stdinBuf.indexOf('\n');
  if (nl < 0 || token) return;
  token = stdinBuf.slice(0, nl).trim();
  process.stdin.destroy();
  log(`token received (${token.length} chars); stdin destroyed`);
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* none */
  }
  const oldUmask = process.umask(0o177);
  server.listen(sockPath, () => {
    process.umask(oldUmask);
    fs.chmodSync(sockPath, 0o600);
    log(`listening ${sockPath}`);
    writeManifest();
    push('Reply with exactly: ready');
    turnStart = Date.now();
  });
});

// ---- signals -----------------------------------------------------------------------
let exiting = false;
async function gracefulExit(why: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  const t0 = Date.now();
  const cp = claudePid();
  log(`graceful exit (${why}); claude pid ${cp ?? 'none'}; ending input`);
  endInput();
  // Give the SDK its stdin-EOF path; fall back to close().
  for (let i = 0; i < 50 && cp && alive(cp); i++) await new Promise((r) => setTimeout(r, 100));
  if (cp && alive(cp)) {
    log(`claude still alive after ${Date.now() - t0} ms; q.close()`);
    try {
      q.close();
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 30 && alive(cp); i++) await new Promise((r) => setTimeout(r, 100));
  }
  log(`claude ${cp && alive(cp) ? 'STILL ALIVE' : 'exited'} after ${Date.now() - t0} ms; host exiting`);
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', () => void gracefulExit('SIGTERM'));
process.on('SIGINT', () => void gracefulExit('SIGINT'));
process.on('SIGHUP', () => log('SIGHUP received (ignored)'));
process.on('uncaughtException', (e) => log(`uncaughtException ${String(e)}`));
process.on('exit', (c) => log(`exit code ${c}`));
