import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lastUsedByDir,
  ProjectsService,
  rankProjects,
  readConfigProjectDirs,
  readProjects,
  type HiddenProjects,
} from '../src/claude/projects';
import { slugForCwd } from '../src/claude/paths';

const made: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-proj-'));
  made.push(dir);
  return dir;
}

/** A `~/.claude.json` with the given folders as its `projects` keys. */
function configWith(dirs: string[], extra: Record<string, unknown> = {}): string {
  const root = tmp();
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ ...extra, projects: Object.fromEntries(dirs.map((d) => [d, {}])) }));
  return file;
}

/** A `~/.claude/projects` root with a transcript per folder, stamped with an mtime. */
function projectsRoot(entries: { dir: string; mtimeMs?: number; name?: string }[]): string {
  const root = tmp();
  for (const e of entries) {
    const slugDir = path.join(root, slugForCwd(e.dir));
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, e.name ?? '11111111-2222-3333-4444-555555555555.jsonl');
    fs.writeFileSync(file, '{}\n');
    if (e.mtimeMs !== undefined) fs.utimesSync(file, e.mtimeMs / 1000, e.mtimeMs / 1000);
  }
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('rankProjects', () => {
  it('sorts most recently used first, and never-used folders last by name', () => {
    const ranked = rankProjects([
      { dir: '/Users/test/zeta' },
      { dir: '/Users/test/old', lastUsedAt: 100 },
      { dir: '/Users/test/alpha' },
      { dir: '/Users/test/new', lastUsedAt: 900 },
    ]);
    expect(ranked.map((p) => p.name)).toEqual(['new', 'old', 'alpha', 'zeta']);
  });

  it('keeps the newest timestamp when one folder arrives from several sources', () => {
    // The config knows a file mtime; a live session knows it is being used now.
    const ranked = rankProjects([
      { dir: '/Users/test/proj', lastUsedAt: 100 },
      { dir: '/Users/test/proj', lastUsedAt: 900 },
    ]);
    expect(ranked).toEqual([{ dir: '/Users/test/proj', name: 'proj', lastUsedAt: 900 }]);
  });

  it('treats a trailing separator as the same folder, so the dropdown shows it once', () => {
    const ranked = rankProjects([{ dir: '/Users/test/proj' }, { dir: '/Users/test/proj/' }]);
    expect(ranked).toHaveLength(1);
  });

  it('drops relative paths and rubbish rather than offering a cwd that cannot be spawned into', () => {
    const ranked = rankProjects([
      { dir: 'relative/path' },
      { dir: '' },
      { dir: undefined as unknown as string },
      { dir: '/Users/test/ok' },
    ]);
    expect(ranked.map((p) => p.dir)).toEqual(['/Users/test/ok']);
  });

  it('carries the full path as well as the basename, since two checkouts share a name', () => {
    const ranked = rankProjects([{ dir: '/Users/test/a/app' }, { dir: '/Users/test/b/app' }]);
    expect(ranked.map((p) => p.name)).toEqual(['app', 'app']);
    expect(ranked.map((p) => p.dir).sort()).toEqual(['/Users/test/a/app', '/Users/test/b/app']);
  });
});

describe('readConfigProjectDirs', () => {
  it('reads the projects map keys', async () => {
    const file = configWith(['/Users/test/one', '/Users/test/two']);
    expect((await readConfigProjectDirs(file)).sort()).toEqual(['/Users/test/one', '/Users/test/two']);
  });

  it('ignores every other key in the file', async () => {
    // The real file is mostly caches and telemetry; only `projects` is ours.
    const file = configWith(['/Users/test/one'], { numStartups: 12, mcpServers: {} });
    expect(await readConfigProjectDirs(file)).toEqual(['/Users/test/one']);
  });

  it('returns nothing for a missing, unparseable or shapeless file', async () => {
    const root = tmp();
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const noProjects = path.join(root, 'none.json');
    fs.writeFileSync(noProjects, JSON.stringify({ projects: 'nope' }));

    expect(await readConfigProjectDirs(path.join(root, 'missing.json'))).toEqual([]);
    expect(await readConfigProjectDirs(bad)).toEqual([]);
    expect(await readConfigProjectDirs(noProjects)).toEqual([]);
  });
});

