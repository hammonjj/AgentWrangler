import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { ColumnPrefsService } from '../src/core/columnPrefs';

function fakeStorage(initial: unknown = {}): KeyValueStorage & { saved: unknown } {
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

describe('ColumnPrefsService', () => {
  it('reads a saved layout back', () => {
    const svc = new ColumnPrefsService(fakeStorage({ hidden: ['pr'], widths: { proj: 210 } }));
    expect(svc.value).toEqual({ hidden: ['pr'], widths: { proj: 210 } });
  });

  it('persists what the dashboard sends', () => {
    const storage = fakeStorage();
    const svc = new ColumnPrefsService(storage);
    svc.set({ hidden: ['branch'], widths: { age: 64 } });
    expect(storage.saved).toEqual({ hidden: ['branch'], widths: { age: 64 } });
    expect(svc.value).toEqual({ hidden: ['branch'], widths: { age: 64 } });
  });

  it('sanitizes on the way in, so one bad message cannot poison storage', () => {
    const storage = fakeStorage({ hidden: ['pr'], widths: { age: 70 } });
    const svc = new ColumnPrefsService(storage);
    svc.set({ hidden: ['nope'], widths: { proj: 'wide' } });
    expect(svc.value).toEqual({ hidden: [], widths: {} });
    expect(storage.saved).toEqual({ hidden: [], widths: {} });
  });

  it('survives a storage value written by an older build', () => {
    const svc = new ColumnPrefsService(fakeStorage('garbage'));
    expect(svc.value).toEqual({ hidden: [], widths: {} });
  });

  it('fires once per real change and never for a no-op', () => {
    // Both dashboards echo the layout back on every snapshot; a service that
    // fired on an identical set would bounce updates between them forever.
    const svc = new ColumnPrefsService(fakeStorage());
    let fired = 0;
    svc.onDidChange(() => fired++);

    svc.set({ hidden: ['pr'], widths: {} });
    expect(fired).toBe(1);

    svc.set({ hidden: ['pr'], widths: {} });
    expect(fired).toBe(1);

    svc.set({ hidden: ['pr'], widths: { age: 70 } });
    expect(fired).toBe(2);
  });
});
