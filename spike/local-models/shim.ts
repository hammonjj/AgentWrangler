// Spike #50 — throwaway protocol shim, never merged.
// Serves Anthropic `/v1/messages` (Claude Code) and OpenAI `/v1/responses` (Codex) on loopback and
// forwards each request to an OpenAI `chat/completions` server (mlx_lm.server). The upstream call
// is non-streaming; the reply is replayed to the harness as SSE. Logs sizes and outcomes only.
//
// Run: UPSTREAM=http://127.0.0.1:18080 MODEL=<id> PORT=18090 node spike/local-models/shim.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:18080';
const MODEL = process.env.MODEL ?? '';
const PORT = Number(process.env.PORT ?? 18090);
const LOG = process.env.LOG ?? '/tmp/aw50-shim.jsonl';
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {};
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 4096);

type Json = Record<string, any>;
let seq = 0;

function log(o: Json) { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); }

async function readBody(req: IncomingMessage): Promise<Json> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const s = Buffer.concat(parts).toString('utf8');
  return s ? JSON.parse(s) : {};
}

async function upstream(body: Json): Promise<{ json: Json; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(UPSTREAM + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens: MAX_TOKENS, ...body, ...EXTRA }),
  });
  const json = await r.json();
  return { json, ms: Math.round(performance.now() - t0) };
}

function sse(res: ServerResponse, event: string, data: Json) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- Anthropic Messages -> chat/completions ----------

function textOf(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

// Chat templates (Qwen) reject a system message after the first; fold later ones into it.
function foldSystem(messages: Json[]) {
  const later: string[] = [];
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === 'system') later.unshift(String(messages.splice(i, 1)[0].content ?? ''));
  }
  if (!later.length) return;
  if (messages[0]?.role === 'system') messages[0].content += '\n\n' + later.join('\n\n');
  else messages.unshift({ role: 'system', content: later.join('\n\n') });
}

function anthropicToChat(b: Json): Json {
  const messages: Json[] = [];
  const sys = textOf(b.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of b.messages ?? []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
      const calls = m.content.filter((x: any) => x.type === 'tool_use').map((x: any) => ({
        id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) },
      }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const results = m.content.filter((x: any) => x.type === 'tool_result');
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: textOf(r.content) || String(r.content ?? '') });
      const text = m.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
      if (text) messages.push({ role: 'user', content: text });
    }
  }
  foldSystem(messages);
  const tools = (b.tools ?? []).filter((t: any) => t.input_schema).map((t: any) => ({
    type: 'function', function: { name: t.name, description: (t.description ?? '').slice(0, 2000), parameters: t.input_schema },
  }));
  return { messages, ...(tools.length ? { tools } : {}), max_tokens: Math.min(b.max_tokens ?? MAX_TOKENS, MAX_TOKENS) };
}

async function messages(req: IncomingMessage, res: ServerResponse) {
  const id = ++seq;
  const b = await readBody(req);
  const chatReq = anthropicToChat(b);
  const { json, ms } = await upstream(chatReq);
  if (json.error) {
    log({ api: 'messages', id, roles: chatReq.messages.map((m: Json) => m.role), upstreamError: json.error });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `upstream: ${JSON.stringify(json.error)}` } }));
    return;
  }
  const msg = json.choices?.[0]?.message ?? {};
  const content: Json[] = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input: any = {};
    let parseError = false;
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { parseError = true; }
    content.push({ type: 'tool_use', id: `toolu_${id}_${content.length}`, name: tc.function.name, input, ...(parseError ? {} : {}) });
  }
  const stop = (msg.tool_calls?.length ? 'tool_use' : json.choices?.[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn');
  const usage = { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0 };
  log({ api: 'messages', id, reqModel: b.model, stream: !!b.stream, sysChars: textOf(b.system).length,
    msgs: (b.messages ?? []).length, tools: (b.tools ?? []).length, toolTypes: [...new Set((b.tools ?? []).map((t: any) => t.type ?? 'custom'))],
    ms, usage, stop, toolCalls: (msg.tool_calls ?? []).map((t: any) => t.function.name), textChars: (msg.content ?? '').length,
    reasoningChars: (msg.reasoning ?? '').length, upstreamError: json.error ?? null });
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: b.model, content, stop_reason: stop, stop_sequence: null, usage };
  if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
  content.forEach((c, i) => {
    if (c.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ---------- OpenAI Responses -> chat/completions ----------

function responsesToChat(b: Json): { chat: Json; dropped: string[] } {
  const dropped: string[] = [];
  const messages: Json[] = [];
  if (b.instructions) messages.push({ role: 'system', content: b.instructions });
  const input = typeof b.input === 'string' ? [{ type: 'message', role: 'user', content: b.input }] : (b.input ?? []);
  for (const it of input) {
    const type = it.type ?? 'message';
    if (type === 'message') {
      const text = typeof it.content === 'string' ? it.content
        : (it.content ?? []).map((c: any) => c.text ?? '').join('\n');
      const role = it.role === 'developer' ? 'system' : it.role;
      messages.push({ role, content: text });
    } else if (type === 'function_call') {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: it.call_id, type: 'function', function: { name: it.name, arguments: it.arguments } }] });
    } else if (type === 'function_call_output') {
      const out = typeof it.output === 'string' ? it.output : JSON.stringify(it.output);
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: out });
    } else if (type === 'custom_tool_call') {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: it.call_id, type: 'function', function: { name: it.name, arguments: JSON.stringify({ input: it.input }) } }] });
    } else if (type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) });
    } else {
      dropped.push(type);
    }
  }
  // Responses sends assistant text and each call as separate items; chat templates expect one
  // assistant turn carrying content + tool_calls.
  for (let i = messages.length - 1; i > 0; i--) {
    const a = messages[i - 1], b2 = messages[i];
    if (a.role === 'assistant' && b2.role === 'assistant' && b2.tool_calls && !b2.content) {
      a.tool_calls = [...(a.tool_calls ?? []), ...b2.tool_calls];
      messages.splice(i, 1);
    }
  }
  foldSystem(messages);
  const tools: Json[] = [];
  for (const t of b.tools ?? []) {
    if (t.type === 'function') tools.push({ type: 'function', function: { name: t.name, description: (t.description ?? '').slice(0, 2000), parameters: t.parameters ?? { type: 'object', properties: {} } } });
    else if (t.type === 'custom') tools.push({ type: 'function', function: { name: t.name, description: (t.description ?? '').slice(0, 2000), parameters: { type: 'object', properties: { input: { type: 'string', description: 'Raw tool input' } }, required: ['input'] } } });
    else dropped.push(`tool:${t.type}`);
  }
  return { chat: { messages, ...(tools.length ? { tools } : {}) }, dropped };
}

