/**
 * A long envelope from a tab goes in parts (`shared/wireParts.ts`): a `send` with a few pasted
 * images used to be over the socket's message limit, close it with 1009, and be resent on the
 * next socket for ever.
 */
import { describe, expect, it } from 'vitest';
import { ownerContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { createBrowserConnections, type ClientSocket } from '../src/core/web/browserConnections';
import { parseShellToHost } from '../src/shared/shellProtocol';
import {
  MAX_ASSEMBLED_CHARS,
  MAX_SOCKET_MESSAGE_BYTES,
  PartAssembler,
  WIRE_PART_CHARS,
  envelopeLabel,
  oversizedResends,
  parseWirePart,
  splitLine,
  type WirePart,
} from '../src/shared/wireParts';

const bodyOf = (line: string): WirePart => parseWirePart((JSON.parse(line) as { body: unknown }).body)!;

function join(lines: string[], assembler = new PartAssembler()) {
  let last: ReturnType<PartAssembler['add']> = { kind: 'pending' };
  for (const l of lines) last = assembler.add(bodyOf(l));
  return last;
}

describe('splitLine', () => {
  it('leaves a short line alone', () => {
    expect(splitLine('{"pane":"x"}', 'c1', 'x.y')).toEqual(['{"pane":"x"}']);
  });

  it('splits a long line into parts that join back to it', () => {
    const line = JSON.stringify({ pane: 'conversation', body: { type: 'send', text: 'a'.repeat(95) } });
    const parts = splitLine(line, 'c1', 'conversation.send', 10);
    expect(parts.length).toBe(Math.ceil(line.length / 10));
    expect(parts.every((p) => (JSON.parse(p) as { pane: string }).pane === 'shell')).toBe(true);
    expect(join(parts)).toEqual({ kind: 'done', line, label: 'conversation.send', count: parts.length });
  });

  it('survives a cut through a surrogate pair', () => {
    const line = JSON.stringify({ t: '\u{1F600}'.repeat(7) });
    const r = join(splitLine(line, 'c1', 'x.y', 3));
    expect(r.kind === 'done' && r.line).toBe(line);
  });

  it('keeps every part under the socket limit, even for text that escapes badly', () => {
    expect(JSON.stringify('\u0001'.repeat(WIRE_PART_CHARS)).length).toBeLessThan(MAX_SOCKET_MESSAGE_BYTES);
    expect(MAX_ASSEMBLED_CHARS).toBeGreaterThan(MAX_SOCKET_MESSAGE_BYTES);
  });
});

describe('PartAssembler', () => {
  const parts = (id: string, line: string) => splitLine(line, id, 'conversation.send', 4).map(bodyOf);

  it('refuses an envelope that says it is over the limit, at its first part', () => {
    const a = new PartAssembler(10);
    expect(a.add(parts('c1', 'x'.repeat(20))[0])).toEqual({ kind: 'refused', label: 'conversation.send', chars: 20, reason: 'over the 0.0 MB limit' });
    expect(a.pendingChars).toBe(0);
  });

  it('drops what it was joining on a part out of order, and a new part 0 starts over', () => {
    const a = new PartAssembler();
    const p = parts('c1', 'abcdefghijkl');
    expect(a.add(p[0])).toEqual({ kind: 'pending' });
    expect(a.add(p[2]).kind).toBe('refused');
    expect(a.add(p[1]).kind).toBe('refused');
    // The tab sends it all again after a drop.
    const q = parts('c1', 'abcdefghijkl');
    a.add(q[0]);
    a.add(parts('c2', 'zzzzzzzz')[0]);
    expect(a.add(q[1]).kind).toBe('refused');
  });

  it('refuses parts that do not add up to what they said', () => {
    const p = parts('c1', 'abcdefgh');
    const a = new PartAssembler();
    a.add(p[0]);
    expect(a.add({ ...p[1], data: 'abcdefgh' })).toMatchObject({ kind: 'refused', reason: 'longer than it said' });
    const b = new PartAssembler();
    b.add(p[0]);
    expect(b.add({ ...p[1], data: 'a' })).toMatchObject({ kind: 'refused', reason: 'shorter than it said' });
  });
});

describe('parsing', () => {
  it('checks a part', () => {
    const ok = { type: 'part', id: 'c1', index: 0, count: 2, chars: 10, label: 'a.b', data: 'xxxxx' };
    expect(parseWirePart(ok)).toEqual(ok);
    expect(parseWirePart({ ...ok, index: 2 })).toBeUndefined();
    expect(parseWirePart({ ...ok, count: 0 })).toBeUndefined();
    expect(parseWirePart({ ...ok, id: '' })).toBeUndefined();
    expect(parseWirePart({ ...ok, data: 1 })).toBeUndefined();
    expect(parseWirePart({ ...ok, label: 'a b\n' })?.label).toBe('a?b?');
    expect(parseWirePart({ type: 'hello' })).toBeUndefined();
  });

  it('names an envelope by pane and type only', () => {
    expect(envelopeLabel({ pane: 'conversation', body: { type: 'send', text: 'secret' } })).toBe('conversation.send');
    expect(envelopeLabel({ pane: 'a b', body: {} })).toBe('a?b.?');
    expect(envelopeLabel(null)).toBe('?.?');
  });

  it('parses the shell oversized report', () => {
    expect(parseShellToHost({ type: 'oversized', label: 'conversation.send', chars: 5 })).toEqual({ type: 'oversized', label: 'conversation.send', chars: 5 });
    expect(parseShellToHost({ type: 'oversized', label: 'x', chars: -1 })).toBeUndefined();
  });

  it('picks the long unacknowledged envelopes', () => {
    const unacked = new Map([
      ['a', { line: 'x'.repeat(5) }],
      ['b', { line: 'x'.repeat(50) }],
    ]);
    expect(oversizedResends(unacked, 10)).toEqual(['b']);
  });
});

describe('a connection given parts', () => {
  function wire() {
    const listeners: ((d: Buffer, bin: boolean) => void)[] = [];
    const errors: ((e?: unknown) => void)[] = [];
    const out: { pane: string; body: { type: string; ids?: string[] } }[] = [];
    const logs: string[] = [];
    const received: unknown[] = [];
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
        if (event === 'error') errors.push(l as (e?: unknown) => void);
        return this;
      },
    } as unknown as ClientSocket;
    const conns = createBrowserConnections({
      clients: new ClientRegistry({ log: () => undefined }),
      log: (l) => logs.push(l),
      build: () => 'b1',
      isMutating: () => false,
      limits: { pingIntervalMs: 0 },
      createPanes: (t) => {
        t.onDidReceiveMessage((m) => received.push(m));
        return { dashboard: { dispose() {} }, conversation: { dispose() {} } as never };
      },
    });
    conns.attach(ws, ownerContext('browser', { deviceId: 'd', deviceScope: 'lan' }));
    const sayLine = (l: string) => listeners.forEach((f) => f(Buffer.from(l), false));
    return { sayLine, out, logs, received, errors, conns };
  }

  it('hands the panes the joined envelope, acknowledges it, and logs what it was and how big', async () => {
    const t = wire();
    const envelope = { pane: 'conversation', commandId: 'cmd-9', body: { type: 'send', text: 'y'.repeat(3000) } };
    const line = JSON.stringify(envelope);
    const parts = splitLine(line, 'cmd-9', envelopeLabel(envelope), 1000);
    expect(parts.length).toBe(4);
    for (const p of parts) t.sayLine(p);
    expect(t.received).toEqual([envelope]);
    await new Promise((r) => setImmediate(r));
    expect(t.out.some((m) => m.body.type === 'ack' && m.body.ids?.includes('cmd-9'))).toBe(true);
    expect(t.logs.some((l) => l.includes('conversation.send') && l.includes('in 4 parts'))).toBe(true);
    expect(t.logs.join('\n')).not.toContain('yyyy');
    expect(t.conns.size).toBe(1);
  });

  it('logs a refused envelope by name and size and stays open', () => {
    const t = wire();
    const envelope = { pane: 'conversation', commandId: 'c', body: { type: 'send', text: 'z'.repeat(50) } };
    const parts = splitLine(JSON.stringify(envelope), 'c', 'conversation.send', 10);
    t.sayLine(parts[0]);
    t.sayLine(parts[2]);
    expect(t.received).toEqual([]);
    expect(t.logs.some((l) => l.includes('conversation.send') && l.includes('out of order'))).toBe(true);
    expect(t.conns.size).toBe(1);
  });

  it('says when ws refused a message for its size', () => {
    const t = wire();
    t.errors.forEach((f) => f(Object.assign(new RangeError('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' })));
    expect(t.logs.some((l) => l.includes('over the 16.0 MB socket limit'))).toBe(true);
    expect(t.conns.size).toBe(0);
  });

  it('logs a tab that kept back an envelope over the whole limit', () => {
    const t = wire();
    t.sayLine(JSON.stringify({ pane: 'shell', body: { type: 'oversized', label: 'conversation.send', chars: 70 * 1024 * 1024 } }));
    expect(t.logs.some((l) => l.includes('did not send a conversation.send of 70.0 MB'))).toBe(true);
  });
});
