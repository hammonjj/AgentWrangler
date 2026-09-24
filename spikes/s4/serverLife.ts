// Spike S4 (#8): what the *server* does, as opposed to the client.
//   term    SIGTERM an idle listener, then one with a turn waiting on approval; SIGKILL it;
//           start a fresh listener on the same CODEX_HOME and resume the thread.
//   writers two listeners on one CODEX_HOME (think: AW's server and the VS Code extension's
//           app-server) both resume and drive the same thread.
// Usage: node spikes/s4/serverLife.ts <term|writers>
// CODEX_BIN / CODEX_BIN2 choose the binaries for the first and second server.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rpc, sleep, type Frame } from './rpc.ts';
import { ROOT, PROJ, codexBinaries, makeHome, startMock, startListener, alive } from './env.ts';

const which = process.argv[2] ?? 'term';
const log = path.join(ROOT, `life-${which}.jsonl`);
fs.rmSync(log, { force: true });
const bins = codexBinaries();
const bin1 = process.env.CODEX_BIN ?? bins[0];
const bin2 = process.env.CODEX_BIN2 ?? bins[0];
const mock = await startMock(path.join(ROOT, `mock-life-${which}.log`), 20000);
const home = makeHome(`home-life-${which}`, mock.port);
const out: Record<string, unknown> = { which };
const spawned: number[] = [];
const isReq = (f: Frame) => f.id !== undefined && typeof f.method === 'string';
let sockSeq = 0;

async function server(binary: string): Promise<{ pid: number; sock: string }> {
  const sock = path.join(ROOT, `life-${which}-${sockSeq++}.sock`);
  const child = await startListener(binary, home, sock, path.join(ROOT, `server-life-${which}.log`));
  spawned.push(child.pid!);
  return { pid: child.pid!, sock };
}

async function client(name: string, sock: string): Promise<Rpc> {
  const rpc = new Rpc(name, log);
  await rpc.connect({ kind: 'unix', path: sock });
  await rpc.initialize(name);
  return rpc;
}

async function waitExit(pid: number, ms: number): Promise<number | 'still alive'> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (!alive(pid)) return Date.now() - start; await sleep(100); }
  return 'still alive';
}

