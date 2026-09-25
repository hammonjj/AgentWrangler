/**
 * Durable missions: one JSON file per mission plus a small index
 * (`docs/plans/intelligent-orchestration.md` §23.1).
 *
 * The same discipline as `JsonStore`: whole-file writes to a sibling temp file
 * and a rename, so a crash leaves the previous document rather than half of the
 * new one. On top of that, the last good version is kept as `<id>.json.bak`
 * before each replace, so a file that is somehow unreadable (disk trouble, a
 * hand edit) falls back one write instead of losing the mission (§25 row 32).
 *
 * One writer (the core), "load, replace one". The index is reconstructible:
 * it is rebuilt from the files whenever it is missing or unreadable.
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type { Mission, MissionState } from '../../shared/orchestration/types';
import { missionMachine } from '../domain/lifecycles';
import { MISSION_SCHEMA_VERSION, UnreadableMission, migrateMission } from './migrations';

/** The file operations the store uses. Tests inject failures through it. */
export interface StoreFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  mkdirSync(dir: string, opts: { recursive: true }): unknown;
  readdirSync(dir: string): string[];
  existsSync(file: string): boolean;
}

export interface MissionIndexEntry {
  id: string;
  title: string;
  state: MissionState;
  repoRoot: string;
  updatedAt: number;
}

export interface LoadedMission {
  mission: Mission;
  /** The main file could not be read; this came from `.bak`, one write behind. */
  fromBackup?: boolean;
}

export type LoadResult = LoadedMission | { id: string; unreadable: string };

const INDEX = 'index.json';
const INDEX_VERSION = 1;

export class MissionStore {
  private readonly fs: StoreFs;

  /** `dir` is `<dataDir>/orchestration/missions`. */
  constructor(
    private readonly dir: string,
    opts: { fs?: StoreFs; log?: (msg: string) => void } = {},
  ) {
    this.fs = opts.fs ?? nodeFs;
    this.log = opts.log ?? (() => undefined);
  }

  private readonly log: (msg: string) => void;

  /** Write a mission. Throws if the write fails; the previous file and the index are then unchanged. */
  save(mission: Mission): void {
    const record: Mission = { ...mission, v: MISSION_SCHEMA_VERSION };
    this.fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(record.id);
    // Keep the last good version before replacing it. Only a file that still
    // parses is worth keeping: copying a corrupt one over a good `.bak` would
    // throw away the only readable copy.
    if (this.fs.existsSync(file) && this.readable(file)) this.fs.copyFileSync(file, `${file}.bak`);
    this.writeAtomic(file, record);
    this.updateIndex((entries) => [...entries.filter((e) => e.id !== record.id), entry(record)]);
  }

  /** One mission, falling back to its `.bak`. */
  load(id: string): LoadResult {
    const file = this.file(id);
    try {
      return { mission: migrateMission(this.parse(file)) };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      try {
        const mission = migrateMission(this.parse(`${file}.bak`));
        this.log(`mission ${id}: ${why}; loaded the previous version from its backup`);
        return { mission, fromBackup: true };
      } catch {
        this.log(`mission ${id}: ${why}, and no readable backup`);
        return { id, unreadable: why };
      }
    }
  }

  /** Every mission not yet in a terminal state, for recovery (§23.3 step 1). */
  loadActive(): LoadResult[] {
    return this.list()
      .filter((e) => !missionMachine.isTerminal(e.state))
      .map((e) => this.load(e.id));
  }

  /** The index, rebuilt from the files if it is missing or unreadable. */
  list(): MissionIndexEntry[] {
    const indexFile = path.join(this.dir, INDEX);
    try {
      const doc = JSON.parse(this.fs.readFileSync(indexFile, 'utf8')) as { v?: unknown; missions?: unknown };
      if (doc.v === INDEX_VERSION && Array.isArray(doc.missions)) return doc.missions as MissionIndexEntry[];
    } catch {
      // Absent on first run; anything else is rebuilt below.
    }
    return this.rebuildIndex();
  }

  /** Scan the files and write a fresh index. */
  rebuildIndex(): MissionIndexEntry[] {
    let names: string[] = [];
    try {
      names = this.fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const entries: MissionIndexEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === INDEX) continue;
      const loaded = this.load(name.slice(0, -'.json'.length));
      if ('mission' in loaded) entries.push(entry(loaded.mission));
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    if (entries.length > 0) this.writeAtomic(path.join(this.dir, INDEX), { v: INDEX_VERSION, missions: entries });
    return entries;
  }

  private updateIndex(change: (entries: MissionIndexEntry[]) => MissionIndexEntry[]): void {
    const next = change(this.list()).sort((a, b) => a.id.localeCompare(b.id));
    this.writeAtomic(path.join(this.dir, INDEX), { v: INDEX_VERSION, missions: next });
  }

  private file(id: string): string {
    // Ids are ULIDs; refuse anything that could walk out of the directory.
    if (!/^[0-9A-Za-z_-]+$/.test(id)) throw new UnreadableMission(`bad mission id ${JSON.stringify(id)}`);
    return path.join(this.dir, `${id}.json`);
  }

  private parse(file: string): unknown {
    return JSON.parse(this.fs.readFileSync(file, 'utf8'));
  }

  private readable(file: string): boolean {
    try {
      this.parse(file);
      return true;
    } catch {
      return false;
    }
  }

  private writeAtomic(file: string, doc: unknown): void {
    const tmp = `${file}.tmp`;
    this.fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    this.fs.renameSync(tmp, file);
  }
}

function entry(m: Mission): MissionIndexEntry {
  return { id: m.id, title: m.title, state: m.state, repoRoot: m.repoRoot, updatedAt: m.updatedAt };
}
