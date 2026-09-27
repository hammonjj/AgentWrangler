/**
 * Local observability (`docs/plans/intelligent-orchestration.md` §19.4; #51):
 * per local model, from the telemetry log's `attempt` and `local-call`
 * records — executions, tokens, tokens/s, time to first token, runtime,
 * context, device, queue delay, success, escalation from local, and the
 * API-equivalent cost avoided, which is **an estimate and is always labelled
 * as one**. Cost itself is `$0 API cost` by rule.
 *
 * Pure and shared: the main process folds records, Preferences renders them.
 */
import type { AttemptRecord, LocalCallRecord, TelemetryRecord } from './telemetry';
import type { ModelSourceId } from './types';

export interface LocalModelSummary {
  source: ModelSourceId;
  model: string;
  /** Agentic attempts plus direct calls. */
  executions: number;
  attempts: number;
  completions: number;
  qualifications: number;
  succeeded: number;
  /** Attempts that passed verification on the task's first attempt. */
  verifiedFirstTime: number;
  /** Local runs a hosted model had to take over from: a later hosted attempt of the same task, or a completion that fell back. */
  escalated: number;
  inputTokens: number;
  outputTokens: number;
  avgTokPerSec?: number;
  avgTtftMs?: number;
  avgRuntimeMs?: number;
  avgQueueMs?: number;
  contextWindow?: number;
  device?: string;
  runtime?: string;
  external?: boolean;
  /** Labelled estimate (§19.4). Absent when no hosted equivalent had a price. */
  apiEquivalentUsd?: number;
}

interface Acc {
  s: LocalModelSummary;
  tps: number[];
  ttft: number[];
  runtime: number[];
  queue: number[];
  avoided: number[];
}

function mean(xs: number[]): number | undefined {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

function sumTokens(usage: AttemptRecord['usage']): { in: number; out: number } {
  let i = 0;
  let o = 0;
  for (const u of Object.values(usage ?? {})) {
    i += u.in ?? 0;
    o += u.out ?? 0;
  }
  return { in: i, out: o };
}

/** Fold records into one summary per local model, most executions first. */
export function summariseLocal(records: readonly TelemetryRecord[]): LocalModelSummary[] {
  const byKey = new Map<string, Acc>();
  const acc = (source: ModelSourceId, model: string): Acc => {
    const key = `${source}\0${model}`;
    let a = byKey.get(key);
    if (!a) {
      a = {
        s: { source, model, executions: 0, attempts: 0, completions: 0, qualifications: 0, succeeded: 0, verifiedFirstTime: 0, escalated: 0, inputTokens: 0, outputTokens: 0 },
        tps: [],
        ttft: [],
        runtime: [],
        queue: [],
        avoided: [],
      };
      byKey.set(key, a);
    }
    return a;
  };
  const seen = new Set<string>();
  const attemptsByTask = new Map<string, AttemptRecord[]>();
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.type === 'attempt') {
      const list = attemptsByTask.get(r.taskId) ?? [];
      list.push(r);
      attemptsByTask.set(r.taskId, list);
      if (!r.local) continue;
      const a = acc(r.local.source, r.target.model);
      const s = a.s;
      s.executions++;
      s.attempts++;
      if (r.outcome === 'succeeded') s.succeeded++;
      if (r.n === 1 && r.outcome === 'succeeded' && r.verification.some((v) => v.outcome === 'passed')) s.verifiedFirstTime++;
      const t = sumTokens(r.usage);
      s.inputTokens += t.in;
      s.outputTokens += t.out;
      note(a, r.local, r.activeMs);
    } else if (r.type === 'local-call') {
      const a = acc(r.source, r.model);
      const s = a.s;
      if (r.purpose === 'qualification') {
        s.qualifications++;
      } else {
        s.executions++;
        s.completions++;
        if (r.ok) s.succeeded++;
        if (r.fellBackToHosted) s.escalated++;
      }
      s.inputTokens += r.inputTokens ?? 0;
      s.outputTokens += r.outputTokens ?? 0;
      note(a, r.local, r.durationMs);
    }
  }
  // Escalation from local: a local attempt that a later attempt of the same task ran on a hosted model.
  for (const list of attemptsByTask.values()) {
    const sorted = [...list].sort((x, y) => x.n - y.n);
    sorted.forEach((r, i) => {
      if (!r.local) return;
      if (sorted.slice(i + 1).some((later) => !later.local)) acc(r.local.source, r.target.model).s.escalated++;
    });
  }
  return [...byKey.values()]
    .map((a) => {
      const s = { ...a.s };
      const round = (n: number | undefined, d = 0) => (n === undefined ? undefined : Math.round(n * 10 ** d) / 10 ** d);
      const tps = round(mean(a.tps), 1);
      const ttft = round(mean(a.ttft));
      const runtime = round(mean(a.runtime));
      const queue = round(mean(a.queue));
      if (tps !== undefined) s.avgTokPerSec = tps;
      if (ttft !== undefined) s.avgTtftMs = ttft;
      if (runtime !== undefined) s.avgRuntimeMs = runtime;
      if (queue !== undefined) s.avgQueueMs = queue;
      if (a.avoided.length > 0) s.apiEquivalentUsd = Math.round(a.avoided.reduce((x, y) => x + y, 0) * 100) / 100;
      return s;
    })
    .sort((x, y) => y.executions - x.executions || x.model.localeCompare(y.model));

  function note(a: Acc, m: AttemptRecord['local'] & object, runtimeMs: number | undefined): void {
    if (m.outTokPerSec !== undefined) a.tps.push(m.outTokPerSec);
    if (m.ttftMs !== undefined) a.ttft.push(m.ttftMs);
    if (runtimeMs !== undefined) a.runtime.push(runtimeMs);
    if (m.queueMs !== undefined) a.queue.push(m.queueMs);
    if (m.apiEquivalentUsd !== undefined) a.avoided.push(m.apiEquivalentUsd);
    if (m.contextWindow !== undefined) a.s.contextWindow = m.contextWindow;
    if (m.device) a.s.device = m.device;
    if (m.runtime) a.s.runtime = m.runtime;
    if (m.external) a.s.external = true;
  }
}

