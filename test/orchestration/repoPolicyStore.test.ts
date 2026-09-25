import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RepoPolicyStore,
  identityFor,
  repoIdentity,
  worktreeRootPath,
} from '../../src/orchestration/policy/repoPolicyStore';

let tmp: string;
let repo: string;
let dataDir: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-policy-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'proj-t1'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function linkedWorktree(): string {
  const wt = path.join(tmp, 'proj.aw', 'm', 't1');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'proj-t1')}\n`);
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'proj-t1', 'HEAD'), 'ref: refs/heads/aw/m/t1\n');
  return wt;
}

function writePolicy(store: RepoPolicyStore, id: string, doc: unknown): void {
  const file = store.fileFor(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

describe('repoIdentity', () => {
  it('gives the primary checkout and its worktrees one id', () => {
    const primary = repoIdentity(path.join(repo));
    const fromWorktree = repoIdentity(path.join(linkedWorktree(), 'src'));
    expect(primary).toBeDefined();
    expect(fromWorktree).toEqual(primary);
    expect(primary?.id).toMatch(/^proj-[0-9a-f]{12}$/);
    expect(primary?.primaryRoot).toBe(repo);
  });

  it('distinguishes two repositories with the same folder name', () => {
    const other = path.join(tmp, 'elsewhere', 'proj');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    expect(identityFor(other).id).not.toBe(identityFor(repo).id);
  });

  it('is undefined outside git', () => {
    expect(repoIdentity(dataDir)).toBeUndefined();
  });
});

describe('RepoPolicyStore', () => {
  it('uses the defaults with no file, versioned "default"', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    const loaded = store.forFolder(repo);
    expect(loaded).toMatchObject({ source: 'default', version: 'default' });
    expect(loaded?.errors).toBeUndefined();
    expect(loaded?.policy.verification.commands).toEqual({});
    expect(worktreeRootPath(loaded!)).toBe(path.join(tmp, 'proj.aw'));
  });

  it('loads a valid file and lays it over the defaults field by field', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    const id = identityFor(repo).id;
    writePolicy(store, id, { verification: { unit: { run: ['npm', 'test'] }, missionDefault: ['unit'] } });
    const loaded = store.forFolder(linkedWorktree());
    expect(loaded?.source).toBe('file');
    expect(loaded?.version).toMatch(/^v1-[0-9a-f]{12}$/);
    expect(loaded?.policy.verification.missionDefault).toEqual(['unit']);
    expect(loaded?.policy.worktrees.root).toBe('../<repo>.aw');
    expect(loaded?.policy.finish.default).toBe('merge-local');
  });

  it('ignores an invalid file whole, with precise errors, logged once', () => {
    const logs: string[] = [];
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'), { log: (m) => logs.push(m) });
    const id = identityFor(repo).id;
    // Valid risk plus an invalid command: nothing of it may apply.
    writePolicy(store, id, { risk: [{ paths: ['a'], level: 'high', why: 'x' }], verification: { unit: { run: 'npm test' } } });
    const first = store.forFolder(repo);
    const second = store.forFolder(repo);
    expect(first).toMatchObject({ source: 'default', version: 'default' });
    expect(first?.policy.risk).toEqual([]);
    expect(first?.errors?.map((e) => e.path)).toEqual(['verification.unit.run']);
    expect(second?.errors).toEqual(first?.errors);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/ignored, using defaults: verification\.unit\.run/);
  });

  it('rejects a file whose lists name missing commands', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    writePolicy(store, identityFor(repo).id, { finish: { gate: ['build'] } });
    expect(store.forFolder(repo)?.errors).toEqual([{ path: 'finish.gate[0]', message: 'no verification command named "build"' }]);
  });

  it('rejects unparseable JSON', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    writePolicy(store, identityFor(repo).id, '{ nope');
    expect(store.forFolder(repo)).toMatchObject({ source: 'default', errors: [{ path: '' }] });
  });

  it('versions by meaning, not formatting, and changes when what runs changes', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    const r = identityFor(repo);
    writePolicy(store, r.id, { verification: { unit: { run: ['npm', 'test'], timeoutSec: 600 } } });
    const a = store.load(r).version;
    writePolicy(store, r.id, `{\n  "verification": {"unit": {"timeoutSec": 600, "run": ["npm", "test"]}}\n}\n`);
    expect(store.load(r).version).toBe(a);
    writePolicy(store, r.id, { verification: { unit: { run: ['npm', 'test', '--', '--bail'] } } });
    expect(store.load(r).version).not.toBe(a);
  });

  it('saves only a valid policy and leaves the file alone otherwise', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    const r = identityFor(repo);
    const ok = store.save(r, { finish: { default: 'pull-request' } });
    expect(ok).toMatchObject({ ok: true, loaded: { source: 'file', policy: { finish: { default: 'pull-request' } } } });
    const bad = store.save(r, { finish: { default: 'discard' as never } });
    expect(bad).toMatchObject({ ok: false, errors: [{ path: 'finish.default' }] });
    expect(store.load(r).policy.finish.default).toBe('pull-request');
    expect(fs.readdirSync(path.join(dataDir, 'repos'))).toEqual([`${r.id}.json`]);
  });

  it('refuses a repo id that could leave the directory', () => {
    const store = new RepoPolicyStore(path.join(dataDir, 'repos'));
    expect(() => store.fileFor('../x')).toThrow(/bad repo id/);
    expect(() => store.fileFor('..')).toThrow(/bad repo id/);
  });
});
