import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutFor, parseHead } from '../src/core/checkout';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-checkout-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('checkoutFor', () => {
  it('finds the repo root and branch from a subdirectory of a main checkout', () => {
    const repo = path.join(root, 'main-repo');
    write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    expect(checkoutFor(path.join(repo, 'src', 'deep'))).toEqual({ repoRoot: repo, branch: 'feature/x' });
  });

  it('knows a linked worktree, the checkout it belongs to, and its own branch', () => {
    const repo = path.join(root, 'wt-main');
    const wt = path.join(root, 'wt-main-topic');
    write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(repo, '.git', 'worktrees', 'wt-main-topic', 'HEAD'), 'ref: refs/heads/feat/topic\n');
    write(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt-main-topic')}\n`);
    expect(checkoutFor(wt)).toEqual({ repoRoot: repo, worktree: wt, branch: 'feat/topic' });
  });

  it('has no branch on a detached HEAD, and nothing outside git', () => {
    const repo = path.join(root, 'detached');
    write(path.join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(checkoutFor(repo)).toEqual({ repoRoot: repo, branch: undefined });
    expect(checkoutFor(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-nogit-')))).toEqual({});
  });
});

describe('parseHead', () => {
  it('reads a branch ref and nothing else', () => {
    expect(parseHead('ref: refs/heads/main\n')).toBe('main');
    expect(parseHead('ref: refs/tags/v1\n')).toBeUndefined();
    expect(parseHead('abc123')).toBeUndefined();
  });
});
