// Spike #50 — throwaway probe of an OpenAI-compatible local server. Never merged.
// Run: BASE=http://127.0.0.1:18080 MODEL=<id> node spike/local-models/probe.ts [runs]
// Prints JSON facts only; no prompts or outputs from real work are involved.

const BASE = process.env.BASE ?? 'http://127.0.0.1:18080';
const MODEL = process.env.MODEL ?? '';
const RUNS = Number(process.argv[2] ?? 10);
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {};

type Json = Record<string, any>;

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path);
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body };
}

async function chat(body: Json): Promise<{ ms: number; json: Json }> {
  const t0 = performance.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, temperature: 0, ...body, ...EXTRA }),
  });
  const json = await r.json();
  return { ms: performance.now() - t0, json };
}

async function streamTiming(prompt: string, maxTokens: number) {
  const t0 = performance.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: maxTokens, stream: true,
      stream_options: { include_usage: true }, ...EXTRA,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let ttft: number | null = null;
  let chunks = 0;
  let usage: any = null;
  let buf = '';
  let sawTimings = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const ev = JSON.parse(data);
      const d = ev.choices?.[0]?.delta;
      if (d && (d.content || d.reasoning) && ttft === null) ttft = performance.now() - t0;
      if (d && (d.content || d.reasoning)) chunks++;
      if (ev.usage) usage = ev.usage;
      if (ev.timings) sawTimings = true;
    }
  }
  const total = performance.now() - t0;
  const out = usage?.completion_tokens ?? chunks;
  const decodeMs = total - (ttft ?? 0);
  return {
    ttftMs: Math.round(ttft ?? -1), totalMs: Math.round(total), completionTokens: out,
    decodeTokPerSec: +(out / (decodeMs / 1000)).toFixed(1), usage, serverTimingsField: sawTimings,
  };
}

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } },
      required: ['city', 'unit'],
    },
  },
};
const readTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from the workspace',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

async function toolCalls() {
  let ok = 0, textOnly = 0, badArgs = 0, wrongTool = 0;
  const lat: number[] = [];
  let sample: any = null;
  for (let i = 0; i < RUNS; i++) {
    const { ms, json } = await chat({
      max_tokens: 256,
      tools: [weatherTool, readTool],
      messages: [{ role: 'user', content: `What's the weather in Paris${i % 2 ? '' : ', France'}? Use celsius.` }],
    });
    lat.push(ms);
    const tc = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!sample) sample = { finish_reason: json.choices?.[0]?.finish_reason, tool_call: tc };
    if (!tc) { textOnly++; continue; }
    if (tc.function?.name !== 'get_weather') { wrongTool++; continue; }
    try {
      const a = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      if (/paris/i.test(a.city) && a.unit === 'c') ok++; else badArgs++;
    } catch { badArgs++; }
  }
  return { runs: RUNS, ok, textOnly, wrongTool, badArgs, medianMs: median(lat), sample };
}

// Multi-turn: feed a tool result back and expect the model to use it.
async function toolRoundTrip() {
  let ok = 0;
  for (let i = 0; i < RUNS; i++) {
    const { json } = await chat({
      max_tokens: 256,
      tools: [readTool],
      messages: [
        { role: 'user', content: 'What is the version field in package.json?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"name":"demo","version":"4.17.2"}' },
      ],
    });
    if (/4\.17\.2/.test(json.choices?.[0]?.message?.content ?? '')) ok++;
  }
  return { runs: RUNS, ok };
}

async function structured() {
  const schema = {
    type: 'object',
    properties: { tier: { type: 'string', enum: ['fast', 'standard', 'deep'] }, risk: { type: 'integer', minimum: 1, maximum: 5 } },
    required: ['tier', 'risk'], additionalProperties: false,
  };
  let valid = 0, parsed = 0;
  let sample = '';
  for (let i = 0; i < RUNS; i++) {
    const { json } = await chat({
      max_tokens: 200,
      response_format: { type: 'json_schema', json_schema: { name: 'assessment', schema, strict: true } },
      messages: [{ role: 'user', content: 'Assess this task: "rename a variable in one file". Reply with the assessment.' }],
    });
    const c: string = json.choices?.[0]?.message?.content ?? '';
    if (!sample) sample = c.slice(0, 160);
    try {
      const o = JSON.parse(c);
      parsed++;
      if (['fast', 'standard', 'deep'].includes(o.tier) && Number.isInteger(o.risk) && Object.keys(o).length === 2) valid++;
    } catch { /* not JSON */ }
  }
  return { runs: RUNS, strictJsonParsed: parsed, schemaValid: valid, sample };
}

async function concurrency(n: number) {
  const one = await streamTiming('Count from 1 to 40, comma separated.', 200);
  const t0 = performance.now();
  const all = await Promise.all(Array.from({ length: n }, () => streamTiming('Count from 1 to 40, comma separated.', 200)));
  const wall = performance.now() - t0;
  return {
    n, singleTotalMs: one.totalMs, parallelWallMs: Math.round(wall),
    speedupVsSerial: +((one.totalMs * n) / wall).toFixed(2),
    ttftMs: all.map(a => a.ttftMs),
  };
}

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.floor(s.length / 2)] ?? -1);
}

const out: Json = { base: BASE, model: MODEL, extra: EXTRA };
out.models = await get('/v1/models');
out.health = await get('/health');
out.props = (await get('/props')).status;
out.slots = (await get('/slots')).status;
out.metrics = (await get('/metrics')).status;
const plain = await chat({ max_tokens: 64, messages: [{ role: 'user', content: 'Say hi.' }] });
out.plainResponseKeys = Object.keys(plain.json);
out.plainUsage = plain.json.usage;
out.plainMessageKeys = Object.keys(plain.json.choices?.[0]?.message ?? {});
out.stream = await streamTiming('Write a 150-word paragraph about rivers.', 300);
out.tools = await toolCalls();
out.toolRoundTrip = await toolRoundTrip();
out.structured = await structured();
out.concurrency4 = await concurrency(4);
console.log(JSON.stringify(out, null, 2));
