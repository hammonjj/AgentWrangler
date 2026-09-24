// Spike S4 (#8): how are server-request ids scoped? Two threads on one listener both wait on
// an approval; record their ids on the owning connection and on a second connection that
// resumes both, then answer one and see which thread moves.
// Usage: node spikes/s4/ids.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rpc, sleep, type Frame } from './rpc.ts';
import { ROOT, PROJ, codexBinaries, makeHome, startMock, startListener, alive } from './env.ts';

const log = path.join(ROOT, 'ids.jsonl');
fs.rmSync(log, { force: true });
const mock = await startMock(path.join(ROOT, 'mock-ids.log'));
const home = makeHome('home-ids', mock.port);
const sock = path.join(ROOT, 'ids.sock');
const server = await startListener(codexBinaries()[0], home, sock, path.join(ROOT, 'server-ids.log'));
const out: Record<string, unknown> = {};
const isReq = (f: Frame) => f.id !== undefined && typeof f.method === 'string';
try {
  const c1 = new Rpc('c1', log);
  await c1.connect({ kind: 'unix', path: sock });
  await c1.initialize();
  const threads: string[] = [];
  for (let i = 0; i < 2; i++) {
    const t = await c1.request('thread/start', { cwd: PROJ, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    threads.push(t.thread.id);
    await c1.request('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: 'approve please', text_elements: [] }] });
    await c1.waitFor((f) => isReq(f) && f.params?.threadId === t.thread.id, 20000);
  }
  out.c1Requests = c1.inbound().filter(isReq).map((f) => ({ id: f.id, thread: threads.indexOf(f.params.threadId) }));

  const c2 = new Rpc('c2', log);
  await c2.connect({ kind: 'unix', path: sock });
  await c2.initialize();
  for (const threadId of threads) await c2.request('thread/resume', { threadId });
  await sleep(1500);
  out.c2Requests = c2.inbound().filter(isReq).map((f) => ({ id: f.id, thread: threads.indexOf(f.params.threadId) }));

  // Answer the second thread's request from c2, using the id c2 was given.
  const target = c2.inbound().find((f) => isReq(f) && f.params.threadId === threads[1]);
  if (target) c2.respond(target.id!, { decision: 'decline' });
  await sleep(2000);
  out.c1ResolvedAfterC2Answer = c1.inbound().filter((f) => f.method === 'serverRequest/resolved').map((f) => ({ requestId: f.params.requestId, thread: threads.indexOf(f.params.threadId) }));
  out.c1TurnCompleted = c1.inbound().filter((f) => f.method === 'turn/completed').map((f) => ({ thread: threads.indexOf(f.params.threadId), status: f.params.turn?.status }));
  out.commandItems = c1.inbound().filter((f) => f.method === 'item/completed' && f.params.item?.type === 'commandExecution').map((f) => ({ thread: threads.indexOf(f.params.threadId), status: f.params.item.status }));
  c1.drop();
  c2.drop();
} catch (e) {
  out.error = (e as Error).message;
} finally {
  if (alive(server.pid)) process.kill(server.pid!, 'SIGTERM');
  mock.child.kill();
  console.log(JSON.stringify(out, null, 1));
}
