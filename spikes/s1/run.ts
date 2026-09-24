/**
 * Spike S1 (#5) driver. Throwaway; never merged.
 *
 *   node spikes/s1/run.ts <mode>:<kill> [<mode>:<kill> ...]
 *     mode: idle | stream | ask | bash | bg | eofask | eofbash | eofbg
 *     kill: SIGKILL | SIGTERM | clean | none (eof modes use none)
 *
 * For each case: start a holder (detached, its own process group), wait for it
 * to report READY, snapshot the holder's process tree, hit the holder, then
 * poll the recorded pids until they are gone or a deadline passes. Every pid
 * touched is one this script spawned (a descendant of its own holder), checked
 * by start time before any cleanup signal so a reused pid is never hit.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = '/tmp/aw-spike-s1';
const PROJ = path.join(ROOT, 'proj');
const HOLDER = path.join(import.meta.dirname, 'holder.ts');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
fs.mkdirSync(PROJ, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Proc = { pid: number; ppid: number; lstart: string; stat: string; command: string };

function psPids(pids: number[]): Map<number, Proc> {
  const res = new Map<number, Proc>();
  if (pids.length === 0) return res;
  let outp = '';
  try {
    outp = execFileSync('ps', ['-o', 'pid=,ppid=,stat=,lstart=,command=', '-p', pids.join(',')], { encoding: 'utf8' });
  } catch (e) {
    outp = (e as { stdout?: string }).stdout ?? '';
  }
  for (const line of outp.split('\n')) {
    const tok = line.trim().split(/\s+/);
    if (tok.length < 8) continue;
    const [pid, ppid, stat, ...rest] = tok;
    res.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), stat, lstart: rest.slice(0, 5).join(' '), command: rest.slice(5).join(' ') });
  }
  return res;
}

/** pid → ppid for the whole table; used only to find our own holder's descendants. */
function ppidTable(): Map<number, number> {
  const m = new Map<number, number>();
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
    const [a, b] = line.trim().split(/\s+/);
    if (a) m.set(Number(a), Number(b));
  }
  return m;
}

function descendants(root: number): number[] {
  const t = ppidTable();
  const out: number[] = [];
  const frontier = [root];
  while (frontier.length) {
    const p = frontier.pop()!;
    for (const [c, pp] of t) if (pp === p) { out.push(c); frontier.push(c); }
  }
  return out;
}

