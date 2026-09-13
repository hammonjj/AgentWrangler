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
    const svc = new ColumnPrefsService(fakeStorage({ hidden: ['pr'], widths: { proj: 210 }, v: 1 }));
    expect(svc.value).toEqual({ hidden: ['pr'], widths: { proj: 210 }, v: 1 });
  });

  it('persists what the dashboard sends', () => {
    const storage = fakeStorage();
    const svc = new ColumnPrefsService(storage);
    svc.set({ hidden: ['branch'], widths: { age: 64 } });
    expect(storage.saved).toEqual({ hidden: ['branch'], widths: { age: 64 }, v: 1 });
    expect(svc.value).toEqual({ hidden: ['branch'], widths: { age: 64 }, v: 1 });
  });

  it('sanitizes on the way in, so one bad message cannot poison storage', () => {
    const storage = fakeStorage({ hidden: ['pr'], widths: { age: 70 }, v: 1 });
    const svc = new ColumnPrefsService(storage);
    svc.set({ hidden: ['nope'], widths: { proj: 'wide' } });
    expect(svc.value).toEqual({ hidden: [], widths: {}, v: 1 });
    expect(storage.saved).toEqual({ hidden: [], widths: {}, v: 1 });
  });

  it('survives a storage value written by an older build', () => {
    const svc = new ColumnPrefsService(fakeStorage('garbage'));
    expect(svc.value).toEqual({ hidden: [], widths: {}, v: 1 });
  });

  it('drops widths saved before they were ever applied, and keeps hidden columns', () => {
    // What the CSP bug left behind: a Branch column six hundred pixels wide,
    // because every drag measured the equal split the table had fallen back to.
    const storage = fakeStorage({ hidden: ['pr', 'age'], widths: { branch: 634, model: 581 } });
    const svc = new ColumnPrefsService(storage);

    expect(svc.value).toEqual({ hidden: ['pr', 'age'], widths: {}, v: 1 });
    // Written back, so a second window does not repeat the drop against widths
    // this one has since saved.
    expect(storage.saved).toEqual({ hidden: ['pr', 'age'], widths: {}, v: 1 });
  });

  it('leaves widths alone once they carry the current version', () => {
    const svc = new ColumnPrefsService(fakeStorage({ hidden: [], widths: { branch: 200 }, v: 1 }));
    expect(svc.value.widths).toEqual({ branch: 200 });
  });

  it('does not re-arm the migration when the webview sends a layout without a version', () => {
    // The round trip drops `v` and the next startup would wipe the drag that
    // was just saved, which is the original bug wearing a different hat.
    const storage = fakeStorage();
    new ColumnPrefsService(storage).set({ hidden: [], widths: { branch: 200 } });
    expect(new ColumnPrefsService(storage).value.widths).toEqual({ branch: 200 });
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
