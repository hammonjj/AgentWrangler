import { describe, expect, it } from 'vitest';
import type { ProjectDTO } from '../src/shared/model';
import { orderProjects } from '../src/shared/projectOrder';

const p = (name: string, lastUsedAt?: number, dir = `/Users/test/${name}`): ProjectDTO => ({ dir, name, lastUsedAt });

describe('orderProjects', () => {
  it('puts favourites first, and the rest newest-used first with never-used last by name', () => {
    const list = [p('recent', 900), p('zeta'), p('fav-old', 100), p('old', 200), p('alpha')];
    const ordered = orderProjects(list, new Set(['/Users/test/fav-old']));
    expect(ordered.map((x) => x.name)).toEqual(['fav-old', 'recent', 'old', 'alpha', 'zeta']);
  });

  it('orders favourites by name, so using one does not move it', () => {
    const favs = new Set(['/Users/test/beta', '/Users/test/alpha']);
    const before = orderProjects([p('beta', 100), p('alpha', 200), p('other', 50)], favs);
    const after = orderProjects([p('beta', 999), p('alpha', 200), p('other', 50)], favs);
    expect(before.map((x) => x.name)).toEqual(['alpha', 'beta', 'other']);
    expect(after.map((x) => x.name)).toEqual(['alpha', 'beta', 'other']);
  });

  it('breaks a name tie between favourites by path, so two checkouts keep a fixed order', () => {
    const a = p('app', 900, '/Users/test/b/app');
    const b = p('app', 100, '/Users/test/a/app');
    const ordered = orderProjects([a, b], new Set([a.dir, b.dir]));
    expect(ordered.map((x) => x.dir)).toEqual(['/Users/test/a/app', '/Users/test/b/app']);
  });

  it('marks favourites and clears the mark from anything no longer starred', () => {
    const list: ProjectDTO[] = [{ ...p('was', 100), favourite: true }, p('now', 50)];
    const ordered = orderProjects(list, new Set(['/Users/test/now']));
    expect(ordered).toEqual([
      { dir: '/Users/test/now', name: 'now', lastUsedAt: 50, favourite: true },
      { dir: '/Users/test/was', name: 'was', lastUsedAt: 100 },
    ]);
  });

  it('sends an un-starred folder back to its recency slot, whatever order it arrived in', () => {
    const list: ProjectDTO[] = [{ ...p('fav', 10), favourite: true }, p('new', 900), p('mid', 500)];
    expect(orderProjects(list, new Set()).map((x) => x.name)).toEqual(['new', 'mid', 'fav']);
  });

  it('ignores a favourite that is not in the list', () => {
    const ordered = orderProjects([p('one', 1)], new Set(['/Users/test/gone']));
    expect(ordered.map((x) => x.name)).toEqual(['one']);
  });
});
