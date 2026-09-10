import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isSessionJsonlName } from './paths';
import { readTranscriptSummary, type TranscriptSummary } from './transcriptTail';

export interface IndexedTranscript {
  sessionId: string;
  path: string;
  summary: TranscriptSummary;
}

export interface ScanOptions {
  /** SessionIds that are live right now — always indexed regardless of age. */
  liveIds: Set<string>;
  endedWindowMs: number;
  nowMs: number;
}

/**
 * Cache of transcript summaries keyed by sessionId. Fed by the recursive
 * projects watcher (single-file updates) and periodic full scans.
 */
export class TranscriptIndex {
  private bySession = new Map<string, IndexedTranscript>();

  get(sessionId: string): IndexedTranscript | undefined {
    return this.bySession.get(sessionId);
  }

  all(): IndexedTranscript[] {
    return [...this.bySession.values()];
  }

  /**
   * Re-read one transcript incrementally. Returns the entry when the file
   * changed (bytes appended / first index), null when unchanged, undefined
   * when the file is gone (entry dropped).
   */
  async updateFile(filePath: string): Promise<IndexedTranscript | null | undefined> {
    const base = path.basename(filePath);
    if (!isSessionJsonlName(base)) return null;
    const sessionId = base.slice(0, -'.jsonl'.length).toLowerCase();

    const existing = this.bySession.get(sessionId);
    const prev = existing && existing.path === filePath ? existing.summary : undefined;
    const summary = await readTranscriptSummary(filePath, prev, { needTitle: true });
    if (summary === undefined) {
      this.bySession.delete(sessionId);
      return undefined;
    }
    if (summary === prev) return null;
    const entry: IndexedTranscript = { sessionId, path: filePath, summary };
    this.bySession.set(sessionId, entry);
    return entry;
  }

  /** Walk all project dirs. Old non-live transcripts are stat-gated (no tail read). */
  async scanAll(projectsRoot: string, opts: ScanOptions): Promise<void> {
    let dirNames: string[];
    try {
      dirNames = await fs.readdir(projectsRoot);
    } catch {
      this.bySession.clear();
      return;
    }

    const seen = new Set<string>();
    for (const dirName of dirNames) {
      const dirPath = path.join(projectsRoot, dirName);
      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isFile() || !isSessionJsonlName(ent.name)) continue;
        const sessionId = ent.name.slice(0, -'.jsonl'.length).toLowerCase();
        const full = path.join(dirPath, ent.name);
        seen.add(sessionId);

        if (!opts.liveIds.has(sessionId)) {
          try {
            const st = await fs.stat(full);
            if (st.mtimeMs < opts.nowMs - opts.endedWindowMs) {
              this.bySession.delete(sessionId);
              continue;
            }
          } catch {
            continue;
          }
        }
        await this.updateFile(full);
      }
    }

    for (const id of [...this.bySession.keys()]) {
      if (!seen.has(id)) this.bySession.delete(id);
    }
  }
}
