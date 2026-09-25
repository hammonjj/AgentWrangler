/**
 * Per-session usage, summed from turn records (#28): what the table's Usage
 * column and the conversation header show.
 *
 * Fed live by `TurnTelemetry` as it writes each record, and at startup from the
 * JSONL files of this month and the last (older sessions are long off the
 * table). Only sessions with records have an entry: no records, no usage, never
 * a row of zeroes.
 */
import * as fsp from 'node:fs/promises';
import { Emitter, type Disposable } from '../events';
import type { TurnRecord } from '../../shared/orchestration/telemetry';
import type { SessionUsage } from '../../shared/sessionUsage';
import { monthFile } from './telemetryLog';

/** A session's running sums, with what the public aggregate is derived from. */
interface Sums {
  usage: SessionUsage;
  /** Output tokens per model, to order `models`. */
  modelOut: Map<string, number>;
  /** Turns that had usage, and those of them that had a cost. */
  withUsage: number;
  costed: number;
  /** Record ids already counted: a record loaded from disk and seen live counts once. */
  ids: Set<string>;
}

/**
 * Tokens counted once whatever the agent's convention: Claude reports cached
 * input beside `in`, Codex counts it inside `in` (README, "Usage records").
 */
function turnTotal(r: TurnRecord, m: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number }): number {
  const base = (m.in ?? 0) + (m.out ?? 0);
  return r.harness === 'codex' ? base : base + (m.cacheRead ?? 0) + (m.cacheWrite ?? 0);
}

/** Fold one turn record into a session's sums. Pure apart from mutating `sums`. */
export function addTurn(sums: Sums | undefined, r: TurnRecord): Sums {
  const s: Sums = sums ?? {
    usage: {
      turns: 0,
      unknownTurns: 0,
      tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costBasis: 'none',
      uncostedTurns: 0,
      models: [],
      effort: {},
      coversGap: false,
      lastAt: 0,
    },
    modelOut: new Map(),
    withUsage: 0,
    costed: 0,
    ids: new Set(),
  };
  if (s.ids.has(r.id)) return s;
  s.ids.add(r.id);
  const u = s.usage;
  u.turns++;
  if (r.usageUnknown) u.unknownTurns++;
  const models = Object.entries(r.modelsUsed ?? {});
  if (models.length > 0) s.withUsage++;
  for (const [model, m] of models) {
    u.tokens.total += turnTotal(r, m);
    u.tokens.input += m.in ?? 0;
    u.tokens.output += m.out ?? 0;
    u.tokens.cacheRead += m.cacheRead ?? 0;
    u.tokens.cacheWrite += m.cacheWrite ?? 0;
    s.modelOut.set(model, (s.modelOut.get(model) ?? 0) + (m.out ?? 0));
  }
  if (r.costUsd !== undefined && r.costBasis !== 'none') {
    u.costUsd = Math.round(((u.costUsd ?? 0) + r.costUsd) * 1e9) / 1e9;
    u.costBasis = s.costed === 0 || u.costBasis === r.costBasis ? r.costBasis : 'mixed';
    s.costed++;
  }
  u.uncostedTurns = s.costed > 0 ? s.withUsage - s.costed : 0;
  if (r.coversGap) u.coversGap = true;
  if (r.at >= u.lastAt) {
    u.lastAt = r.at;
    u.effort = { ...r.effort };
  }
  u.models = [...s.modelOut.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  return s;
}

export class SessionUsageIndex implements Disposable {
  private sums = new Map<string, Sums>();
  private emitter = new Emitter<void>();
  readonly onDidChange = (listener: () => void): Disposable => this.emitter.event(listener);

  /** A copy of the session's usage, or undefined when it has no records. */
  get(sessionId: string | undefined): SessionUsage | undefined {
    if (!sessionId) return undefined;
    const s = this.sums.get(sessionId.toLowerCase());
    return s ? { ...s.usage, tokens: { ...s.usage.tokens }, models: [...s.usage.models], effort: { ...s.usage.effort } } : undefined;
  }

  add(record: TurnRecord): void {
    if (this.fold(record)) this.emitter.fire();
  }

  /** Read this month's and last month's records. Unreadable lines are skipped. */
  async load(dir: string, now = Date.now()): Promise<void> {
    const thisMonth = new Date(now);
    const lastMonth = Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 15);
    let changed = false;
    for (const file of [monthFile(dir, lastMonth), monthFile(dir, now)]) {
      let text: string;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as TurnRecord;
          if (r && r.type === 'turn' && typeof r.sessionId === 'string' && typeof r.id === 'string' && this.fold(r)) changed = true;
        } catch {
          // A torn last line from a crash mid-append; the rest is still good.
        }
      }
    }
    if (changed) this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private fold(r: TurnRecord): boolean {
    const key = r.sessionId.toLowerCase();
    const prev = this.sums.get(key);
    const before = prev?.usage.turns ?? 0;
    const next = addTurn(prev, r);
    this.sums.set(key, next);
    return next.usage.turns !== before;
  }
}
