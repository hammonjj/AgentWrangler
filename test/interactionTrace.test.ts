/**
 * Row-click tracing (#190): the correlation id survives the trip, the stages add up, and nothing
 * but ids and numbers is ever logged.
 */
import { describe, expect, it } from 'vitest';
import { ownerContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { createBrowserConnections, type ClientSocket } from '../src/core/web/browserConnections';
import { InteractionTracer, formatEntry, formatSummary } from '../src/core/web/interactionTrace';
import { RelaySocket, type TracedItem } from '../src/remote/relay/virtualSocket';
import { ClickTrace } from '../src/webview/common/clickTrace';
import { parseShellToHost } from '../src/shared/shellProtocol';
import { newTraceId, parseTraceId, parseTraceReport, percentile } from '../src/shared/trace';
import type { RelayItem } from '../src/shared/relay';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('trace ids and reports', () => {
  it('mints ids it accepts, and refuses anything else', () => {
    expect(parseTraceId(newTraceId())).toBeDefined();
    for (const bad of [undefined, 3, '', 'a b c d e f', 'x'.repeat(40), '../../etc']) expect(parseTraceId(bad)).toBeUndefined();
  });

  it('accepts a complete report and rejects bad numbers', () => {
    const ok = { type: 'trace', cid: 'abcdef1234', recvMs: 120.4, firstMs: 150, interactiveMs: 160, reconnects: 2 };
    expect(parseTraceReport(ok)).toEqual({ cid: 'abcdef1234', recvMs: 120, firstMs: 150, interactiveMs: 160, reconnects: 2 });
    expect(parseShellToHost(ok)).toMatchObject({ type: 'trace', cid: 'abcdef1234' });
    expect(parseTraceReport({ ...ok, recvMs: -1 })).toBeUndefined();
    expect(parseTraceReport({ ...ok, firstMs: Number.NaN })).toBeUndefined();
    expect(parseTraceReport({ ...ok, cid: 'bad id' })).toBeUndefined();
  });

  it('takes percentiles by nearest rank', () => {
    expect(percentile([], 0.5)).toBeUndefined();
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
  });
});

describe('ClickTrace (the page)', () => {
  function page() {
    let t = 1000;
    const reports: unknown[] = [];
    const queued: (() => void)[] = [];
    const trace = new ClickTrace({
      now: () => t,
      afterPaint: (run) => queued.push(run),
      afterIdle: (run) => queued.push(run),
      report: (r) => reports.push(r),
      reconnects: () => 1,
    });
    return {
      trace,
      reports,
      advance: (ms: number) => void (t += ms),
      drain: () => {
        while (queued.length) queued.shift()!();
      },
    };
  }
  const click = { pane: 'dashboard', commandId: 'c1', body: { type: 'rowClick', key: 'k' } };

  it('stamps only a row click, and reports click-to-recv, first and interactive', () => {
    const p = page();
    expect(p.trace.stamp({ pane: 'dashboard', body: { type: 'ready' } })).not.toHaveProperty('cid');
    const stamped = p.trace.stamp(click) as typeof click & { cid: string };
    expect(parseTraceId(stamped.cid)).toBeDefined();
    p.advance(400);
    p.trace.received({ pane: 'conversation', cid: stamped.cid, body: { type: 'init' } });
    p.advance(30);
    p.drain();
    expect(p.reports).toEqual([{ cid: stamped.cid, recvMs: 400, firstMs: 430, interactiveMs: 430, reconnects: 1 }]);
  });

  it('ignores an init for another click, other messages, and a dropped connection', () => {
    const p = page();
    const a = p.trace.stamp(click) as typeof click & { cid: string };
    p.trace.received({ pane: 'conversation', cid: 'someoneelse1', body: { type: 'init' } });
    p.trace.received({ pane: 'conversation', cid: a.cid, body: { type: 'append' } });
    p.drain();
    expect(p.reports).toEqual([]);
    p.trace.reset();
    p.trace.received({ pane: 'conversation', cid: a.cid, body: { type: 'init' } });
    p.drain();
    expect(p.reports).toEqual([]);
  });

  it('follows only the latest click', () => {
    const p = page();
    const a = p.trace.stamp(click) as typeof click & { cid: string };
    const b = p.trace.stamp(click) as typeof click & { cid: string };
    p.trace.received({ pane: 'conversation', cid: a.cid, body: { type: 'init' } });
    p.drain();
    expect(p.reports).toEqual([]);
    p.trace.received({ pane: 'conversation', cid: b.cid, body: { type: 'init' } });
    p.drain();
    expect(p.reports).toHaveLength(1);
  });
});

describe('InteractionTracer (the daemon)', () => {
  function make() {
    let t = 0;
    const lines: string[] = [];
    const tracer = new InteractionTracer({ log: (l) => lines.push(l), now: () => t, capacity: 3, summaryEvery: 2 });
    return { tracer, lines, at: (ms: number) => void (t = ms) };
  }
  const report = (cid: string, extra = {}) => ({ cid, recvMs: 500, firstMs: 540, interactiveMs: 560, reconnects: 0, ...extra });

  it('joins daemon stages, relay stats and the browser report, with a residual', () => {
    const { tracer, lines, at } = make();
    at(0);
    tracer.begin('c1', 'cid0000001', 'relay');
    expect(tracer.awaiting('c1')).toBe('cid0000001');
    at(20);
    tracer.navigated('c1');
    at(120);
    tracer.initQueued('c1');
    expect(tracer.awaiting('c1')).toBeUndefined();
    tracer.relayBatch('cid0000001', { items: 3, queueDepth: 2, behindBatch: true, queuedMs: 250, sealMs: 30, sendMs: 80, parts: 2, bytes: 200_000, retries: 0 });
    const entry = tracer.complete('c1', report('cid0000001'))!;
    expect(entry).toMatchObject({ transport: 'relay', smartOpenMs: 20, initMs: 100, recvMs: 500, renderMs: 40, residualMs: 500 - 20 - 100 - 250 - 30 - 80 });
    expect(lines[0]).toContain('cid0000001 relay click→recv 500 ms');
    expect(lines[0]).toContain('2 parts');
  });

  it('accepts relay stats that land after the report', () => {
    const { tracer } = make();
    tracer.begin('c1', 'cid0000002', 'relay');
    tracer.navigated('c1');
    tracer.initQueued('c1');
    const entry = tracer.complete('c1', report('cid0000002'))!;
    expect(entry.relay).toBeUndefined();
    tracer.relayBatch('cid0000002', { items: 1, queueDepth: 0, behindBatch: false, queuedMs: 5, sealMs: 5, sendMs: 5, parts: 1, bytes: 10, retries: 0 });
    expect(tracer.recent()[0].relay?.parts).toBe(1);
  });

  it('refuses a report from another connection or for an unknown click', () => {
    const { tracer } = make();
    tracer.begin('c1', 'cid0000003', 'lan');
    expect(tracer.complete('c2', report('cid0000003'))).toBeUndefined();
    expect(tracer.complete('c1', report('cid9999999'))).toBeUndefined();
    tracer.end('c1');
    expect(tracer.complete('c1', report('cid0000003'))).toBeUndefined();
  });

  it('keeps a bounded ring, summarises p50/p95 per transport, and logs a summary every N', () => {
    const { tracer, lines } = make();
    for (let i = 0; i < 4; i++) {
      tracer.begin('c1', `cid000000${i}`, i % 2 ? 'relay' : 'lan');
      tracer.complete('c1', report(`cid000000${i}`, { recvMs: 100 * (i + 1) }));
    }
    expect(tracer.recent()).toHaveLength(3);
    const s = tracer.summary();
    expect(s.lan?.count).toBe(1);
    expect(s.relay?.count).toBe(2);
    expect(lines.filter((l) => l.includes('summary'))).toHaveLength(2);
    expect(formatSummary(s)).toContain('relay n=2');
  });

  it('bounds pending clicks', () => {
    const { tracer } = make();
    for (let i = 0; i < 500; i++) tracer.begin(`c${i}`, `cid${String(i).padStart(7, '0')}`, 'lan');
    expect(tracer.awaiting('c0')).toBeUndefined();
    expect(tracer.awaiting('c499')).toBeDefined();
  });
});

describe('through browserConnections', () => {
  function socketOf(traced: { cid: string }[]): ClientSocket & { out: string[]; emit(line: string): void } {
    const listeners: ((d: Buffer, bin: boolean) => void)[] = [];
    const out: string[] = [];
    return {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      out,
      send: (d: string) => void out.push(d),
      sendTraced: (d: string, cid: string) => {
        traced.push({ cid });
        out.push(d);
      },
      ping() {},
      close() {},
      terminate() {},
      on(event: string, l: unknown) {
        if (event === 'message') listeners.push(l as (d: Buffer, bin: boolean) => void);
        return this;
      },
      emit: (line: string) => listeners.forEach((l) => l(Buffer.from(line), false)),
    } as never;
  }

  function wire(scope: 'relay' | 'loopback') {
    const lines: string[] = [];
    const tracer = new InteractionTracer({ log: (l) => lines.push(l), summaryEvery: 0 });
    let post: (msg: unknown) => unknown = () => undefined;
    const conns = createBrowserConnections({
      clients: new ClientRegistry({ log: () => undefined }),
      log: () => undefined,
      build: () => 'b1',
      isMutating: () => false,
      tracer,
      limits: { pingIntervalMs: 0 },
      createPanes: (transport) => {
        post = (m) => transport.postMessage(m);
        return { dashboard: { dispose() {} }, conversation: { dispose() {} } as never };
      },
    });
    const traced: { cid: string }[] = [];
    const ws = socketOf(traced);
    conns.attach(ws, ownerContext('browser', { deviceId: 'dev1', deviceScope: scope }));
    return { ws, post: (m: unknown) => post(m), tracer, lines, traced };
  }

  for (const scope of ['relay', 'loopback'] as const) {
    it(`follows a click on a ${scope} tab: rowClick, navigate, init echoing its id, then the report`, async () => {
      const t = wire(scope);
      t.ws.emit(JSON.stringify({ pane: 'dashboard', commandId: 'cmd-1', cid: 'cid0000010', body: { type: 'rowClick', key: 'k' } }));
      await t.post({ pane: 'shell', body: { type: 'navigate', target: 'conversation', key: 'k' } });
      await t.post({ pane: 'conversation', body: { type: 'init', blocks: [{ text: 'SECRET transcript text' }] } });
      const init = t.ws.out.map((l) => JSON.parse(l)).find((m) => m.body?.type === 'init');
      expect(init.cid).toBe('cid0000010');
      expect(t.traced.map((x) => x.cid)).toEqual(['cid0000010']);
      t.ws.emit(JSON.stringify({ pane: 'shell', body: { type: 'trace', cid: 'cid0000010', recvMs: 300, firstMs: 330, interactiveMs: 340, reconnects: 0 } }));
      expect(t.tracer.recent()[0]).toMatchObject({ cid: 'cid0000010', transport: scope === 'relay' ? 'relay' : 'lan' });
      expect(t.lines.join('\n')).toContain('cid0000010');
      expect(t.lines.join('\n')).not.toContain('SECRET');
    });
  }

  it('leaves an init alone when no click is waiting, and ignores a malformed id', async () => {
    const t = wire('relay');
    t.ws.emit(JSON.stringify({ pane: 'dashboard', commandId: 'cmd-1', cid: 'bad id!', body: { type: 'rowClick', key: 'k' } }));
    await t.post({ pane: 'conversation', body: { type: 'init' } });
    const init = t.ws.out.map((l) => JSON.parse(l)).find((m) => m.body?.type === 'init');
    expect(init).not.toHaveProperty('cid');
    expect(t.traced).toEqual([]);
  });
});

describe('RelaySocket traced batches', () => {
  it('reports how long a traced item queued, what was ahead of it and whether a batch was in flight', async () => {
    const seen: { items: RelayItem[]; traced: TracedItem[] }[] = [];
    let release: () => void = () => undefined;
    const socket = new RelaySocket({
      batchMs: 1,
      send: (items, traced) => {
        seen.push({ items, traced });
        return new Promise<void>((r) => (release = r));
      },
      onEnd: () => undefined,
    });
    socket.send('first');
    await tick(10);
    socket.send('ahead');
    socket.sendTraced('mine', 'cid0000020');
    release();
    await tick(10);
    release();
    expect(seen[0].traced).toEqual([]);
    expect(seen[1].items).toHaveLength(2);
    expect(seen[1].traced[0]).toMatchObject({ cid: 'cid0000020', queueDepth: 1, behindBatch: true });
    expect(seen[1].traced[0].queuedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('formatEntry', () => {
  it('is ids, stage names and numbers only', () => {
    const line = formatEntry({ cid: 'cid0000030', transport: 'lan', recvMs: 1, firstMs: 2, interactiveMs: 3, reconnects: 0, renderMs: 1, smartOpenMs: 1, initMs: 1, residualMs: 0 });
    expect(line).toMatch(/^[\w\s→,().+/-]+$/);
  });
});
