/**
 * Where telemetry records go: append-only JSONL, one file per month
 * (`<dir>/YYYY-MM.jsonl`, UTC), plus a small `state.json` that remembers each
 * execution's last totals between runs of the app
 * (`docs/plans/intelligent-orchestration.md` §16.2, §23.1).
 *
 * Local only, metadata only: nothing here is ever sent anywhere. Records are
 * idempotent by `id`: writing one twice records it once (recent ids are
 * remembered in memory, and each execution's last turn id in the state file).
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type { TelemetryRecord } from '../../shared/orchestration/telemetry';
import type { SegmentState } from './turnUsage';

export interface TelemetryFs {
  appendFileSync(file: string, data: string, encoding: 'utf8'): void;
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  mkdirSync(dir: string, opts: { recursive: true }): unknown;
}

const STATE_FILE = 'state.json';
const STATE_VERSION = 1;
/** Executions remembered in the state file; the least recently updated go first. */
export const MAX_SEGMENTS = 500;
const RECENT_IDS = 2000;

export function monthFile(dir: string, at: number): string {
  const d = new Date(at);
  return path.join(dir, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
}

export class TelemetryLog {
  private readonly fs: TelemetryFs;
  private segments?: Map<string, SegmentState>;
  private recent = new Set<string>();

  constructor(
    private readonly dir: string,
    opts: { fs?: TelemetryFs } = {},
  ) {
    this.fs = opts.fs ?? nodeFs;
  }

  /** Append a record unless one with its id was already written. True if written. */
  append(record: TelemetryRecord): boolean {
    if (this.recent.has(record.id)) return false;
    this.fs.mkdirSync(this.dir, { recursive: true });
    this.fs.appendFileSync(monthFile(this.dir, record.at), `${JSON.stringify(record)}\n`, 'utf8');
    this.recent.add(record.id);
    if (this.recent.size > RECENT_IDS) this.recent.delete(this.recent.values().next().value as string);
    return true;
  }

  /** What was remembered about an execution, from this run or a previous one. */
  segment(key: string): SegmentState | undefined {
    return this.load().get(key);
  }

  setSegment(key: string, state: SegmentState): void {
    const segments = this.load();
    segments.delete(key);
    segments.set(key, state);
    while (segments.size > MAX_SEGMENTS) segments.delete(segments.keys().next().value as string);
    this.fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, STATE_FILE);
    const tmp = `${file}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify({ v: STATE_VERSION, segments: Object.fromEntries(segments) }), 'utf8');
    this.fs.renameSync(tmp, file);
  }

  /** Read once; everything loaded from disk is marked as such (the next turn may cover a gap). */
  private load(): Map<string, SegmentState> {
    if (this.segments) return this.segments;
    const segments = new Map<string, SegmentState>();
    try {
      const doc = JSON.parse(this.fs.readFileSync(path.join(this.dir, STATE_FILE), 'utf8')) as { v?: unknown; segments?: unknown };
      if (doc.v === STATE_VERSION && doc.segments && typeof doc.segments === 'object') {
        const entries = Object.entries(doc.segments as Record<string, SegmentState>).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [key, s] of entries) {
          segments.set(key, { ...s, fromDisk: true });
          if (s.lastId) this.recent.add(s.lastId);
        }
      }
    } catch {
      // First run, or an unreadable file: start with no baselines.
    }
    this.segments = segments;
    return segments;
  }
}
