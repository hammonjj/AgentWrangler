import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MISSION_SCHEMA_VERSION, UnreadableMission, migrateMission } from '../../src/orchestration/store/migrations';
import { MissionStore, type StoreFs } from '../../src/orchestration/store/missionStore';
import { mission } from './fixtures';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-missions-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ID = '01J0000000000000000000000A';

describe('MissionStore', () => {
  it('round-trips a mission and indexes it', () => {
    const store = new MissionStore(dir);
    const m = mission({ id: ID, title: 'Round trip' });
    store.save(m);
    expect(store.load(ID)).toEqual({ mission: m });
    expect(store.list()).toEqual([{ id: ID, title: 'Round trip', state: 'draft', repoRoot: '/Users/test/proj', updatedAt: m.updatedAt }]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous good version as .bak and falls back to it', () => {
    const store = new MissionStore(dir);
    store.save(mission({ id: ID, title: 'first' }));
    store.save(mission({ id: ID, title: 'second' }));
    fs.writeFileSync(path.join(dir, `${ID}.json`), '{ half a write', 'utf8');
    const loaded = store.load(ID);
    expect(loaded).toMatchObject({ fromBackup: true, mission: { title: 'first' } });
  });

  it('never replaces a good backup with a corrupt file', () => {
    const store = new MissionStore(dir);
    store.save(mission({ id: ID, title: 'good' }));
    store.save(mission({ id: ID, title: 'newer' }));
    fs.writeFileSync(path.join(dir, `${ID}.json`), 'garbage', 'utf8');
    store.save(mission({ id: ID, title: 'after' }));
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json.bak`), 'utf8')).title).toBe('good');
  });

  it('reports a mission with no readable copy instead of throwing', () => {
    const store = new MissionStore(dir);
    fs.writeFileSync(path.join(dir, `${ID}.json`), 'garbage', 'utf8');
    expect(store.load(ID)).toMatchObject({ id: ID, unreadable: expect.any(String) });
  });

  it('a failed write leaves the previous file and the index unchanged', () => {
    const store = new MissionStore(dir);
    store.save(mission({ id: ID, title: 'before' }));
    const failing: StoreFs = {
      ...fs,
      readFileSync: fs.readFileSync,
      renameSync: (from, to) => {
        if (to.endsWith(`${ID}.json`)) throw new Error('disk full');
        fs.renameSync(from, to);
      },
    } as StoreFs;
    const broken = new MissionStore(dir, { fs: failing });
    expect(() => broken.save(mission({ id: ID, title: 'after', state: 'running' }))).toThrow('disk full');
    expect(store.load(ID)).toMatchObject({ mission: { title: 'before' } });
    expect(store.list()[0]).toMatchObject({ title: 'before', state: 'draft' });
  });

  it('rebuilds a missing or corrupt index from the files', () => {
    const store = new MissionStore(dir);
    store.save(mission({ id: ID }));
    store.save(mission({ id: '01J0000000000000000000000B', state: 'completed', finish: 'keep' }));
    fs.writeFileSync(path.join(dir, 'index.json'), 'nope', 'utf8');
    expect(store.list().map((e) => e.id)).toEqual([ID, '01J0000000000000000000000B']);
    // loadActive skips terminal missions.
    expect(store.loadActive().map((r) => ('mission' in r ? r.mission.id : r.id))).toEqual([ID]);
  });

  it('refuses ids that could leave the directory', () => {
    expect(() => new MissionStore(dir).save(mission({ id: '../escape' }))).toThrow(UnreadableMission);
  });

  it('an empty store lists nothing', () => {
    expect(new MissionStore(path.join(dir, 'absent')).list()).toEqual([]);
  });
});

describe('migrateMission', () => {
  /** The shape the plan first described (v0): no `v`, one `assignment.sessionId`. */
  const v0 = {
    id: ID,
    title: 'Old',
    objective: 'Synthetic',
    repoRoot: '/Users/test/proj',
    base: { ref: 'main', commit: 'abc' },
    integration: 'none',
    policy: {},
    state: 'running',
    source: { kind: 'user', trusted: true },
    tasks: [],
    attempts: [
      { id: 'a1', taskId: 't1', n: 1, assignment: { mode: 'fresh', sessionId: 'sess-1', harness: 'claude-code' }, state: 'running' },
      { id: 'a2', taskId: 't1', n: 2, assignment: { mode: 'fresh', harness: 'codex' }, state: 'created' },
    ],
    createdAt: 1,
    updatedAt: 1,
    futureField: 'kept',
  };

  it('moves a v0 file to v1: one session id becomes a list, lists get defaults', () => {
    const m = migrateMission(v0);
    expect(m.v).toBe(MISSION_SCHEMA_VERSION);
    expect(m.attempts[0].assignment).toEqual({ mode: 'fresh', sessionIds: ['sess-1'], harness: 'claude-code' });
    expect(m.attempts[1].assignment.sessionIds).toEqual([]);
    expect(m.attempts[0].verification).toEqual([]);
    expect(m.attempts[0].flags).toEqual({});
    expect(m.decisions).toEqual([]);
    expect(m.worktrees).toEqual([]);
    expect(m.policyChanges).toEqual([]);
    expect((m as unknown as { futureField: string }).futureField).toBe('kept');
  });

  it('loads a v0 file from disk through the store', () => {
    fs.writeFileSync(path.join(dir, `${ID}.json`), JSON.stringify(v0), 'utf8');
    const loaded = new MissionStore(dir).load(ID);
    if (!('mission' in loaded)) throw new Error('unreadable');
    expect(loaded.mission.v).toBe(1);
    expect(loaded.mission.attempts[0].assignment.sessionIds).toEqual(['sess-1']);
  });

  it('refuses a file from a newer build and a non-mission', () => {
    expect(() => migrateMission({ ...v0, v: MISSION_SCHEMA_VERSION + 1 })).toThrow(/newer/);
    expect(() => migrateMission([])).toThrow(UnreadableMission);
    expect(() => migrateMission({ v: 1 })).toThrow(/missing/);
  });
});
