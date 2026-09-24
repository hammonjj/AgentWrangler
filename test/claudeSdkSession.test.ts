import { describe, expect, it } from 'vitest';
import { ClaudeSdkSession, END_TIMINGS, type QueryFn } from '../src/claude/runner/claudeSdkSession';
import { ResyncNeeded, SeqLog } from '../src/core/session/seqLog';
import { emptyHostState, reduceHostSnapshot, type HostEvent } from '../src/shared/sessionProtocol';

/**
 * The execution layer's contract: the session host protocol
 * (`src/shared/sessionProtocol.ts`), exercised in-process with a fake SDK
 * `query`. No process is spawned.
 */

interface FakeOpts {
  /** The interrupted turn reports its end, as a real CLI does. */
  interruptEndsTurn?: boolean;
  /** Closing stdin ends the stream, as an idle CLI does. */
  exitsOnEof?: boolean;
  /** `close()` ends the stream (the SDK terminating the child). */
  closeEndsStream?: boolean;
  /** The interrupt control call never settles, as with a SIGSTOPped CLI. */
  interruptHangs?: boolean;
}

function fakeQuery(fo: FakeOpts = {}) {
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let error: unknown;
  const kick = () => {
    wake?.();
    wake = undefined;
  };
  const emit = (msg: unknown) => {
    pending.push(msg);
    kick();
  };
  const finish = () => {
    done = true;
    kick();
  };
  const fail = (err: unknown) => {
    error = err;
    kick();
  };
  const stream = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift();
        continue;
      }
      if (error) throw error;
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  })();
  const calls = { interrupt: 0, close: 0, sent: [] as unknown[], options: undefined as any, eof: false };
  const query: QueryFn = ({ prompt, options }) => {
    calls.options = options;
    void (async () => {
      for await (const m of prompt) calls.sent.push(m);
      calls.eof = true;
      if (fo.exitsOnEof) finish();
    })();
    return Object.assign(stream, {
      interrupt: () => {
        calls.interrupt++;
        if (fo.interruptHangs) return new Promise<void>(() => undefined);
        if (fo.interruptEndsTurn) emit({ type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0 });
        return Promise.resolve();
      },
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      close: () => {
        calls.close++;
        if (fo.closeEndsStream) fail(new Error('aborted'));
      },
    }) as never;
  };
  return { query, emit, finish, fail, calls };
}

/** Timers that run only when told to, so the end sequence is testable without waiting. */
function manualTimers() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    /** Move the clock on, firing whatever falls due. */
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function make(fo: FakeOpts = {}, extra: { ringBytes?: number; timers?: ReturnType<typeof manualTimers> } = {}) {
  const fake = fakeQuery(fo);
  const session = new ClaudeSdkSession(
    { cwd: '/Users/test/proj' },
    {
      query: fake.query,
      binary: '/fake/claude',
      log: () => undefined,
      ringBytes: extra.ringBytes,
      setTimeout: extra.timers?.setTimeout,
      clearTimeout: extra.timers?.clearTimeout,
    },
  );
  const events: HostEvent[] = [];
  session.subscribe(0, (e) => events.push(e));
  session.start();
  return { session, fake, events };
}

function askOptions(over: Record<string, unknown> = {}) {
  return { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'req_1', ...over } as never;
}