function pct(n: number, of: number): string {
  return `${Math.round((n / of) * 100)}%`;
}

function secs(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 100) / 10} s`;
}

/** "27 runs · $0 API cost · 93% verified first time · 14% escalated · 41 tok/s · …", as §19.4 draws it. */
export function localSummaryText(s: LocalModelSummary): string {
  const parts = [`${s.executions} run${s.executions === 1 ? '' : 's'}`, '$0 API cost'];
  if (s.attempts > 0) parts.push(`${pct(s.verifiedFirstTime, s.attempts)} verified first time`);
  if (s.executions > 0) parts.push(`${pct(s.succeeded, s.executions)} succeeded`, `${pct(s.escalated, s.executions)} escalated`);
  if (s.avgTokPerSec !== undefined) parts.push(`${s.avgTokPerSec} tok/s`);
  if (s.avgTtftMs !== undefined) parts.push(`TTFT ${Math.round(s.avgTtftMs)} ms`);
  if (s.avgRuntimeMs !== undefined) parts.push(`runtime ${secs(s.avgRuntimeMs)}`);
  if (s.avgQueueMs !== undefined && s.avgQueueMs > 0) parts.push(`queue ${secs(s.avgQueueMs)}`);
  parts.push(`${s.inputTokens + s.outputTokens} tokens`);
  if (s.contextWindow !== undefined) parts.push(`context ${Math.round(s.contextWindow / 1000)}k`);
  if (s.device) parts.push(s.device);
  if (s.apiEquivalentUsd !== undefined) parts.push(`~$${s.apiEquivalentUsd.toFixed(2)} API-equivalent avoided (estimate)`);
  return parts.join(' · ');
}

/** Records the summary needs, for an index that keeps only those. */
export function isLocalMetricsRecord(r: TelemetryRecord): r is AttemptRecord | LocalCallRecord {
  return r.type === 'attempt' || r.type === 'local-call';
}
