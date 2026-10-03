/**
 * The JSONL-vs-`node:sqlite` measurement behind plan §23.1's storage decision
 * (#49). Generates **synthetic** telemetry at three volumes into a temp
 * directory, then times what the analytics view does with it: load the
 * monthly JSONL into `AnalyticsIndex`, build the dataset, and answer the view's
 * queries; and the same through a one-way import into `node:sqlite`.
 *
 *   npm run bench:analytics            # Node on PATH
 *
 * Nothing it writes is kept: the temp directories are removed at the end, and
 * no output belongs in the repo. The fixture shapes are the test fixtures'.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AnalyticsIndex } from '../src/core/telemetry/telemetryIndex';
import { buildDataset, calibrationReport, computeMetrics, hostedLocalSplit, type AnalyticsRecord } from '../src/shared/orchestration/analytics';
import type { TurnRecord } from '../src/shared/orchestration/telemetry';
import { taskRecords, TIERS, type TaskSpec } from '../test/orchestration/analyticsFixtures';

/** Tasks per volume. "Realistic" is about a year of heavy orchestrated use; see the plan for the reasoning. */
const VOLUMES: [string, number][] = [
  ['realistic', 2_000],
  ['10x', 20_000],
  ['100x', 200_000],
];
/** Turn records per attempt, and turns of sessions no task owns per task (they dominate the log). */
const TURNS_PER_ATTEMPT = 8;
const LOOSE_TURNS_PER_TASK = 6;
const MONTHS = 12;
const START = Date.UTC(2026, 0, 1);

let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

function spec(i: number, day: number): TaskSpec {
  const tier = pick(['basic', 'standard', 'standard', 'expert']);
  const fails = rand() < 0.25;
  const attempts: TaskSpec['attempts'] = [
    {
      tier,
      costUsd: rand() < 0.85 ? Math.round(rand() * 300) / 100 : undefined,
      tokens: Math.round(rand() * 80_000),
      git: { files: 1 + Math.floor(rand() * 8), lines: Math.floor(rand() * 400) },
      verification: fails ? 'failed' : 'passed',
      activeMs: Math.round(rand() * 900_000),
      permissionAsks: Math.floor(rand() * 3),
      scopeAccuracy: Math.round(rand() * 100) / 100,
      ...(fails ? { outcome: 'failed' as const, category: pick(['quality-new', 'infra', 'context'] as const) } : {}),
    },
  ];
  if (fails && rand() < 0.7) attempts.push({ tier: tier === 'basic' ? 'standard' : 'expert', escalation: 'raise-tier', costUsd: Math.round(rand() * 500) / 100, tokens: 90_000, verification: 'passed' });
  return {
    mission: `m-${i % 7 === 0 ? 'other' : 'bench'}-${Math.floor(i / 3)}`,
    task: `${i}`,
    kind: pick(['feature', 'bugfix', 'docs', 'test', 'refactor']),
    complexity: pick(['trivial', 'routine', 'involved', 'hard']),
    harness: rand() < 0.2 ? 'codex' : 'claude-code',
    mode: pick(['manual', 'assisted'] as const),
    ...(rand() < 0.15 ? { router: { tier: 'standard', effort: 'medium' as const, changed: ['tier' as const] } } : {}),
    attempts,
    day,
  };
}

function turn(i: number, at: number, attemptId?: string): TurnRecord {
  return {
    v: 1,
    type: 'turn',
    at,
    id: `turn:${i}`,
    sessionId: `s-${i % 997}`,
    harness: 'claude-code',
    source: 'anthropic',
    modelsUsed: { sonnet: { in: 1200, out: 400, cacheRead: 30_000, cacheWrite: 900, costUsd: 0.03 } },
    costUsd: 0.03,
    effort: { requested: 'medium', applied: 'medium' },
    permissionMode: 'default',
    durationMs: 40_000,
    apiMs: 30_000,
    numTurns: 6,
    toolCalls: { Read: 3, Edit: 2, Bash: 1 },
    permissionAsks: 0,
    isError: false,
    costBasis: 'harness-estimate',
    ...(attemptId ? { attemptId } : {}),
  };
}