describe('ClaudeSdkSession: the host protocol, in-process', () => {
  it('numbers every event, strictly increasing from 1, with no gaps', async () => {
    const { session, fake, events } = make();
    fake.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    session.send({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, uuid: 'u1' } as never);
    fake.emit({ type: 'result', subtype: 'success', is_error: false });
    await settle();
    expect(events.length).toBeGreaterThan(3);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it('keeps its snapshot equal to the replay of its events', async () => {
    const { session, fake } = make();
    fake.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void fake.calls.options.canUseTool('Bash', { command: 'ls' }, askOptions());
    void fake.calls.options.canUseTool('Bash', { command: 'pwd' }, askOptions({ requestId: 'req_2', toolUseID: 'toolu_2' }));
    await settle();
    session.respondAsk('req_1', { behavior: 'allow' });
    await settle();

    const replay: HostEvent[] = [];
    session.subscribe(0, (e) => replay.push(e)).dispose();
    const rebuilt = replay.reduce(reduceHostSnapshot, emptyHostState());
    const { epoch, ring, ...replayable } = session.snapshot();
    expect(rebuilt).toEqual(replayable);
    expect(epoch).toMatch(/[0-9a-f-]{36}/);
    expect(ring).toEqual({ fromSeq: 0, truncated: false });
    expect(session.snapshot()).toMatchObject({ state: 'running', sessionId: 's1' });
    expect(session.snapshot().pendingAsks.map((a) => a.requestId)).toEqual(['req_2']);
  });

  it('reports a raw ask, and settles it exactly once', async () => {
    const { session, fake, events } = make();
    const decision = fake.calls.options.canUseTool('Bash', { command: 'ls' }, askOptions({ suggestions: [{ type: 'addRules' }] }));
    await settle();
    expect(events.find((e) => e.type === 'ask')).toMatchObject({
      ask: { requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1', suggestions: [{ type: 'addRules' }] },
    });

    expect(session.respondAsk('req_1', { behavior: 'allow', updatedInput: { command: 'ls' } })).toBe('applied');
    expect(session.respondAsk('req_1', { behavior: 'deny', message: 'no' })).toBe('stale');
    expect(session.respondAsk('never', { behavior: 'deny', message: 'no' })).toBe('gone');
    await expect(decision).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(events.filter((e) => e.type === 'askSettled')).toEqual([
      expect.objectContaining({ requestId: 'req_1', reason: 'responded', outcome: 'allowed' }),
    ]);
  });

  it('settles an aborted ask, and a late answer to it is stale', async () => {
    const { session, fake, events } = make();
    const ctrl = new AbortController();
    const decision = fake.calls.options.canUseTool('Bash', { command: 'sleep 9' }, askOptions({ signal: ctrl.signal }));
    await settle();
    ctrl.abort();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    expect(events.at(-1)).toMatchObject({ type: 'askSettled', reason: 'aborted' });
    expect(session.respondAsk('req_1', { behavior: 'allow' })).toBe('stale');
  });

  it('settles an ask the permission hook answered, when its tool_result arrives', async () => {
    const { fake, events, session } = make();
    void fake.calls.options.canUseTool('Bash', { command: 'rm x' }, askOptions({ toolUseID: 'toolu_7' }));
    await settle();
    fake.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_7', is_error: true, content: 'denied' }] },
    });
    await settle();
    // An error result may be a refusal or an allowed tool that failed: no outcome is claimed.
    const settled = events.find((e) => e.type === 'askSettled') as { reason: string; outcome?: string };
    expect(settled.reason).toBe('answeredElsewhere');
    expect(settled.outcome).toBeUndefined();
    expect(session.snapshot().pendingAsks).toEqual([]);
  });

  it('leaves an open ask alone when a turn ends; it may belong to a background task or the next turn', async () => {
    const { session, fake } = make();
    let resolved = false;
    void fake.calls.options.canUseTool('Bash', { command: 'ls' }, askOptions()).then(() => (resolved = true));
    await settle();
    fake.emit({ type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0 });
    await settle();
    expect(resolved).toBe(false);
    expect(session.snapshot().pendingAsks.map((a) => a.requestId)).toEqual(['req_1']);
  });

  it('stays running when a result says a turn is queued', async () => {
    const { session, fake } = make();
    session.send({ type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u1' } as never);
    session.send({ type: 'user', message: { role: 'user', content: 'b' }, uuid: 'u2' } as never);
    fake.emit({ type: 'result', subtype: 'success', is_error: false, queued_turn_count: 1 });
    await settle();
    expect(session.state).toBe('running');
    fake.emit({ type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0 });
    await settle();
    expect(session.state).toBe('idle');
  });

  it('reports nothing after its exit', async () => {
    const { fake, events } = make();
    fake.finish();
    await settle();
    const exitAt = events.findIndex((e) => e.type === 'exit');
    expect(exitAt).toBeGreaterThan(-1);
    expect(events.slice(exitAt + 1)).toEqual([]);
  });

  it('asks a client whose seq is ahead of this stream (a restarted host) to resync', () => {
    const { session } = make();
    expect(() => session.subscribe(session.snapshot().seq + 100, () => undefined)).toThrow(ResyncNeeded);
  });

  it('is idempotent on the message uuid', () => {
    const { session, fake } = make();
    const msg = { type: 'user', message: { role: 'user', content: 'once' }, parent_tool_use_id: null, uuid: 'same' } as never;
    expect(session.send(msg)).toEqual({ accepted: true, duplicate: false });
    expect(session.send(msg)).toEqual({ accepted: false, duplicate: true });
    return settle().then(() => expect(fake.calls.sent).toHaveLength(1));
  });

  it('refuses sends once ending', async () => {
    const timers = manualTimers();
    const { session } = make({}, { timers });
    void session.end();
    expect(session.send({ type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u' } as never)).toEqual({
      accepted: false,
      duplicate: false,
    });
  });

  it('learns and reports its session id', async () => {
    const { session, fake, events } = make();
    fake.emit({ type: 'system', subtype: 'init', session_id: 'abc' });
    await settle();
    expect(session.sessionId).toBe('abc');
    expect(events.find((e) => e.type === 'sessionId')).toMatchObject({ sessionId: 'abc' });
    expect(session.state).toBe('idle');
  });

  it('passes a fresh session id to the SDK, but never alongside resume', () => {
    const fresh = fakeQuery();
    new ClaudeSdkSession({ cwd: '/Users/test/p', sessionId: 'new-id' }, { query: fresh.query, binary: '/b', log: () => undefined }).start();
    expect(fresh.calls.options).toMatchObject({ sessionId: 'new-id', resume: undefined });

    const resumed = fakeQuery();
    new ClaudeSdkSession(
      { cwd: '/Users/test/p', sessionId: 'ignored', resume: 'old-id' },
      { query: resumed.query, binary: '/b', log: () => undefined },
    ).start();
    expect(resumed.calls.options).toMatchObject({ resume: 'old-id', sessionId: undefined });
  });

  it('reports a failed start as an exit with an error', () => {
    const session = new ClaudeSdkSession(
      { cwd: '/Users/test/p' },
      {
        query: () => {
          throw new Error('no binary');
        },
        binary: '/b',
        log: () => undefined,
      },
    );
    session.start();
    expect(session.snapshot()).toMatchObject({ state: 'exited', exit: { error: expect.stringContaining('no binary') } });
  });

  it('replays from any seq it still holds, and asks for a resync once it has evicted past it', async () => {
    const { session, fake } = make({}, { ringBytes: 400 });
    for (let i = 0; i < 20; i++) fake.emit({ type: 'stream_event', event: { delta: `chunk ${i} `.repeat(3) } });
    await settle();
    const tail: HostEvent[] = [];
    const seq = session.snapshot().seq;
    session.subscribe(seq - 1, (e) => tail.push(e)).dispose();
    expect(tail.map((e) => e.seq)).toEqual([seq]);
    expect(() => session.subscribe(0, () => undefined)).toThrow(ResyncNeeded);
  });

  describe('end (playbook §7.1)', () => {
    it('interrupts a running turn first, waits for its result, then closes stdin', async () => {
      const { session, fake } = make({ interruptEndsTurn: true, exitsOnEof: true });
      session.send({ type: 'user', message: { role: 'user', content: 'go' }, uuid: 'u1' } as never);
      await settle();
      await session.end();
      expect(fake.calls.interrupt).toBe(1);
      expect(fake.calls.eof).toBe(true);
      expect(fake.calls.close).toBe(0);
      expect(session.snapshot()).toMatchObject({ state: 'exited', exit: {} });
    });

    it('does not interrupt an idle session; stdin EOF is enough', async () => {
      const { session, fake } = make({ exitsOnEof: true });
      fake.emit({ type: 'system', subtype: 'init', session_id: 's' });
      await settle();
      await session.end();
      expect(fake.calls.interrupt).toBe(0);
      expect(fake.calls.close).toBe(0);
    });

    it('escalates to close() when the CLI does not exit on EOF, and treats that as a clean end', async () => {
      const timers = manualTimers();
      const { session, fake, events } = make({ closeEndsStream: true }, { timers });
      fake.emit({ type: 'system', subtype: 'init', session_id: 's' });
      await settle();
      const ended = session.end();
      await settle();
      expect(fake.calls.close).toBe(0);
      timers.advance(END_TIMINGS.eofWaitMs);
      await settle();
      expect(fake.calls.close).toBe(1);
      await ended;
      // Stopped on purpose: the close() it took to get there is not the reason.
      expect(events.at(-1)).toMatchObject({ type: 'exit', exit: { reason: 'stopped' } });
      expect((events.at(-1) as { exit: { error?: string } }).exit.error).toBeUndefined();
    });

    it('stops waiting for an interrupted turn after the grace period', async () => {
      const timers = manualTimers();
      const { session, fake } = make({ exitsOnEof: true }, { timers });
      session.send({ type: 'user', message: { role: 'user', content: 'go' }, uuid: 'u1' } as never);
      await settle();
      const ended = session.end();
      await settle();
      expect(fake.calls.interrupt).toBe(1);
      expect(fake.calls.eof).toBe(false);
      timers.advance(END_TIMINGS.graceMs);
      await settle();
      await ended;
      expect(fake.calls.eof).toBe(true);
    });

    it('settles an ask left open when it ends', async () => {
      const { session, fake, events } = make({ exitsOnEof: true, interruptEndsTurn: true });
      const decision = fake.calls.options.canUseTool('Bash', { command: 'ls' }, askOptions());
      await settle();
      await session.end();
      await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
      expect(events.some((e) => e.type === 'askSettled' && e.requestId === 'req_1')).toBe(true);
    });

    it('does not hang on a CLI that never answers the interrupt (a paused process)', async () => {
      const timers = manualTimers();
      const { session, fake } = make({ closeEndsStream: true, interruptHangs: true }, { timers });
      session.send({ type: 'user', message: { role: 'user', content: 'go' }, uuid: 'u1' } as never);
      await settle();
      const ended = session.end();
      await settle();
      timers.advance(END_TIMINGS.graceMs);
      await settle();
      timers.advance(END_TIMINGS.eofWaitMs);
      await settle();
      expect(fake.calls.close).toBe(1);
      await ended;
      expect(session.state).toBe('exited');
    });

    it('is the same promise when asked twice', () => {
      const { session } = make({ exitsOnEof: true });
      expect(session.end()).toBe(session.end());
    });
  });
});

describe('SeqLog', () => {
  it('does not ask for a resync before it has evicted anything', () => {
    // Spike S3's false positive: "older than the oldest entry held" is not stale.
    const log = new SeqLog<{ seq: number; n: number }>();
    log.push({ n: 1 });
    log.push({ n: 2 });
    const got: number[] = [];
    log.subscribe(0, (e) => got.push(e.n));
    expect(got).toEqual([1, 2]);
    expect(log.evictedThrough).toBe(0);
  });

  it('evicts by size, keeps the newest event however large, and records what it dropped', () => {
    const log = new SeqLog<{ seq: number; s: string }>({ maxBytes: 50 });
    log.push({ s: 'a'.repeat(20) });
    log.push({ s: 'b'.repeat(20) });
    log.push({ s: 'c'.repeat(200) });
    expect(log.since(log.evictedThrough).map((e) => e.seq)).toEqual([3]);
    expect(log.evictedThrough).toBe(2);
    expect(() => log.since(1)).toThrow(ResyncNeeded);
  });

  it('delivers in seq order even when a listener pushes, and replays nothing twice to a mid-delivery subscriber', () => {
    const log = new SeqLog<{ seq: number; n: number }>();
    const first: number[] = [];
    const second: number[] = [];
    const late: number[] = [];
    log.subscribe(0, (e) => {
      first.push(e.seq);
      if (e.n === 1) {
        log.push({ n: 2 });
        log.subscribe(e.seq, (x) => late.push(x.seq));
      }
    });
    log.subscribe(0, (e) => second.push(e.seq));
    log.push({ n: 1 });
    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
    expect(late).toEqual([2]);
  });

  it('runs the numbered hook before any listener sees the event', () => {
    const log = new SeqLog<{ seq: number }>();
    let folded = 0;
    const seen: number[] = [];
    log.subscribe(0, () => seen.push(folded));
    log.push({}, (e) => (folded = e.seq));
    expect(seen).toEqual([1]);
  });

  it('keeps delivering when a listener throws', () => {
    const errors: unknown[] = [];
    const log = new SeqLog<{ seq: number }>({ onListenerError: (e) => errors.push(e) });
    const got: number[] = [];
    log.subscribe(0, () => {
      throw new Error('bad listener');
    });
    log.subscribe(0, (e) => got.push(e.seq));
    log.push({});
    expect(got).toEqual([1]);
    expect(errors).toHaveLength(1);
  });
});
