/**
 * A read-only, in-memory index of some of the telemetry log's records: every
 * monthly JSONL file read once at start, then each record added as it is
 * written (the same `appendTelemetry` that writes it). Nothing here writes.
 *
 * Which records is the subclass's business: `RoutingEvidenceIndex` holds
 * routing and attempt records for the gate (#42), `AnalyticsIndex` everything
 * the analytics view reads (#49). Lines are pre-filtered by their `"type"`
 * before parsing, so the turn records that dominate the log are skipped
 * without a `JSON.parse`.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Emitter, type Disposable, type Listener } from '../events';
import type { TelemetryRecord } from '../../shared/orchestration/telemetry';
import { isAnalyticsRecord, ANALYTICS_RECORD_TYPES, type AnalyticsRecord } from '../../shared/orchestration/analytics';

export const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

export class TelemetryIndex<T extends TelemetryRecord> implements Disposable {
  private readonly byId = new Map<string, T>();
  private readonly emitter = new Emitter<void>();
  private cached?: T[];
  private readonly needles: string[];

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  constructor(
    private readonly accept: (r: TelemetryRecord) => r is T,
    /** Record types this index can hold: a line naming none of them is not parsed. */
    types: readonly string[],
  ) {
    this.needles = types.map((t) => `"type":"${t}"`);
  }

  /** Read every month file in the log directory. A missing directory is an empty log. */
  async load(dir: string): Promise<void> {
    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((f) => MONTH_FILE.test(f)).sort();
    } catch {
      return;
    }
    for (const f of files) {
      let text: string;
      try {
        text = await fsp.readFile(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      this.ingest(text);
    }
    this.changed();
  }

  /** Parse one file's text. Separate from `load` so a benchmark can time it. */
  ingest(text: string): void {
    for (const line of text.split('\n')) {
      if (!this.needles.some((n) => line.includes(n))) continue;
      try {
        const r = JSON.parse(line) as TelemetryRecord;
        if (r && typeof r.id === 'string' && this.accept(r)) this.byId.set(r.id, r);
      } catch {
        // A torn last line; skip it.
      }
    }
  }

  add(record: TelemetryRecord): void {
    if (!this.accept(record)) return;
    this.byId.set(record.id, record);
    this.changed();
  }

  records(): readonly T[] {
    this.cached ??= [...this.byId.values()];
    return this.cached;
  }

  get size(): number {
    return this.byId.size;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private changed(): void {
    this.cached = undefined;
    this.emitter.fire();
  }
}

/** Everything the analytics view reads (§17, #49). */
export class AnalyticsIndex extends TelemetryIndex<AnalyticsRecord> {
  constructor() {
    super(isAnalyticsRecord, ANALYTICS_RECORD_TYPES);
  }
}
