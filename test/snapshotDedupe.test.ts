/**
 * Redundant table snapshots (#191): an unchanged table is not sent again, a table nobody can see
 * is not sent at all, and a page coming back (or redrawing) is owed the current one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { SnapshotCoalescer, createBrowserConnections, snapshotFingerprint, type ClientSocket } from '../src/core/web/browserConnections';
import { RELAY_CONNECTION_LIMITS } from '../src/app/webWorkbench';
import { parseShellToHost } from '../src/shared/shellProtocol';
import { tableShownForClasses, tableShownOn } from '../src/shared/appRoutes';

const snap = (n: number, nowMs = 0, extra: object = {}) => ({ pane: 'dashboard', body: { type: 'snapshot', sessions: [{ key: 'a', n }], nowMs, ...extra } });

describe('snapshotFingerprint', () => {
  it('ignores the clock and nothing else', () => {
    expect(snapshotFingerprint(snap(1, 1))).toBe(snapshotFingerprint(snap(1, 999)));
    expect(snapshotFingerprint(snap(1))).not.toBe(snapshotFingerprint(snap(2)));
    expect(snapshotFingerprint(snap(1))).not.toBe(snapshotFingerprint(snap(1, 0, { usage: { x: 1 } })));
  });

  it('is undefined for what is not a body', () => {
    expect(snapshotFingerprint(undefined)).toBeUndefined();
    expect(snapshotFingerprint({ pane: 'dashboard' })).toBeUndefined();
  });
});

describe('SnapshotCoalescer dedupe', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function rig() {
    const sent: unknown[] = [];
    const c = new SnapshotCoalescer((e) => sent.push(e), { snapshotIntervalMs: 1000, hiddenSnapshotIntervalMs: 10_000 });
    return { c, sent };
  }

  it('sends the first, skips repeats that differ only by the clock, sends a real change', () => {
    const { c, sent } = rig();
    c.push(snap(1, 0));
    vi.advanceTimersByTime(1000);
    c.push(snap(1, 1000));
    vi.advanceTimersByTime(1000);
    c.push(snap(1, 2000));
    expect(sent).toHaveLength(1);
    expect(c.skipped).toBe(2);
    vi.advanceTimersByTime(1000);
    c.push(snap(2, 3000));
    expect(sent).toHaveLength(2);
  });

  it('sends again after invalidate, though nothing changed', () => {
    const { c, sent } = rig();
    c.push(snap(1));
    vi.advanceTimersByTime(1000);
    c.invalidate();
    c.push(snap(1, 1000));
    expect(sent).toHaveLength(2);
  });

  it('a hidden page coming back gets the latest changed table at once, and nothing when it is unchanged', () => {
    const { c, sent } = rig();
    c.push(snap(1));
    c.setHidden(true);
    vi.advanceTimersByTime(1000);
    c.push(snap(2, 1000));
    c.push(snap(3, 1100));
    expect(sent).toHaveLength(1);
    c.setHidden(false);
    expect(sent).toHaveLength(2);
    expect((sent[1] as ReturnType<typeof snap>).body.sessions[0].n).toBe(3);
    c.setHidden(true);
    vi.advanceTimersByTime(5000);
    c.push(snap(3, 6100));
    c.setHidden(false);
    expect(sent).toHaveLength(2);
  });
});

describe('visibility of the table pane', () => {
  it('parses the optional table flag', () => {
    expect(parseShellToHost({ type: 'visibility', hidden: false, table: false })).toEqual({ type: 'visibility', hidden: false, table: false });
    expect(parseShellToHost({ type: 'visibility', hidden: true })).toEqual({ type: 'visibility', hidden: true });
    expect(parseShellToHost({ type: 'visibility', hidden: true, table: 'no' })).toEqual({ type: 'visibility', hidden: true });
  });

  it('knows which surfaces show the table', () => {
    expect(['split', 'table', 'analytics'].every((s) => tableShownOn(s as never))).toBe(true);
    expect(tableShownOn('conversation')).toBe(false);
    expect(tableShownOn('page')).toBe(false);
    const classes = (...names: string[]) => ({ contains: (n: string) => names.includes(n) });
    expect(tableShownForClasses(classes('aw-surface-split'))).toBe(true);
    expect(tableShownForClasses(classes('aw-surface-conversation'))).toBe(false);
    expect(tableShownForClasses(classes('aw-surface-page'))).toBe(false);
    expect(tableShownForClasses(classes())).toBe(true);
  });
});

describe('through a relay-limited connection', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function wire() {
    const listeners: ((d: Buffer, bin: boolean) => void)[] = [];
    const out: { pane: string; body: { type: string } }[] = [];
    const ws = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (d: string) => void out.push(JSON.parse(d)),
      ping() {},
      close() {},
      terminate() {},
      on(event: string, l: unknown) {
        if (event === 'message') listeners.push(l as (d: Buffer, bin: boolean) => void);
        return this;
      },
    } as unknown as ClientSocket;
    let post: (m: unknown) => unknown = () => undefined;
    const conns = createBrowserConnections({
      clients: new ClientRegistry({ log: () => undefined }),
      log: () => undefined,
      build: () => 'b1',
      isMutating: () => false,
      limits: { ...RELAY_CONNECTION_LIMITS, pingIntervalMs: 0 },
      createPanes: (t) => {
        post = (m) => t.postMessage(m);
        return { dashboard: { dispose() {} }, conversation: { dispose() {} } as never };
      },
    });
    conns.attach(ws, ownerContext('browser', { deviceId: 'd', deviceScope: 'relay' }));
    const say = (m: unknown) => listeners.forEach((l) => l(Buffer.from(JSON.stringify(m)), false));
    const snapshots = () => out.filter((m) => m.pane === 'dashboard' && m.body.type === 'snapshot').length;
    return { post: (m: unknown) => post(m), say, snapshots };
  }

  it('sends nothing for an idle table, however many identical snapshots the host builds', async () => {
    const t = wire();
    await t.post(snap(1, 0));
    for (let i = 1; i <= 60; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await t.post(snap(1, i * 5_000));
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.snapshots()).toBe(1);
  });

  it('holds snapshots while the table pane is off screen and restores the current one on return', async () => {
    const t = wire();
    await t.post(snap(1));
    t.say({ pane: 'shell', body: { type: 'visibility', hidden: false, table: false } });
    for (let i = 1; i <= 20; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await t.post(snap(i + 1, i * 5_000));
    }
    expect(t.snapshots()).toBe(1);
    t.say({ pane: 'shell', body: { type: 'visibility', hidden: false, table: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.snapshots()).toBe(2);
  });

  it('a pane that says ready is sent the table again even if it is unchanged', async () => {
    const t = wire();
    await t.post(snap(1));
    await vi.advanceTimersByTimeAsync(6_000);
    await t.post(snap(1, 6_000));
    expect(t.snapshots()).toBe(1);
    t.say({ pane: 'dashboard', commandId: 'cmd-1', body: { type: 'ready' } });
    await vi.advanceTimersByTimeAsync(6_000);
    await t.post(snap(1, 12_000));
    expect(t.snapshots()).toBe(2);
  });
});
