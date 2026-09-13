import { describe, expect, it } from 'vitest';
import { HiddenProjectsService } from '../src/core/hiddenProjects';

/** The two methods of VSCode's Memento that the service uses. */
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

const KEY = 'agentWrangler.hiddenProjects';

describe('HiddenProjectsService', () => {
  it('remembers a removal across a reload', () => {
    const store = storage();
    new HiddenProjectsService(store).hide('/Users/test/proj');
    expect(new HiddenProjectsService(store).value.has('/Users/test/proj')).toBe(true);
  });

  it('forgets one when the folder is browsed to again', () => {
    const store = storage();
    const svc = new HiddenProjectsService(store);
    svc.hide('/Users/test/proj');
    svc.unhide('/Users/test/proj');
    expect(svc.value.size).toBe(0);
    expect(store.raw[KEY]).toEqual([]);
  });

  it('fires only on a real change, so two dashboards do not loop', () => {
    const svc = new HiddenProjectsService(storage());
    let fired = 0;
    svc.onDidChange(() => fired++);

    svc.hide('/Users/test/proj');
    svc.hide('/Users/test/proj'); // already hidden
    svc.unhide('/Users/test/other'); // never hidden
    expect(fired).toBe(1);
  });

  it('survives junk in storage rather than failing to construct', () => {
    const svc = new HiddenProjectsService(storage({ [KEY]: ['/Users/test/ok', 42, null] }));
    expect([...svc.value]).toEqual(['/Users/test/ok']);
  });
});