/** Write the monthly files; returns bytes and lines. */
function generate(dir: string, tasks: number): { bytes: number; lines: number; records: AnalyticsRecord[] } {
  fs.mkdirSync(dir, { recursive: true });
  const perMonth = new Map<string, string[]>();
  const records: AnalyticsRecord[] = [];
  let turnId = 0;
  let lines = 0;
  const put = (r: { at: number }) => {
    const d = new Date(r.at);
    const f = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
    const list = perMonth.get(f) ?? [];
    list.push(JSON.stringify(r));
    perMonth.set(f, list);
    lines++;
  };
  const days = MONTHS * 30;
  for (let i = 0; i < tasks; i++) {
    const day = Math.floor((i / tasks) * days);
    const recs = taskRecords(spec(i, day)).map((r) => ({ ...r, at: r.at - Date.UTC(2026, 8, 1) + START }));
    for (const r of recs) {
      put(r);
      records.push(r);
      if (r.type === 'attempt') for (let k = 0; k < TURNS_PER_ATTEMPT; k++) put(turn(turnId++, r.at, r.attemptId));
    }
    for (let k = 0; k < LOOSE_TURNS_PER_TASK; k++) put(turn(turnId++, START + day * 86_400_000));
  }
  let bytes = 0;
  for (const [f, list] of perMonth) {
    const text = list.join('\n') + '\n';
    fs.writeFileSync(path.join(dir, f), text);
    bytes += Buffer.byteLength(text);
  }
  return { bytes, lines, records };
}

function heapMb(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 1_048_576;
}

function time<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const v = fn();
  return [v, performance.now() - t];
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const v = await fn();
  return [v, performance.now() - t];
}

const repoOf = (m: string) => (m.includes('other') ? '/Users/test/other' : '/Users/test/proj');

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-bench-analytics-'));
  const rows: string[] = [];
  try {
    for (const [name, tasks] of VOLUMES) {
      const dir = path.join(root, name);
      const gen = generate(dir, tasks);
      gen.records.length = 0;

      // JSONL: what the app does at start, then per view refresh.
      const before = heapMb();
      const index = new AnalyticsIndex();
      const [, loadMs] = await timeAsync(() => index.load(dir));
      const indexHeap = heapMb() - before;
      const input = { records: index.records(), tiers: TIERS, repoOf };
      const [ds, buildMs] = time(() => buildDataset(input));
      const [, queryMs] = time(() => {
        computeMetrics(ds, {});
        calibrationReport(ds, {});
        hostedLocalSplit(ds, {});
      });
      const [, filteredMs] = time(() => computeMetrics(ds, { kind: 'bugfix', tier: 'standard' }));
      const totalHeap = heapMb() - before;

      // node:sqlite: a one-way import of the same records, then the same load.
      const dbFile = path.join(root, `${name}.db`);
      const db = new DatabaseSync(dbFile);
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT PRIMARY KEY, type TEXT NOT NULL, at INTEGER NOT NULL, mission TEXT, task TEXT, json TEXT NOT NULL); CREATE INDEX records_type_at ON records(type, at);');
      const insert = db.prepare('INSERT OR IGNORE INTO records (id, type, at, mission, task, json) VALUES (?, ?, ?, ?, ?, ?)');
      const [, importMs] = time(() => {
        db.exec('BEGIN');
        for (const r of index.records()) {
          const m = 'missionId' in r ? r.missionId : null;
          const t = 'taskId' in r ? (r.taskId ?? null) : null;
          insert.run(r.id, r.type, r.at, m, t, JSON.stringify(r));
        }
        db.exec('COMMIT');
      });
      const [sqlRecords, sqlLoadMs] = time(() => (db.prepare('SELECT json FROM records').all() as { json: string }[]).map((x) => JSON.parse(x.json) as AnalyticsRecord));
      const [, sqlAggMs] = time(() =>
        db.prepare("SELECT json_extract(json, '$.outcome') o, count(*) n FROM records WHERE type = 'task-final' GROUP BY o").all(),
      );
      db.close();
      const dbBytes = fs.statSync(dbFile).size;

      rows.push(
        [
          name,
          tasks.toLocaleString(),
          gen.lines.toLocaleString(),
          index.size.toLocaleString(),
          `${(gen.bytes / 1_048_576).toFixed(1)} MB`,
          `${loadMs.toFixed(0)} ms`,
          `${buildMs.toFixed(0)} ms`,
          `${queryMs.toFixed(0)} ms`,
          `${filteredMs.toFixed(0)} ms`,
          `${indexHeap.toFixed(0)} / ${totalHeap.toFixed(0)} MB`,
          `${importMs.toFixed(0)} ms`,
          `${(dbBytes / 1_048_576).toFixed(1)} MB`,
          `${sqlLoadMs.toFixed(0)} ms (${sqlRecords.length.toLocaleString()})`,
          `${sqlAggMs.toFixed(0)} ms`,
        ].join(' | '),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`node ${process.versions.node}, sqlite ${process.versions.sqlite ?? '?'}, ${os.cpus()[0]?.model ?? os.arch()}, ${Math.round(os.totalmem() / 1_073_741_824)} GB`);
  console.log('| Volume | Tasks | JSONL lines | Indexed | JSONL size | Index load | Dataset | All metrics + calibration + split | Filtered metrics | Heap (index / all) | SQLite import | DB size | SQLite load + parse | SQL aggregate |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r} |`);
}

void main();