function readEvents(file: string): { kind: string; [k: string]: unknown }[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function findTranscript(sid: string): string | undefined {
  const dir = path.join(CLAUDE_HOME, 'projects');
  for (const d of fs.readdirSync(dir)) {
    if (!d.includes('aw-spike-s1')) continue;
    const f = path.join(dir, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

function transcriptState(file: string | undefined) {
  if (!file) return { exists: false };
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let lastParses = true;
  let last: { type?: string; subtype?: string } = {};
  try { last = JSON.parse(lines[lines.length - 1]); } catch { lastParses = false; }
  let badLines = 0;
  for (const l of lines) { try { JSON.parse(l); } catch { badLines++; } }
  return {
    exists: true,
    lines: lines.length,
    endsWithNewline: raw.endsWith('\n'),
    lastParses,
    badLines,
    lastType: last.type,
    lastSubtype: last.subtype,
    tailTypes: lines.slice(-4).map((l) => { try { const j = JSON.parse(l); return `${j.type}${j.subtype ? '/' + j.subtype : ''}`; } catch { return 'UNPARSEABLE'; } }),
  };
}

function sessionFile(pid: number): string {
  return path.join(CLAUDE_HOME, 'sessions', `${pid}.json`);
}

function readSessionFile(pid: number): unknown {
  // Only ever called with a claude pid this script spawned.
  try { return JSON.parse(fs.readFileSync(sessionFile(pid), 'utf8')); } catch { return undefined; }
}

async function runCase(spec: string) {
  const [mode, kill] = spec.split(':');
  const sid = randomUUID();
  const dir = path.join(ROOT, 'runs', `${Date.now()}-${mode}-${kill}`);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, 'holder.log'), 'a');
  const holder = spawn(process.execPath, [HOLDER, '--mode', mode, '--out', dir, '--cwd', PROJ, '--session', sid, ...(process.env.S1_EXTRA ? process.env.S1_EXTRA.split(' ') : [])], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  let holderExit: { at: number; code: number | null; signal: string | null } | undefined;
  holder.on('exit', (code, signal) => { holderExit = { at: Date.now(), code, signal }; });
  const holderPid = holder.pid!;
  const eventsFile = path.join(dir, 'events.jsonl');
  const result: Record<string, unknown> = { spec, mode, kill, sid, dir, holderPid };
  const base = mode.replace(/^eof/, '');

  // ---- wait for READY -------------------------------------------------------
  const readyDeadline = Date.now() + 120_000;
  while (!readEvents(eventsFile).some((e) => e.kind === 'READY')) {
    if (Date.now() > readyDeadline || holderExit) { result.error = 'never READY'; break; }
    await sleep(200);
  }
  // For shell cases, wait until the sleep is actually running under claude.
  if (!result.error && (base === 'bash' || base === 'bg')) {
    const want = base === 'bash' ? /sleep 120/ : /sleep 600/;
    const d = Date.now() + 30_000;
    for (;;) {
      const procs = psPids(descendants(holderPid));
      if ([...procs.values()].some((p) => want.test(p.command))) break;
      if (Date.now() > d) { result.error = 'shell never seen'; break; }
      await sleep(200);
    }
  }
  await sleep(300);

  // ---- snapshot -------------------------------------------------------------
  const tree = psPids(descendants(holderPid));
  const claude = [...tree.values()].find((p) => p.ppid === holderPid && /claude/.test(p.command));
  const tracked = new Map<number, { role: string; lstart: string; command: string }>();
  tracked.set(holderPid, { role: 'holder', lstart: psPids([holderPid]).get(holderPid)?.lstart ?? '', command: 'holder' });
  for (const p of tree.values()) {
    const role = p === claude ? 'claude' : /sleep 600/.test(p.command) ? 'bg-sleep' : /sleep 120/.test(p.command) ? 'fg-sleep' : /sleep/.test(p.command) ? 'sleep' : /(zsh|bash|sh) /.test(p.command) || /^\S*(zsh|bash|sh)$/.test(p.command) ? 'shell' : 'other';
    tracked.set(p.pid, { role, lstart: p.lstart, command: p.command.slice(0, 160) });
  }
  result.tree = [...tracked.entries()].map(([pid, v]) => ({ pid, ...v, ppid: tree.get(pid)?.ppid }));
  const claudePid = claude?.pid;
  result.claudePid = claudePid;
  result.sessionFileBefore = claudePid ? readSessionFile(claudePid) : undefined;
  const transcript = findTranscript(sid);
  result.transcriptPath = transcript;
  result.transcriptBefore = transcriptState(transcript);

  // ---- hit it ---------------------------------------------------------------
  const tKill = Date.now();
  if (kill === 'SIGKILL' || kill === 'SIGTERM') process.kill(holderPid, kill);
  else if (kill === 'sweep') process.kill(holderPid, 'SIGKILL');
  else if (kill === 'clean') process.kill(holderPid, 'SIGUSR2');

  // ---- observe --------------------------------------------------------------
  const obs = new Map<number, { diedAt?: number; orphanAt?: number; ppids: number[]; zombieAt?: number }>();
  for (const pid of tracked.keys()) obs.set(pid, { ppids: [] });
  const limit = base === 'bash' || base === 'bg' ? 170_000 : 40_000;
  const soft = 25_000;
  // Is sessions/<pid>.json still there while claude outlives its holder? This
  // is what the §7.3 orphan sweep keys on.
  const sessionSamples: { ms: number; exists: boolean; claudeAlive: boolean }[] = [];
  const sampleAt = [1000, 5000, 15000, 60000, 110000];
  // `sweep`: SIGKILL the holder, then 5 s later SIGTERM the orphaned claude
  // the way §7.3's sweep (`endProcess`) would, start-time checked.
  let swept = false;
  for (;;) {
    const now = Date.now();
    if (kill === 'sweep' && !swept && claudePid && now - tKill >= 5000) {
      swept = true;
      const p = psPids([claudePid]).get(claudePid);
      if (p && p.lstart === tracked.get(claudePid)!.lstart) { process.kill(claudePid, 'SIGTERM'); result.sweptAt = now - tKill; }
    }
    if (claudePid && sampleAt.length && now - tKill >= sampleAt[0]) {
      sampleAt.shift();
      sessionSamples.push({ ms: now - tKill, exists: fs.existsSync(sessionFile(claudePid)), claudeAlive: obs.get(claudePid)!.diedAt === undefined });
    }
    const live = psPids([...tracked.keys()]);
    for (const [pid, o] of obs) {
      const p = live.get(pid);
      const same = p && p.lstart === tracked.get(pid)!.lstart;
      if (!same || p.stat.startsWith('Z')) {
        if (p?.stat.startsWith('Z') && o.zombieAt === undefined) o.zombieAt = now - tKill;
        if (!same && o.diedAt === undefined) o.diedAt = now - tKill;
        continue;
      }
      if (o.ppids[o.ppids.length - 1] !== p.ppid) o.ppids.push(p.ppid);
      if (p.ppid === 1 && o.orphanAt === undefined) o.orphanAt = now - tKill;
    }
    const claudeGone = claudePid === undefined || obs.get(claudePid)!.diedAt !== undefined;
    const allGone = [...obs.values()].every((o) => o.diedAt !== undefined);
    if (allGone) break;
    // Past the soft limit only keep watching if claude itself is still up
    // (a surviving bg sleep is recorded, not waited out).
    if (now - tKill > soft && claudeGone) break;
    if (now - tKill > limit) break;
    await sleep(50);
  }
  await sleep(1500); // give the CLI's own cleanup a moment on disk
  result.sessionSamples = sessionSamples;
  result.observe = [...obs.entries()].map(([pid, o]) => ({ pid, role: tracked.get(pid)!.role, ...o }));
  result.holderExit = holderExit ? { ms: holderExit.at - tKill, code: holderExit.code, signal: holderExit.signal } : 'still running';
  result.sessionFileAfterExists = claudePid ? fs.existsSync(sessionFile(claudePid)) : undefined;
  result.sessionFileAfter = claudePid ? readSessionFile(claudePid) : undefined;
  result.transcriptAfter = transcriptState(findTranscript(sid));
  const hookFile = claudePid ? path.join(dir, `hook-${claudePid}.jsonl`) : '';
  result.hookEvents = hookFile && fs.existsSync(hookFile)
    ? fs.readFileSync(hookFile, 'utf8').split(/(?<=\})\s*(?=\{)/).map((s) => { try { return JSON.parse(s).hook_event_name + ':' + (JSON.parse(s).reason ?? ''); } catch { return '?'; } })
    : [];
  const events = readEvents(eventsFile);
  result.holderEvents = events.filter((e) => ['READY', 'can_use_tool', 'can_use_tool_aborted', 'end_stdin', 'child_exit', 'iterator_done', 'iterator_error', 'clean_exit', 'holder_exit'].includes(e.kind) || (e.kind === 'sdk' && (e.type === 'result' || e.type === 'system'))).map((e) => ({ ...e, sinceKill: (e.at as number) - tKill }));

  // ---- clean up only what we recorded, start-time checked --------------------
  const leftovers: number[] = [];
  const live = psPids([...tracked.keys()]);
  for (const [pid, t] of tracked) {
    const p = live.get(pid);
    if (p && p.lstart === t.lstart && !p.stat.startsWith('Z')) { leftovers.push(pid); process.kill(pid, 'SIGTERM'); }
  }
  if (leftovers.length) {
    await sleep(2000);
    const again = psPids(leftovers);
    for (const pid of leftovers) { const p = again.get(pid); if (p && p.lstart === tracked.get(pid)!.lstart) process.kill(pid, 'SIGKILL'); }
  }
  result.cleanupKilled = leftovers.map((pid) => `${pid}:${tracked.get(pid)!.role}`);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  fs.closeSync(log);
  const short = (result.observe as { role: string; diedAt?: number; orphanAt?: number }[]).map((o) => `${o.role}:${o.diedAt ?? 'ALIVE'}${o.orphanAt !== undefined ? '(orphan@' + o.orphanAt + ')' : ''}`).join(' ');
  console.log(`${spec.padEnd(18)} ${result.error ?? ''} ${short} | sess.json during=${sessionSamples.map((s) => `${s.ms}:${s.exists ? 'Y' : 'N'}${s.claudeAlive ? '' : '(dead)'}`).join(',')} after=${result.sessionFileAfterExists} | tx=${JSON.stringify(result.transcriptAfter)} | hooks=${(result.hookEvents as string[]).join(',')} | cleanup=${(result.cleanupKilled as string[]).join(',')} | ${dir}`);
  return result;
}

const specs = process.argv.slice(2);
for (const s of specs) await runCase(s);