async function responses(req: IncomingMessage, res: ServerResponse) {
  const id = ++seq;
  const b = await readBody(req);
  const customTools = new Set((b.tools ?? []).filter((t: any) => t.type === 'custom').map((t: any) => t.name));
  const { chat, dropped } = responsesToChat(b);
  const { json, ms } = await upstream(chat);
  const msg = json.choices?.[0]?.message ?? {};
  const output: Json[] = [];
  if (msg.content) output.push({ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
  (msg.tool_calls ?? []).forEach((tc: any, i: number) => {
    const call_id = `call_${id}_${i}`;
    if (customTools.has(tc.function.name)) {
      let inputText = tc.function.arguments;
      try { inputText = JSON.parse(tc.function.arguments).input ?? inputText; } catch { /* raw */ }
      output.push({ type: 'custom_tool_call', id: `ctc_${id}_${i}`, call_id, name: tc.function.name, input: inputText, status: 'completed' });
    } else {
      output.push({ type: 'function_call', id: `fc_${id}_${i}`, call_id, name: tc.function.name, arguments: tc.function.arguments, status: 'completed' });
    }
  });
  const usage = { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0,
    total_tokens: json.usage?.total_tokens ?? 0,
    input_tokens_details: { cached_tokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: 0 } };
  log({ api: 'responses', id, reqModel: b.model, stream: !!b.stream, instrChars: (b.instructions ?? '').length,
    inputItems: Array.isArray(b.input) ? b.input.length : 1, tools: (b.tools ?? []).length,
    toolKinds: (b.tools ?? []).map((t: any) => `${t.type}:${t.name ?? ''}`), dropped, reasoning: b.reasoning ?? null,
    ms, usage, toolCalls: (msg.tool_calls ?? []).map((t: any) => t.function.name), textChars: (msg.content ?? '').length,
    upstreamError: json.error ?? null });
  const response = { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: b.model, output, usage };
  if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let n = 0;
  const ev = (type: string, data: Json) => sse(res, type, { type, sequence_number: n++, ...data });
  ev('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  output.forEach((item, i) => {
    ev('response.output_item.added', { output_index: i, item: item.type === 'message' ? { ...item, content: [] } : item });
    if (item.type === 'message') ev('response.output_text.delta', { output_index: i, item_id: item.id, content_index: 0, delta: item.content[0].text });
    ev('response.output_item.done', { output_index: i, item });
  });
  ev('response.completed', { response });
  res.end();
}

createServer(async (req, res) => {
  try {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path.endsWith('/messages')) return await messages(req, res);
    if (req.method === 'POST' && path.endsWith('/responses')) return await responses(req, res);
    if (req.method === 'POST' && path.endsWith('/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":0}'); return; }
    log({ api: 'unhandled', method: req.method, path });
    res.writeHead(404); res.end();
  } catch (e: any) {
    log({ api: 'error', message: String(e?.message ?? e) });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e?.message ?? e) } }));
  }
}).listen(PORT, '127.0.0.1', () => log({ api: 'listen', port: PORT, upstream: UPSTREAM }));
