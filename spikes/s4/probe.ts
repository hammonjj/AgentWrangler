// Spike S4 (#8): smoke test. One stdio app-server on the isolated home, one thread, one
// turn per script, to check the mock and learn which tools and requests Codex produces.
// Usage: node spikes/s4/probe.ts [approve|ask|slow|plain] [approvalPolicy]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rpc, sleep } from './rpc.ts';
import { ROOT, PROJ, codexBinaries, makeHome, codexEnv, startMock } from './env.ts';

const script = process.argv[2] ?? 'plain';
const policy = process.argv[3] ?? 'untrusted';
fs.mkdirSync(ROOT, { recursive: true });
const log = path.join(ROOT, `probe-${script}.jsonl`);
fs.rmSync(log, { force: true });
const mock = await startMock(path.join(ROOT, 'mock-probe.log'), 3000);
const home = makeHome('home-probe', mock.port);
const rpc = new Rpc('probe', log);
await rpc.connect({ kind: 'stdio', binary: codexBinaries()[0], env: codexEnv(home) });
try {
  console.log('initialize', JSON.stringify(await rpc.initialize()).slice(0, 300));
  const started = await rpc.request('thread/start', { cwd: PROJ, approvalPolicy: policy, sandbox: 'workspace-write' });
  const threadId = started.thread.id;
  console.log('thread', threadId, 'policy', started.approvalPolicy);
  const collab = script === 'ask' ? { collaborationMode: { mode: 'plan', settings: { model: 'mock-model', reasoning_effort: null, developer_instructions: null } } } : {};
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: `${script} please`, text_elements: [] }], ...collab });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const req = rpc.inbound().find((f) => f.method && f.id !== undefined && !(f as any).answered);
    if (req) {
      (req as any).answered = true;
      console.log('server request', req.method, JSON.stringify(req.params).slice(0, 400));
      if (/requestApproval$/.test(req.method!)) rpc.respond(req.id!, { decision: 'accept' });
      else if (req.method === 'item/tool/requestUserInput') rpc.respond(req.id!, { answers: { q1: { answers: ['A'] } } });
    }
    if (rpc.inbound().some((f) => f.method === 'turn/completed')) break;
    await sleep(100);
  }
  console.log('methods seen', [...new Set(rpc.inbound().map((f) => f.method).filter(Boolean))].join(' '));
} finally {
  rpc.drop();
  mock.child.kill();
}
