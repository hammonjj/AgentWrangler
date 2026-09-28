/**
 * The records automatic routing's gate and the shadow comparison report are
 * computed from (§27.3, #42): every `routing` and `attempt` record in the
 * telemetry log, read once at start and then added as they are written.
 * Metadata only, like the log itself. The computing is
 * `shared/orchestration/autoRouting.ts`'s; this only holds the records.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Emitter, type Disposable, type Listener } from '../events';
import type { TelemetryRecord } from '../../shared/orchestration/telemetry';
import { isEvidenceRecord, type EvidenceRecord } from '../../shared/orchestration/autoRouting';

export class RoutingEvidenceIndex implements Disposable {
  private readonly byId = new Map<string, EvidenceRecord>();
  private readonly emitter = new Emitter<void>();
  private cached?: EvidenceRecord[];

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
        if (!line.includes('"routing"') && !line.includes('"attempt"')) continue;
        try {
          const r = JSON.parse(line) as TelemetryRecord;
          if (r && typeof r.id === 'string' && isEvidenceRecord(r)) this.byId.set(r.id, r);
        } catch {
          // A torn last line; skip it.
        }
      }
    }
    this.changed();
  }

  add(record: TelemetryRecord): void {
    if (!isEvidenceRecord(record)) return;
    this.byId.set(record.id, record);
    this.changed();
  }

  records(): readonly EvidenceRecord[] {
    this.cached ??= [...this.byId.values()];
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
