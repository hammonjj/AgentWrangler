/**
 * The records local observability is folded from (§19.4, #51): every
 * `attempt` and `local-call` record in the telemetry log, read once at start
 * and then added as they are written. Metadata only, like the log itself.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Emitter, type Disposable, type Listener } from '../events';
import type { AttemptRecord, LocalCallRecord, TelemetryRecord } from '../../shared/orchestration/telemetry';
import { isLocalMetricsRecord, summariseLocal, type LocalModelSummary } from '../../shared/orchestration/localMetrics';

export class LocalMetricsIndex implements Disposable {
  private readonly records = new Map<string, AttemptRecord | LocalCallRecord>();
  private readonly emitter = new Emitter<void>();
  private cached?: LocalModelSummary[];

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  /** Read every month file in the log directory. A missing directory is an empty log. */
  async load(dir: string): Promise<void> {
    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
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
      for (const line of text.split('\n')) {
        if (!line.includes('"attempt"') && !line.includes('"local-call"')) continue;
        try {
          const r = JSON.parse(line) as TelemetryRecord;
          if (r && typeof r.id === 'string' && isLocalMetricsRecord(r)) this.records.set(r.id, r);
        } catch {
          // A torn last line; skip it.
        }
      }
    }
    this.changed();
  }

  add(record: TelemetryRecord): void {
    if (!isLocalMetricsRecord(record)) return;
    this.records.set(record.id, record);
    this.changed();
  }

  summaries(): LocalModelSummary[] {
    this.cached ??= summariseLocal([...this.records.values()]);
    return this.cached;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private changed(): void {
    this.cached = undefined;
    this.emitter.fire();
  }
}
