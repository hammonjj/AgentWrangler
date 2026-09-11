import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorktree, parseWorktreeGitdir } from '../src/core/worktree';

describe('parseWorktreeGitdir', () => {
  it('reads the worktree name and the repo it belongs to', () => {
    expect(parseWorktreeGitdir('gitdir: /Users/test/proj/.git/worktrees/feature-x\n')).toEqual({
      name: 'feature-x',
      mainRepo: '/Users/test/proj',
    });
  });

  it('tolerates the spacing and line endings git might write', () => {
    expect(parseWorktreeGitdir('gitdir:/Users/test/proj/.git/worktrees/a\r\n')?.name).toBe('a');
    expect(parseWorktreeGitdir('  gitdir:   /Users/test/proj/.git/worktrees/a  ')?.name).toBe('a');
  });

  it('is not fooled by a submodule, which has the same shape', () => {
    expect(parseWorktreeGitdir('gitdir: ../.git/modules/vendor/lib')).toBeUndefined();
  });

  it('returns nothing for anything else', () => {
    expect(parseWorktreeGitdir('')).toBeUndefined();
    expect(parseWorktreeGitdir('ref: refs/heads/main')).toBeUndefined();
    expect(parseWorktreeGitdir('gitdir: /Users/test/proj/.git/worktrees/')).toBeUndefined();
    expect(parseWorktreeGitdir('gitdir: /Users/test/proj/.git/worktrees/a/b')).toBeUndefined();
  });
});

describe('findWorktree', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds the worktree from a subdirectory of it, and not in a main checkout', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-worktree-'));
    const main = path.join(dir, 'proj');
    const linked = path.join(dir, 'proj-feature');
    const deep = path.join(linked, 'src', 'ui');
    await fsp.mkdir(path.join(main, '.git'), { recursive: true });
    await fsp.mkdir(deep, { recursive: true });
    await fsp.writeFile(path.join(linked, '.git'), `gitdir: ${main}/.git/worktrees/proj-feature\n`, 'utf8');

    expect(findWorktree(deep)).toEqual({
      name: 'proj-feature',
      root: linked,
      mainRepo: path.join(main, ''),
    });
    // The main checkout has a .git DIRECTORY, which is the whole distinction.
    expect(findWorktree(main)).toBeUndefined();
  });

  it('returns nothing outside a repo', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-worktree-'));
    expect(findWorktree(dir)).toBeUndefined();
  });
});
