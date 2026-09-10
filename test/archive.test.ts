import { describe, expect, it } from 'vitest';
import { ArchiveService, type KeyValueStorage } from '../src/core/archive';

function fakeStorage(initial: string[] = []): KeyValueStorage & { saved: unknown } {
  const store: { saved: unknown } & KeyValueStorage = {
    saved: initial,
    get<T>(_key: string, def: T): T {
      return (store.saved as T) ?? def;
    },
    update(_key: string, value: unknown) {
      store.saved = value;
      return Promise.resolve();
    },
  };
  return store;
}

describe('ArchiveService', () => {
  it('loads persisted keys and toggles + persists', () => {
    const storage = fakeStorage(['claude:a']);
    const svc = new ArchiveService(storage);
    expect(svc.isArchived('claude:a')).toBe(true);
    expect(svc.isArchived('claude:b')).toBe(false);

    svc.toggle('claude:b');
    expect(svc.isArchived('claude:b')).toBe(true);
    expect(storage.saved).toEqual(['claude:a', 'claude:b']);

    svc.toggle('claude:a');
    expect(svc.isArchived('claude:a')).toBe(false);
    expect(storage.saved).toEqual(['claude:b']);
  });

  it('fires onDidChange on toggle', () => {
    const svc = new ArchiveService(fakeStorage());
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.toggle('x');
    svc.toggle('x');
    expect(fired).toBe(2);
  });
});
