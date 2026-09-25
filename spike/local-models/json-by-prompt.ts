// Spike #50 — can a server without constrained decoding still serve StructuredCompletion?
// Asks for JSON by instruction only, then validates. Run: MODEL=<id> node json-by-prompt.ts [runs]
const BASE = process.env.BASE ?? 'http://127.0.0.1:18080';
const MODEL = process.env.MODEL ?? '';
const RUNS = Number(process.argv[2] ?? 20);
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {};

const tasks = [
  'rename a variable in one file',
  'migrate the persistence layer from JSON files to SQLite with a data migration',
  'fix a typo in the README',
  'add a new settings toggle with UI, storage and tests',
  'redesign the routing algorithm across five modules',
];
const schema = '{"tier": "basic" | "standard" | "expert", "risk": integer 1-5, "files": integer >= 0}';

let parsed = 0, valid = 0, fenced = 0;
const lat: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3, max_tokens: 120, ...EXTRA,
      messages: [
        { role: 'system', content: `You classify coding tasks. Reply with ONE JSON object and nothing else, shape: ${schema}` },
        { role: 'user', content: `Task: ${tasks[i % tasks.length]}` },
      ],
    }),
  });
  const j = await r.json();
  lat.push(performance.now() - t0);
  let c: string = j.choices?.[0]?.message?.content ?? '';
  if (/```/.test(c)) { fenced++; c = c.replace(/```(json)?/g, ''); }
  try {
    const o = JSON.parse(c.trim());
    parsed++;
    if (['basic', 'standard', 'expert'].includes(o.tier) && Number.isInteger(o.risk) && o.risk >= 1 && o.risk <= 5
      && Number.isInteger(o.files) && o.files >= 0 && Object.keys(o).length === 3) valid++;
  } catch { /* invalid */ }
}
lat.sort((a, b) => a - b);
console.log(JSON.stringify({ runs: RUNS, parsed, valid, fencedButRecoverable: fenced, medianMs: Math.round(lat[lat.length >> 1]) }));
