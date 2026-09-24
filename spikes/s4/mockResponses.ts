// Spike S4 (#8): a scripted stand-in for the OpenAI Responses API, so `codex app-server`
// can run real turns (tool calls, approvals, questions) with no account, no cost and no
// secrets. Point an isolated CODEX_HOME at it with a custom model provider (see setup.ts).
//
// The script is keyed off the last user message text:
//   "approve"  -> a shell tool call that needs approval, then a final message
//   "ask"      -> a request_user_input tool call, then a final message
//   "slow"     -> a final message streamed as deltas over ~SLOW_MS
//   anything   -> a one-line final message
// Every request is appended to $MOCK_LOG as one JSON line (tools offered, script chosen).

import * as http from 'node:http';
import * as fs from 'node:fs';

const port = Number(process.env.MOCK_PORT ?? 0);
const logPath = process.env.MOCK_LOG ?? '/tmp/aw-spike-s4/mock.log';
const slowMs = Number(process.env.SLOW_MS ?? 20000);

function log(entry: Record<string, unknown>): void {
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

let seq = 0;

function sse(res: http.ServerResponse, type: string, data: Record<string, unknown>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function usage() {
  return { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 };
}

function lastUserText(input: any[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.type === 'message' && item.role === 'user') {
      const parts = Array.isArray(item.content) ? item.content : [];
      const text = parts.map((p: any) => p?.text ?? '').join(' ').trim();
      // Codex injects environment/instructions as user messages; skip those.
      if (text && !text.startsWith('<')) return text;
    }
  }
  return '';
}

/** Tool outputs already present in the input mean this is the follow-up request of a turn. */
function toolOutputs(input: any[]): any[] {
  return input.filter((item) => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output');
}

function toolNames(tools: any[]): string[] {
  return (tools ?? []).map((tool: any) => tool?.name ?? tool?.type ?? '?');
}

function pickShellTool(names: string[]): string {
  for (const candidate of ['shell_command', 'exec_command', 'shell', 'local_shell']) if (names.includes(candidate)) return candidate;
  return 'shell';
}

function shellArgs(tool: string, command: string): string {
  if (tool === 'exec_command') return JSON.stringify({ cmd: command });
  if (tool === 'shell_command') return JSON.stringify({ command });
  return JSON.stringify({ command: ['bash', '-lc', command] });
}

function finalMessage(res: http.ServerResponse, text: string): void {
  const id = `msg_${++seq}`;
  sse(res, 'response.output_item.added', { item: { type: 'message', id, role: 'assistant', content: [] } });
  sse(res, 'response.output_text.delta', { item_id: id, delta: text });
  sse(res, 'response.output_item.done', { item: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] } });
}

function start(res: http.ServerResponse): string {
  const id = `resp_${++seq}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, 'response.created', { response: { id } });
  return id;
}

function complete(res: http.ServerResponse, id: string): void {
  sse(res, 'response.completed', { response: { id, usage: usage() } });
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      log({ kind: 'other', method: req.method, url: req.url });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not mocked"}}');
      return;
    }
    let request: any = {};
    try { request = JSON.parse(body); } catch { /* logged below */ }
    const input: any[] = Array.isArray(request.input) ? request.input : [];
    const names = toolNames(request.tools);
    const prompt = lastUserText(input).toLowerCase();
    const outputs = toolOutputs(input);
    const outputsThisTurn = (() => {
      // Only count tool outputs after the last real user message.
      let lastUser = -1;
      input.forEach((item, index) => { if (item?.type === 'message' && item.role === 'user') lastUser = index; });
      return input.slice(lastUser + 1).filter((item) => outputs.includes(item));
    })();
    const script = prompt.includes('approve') ? 'approve' : prompt.includes('ask') ? 'ask' : prompt.includes('slow') ? 'slow' : 'plain';
    const tail = input.slice(-4).map((item: any) => `${item?.type}:${item?.role ?? item?.name ?? ''}:${JSON.stringify(item?.content ?? item?.output ?? item?.arguments ?? '').slice(0, 120)}`);
    log({ kind: 'responses', script, followUp: outputsThisTurn.length, inputItems: input.length, tail, lastOutput: outputsThisTurn.at(-1)?.output });
    const id = start(res);

    if (outputsThisTurn.length > 0 || script === 'plain') {
      finalMessage(res, script === 'plain' ? 'ok' : `finished ${script}`);
      complete(res, id);
      return;
    }
    if (script === 'approve') {
      const tool = pickShellTool(names);
      const callId = `call_${++seq}`;
      const item = { type: 'function_call', id: `fc_${seq}`, name: tool, call_id: callId, arguments: shellArgs(tool, 'touch approved-marker.txt') };
      // Ask for escalation too, so on-request policies also have to prompt.
      sse(res, 'response.output_item.added', { item });
      sse(res, 'response.output_item.done', { item });
      complete(res, id);
      return;
    }
    if (script === 'ask') {
      const callId = `call_${++seq}`;
      const args = { questions: [{ id: 'q1', header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] };
      const item = { type: 'function_call', id: `fc_${seq}`, name: 'request_user_input', call_id: callId, arguments: JSON.stringify(args) };
      sse(res, 'response.output_item.added', { item });
      sse(res, 'response.output_item.done', { item });
      complete(res, id);
      return;
    }
    // slow: stream deltas for slowMs, then complete.
    const msgId = `msg_${++seq}`;
    sse(res, 'response.output_item.added', { item: { type: 'message', id: msgId, role: 'assistant', content: [] } });
    const steps = 20;
    let step = 0;
    let text = '';
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      const delta = `tick${step} `;
      text += delta;
      sse(res, 'response.output_text.delta', { item_id: msgId, delta });
      if (++step >= steps) {
        clearInterval(timer);
        sse(res, 'response.output_item.done', { item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text }] } });
        complete(res, id);
      }
    }, slowMs / steps);
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  log({ kind: 'listening', port: actual });
  process.stdout.write(`${actual}\n`);
});
