import { describe, expect, it } from 'vitest';
import { FavouriteProjectsService } from '../src/core/favouriteProjects';
import { HiddenProjectsService } from '../src/core/hiddenProjects';

/** The two methods of the key-value store that the service uses. */
function storage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    get<T>(key: string, defaultValue: T): T {
      return (data[key] as T) ?? defaultValue;
    },
    update(key: string, value: unknown): unknown {
      data[key] = value;
      return undefined;
    },
    raw: data,
  };
}

const KEY = 'agentWrangler.favouriteProjects';

describe('FavouriteProjectsService', () => {
  it('remembers a favourite across a relaunch', () => {
    const store = storage();
    new FavouriteProjectsService(store).favourite('/Users/test/proj');
    expect(new FavouriteProjectsService(store).value.has('/Users/test/proj')).toBe(true);
  });

  it('forgets one when it is un-starred', () => {
    const store = storage();
    const svc = new FavouriteProjectsService(store);
    svc.favourite('/Users/test/proj');
    svc.unfavourite('/Users/test/proj');
    expect(svc.value.size).toBe(0);
    expect(store.raw[KEY]).toEqual([]);
  });

  it('fires only on a real change', () => {
    const svc = new FavouriteProjectsService(storage());
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.favourite('/Users/test/proj');
    svc.favourite('/Users/test/proj');
    svc.unfavourite('/Users/test/other');
    expect(fired).toBe(1);
  });

  it('keeps its own key, so starring a folder does not hide it', () => {
    const store = storage();
    new FavouriteProjectsService(store).favourite('/Users/test/proj');
    expect(new HiddenProjectsService(store).value.size).toBe(0);
  });

  it('survives junk in storage', () => {
    const svc = new FavouriteProjectsService(storage({ [KEY]: ['/Users/test/ok', 7, null] }));
    expect([...svc.value]).toEqual(['/Users/test/ok']);
  });
});