describe('lastUsedByDir', () => {
  it('finds a folder its own transcripts through the forward slug, and takes the newest', async () => {
    const dir = '/Users/test/proj';
    const root = projectsRoot([{ dir, mtimeMs: 1_000_000 }]);
    const slugDir = path.join(root, slugForCwd(dir));
    const newer = path.join(slugDir, '99999999-2222-3333-4444-555555555555.jsonl');
    fs.writeFileSync(newer, '{}\n');
    fs.utimesSync(newer, 5_000, 5_000);

    expect((await lastUsedByDir([dir], root)).get(dir)).toBe(5_000_000);
  });

  it('ignores sidecar files that are not top-level transcripts', async () => {
    const dir = '/Users/test/proj';
    const root = projectsRoot([{ dir, mtimeMs: 1_000_000 }]);
    const junk = path.join(root, slugForCwd(dir), 'agent-something.jsonl');
    fs.writeFileSync(junk, '{}\n');
    fs.utimesSync(junk, 9_000, 9_000);

    expect((await lastUsedByDir([dir], root)).get(dir)).toBe(1_000_000);
  });

  it('leaves a folder with no transcript directory out entirely', async () => {
    const root = projectsRoot([]);
    expect((await lastUsedByDir(['/Users/test/never'], root)).size).toBe(0);
  });
});

describe('readProjects', () => {
  it('offers config folders that exist, newest first', async () => {
    const base = tmp();
    const older = path.join(base, 'older');
    const newer = path.join(base, 'newer');
    fs.mkdirSync(older);
    fs.mkdirSync(newer);
    const file = configWith([older, newer]);
    const root = projectsRoot([
      { dir: older, mtimeMs: 1_000_000 },
      { dir: newer, mtimeMs: 8_000_000 },
    ]);

    const list = await readProjects({ workspaceFolders: [], sessions: [] }, { file, root });
    expect(list.map((p) => p.dir)).toEqual([newer, older]);
  });

  it('drops a folder that has been deleted, because a conversation cannot start there', async () => {
    const base = tmp();
    const gone = path.join(base, 'gone');
    const file = configWith([gone]);
    const root = projectsRoot([]);

    expect(await readProjects({ workspaceFolders: [], sessions: [] }, { file, root })).toEqual([]);
  });

  it('adds workspace folders Claude Code has never been used in', async () => {
    const base = tmp();
    const fresh = path.join(base, 'fresh');
    fs.mkdirSync(fresh);
    const file = configWith([]);
    const root = projectsRoot([]);

    const list = await readProjects({ workspaceFolders: [fresh], sessions: [] }, { file, root });
    expect(list.map((p) => p.dir)).toEqual([fresh]);
  });

  it('lets a live session outrank a file mtime for the same folder', async () => {
    const base = tmp();
    const dir = path.join(base, 'proj');
    const other = path.join(base, 'other');
    fs.mkdirSync(dir);
    fs.mkdirSync(other);
    const file = configWith([dir, other]);
    const root = projectsRoot([
      { dir, mtimeMs: 1_000_000 },
      { dir: other, mtimeMs: 8_000_000 },
    ]);

    const list = await readProjects({ workspaceFolders: [], sessions: [{ dir, lastUsedAt: 9_000_000 }] }, { file, root });
    expect(list.map((p) => p.dir)).toEqual([dir, other]);
  });
});

