// Spike S4 (#8): drop the client mid-turn, reconnect a new client, `thread/resume`, and
// record what the new client gets back.
//
// Usage: node spikes/s4/scenario.ts <a|ap|b> <slow|approve|ask> [gapMs] [--no-resume] [--second-client]
//   a  AW-owned `app-server --listen unix://<sock>` (the spike starts and later kills it),
//      client speaks WebSocket over the socket directly
//   ap the same listener, client goes through `app-server proxy --sock <sock>`
//   b  an already-running isolated daemon, reached through `app-server proxy` (see daemon.ts)
//   gapMs           how long nobody is connected (default 5000)
//   --no-resume     reconnect and wait, but do not call thread/resume first (does the server
//                   push to a connection that has not subscribed?)
//   --second-client keep a second client subscribed the whole time (multi-client semantics)
// Output: one JSON summary on stdout; every frame in /tmp/aw-spike-s4/<mode>-<script>.jsonl.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rpc, sleep, type Frame, type Transport } from './rpc.ts';
import { ROOT, PROJ, codexBinaries, makeHome, codexEnv, startMock, startListener, alive } from './env.ts';

const [mode = 'a', script = 'slow', gapArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const gapMs = Number(gapArg ?? 5000);
const noResume = process.argv.includes('--no-resume');
const secondClient = process.argv.includes('--second-client');
const tag = `${mode}-${script}-${gapMs}${noResume ? '-noresume' : ''}${secondClient ? '-two' : ''}`;
const log = path.join(ROOT, `${tag}.jsonl`);
fs.mkdirSync(ROOT, { recursive: true });
fs.rmSync(log, { force: true });
fs.rmSync(path.join(PROJ, 'approved-marker.txt'), { force: true });

const binary = process.env.CODEX_BIN ?? codexBinaries()[0];
const summary: Record<string, unknown> = { mode, script, gapMs, noResume, secondClient, binary: path.basename(path.dirname(path.dirname(path.dirname(binary)))) };
const cleanup: Array<() => void> = [];

const isRequest = (f: Frame) => f.id !== undefined && typeof f.method === 'string';
const methods = (frames: Frame[]) => frames.map((f) => (isRequest(f) ? `REQ ${f.method}#${f.id}` : f.method ?? `resp#${f.id}`));

try {
  let transport: Transport;
  let mockPort: number;
  if (mode === 'a' || mode === 'ap') {
    const mock = await startMock(path.join(ROOT, `mock-${tag}.log`), 20000);
    cleanup.push(() => mock.child.kill());
    mockPort = mock.port;
    const home = makeHome(`home-${tag}`, mockPort);
    const sock = path.join(ROOT, `${tag}.sock`);
    const server = await startListener(binary, home, sock, path.join(ROOT, `server-${tag}.log`));
    summary.serverPid = server.pid;
    cleanup.push(() => { if (alive(server.pid)) process.kill(server.pid!, 'SIGTERM'); });
    // 'a' talks WebSocket-over-UDS directly; 'ap' goes through `proxy --sock` (NDJSON on stdio).
    transport = mode === 'a' ? { kind: 'unix', path: sock } : { kind: 'proxy', binary, sock, env: codexEnv(home) };
  } else {
    // The daemon and its mock are long-lived and owned by daemon.ts.
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'daemon-state.json'), 'utf8'));
    mockPort = state.mockPort;
    transport = { kind: 'proxy', binary, env: codexEnv(state.home) };
  }

  const first = new Rpc('client1', log);
  await first.connect(transport);
  await first.initialize('aw-spike-client1');
  const started = await first.request('thread/start', { cwd: PROJ, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  const threadId: string = started.thread.id;
  summary.threadId = threadId;

  // request_user_input is offered in every mode but only answered with a client request in
  // plan mode; in default mode the tool call fails inside Codex and no request is sent.
  const collab = script === 'ask' ? { collaborationMode: { mode: 'plan', settings: { model: 'mock-model', reasoning_effort: null, developer_instructions: null } } } : {};
  const turn = await first.request('turn/start', { threadId, input: [{ type: 'text', text: `${script} please`, text_elements: [] }], ...collab });
  summary.turnId = turn.turn?.id;

  // A second subscriber (think: the VS Code extension, or a second AW window) joins after
  // the first turn starts; resuming a thread with no rollout yet fails with
  // "no rollout found for thread id".
  let observer: Rpc | undefined;
  if (secondClient) {
    observer = new Rpc('observer', log);
    await observer.connect(transport);
    await observer.initialize('aw-spike-observer');
    const joined = await observer.request('thread/resume', { threadId });
    summary.observerJoinStatus = joined.thread?.status;
  }

  // Wait until the turn is in the state we want to interrupt.
  let pendingBefore: Frame | undefined;
  if (script === 'slow') {
    await first.waitFor((f) => f.method === 'item/agentMessage/delta', 20000, 'first delta');
    await sleep(3000);
  } else {
    pendingBefore = await first.waitFor((f) => isRequest(f) && (/requestApproval$/.test(f.method!) || f.method === 'item/tool/requestUserInput'), 20000, 'server request');
    summary.pendingBefore = { method: pendingBefore.method, id: pendingBefore.id, itemId: pendingBefore.params?.itemId };
    if (observer) {
      await sleep(500);
      summary.observerGotRequest = observer.inbound().some((f) => isRequest(f) && f.method === pendingBefore!.method);
    }
  }
  summary.deltasBeforeDrop = first.inbound().filter((f) => f.method === 'item/agentMessage/delta').length;

  const droppedAt = Date.now();
  first.drop();
  summary.serverAliveAfterDrop = summary.serverPid ? alive(summary.serverPid as number) : undefined;
  await sleep(gapMs);
  if (observer) {
    summary.observerDuringGap = methods(observer.inbound(droppedAt));
  }

  const second = new Rpc('client2', log);
  await second.connect(transport);
  await second.initialize('aw-spike-client2');
  const reconnectedAt = Date.now();
  const loaded = await second.request('thread/loaded/list', {}).catch((e: Error) => ({ error: e.message }));
  summary.loadedAfterReconnect = loaded;
  const read = await second.request('thread/read', { threadId, includeTurns: true }).catch((e: Error) => ({ error: e.message }));
  summary.readStatus = (read as any)?.thread?.status ?? read;
  summary.readTurns = (read as any)?.thread?.turns?.map((t: any) => ({ id: t.id, status: t.status, items: t.items?.length }));

  if (noResume) {
    await sleep(5000);
    summary.framesBeforeResume = methods(second.inbound(reconnectedAt));
    if (pendingBefore) {
      // Can the new connection answer the old connection's request id without resuming?
      const answer = pendingBefore.method === 'item/tool/requestUserInput' ? { answers: { q1: { answers: ['A'] } } } : { decision: 'accept' };
      second.respond(pendingBefore.id!, answer);
      await sleep(2000);
      summary.staleAnswerEffect = methods(second.inbound(reconnectedAt)).slice((summary.framesBeforeResume as string[]).length);
      const status = await second.request('thread/read', { threadId }).catch((e: Error) => ({ error: e.message }));
      summary.statusAfterStaleAnswer = (status as any)?.thread?.status ?? status;
    }
  }
  const resumed = await second.request('thread/resume', { threadId }).catch((e: Error) => ({ error: e.message }));
  summary.resume = (resumed as any)?.error
    ? resumed
    : {
        status: (resumed as any).thread?.status,
        turns: (resumed as any).thread?.turns?.map((t: any) => ({ id: t.id, status: t.status, items: t.items?.map((i: any) => i.type) })),
      };

  // Watch what the new connection gets for a while, answering nothing yet.
  await sleep(4000);
  const afterResume = second.inbound(reconnectedAt);
  summary.framesAfterResume = methods(afterResume);
  const replayed = afterResume.find((f) => isRequest(f));
  summary.requestReplayed = replayed ? { method: replayed.method, id: replayed.id, sameId: replayed.id === pendingBefore?.id, itemId: replayed.params?.itemId } : false;
  summary.deltasAfterResume = afterResume.filter((f) => f.method === 'item/agentMessage/delta').length;

  // Try to answer: the replayed request if there is one, else the original id on the new connection.
  if (pendingBefore) {
    const target = replayed ?? pendingBefore;
    const answer = target.method === 'item/tool/requestUserInput' ? { answers: { q1: { answers: ['A'] } } } : { decision: 'accept' };
    second.respond(target.id!, answer);
    summary.answeredWith = replayed ? 'replayed id' : 'stale id from dropped connection';
  }
  const completed = await second.waitFor((f) => f.method === 'turn/completed', 30000, 'turn/completed').catch(() => undefined);
  summary.turnCompletedOnNewClient = completed ? completed.params?.turn?.status : 'not within 30s';
  if (script === 'approve') summary.commandRan = fs.existsSync(path.join(PROJ, 'approved-marker.txt'));
  const item = second.inbound(reconnectedAt).filter((f) => f.method === 'item/completed').map((f) => ({ type: f.params?.item?.type, status: f.params?.item?.status }));
  summary.itemsCompletedOnNewClient = item;
  if (observer) summary.observerAfter = methods(observer.inbound(reconnectedAt)).filter((m) => !m?.includes('delta'));

  second.drop();
  observer?.drop();
} catch (error) {
  summary.error = (error as Error).message;
} finally {
  await sleep(300);
  for (const fn of cleanup.reverse()) fn();
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0); // proxy children would otherwise keep the loop alive after a failure
}
