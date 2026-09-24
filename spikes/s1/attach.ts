/**
 * Spike S1 (#5) confirmations that need two holders. Throwaway; never merged.
 *
 *   node spikes/s1/attach.ts
 *
 * 1. Holder A starts a fresh session with `sessionId: S` and goes idle.
 * 2. Holder B runs a *new* `Query` with `resume: S` while A's claude is alive.
 *    There is no SDK option to connect to a running CLI, so this is the only
 *    thing a second process can do; the question is whether the CLI refuses.
 * 3. A is then sent another turn, so both processes have written to S.
 * 4. Holder C tries a fresh session reusing `sessionId: S` (no resume).
 * All holders are ended with a clean exit; every pid is start-time checked.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = '/tmp/aw-spike-s1';
const PROJ = path.join(ROOT, 'proj');
const HOLDER = path.join(import.meta.dirname, 'holder.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = path.join(ROOT, 'runs', `${Date.now()}-attach`);
fs.mkdirSync(base, { recursive: true });

function events(dir: string): { kind: string; [k: string]: unknown }[] {
  try { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function children(pid: number): number[] {
  const out: number[] = [];
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
    const [a, b] = line.trim().split(/\s+/);
    if (Number(b) === pid) out.push(Number(a));
  }
  return out;
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

type H = { name: string; dir: string; pid: number; claude?: number; exited?: { code: number | null; signal: string | null } };
function start(name: string, extra: string[]): H {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, 'holder.log'), 'a');
  const c = spawn(process.execPath, [HOLDER, '--mode', 'idle', '--out', dir, '--cwd', PROJ, ...extra], { detached: true, stdio: ['ignore', log, log] });
  const h: H = { name, dir, pid: c.pid! };
  c.on('exit', (code, signal) => { h.exited = { code, signal }; });
  return h;
}
async function waitFor(h: H, pred: (e: ReturnType<typeof events>) => boolean, ms = 90_000): Promise<boolean> {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    if (pred(events(h.dir))) return true;
    if (h.exited) return pred(events(h.dir));
    await sleep(200);
  }
  return false;
}
const results = (e: ReturnType<typeof events>) => e.filter((x) => x.kind === 'sdk' && x.type === 'result');
function sessionJson(pid: number | undefined): unknown {
  if (!pid) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')); } catch { return undefined; }
}
function transcriptFor(sid: string): string | undefined {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(dir)) {
    if (!d.includes('aw-spike-s1')) continue;
    const f = path.join(dir, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

const report: Record<string, unknown> = { base };
const S = randomUUID();
report.S = S;

const A = start('A', ['--session', S]);
report.aReady = await waitFor(A, (e) => e.some((x) => x.kind === 'READY'));
A.claude = children(A.pid)[0];
const initA = events(A.dir).find((x) => x.kind === 'sdk' && x.subtype === 'init');
report.aInitSessionId = initA?.session_id;
report.aSessionJson = (sessionJson(A.claude) as { sessionId?: string } | undefined)?.sessionId;
const tx = transcriptFor(S);
report.transcriptNamedS = !!tx;
const linesAfterA = tx ? fs.readFileSync(tx, 'utf8').split('\n').filter(Boolean).length : 0;

const B = start('B', ['--resume', S, '--prompt', 'Reply with just: two']);
report.bReady = await waitFor(B, (e) => e.some((x) => x.kind === 'READY' || x.kind === 'iterator_error' || x.kind === 'iterator_done'));
B.claude = children(B.pid)[0];
const initB = events(B.dir).find((x) => x.kind === 'sdk' && x.subtype === 'init');
report.bInitSessionId = initB?.session_id;
report.bResult = results(events(B.dir)).map((r) => r.result);
report.bErrors = events(B.dir).filter((x) => x.kind === 'iterator_error' || x.kind === 'stderr').map((x) => String(x.err ?? x.d).slice(0, 200));
report.bSessionJson = (sessionJson(B.claude) as { sessionId?: string } | undefined)?.sessionId;
report.bothClaudesAlive = !!A.claude && !!B.claude && alive(A.claude) && alive(B.claude);
report.claudePids = { A: A.claude, B: B.claude };

process.kill(A.pid, 'SIGUSR1');
report.aSecondTurn = await waitFor(A, (e) => results(e).length >= 2);

// Transcript S after both wrote to it.
if (tx) {
  const rows = fs.readFileSync(tx, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; uuid?: string; parentUuid?: string | null; message?: { content?: unknown } });
  const chain = rows.filter((r) => r.uuid);
  const byParent = new Map<string, number>();
  for (const r of chain) if (r.parentUuid) byParent.set(r.parentUuid, (byParent.get(r.parentUuid) ?? 0) + 1);
  report.transcript = {
    linesAfterA,
    linesNow: rows.length,
    userTurns: rows.filter((r) => r.type === 'user' && typeof r.message?.content === 'string').map((r) => r.message!.content),
    forks: [...byParent.values()].filter((n) => n > 1).length,
  };
}
// Did B write into a different file?
if (typeof initB?.session_id === 'string' && initB.session_id !== S) report.bOwnTranscript = !!transcriptFor(initB.session_id);

// 4. fresh session reusing S
const C = start('C', ['--session', S, '--prompt', 'Reply with just: three']);
report.cOutcome = await waitFor(C, (e) => e.some((x) => x.kind === 'READY' || x.kind === 'iterator_error' || x.kind === 'iterator_done'), 60_000);
report.cEvents = events(C.dir).filter((x) => ['READY', 'iterator_error', 'iterator_done', 'stderr'].includes(x.kind) || (x.kind === 'sdk' && (x.type === 'result' || x.subtype === 'init'))).map((x) => ({ kind: x.kind, type: x.type, subtype: x.subtype, session_id: x.session_id, err: x.err ?? x.d, result: x.result }));
C.claude = children(C.pid)[0];

// Clean up: clean exit for every holder, then verify.
for (const h of [A, B, C]) if (!h.exited && alive(h.pid)) process.kill(h.pid, 'SIGUSR2');
await sleep(4000);
report.leftAlive = [A, B, C].flatMap((h) => [h.pid, h.claude]).filter((p): p is number => !!p && alive(p));
for (const p of report.leftAlive as number[]) process.kill(p, 'SIGKILL');
fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