describe('ProjectsService', () => {
  /** Always isolated: a service pointed at the real `~/.claude.json` would read the machine's own projects. */
  function service(
    extra: () => { workspaceFolders: string[]; sessions: { dir: string; lastUsedAt?: number }[] },
    opts: { ttlMs?: number; hidden?: HiddenProjects } = {},
  ) {
    return new ProjectsService(extra, { ...opts, file: configWith([]), root: projectsRoot([]) });
  }

  /** The storage-free half of `HiddenProjectsService`, which lives in core and needs none of it here. */
  function hiddenSet(): HiddenProjects & { value: Set<string> } {
    const value = new Set<string>();
    return { value, hide: (d) => void value.add(d), unhide: (d) => void value.delete(d) };
  }

  it('does not re-scan inside the TTL, and does on force', async () => {
    const base = tmp();
    const one = path.join(base, 'one');
    fs.mkdirSync(one);
    let calls = 0;
    const svc = service(() => {
      calls++;
      return { workspaceFolders: [one], sessions: [] };
    }, { ttlMs: 60_000 });

    await svc.refresh();
    await svc.refresh();
    expect(calls).toBe(1);

    await svc.refresh({ force: true });
    expect(calls).toBe(2);
  });

  it('shares one scan between concurrent callers', async () => {
    const base = tmp();
    const one = path.join(base, 'one');
    fs.mkdirSync(one);
    let calls = 0;
    const svc = service(() => {
      calls++;
      return { workspaceFolders: [one], sessions: [] };
    });

    await Promise.all([svc.refresh(), svc.refresh(), svc.refresh()]);
    expect(calls).toBe(1);
  });

  it('keeps offering a browsed folder that is in no config file', async () => {
    const base = tmp();
    const browsed = path.join(base, 'browsed');
    fs.mkdirSync(browsed);
    const svc = service(() => ({ workspaceFolders: [], sessions: [] }));

    expect(await svc.refresh({ force: true })).toEqual([]);
    svc.add(browsed);
    expect((await svc.refresh({ force: true })).map((p) => p.dir)).toEqual([browsed]);
  });

  it('starts empty, so a dashboard that has not scanned yet sends no project list', () => {
    expect(service(() => ({ workspaceFolders: [], sessions: [] })).value).toEqual([]);
  });

  it('drops a removed folder from the cache at once, without waiting for a scan', async () => {
    const base = tmp();
    const keep = path.join(base, 'keep');
    const drop = path.join(base, 'drop');
    fs.mkdirSync(keep);
    fs.mkdirSync(drop);
    const svc = service(() => ({ workspaceFolders: [keep, drop], sessions: [] }), { hidden: hiddenSet() });

    await svc.refresh({ force: true });
    expect(svc.value.map((p) => p.name).sort()).toEqual(['drop', 'keep']);

    svc.remove(drop);
    expect(svc.value.map((p) => p.name)).toEqual(['keep']);
  });

  it('keeps a removed folder out on the next scan, though the workspace still offers it', async () => {
    const base = tmp();
    const drop = path.join(base, 'drop');
    fs.mkdirSync(drop);
    // The source keeps producing it — the config and the workspace are not ours
    // to edit — so only the hidden set can keep it out.
    const svc = service(() => ({ workspaceFolders: [drop], sessions: [] }), { hidden: hiddenSet() });

    await svc.refresh({ force: true });
    svc.remove(drop);
    expect(await svc.refresh({ force: true })).toEqual([]);
  });

  it('brings a removed folder back when it is browsed to again', async () => {
    const base = tmp();
    const dir = path.join(base, 'proj');
    fs.mkdirSync(dir);
    const svc = service(() => ({ workspaceFolders: [dir], sessions: [] }), { hidden: hiddenSet() });

    svc.remove(dir);
    expect(await svc.refresh({ force: true })).toEqual([]);

    svc.add(dir);
    expect((await svc.refresh({ force: true })).map((p) => p.dir)).toEqual([dir]);
  });

  it('shows a re-added folder without waiting out the TTL', async () => {
    const base = tmp();
    const dir = path.join(base, 'proj');
    fs.mkdirSync(dir);
    // `add` happens because the user browsed to it and is about to look at the
    // list; a cache that was fresh a second ago must not hide their own choice.
    const svc = service(() => ({ workspaceFolders: [], sessions: [] }), { ttlMs: 60_000 });

    await svc.refresh();
    svc.add(dir);
    expect((await svc.refresh()).map((p) => p.dir)).toEqual([dir]);
  });

  it('fires so a second dashboard stops offering what the first removed', async () => {
    const base = tmp();
    const dir = path.join(base, 'proj');
    fs.mkdirSync(dir);
    const svc = service(() => ({ workspaceFolders: [dir], sessions: [] }), { hidden: hiddenSet() });
    let fired = 0;
    svc.onDidChange(() => fired++);

    await svc.refresh({ force: true });
    svc.remove(dir);
    expect(fired).toBe(1);
  });
});
