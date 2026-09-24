// Spike S4 (#8): what `codex app-server daemon update` / `restart` do to running work.
// Needs the isolated daemon from daemon.ts (home-b). A client holds a turn waiting on
// approval, then the daemon subcommand runs; afterwards a new client resumes the thread.
// Usage: node spikes/s4/daemonUpdate.ts <update|restart> [cliForSubcommand]
//   cliForSubcommand: binary that runs the subcommand (for `update --from-cli` this is the
//   package that gets copied and pinned; use /tmp/aw-spike-s4/pkg-old/bin/codex to downgrade).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Rpc, sleep, type Frame } from './rpc.ts';
import { ROOT, PROJ, codexBinaries, codexEnv, alive } from './env.ts';

const action = process.argv[2] ?? 'update';
const cli = process.argv[3] ?? codexBinaries()[0];
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'daemon-state.json'), 'utf8'));
const env = codexEnv(state.home);
const log = path.join(ROOT, `daemon-${action}.jsonl`);
fs.rmSync(log, { force: true });
fs.rmSync(path.join(PROJ, 'approved-marker.txt'), { force: true });
const out: Record<string, unknown> = { action, cli };
const isReq = (f: Frame) => f.id !== undefined && typeof f.method === 'string';
const pidFile = path.join(state.home, 'app-server-daemon', 'daemon.pid');
const readPid = () => { try { return fs.readFileSync(pidFile, 'utf8').trim(); } catch { return 'none'; } };
const version = () => {
  const r = spawnSync(cli, ['app-server', 'daemon', 'version'], { env, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return r.stderr.trim(); }
};

try {
  out.before = { pid: readPid(), version: version() };
  const c1 = new Rpc('c1', log);
  await c1.connect({ kind: 'proxy', binary: codexBinaries()[0], env });
  await c1.initialize();
  const t = await c1.request('thread/start', { cwd: PROJ, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  const threadId = t.thread.id;
  await c1.request('turn/start', { threadId, input: [{ type: 'text', text: 'approve please', text_elements: [] }] });
  await c1.waitFor((f) => isReq(f) && f.params?.threadId === threadId, 20000, 'approval');

  const args = action === 'update' ? ['app-server', 'daemon', 'update', '--from-cli', '--yes'] : ['app-server', 'daemon', 'restart'];
  const started = Date.now();
  const r = spawnSync(cli, args, { env, encoding: 'utf8', input: '', timeout: 120000 });
  out.subcommand = { args: args.slice(2).join(' '), status: r.status, ms: Date.now() - started, stdout: r.stdout.trim().slice(0, 800), stderr: r.stderr.trim().slice(-800) };
  await sleep(1500);
  out.oldClientClosed = c1.closed ? c1.closeReason : 'still open';
  out.oldClientFramesAfter = c1.inbound(started).map((f) => (isReq(f) ? `REQ ${f.method}` : f.method ?? 'resp'));
  out.after = { pid: readPid(), version: version() };

  const c2 = new Rpc('c2', log);
  await c2.connect({ kind: 'proxy', binary: codexBinaries()[0], env });
  await c2.initialize();
  const since = Date.now();
  const resumed = await c2.request('thread/resume', { threadId }).catch((e: Error) => ({ error: e.message }));
  out.resume = (resumed as any).error ?? {
    status: (resumed as any).thread?.status,
    turns: (resumed as any).thread?.turns?.map((x: any) => ({ status: x.status, items: x.items?.map((i: any) => i.type) })),
  };
  await sleep(3000);
  const replay = c2.inbound(since).find(isReq);
  out.replayed = replay ? replay.method : false;
  if (replay) {
    c2.respond(replay.id!, { decision: 'accept' });
    const done = await c2.waitFor((f) => f.method === 'turn/completed', 20000).catch(() => undefined);
    out.turnAfterAnswer = done?.params?.turn?.status ?? 'none';
    out.commandRan = fs.existsSync(path.join(PROJ, 'approved-marker.txt'));
  }
  c1.drop();
  c2.drop();
} catch (e) {
  out.error = (e as Error).message;
} finally {
  out.oldDaemonPidAlive = Number(out.before && (out.before as any).pid) ? alive(Number((out.before as any).pid)) : undefined;
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}