async function startApprovalTurn(rpc: Rpc): Promise<{ threadId: string; request: Frame }> {
  const t = await rpc.request('thread/start', { cwd: PROJ, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  await rpc.request('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: 'approve please', text_elements: [] }] });
  const request = await rpc.waitFor((f) => isReq(f) && f.params?.threadId === t.thread.id, 20000, 'approval');
  return { threadId: t.thread.id, request };
}

const summarizeTurns = (thread: any) => thread?.turns?.map((t: any) => ({ status: t.status, items: t.items?.map((i: any) => `${i.type}${i.status ? `:${i.status}` : ''}`) }));

try {
  if (which === 'term') {
    // 1. Idle listener, one client has come and gone.
    const idle = await server(bin1);
    (await client('idle', idle.sock)).drop();
    await sleep(300);
    process.kill(idle.pid, 'SIGTERM');
    out.idleSigtermExitMs = await waitExit(idle.pid, 5000);

    // 2. Listener with a turn waiting on approval and no client connected.
    const busy = await server(bin1);
    const c1 = await client('c1', busy.sock);
    const { threadId } = await startApprovalTurn(c1);
    c1.drop();
    await sleep(500);
    process.kill(busy.pid, 'SIGTERM');
    out.pendingSigtermExitMs = await waitExit(busy.pid, 10000);
    if (alive(busy.pid)) {
      const c2 = await client('c2', busy.sock).catch((e: Error) => e);
      out.connectAfterSigterm = c2 instanceof Error ? c2.message : 'accepted';
      if (!(c2 instanceof Error)) {
        const r = await c2.request('thread/read', { threadId }).catch((e: Error) => ({ error: e.message }));
        out.statusAfterSigterm = (r as any).thread?.status ?? r;
        c2.drop();
      }
      process.kill(busy.pid, 'SIGINT');
      out.pendingSigintExitMs = await waitExit(busy.pid, 5000);
    }
    if (alive(busy.pid)) { process.kill(busy.pid, 'SIGKILL'); out.killed = 'SIGKILL'; await waitExit(busy.pid, 3000); }

    // 3. A fresh server on the same CODEX_HOME resumes the thread.
    const fresh = await server(bin1);
    const c3 = await client('c3', fresh.sock);
    const since = Date.now();
    const resumed = await c3.request('thread/resume', { threadId }).catch((e: Error) => ({ error: e.message }));
    out.freshResume = (resumed as any).error ?? { status: (resumed as any).thread?.status, turns: summarizeTurns((resumed as any).thread) };
    await sleep(3000);
    out.freshFrames = c3.inbound(since).map((f) => (isReq(f) ? `REQ ${f.method}` : f.method ?? 'resp'));
    await c3.request('turn/start', { threadId, input: [{ type: 'text', text: 'plain', text_elements: [] }] });
    const done = await c3.waitFor((f) => f.method === 'turn/completed', 20000).catch(() => undefined);
    out.freshNextTurn = done?.params?.turn?.status ?? 'none';
    c3.drop();
  } else if (which === 'release') {
    // When does X let go of the writer lock so Y (the VS Code extension) can open the thread?
    const x = await server(bin1);
    const y = await server(bin2);
    const cx = await client('X', x.sock);
    const t = await cx.request('thread/start', { cwd: PROJ, approvalPolicy: 'never', sandbox: 'workspace-write' });
    const id = t.thread.id;
    await cx.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'plain', text_elements: [] }] });
    await cx.waitFor((f) => f.method === 'turn/completed', 15000);
    cx.drop();
    const cy = await client('Y', y.sock);
    const tryY = async () => {
      const r = await cy.request('thread/resume', { threadId: id }).catch((e: Error) => ({ error: e.message }));
      return (r as any).error ?? 'ok';
    };
    // Poll: the thread stays loaded (writer lock held) until `thread_unload_delay_secs` after
    // its last subscriber left and it went idle.
    const waitS = Number(process.env.RELEASE_WAIT_S ?? 2);
    const began = Date.now();
    let yResult = await tryY();
    while (yResult !== 'ok' && Date.now() - began < waitS * 1000) { await sleep(1000); yResult = await tryY(); }
    out.yAfterXDisconnect = { result: yResult, afterMs: Date.now() - began };
    if (yResult === 'ok') {
      await cy.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'plain again', text_elements: [] }] });
      const done = await cy.waitFor((f) => f.method === 'turn/completed', 15000).catch(() => undefined);
      out.yTurnAfterUnload = done?.params?.turn?.status ?? 'none';
      const cx3 = await client('X3', x.sock);
      out.xResumeWhileYHolds = await cx3.request('thread/resume', { threadId: id }).then(() => 'ok', (e: Error) => e.message);
      cx3.drop();
      cy.drop();
      throw new Error('done (released by unload)');
    }
    const cx2 = await client('X2', x.sock);
    out.xLoadedAfterDisconnect = (await cx2.request('thread/loaded/list', {})).data.includes(id);
    // Unsubscribing without having subscribed on this connection:
    out.unsubscribeUnsubscribed = await cx2.request('thread/unsubscribe', { threadId: id }).then((r: any) => r, (e: Error) => e.message);
    await sleep(500);
    out.yAfterUnsubscribeOnly = await tryY();
    await cx2.request('thread/resume', { threadId: id });
    out.unsubscribeAfterResume = await cx2.request('thread/unsubscribe', { threadId: id }).then((r: any) => r, (e: Error) => e.message);
    await sleep(1000);
    out.xLoadedAfterUnsubscribe = (await cx2.request('thread/loaded/list', {})).data.includes(id);
    out.xFramesAfterUnsubscribe = cx2.inbound().map((f) => f.method).filter((m) => m?.startsWith('thread/'));
    out.yAfterResumeUnsubscribe = await tryY();
    if (out.yAfterResumeUnsubscribe === 'ok') {
      await cy.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'plain again', text_elements: [] }] });
      const done = await cy.waitFor((f) => f.method === 'turn/completed', 15000).catch(() => undefined);
      out.yTurn = done?.params?.turn?.status ?? 'none';
    }
    cx2.drop();
    cy.drop();
  } else {
    const x = await server(bin1);
    const y = await server(bin2);
    const cx = await client('X', x.sock);
    const cy = await client('Y', y.sock);

    // Case 1: X has a turn waiting on approval; Y resumes the same thread.
    const { threadId, request } = await startApprovalTurn(cx);
    const yResume = await cy.request('thread/resume', { threadId }).catch((e: Error) => ({ error: e.message }));
    out.busyResumeOnY = (yResume as any).error ?? { status: (yResume as any).thread?.status, turns: summarizeTurns((yResume as any).thread) };
    await sleep(1500);
    out.yGotApproval = cy.inbound().some((f) => isReq(f) && f.params?.threadId === threadId);
    const yTurn = await cy.request('turn/start', { threadId, input: [{ type: 'text', text: 'plain', text_elements: [] }] }).catch((e: Error) => ({ error: e.message }));
    out.busyTurnOnY = (yTurn as any).error ?? 'accepted';
    await cy.waitFor((f) => f.method === 'turn/completed' && f.params?.threadId === threadId, 15000).catch(() => undefined);
    cx.respond(request.id!, { decision: 'accept' });
    const xDone = await cx.waitFor((f) => f.method === 'turn/completed' && f.params?.threadId === threadId, 15000).catch(() => undefined);
    out.xTurnAfterYWrote = xDone?.params?.turn?.status ?? 'none';

    // Case 2: an idle thread loaded in both servers, driven alternately.
    const t2 = await cx.request('thread/start', { cwd: PROJ, approvalPolicy: 'never', sandbox: 'workspace-write' });
    const id2 = t2.thread.id;
    await cx.request('turn/start', { threadId: id2, input: [{ type: 'text', text: 'plain one', text_elements: [] }] });
    await cx.waitFor((f) => f.method === 'turn/completed' && f.params?.threadId === id2, 15000);
    const y2 = await cy.request('thread/resume', { threadId: id2 }).catch((e: Error) => ({ error: e.message }));
    out.idleResumeOnY = (y2 as any).error ?? 'ok';
    const y2Turn = await cy.request('turn/start', { threadId: id2, input: [{ type: 'text', text: 'plain two', text_elements: [] }] }).catch((e: Error) => ({ error: e.message }));
    out.idleTurnOnY = (y2Turn as any).error ?? 'accepted';
    const yDone = await cy.waitFor((f) => f.method === 'turn/completed' && f.params?.threadId === id2, 15000).catch(() => undefined);
    out.idleTurnOnYStatus = yDone?.params?.turn?.status ?? 'none';
    const x2Turn = await cx.request('turn/start', { threadId: id2, input: [{ type: 'text', text: 'plain three', text_elements: [] }] }).catch((e: Error) => ({ error: e.message }));
    out.idleTurnOnXAfterY = (x2Turn as any).error ?? 'accepted';
    const x2Done = await cx.waitFor((f) => f.method === 'turn/completed' && f.params?.threadId === id2 && f.params?.turn?.id === (x2Turn as any)?.turn?.id, 15000).catch(() => undefined);
    out.idleTurnOnXAfterYStatus = x2Done?.params?.turn?.status ?? 'none';
    // Did X see Y's turn at all?
    out.xSawYTurn = cx.inbound().some((f) => f.method === 'turn/started' && f.params?.threadId === id2 && f.params?.turn?.id === (y2Turn as any)?.turn?.id);
    cx.drop();
    cy.drop();

    // What is on disk: read both threads from a third, fresh server.
    for (const pid of spawned) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await sleep(500);
    const z = await server(bin1);
    const cz = await client('Z', z.sock);
    for (const [label, id] of [['thread1', threadId], ['thread2', id2]] as const) {
      const r = await cz.request('thread/read', { threadId: id, includeTurns: true }).catch((e: Error) => ({ error: e.message }));
      out[`${label}OnDisk`] = (r as any).error ?? summarizeTurns((r as any).thread);
    }
    cz.drop();
  }
} catch (e) {
  out.error = (e as Error).message;
} finally {
  for (const pid of spawned) if (alive(pid)) process.kill(pid, 'SIGKILL');
  mock.child.kill();
  out.bin1 = path.basename(path.dirname(path.dirname(path.dirname(bin1))));
  out.bin2 = path.basename(path.dirname(path.dirname(path.dirname(bin2))));
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}
