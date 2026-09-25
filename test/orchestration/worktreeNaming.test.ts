import { describe, expect, it } from 'vitest';
import {
  checkRoot,
  checkSetupPath,
  defaultWorktreeRoot,
  isInside,
  isValidSlug,
  missionBranch,
  resolveWorktreeRoot,
  slugify,
  taskBranch,
  taskLeaf,
  worktreePath,
} from '../../src/orchestration/worktrees/naming';
import { parseLsofCwds, parseStatus, parseWorktreeList } from '../../src/orchestration/worktrees/porcelain';

describe('branch and directory names', () => {
  it('follows §13.2: task, retry and mission branches', () => {
    expect(taskBranch('fix-login', 't1')).toBe('aw/fix-login/t1');
    expect(taskBranch('fix-login', 't2', 2)).toBe('aw/fix-login/t2-a2');
    expect(missionBranch('fix-login')).toBe('aw/fix-login/mission');
    expect(taskLeaf('t3', 1)).toBe('t3');
    expect(taskLeaf('t3', 4)).toBe('t3-a4');
  });

  it('rejects names that would be unsafe as a directory or a ref', () => {
    for (const bad of ['', 'Fix', 'a b', 'a/b', '../x', '-x', 'x-', 'a--b', 'a.lock', 'mission', 'x'.repeat(49)]) {
      expect(isValidSlug(bad), bad).toBe(false);
    }
    expect(() => taskBranch('ok', '../t1')).toThrow();
    expect(() => taskBranch('ok', 't1', 0)).toThrow();
    expect(() => taskLeaf('t1-a2')).toThrow(/retry suffix/);
    // "mission" as a task key would collide with the mission branch.
    expect(() => taskBranch('ok', 'mission')).toThrow();
  });

  it('slugifies titles, falling back when nothing usable is left', () => {
    expect(slugify('Fix the flaky login test!')).toBe('fix-the-flaky-login-test');
    expect(slugify('Café  déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('!!!')).toBe('mission');
    expect(slugify('a'.repeat(60)).length).toBe(48);
  });
});

describe('roots and paths', () => {
  it('puts worktrees in a sibling <repo>.aw by default, and substitutes <repo>', () => {
    expect(defaultWorktreeRoot('/Users/test/proj')).toBe('/Users/test/proj.aw');
    expect(resolveWorktreeRoot('/Users/test/proj')).toBe('/Users/test/proj.aw');
    expect(resolveWorktreeRoot('/Users/test/proj', '../<repo>.aw')).toBe('/Users/test/proj.aw');
    expect(resolveWorktreeRoot('/Users/test/proj', '/Users/test/trees/<repo>')).toBe('/Users/test/trees/proj');
  });

  it('refuses a root inside, equal to, or containing the primary checkout', () => {
    expect(() => checkRoot('/Users/test/proj', '/Users/test/proj')).toThrow();
    expect(() => checkRoot('/Users/test/proj', '/Users/test/proj/.aw')).toThrow();
    expect(() => checkRoot('/Users/test/proj', '/Users/test')).toThrow();
    expect(() => checkRoot('/Users/test/proj', '/Users/test/proj.aw')).not.toThrow();
  });

  it('isInside is strict and not fooled by a shared prefix', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });

  it('builds worktree paths under the root only', () => {
    expect(worktreePath('/Users/test/proj.aw', 'm', 't1')).toBe('/Users/test/proj.aw/m/t1');
    expect(worktreePath('/Users/test/proj.aw', 'm', '_integration')).toBe('/Users/test/proj.aw/m/_integration');
    expect(() => worktreePath('/Users/test/proj.aw', 'm', '..')).toThrow();
    expect(() => worktreePath('/Users/test/proj.aw', '..', 't1')).toThrow();
  });

  it('keeps setup paths inside the checkout and away from .git', () => {
    expect(checkSetupPath('node_modules')).toBe('node_modules');
    expect(checkSetupPath('config/.env/')).toBe('config/.env');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', '.', '.git', '.git/hooks/pre-commit']) {
      expect(() => checkSetupPath(bad), bad).toThrow();
    }
  });
});

describe('porcelain parsers', () => {
  it('reads `git worktree list --porcelain -z`', () => {
    const out = [
      'worktree /Users/test/proj', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /Users/test/proj.aw/m/t1', 'HEAD bbb', 'branch refs/heads/aw/m/t1', 'locked initializing', '',
      'worktree /Users/test/proj.aw/m/t2', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
      'worktree /Users/test/proj.aw/m/t3', 'HEAD ddd', 'branch refs/heads/aw/m/t3', 'locked', '',
      '',
    ].join('\0');
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ path: '/Users/test/proj', head: 'aaa', branch: 'main', detached: false });
    expect(list[1]).toMatchObject({ branch: 'aw/m/t1', locked: 'initializing' });
    expect(list[2]).toMatchObject({ detached: true });
    expect(list[2].branch).toBeUndefined();
    expect(list[2].prunable).toContain('non-existent');
    expect(list[3].locked).toBe('');
  });

  it('reads `git status --porcelain=v1 -z`, skipping the original path of a rename', () => {
    const out = [' M src/a.ts', '?? new file.txt', 'R  b.ts', 'old-b.ts', 'A  c.ts', ''].join('\0');
    expect(parseStatus(out)).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: '??', path: 'new file.txt' },
      { code: 'R ', path: 'b.ts' },
      { code: 'A ', path: 'c.ts' },
    ]);
  });

  it('finds processes whose cwd is the tree or below it, and only those', () => {
    const out = ['p10', 'fcwd', 'n/Users/test/proj.aw/m/t1', 'p11', 'fcwd', 'n/Users/test/proj.aw/m/t1/src', 'p12', 'fcwd', 'n/Users/test/proj.aw/m/t10', 'p13', 'fcwd', 'n/'].join('\n');
    expect(parseLsofCwds(out, '/Users/test/proj.aw/m/t1').sort()).toEqual([10, 11]);
  });
});
