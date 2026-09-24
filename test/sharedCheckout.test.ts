import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutRootFor, clearCheckoutRootCache } from '../src/core/checkout';
import { occupantsOf, occupiesCheckout, sharedCheckouts, type CheckoutEntry } from '../src/core/sharedCheckout';

const e = (key: string, root: string | undefined, label = key): CheckoutEntry => ({ key, root, label });

describe('sharedCheckouts', () => {
  it('flags both sessions in one main checkout, each naming the other', () => {
    const out = sharedCheckouts([e('a', '/Users/test/proj'), e('b', '/Users/test/proj')]);
    expect(out.get('a')).toEqual({ root: '/Users/test/proj', others: ['b'] });
    expect(out.get('b')).toEqual({ root: '/Users/test/proj', others: ['a'] });
  });

  it('leaves separate worktrees of one repo alone', () => {
    const out = sharedCheckouts([
      e('main', '/Users/test/proj'),
      e('wt1', '/Users/test/proj-topic'),
      e('wt2', '/Users/test/proj-other'),
    ]);
    expect(out.size).toBe(0);
  });

  it('flags two sessions in the same linked worktree', () => {
    const out = sharedCheckouts([e('a', '/Users/test/proj-topic'), e('b', '/Users/test/proj-topic'), e('c', '/Users/test/proj')]);
    expect([...out.keys()].sort()).toEqual(['a', 'b']);
  });

  it('treats a trailing slash as the same checkout', () => {
    expect(sharedCheckouts([e('a', '/Users/test/proj/'), e('b', '/Users/test/proj')]).size).toBe(2);
  });

  it('ignores sessions outside git', () => {
    expect(sharedCheckouts([e('a', undefined), e('b', undefined)]).size).toBe(0);
  });

  it('lists every other occupant when three share', () => {
    const out = sharedCheckouts([e('a', '/r', 'A'), e('b', '/r', 'B'), e('c', '/r', 'C')]);
    expect(out.get('b')?.others).toEqual(['A', 'C']);
  });
});

describe('occupiesCheckout', () => {
  it('counts every Claude session that has not ended', () => {
    expect(occupiesCheckout({ provider: 'claude', status: 'done' })).toBe(true);
    expect(occupiesCheckout({ provider: 'claude', status: 'waiting' })).toBe(true);
    expect(occupiesCheckout({ provider: 'claude', status: 'ended' })).toBe(false);
  });

  it('counts a Codex thread only while it is run here or mid-turn', () => {
    expect(occupiesCheckout({ provider: 'codex', status: 'done' })).toBe(false);
    expect(occupiesCheckout({ provider: 'codex', status: 'waiting' })).toBe(false);
    expect(occupiesCheckout({ provider: 'codex', status: 'done', runnerOwned: true })).toBe(true);
    expect(occupiesCheckout({ provider: 'codex', status: 'busy' })).toBe(true);
    expect(occupiesCheckout({ provider: 'codex', status: 'stuck' })).toBe(true);
  });
});

describe('occupantsOf', () => {
  it('names the live sessions already in a folder’s checkout', () => {
    const entries = [e('a', '/Users/test/proj', 'A'), e('b', '/Users/test/proj-topic', 'B')];
    expect(occupantsOf('/Users/test/proj', entries)).toEqual(['A']);
    expect(occupantsOf('/Users/test/elsewhere', entries)).toEqual([]);
    expect(occupantsOf(undefined, entries)).toEqual([]);
  });
});

describe('checkoutRootFor', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-shared-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it('resolves a subfolder of a main checkout to the repo, and a worktree to its own root', () => {
    clearCheckoutRootCache();
    const repo = path.join(tmp, 'repo');
    const wt = path.join(tmp, 'repo-topic');
    write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(repo, '.git', 'worktrees', 'repo-topic', 'HEAD'), 'ref: refs/heads/feat/topic\n');
    write(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'repo-topic')}\n`);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });

    expect(checkoutRootFor(path.join(repo, 'src'))).toBe(repo);
    expect(checkoutRootFor(path.join(wt, 'src'))).toBe(wt);
    expect(checkoutRootFor(undefined)).toBeUndefined();
    // End to end: main-checkout sessions collide, the worktree one does not.
    const out = sharedCheckouts([
      e('a', checkoutRootFor(repo)),
      e('b', checkoutRootFor(path.join(repo, 'src'))),
      e('c', checkoutRootFor(path.join(wt, 'src'))),
    ]);
    expect([...out.keys()].sort()).toEqual(['a', 'b']);
  });
});
