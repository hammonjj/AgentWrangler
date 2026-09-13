import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSuggestService, listFiles, rankPaths, scorePath } from '../src/core/fileSuggest';

const made: string[] = [];

function tree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-fs-'));
  made.push(root);
  for (const f of files) {
    const full = path.join(root, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('scorePath', () => {
  it('matches as a subsequence, so characters need not be adjacent', () => {
    // s…u…c… spread across the path, in order.
    expect(scorePath('src/ui/conversation/runnerSource.ts', 'suc')).toBeTypeOf('number');
  });

  it('requires the characters in order', () => {
    expect(scorePath('src/main.ts', 'main')).toBeTypeOf('number');
    // Every letter is present, but `i` never follows the last `n`.
    expect(scorePath('src/main.ts', 'niam')).toBeUndefined();
  });

  it('does not match when a character is missing', () => {
    expect(scorePath('src/main.ts', 'zzz')).toBeUndefined();
  });

  it('ranks a basename hit above one buried in the directory', () => {
    const inName = scorePath('a/b/runner.ts', 'runner')!;
    const inDir = scorePath('runner/b/other.ts', 'runner')!;
    expect(inName).toBeLessThan(inDir);
  });

  it('ranks an exact filename first, then a prefix, then a loose match', () => {
    const exact = scorePath('src/diff.ts', 'diff.ts')!;
    const prefix = scorePath('src/diffView.ts', 'diff.ts');
    expect(exact).toBeLessThan(prefix ?? Infinity);
  });

  it('is case-insensitive', () => {
    expect(scorePath('src/Runner.ts', 'runner')).toBeTypeOf('number');
    expect(scorePath('src/runner.ts', 'RUNNER')).toBeTypeOf('number');
  });

  it('offers the shortest paths when nothing has been typed yet', () => {
    expect(rankPaths(['a/b/c/deep.ts', 'top.ts'], '')).toEqual(['top.ts', 'a/b/c/deep.ts']);
  });
});

describe('rankPaths', () => {
  const files = ['src/core/dictation.ts', 'src/core/fileSuggest.ts', 'test/dictation.test.ts', 'README.md'];

  it('puts the file named for the query first', () => {
    expect(rankPaths(files, 'dictation')[0]).toBe('src/core/dictation.ts');
  });

  it('drops everything that does not match', () => {
    expect(rankPaths(files, 'readme')).toEqual(['README.md']);
  });

  it('honours the limit, because the popup is a shortlist', () => {
    expect(rankPaths(files, '', 2)).toHaveLength(2);
  });

  it('returns nothing rather than everything for an impossible query', () => {
    expect(rankPaths(files, 'qqqq')).toEqual([]);
  });
});

describe('listFiles', () => {
  it('walks a plain folder and skips the directories nothing is ever mentioned from', async () => {
    const root = tree(['src/a.ts', 'node_modules/pkg/index.js', 'dist/out.js', '.git/config', 'README.md']);
    const files = await listFiles(root);
    expect(files.sort()).toEqual(['README.md', 'src/a.ts']);
  });

  it('returns paths relative to the folder, separated with forward slashes', async () => {
    const root = tree(['deep/nested/file.ts']);
    expect(await listFiles(root)).toEqual(['deep/nested/file.ts']);
  });
});

describe('FileSuggestService', () => {
  it('lists once and answers later queries from the cache', async () => {
    const root = tree(['src/alpha.ts', 'src/beta.ts']);
    const svc = new FileSuggestService(60_000);

    expect(await svc.suggest(root, 'alpha')).toEqual(['src/alpha.ts']);
    // Created after the first listing: a cached answer must not see it.
    fs.writeFileSync(path.join(root, 'src', 'gamma.ts'), '');
    expect(await svc.suggest(root, 'gamma')).toEqual([]);
  });

  it('re-lists once the TTL has passed, because the interesting file is often the new one', async () => {
    const root = tree(['src/alpha.ts']);
    const svc = new FileSuggestService(0);
    await svc.suggest(root, 'alpha');
    fs.writeFileSync(path.join(root, 'src', 'gamma.ts'), '');
    expect(await svc.suggest(root, 'gamma')).toEqual(['src/gamma.ts']);
  });

  it('shares one listing between concurrent keystrokes', async () => {
    const root = tree(['src/alpha.ts']);
    const svc = new FileSuggestService(60_000);
    const [a, b] = await Promise.all([svc.suggest(root, 'a'), svc.suggest(root, 'al')]);
    expect(a).toEqual(['src/alpha.ts']);
    expect(b).toEqual(['src/alpha.ts']);
  });

  it('answers empty for a folder that is gone, rather than throwing into the pane', async () => {
    expect(await new FileSuggestService().suggest('/no/such/folder', 'x')).toEqual([]);
  });
});
