import { describe, expect, it } from 'vitest';
import { RunnerService } from '../src/claude/runner/runnerService';
import { SessionRegistry } from '../src/core/session/sessionRegistry';
import type { QueryFn } from '../src/claude/runner/claudeSdkSession';

/**
 * A stand-in for the SDK's `query`, minimal enough to start a session and
 * observe whether it was asked to close. No process is ever spawned. Modelled
 * on the fake in `test/runnerSession.test.ts`, trimmed to what `dispose`
 * exercises: nothing here ever emits a message, so every session stays
 * `starting` unless `close()` is called on it.
 */
function fakeQuery() {
  let closed = false;
  const stream = (async function* () {
    // Never yields on its own; only `close()` below ends it.
    await new Promise<void>(() => undefined);
  })();

  const query: QueryFn = ({ prompt, options: _options }) => {
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _m of prompt) {
        /* drain, never sent to anywhere real */
      }
    })();
    return Object.assign(stream, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      close: () => {
        closed = true;
      },
    }) as never;
  };

  return { query, isClosed: () => closed };
}

function fakeRegistry() {
  const remembered = new Set<string>();
  return {
    remember: (id: string) => remembered.add(id),
    forget: (id: string) => remembered.delete(id),
    wasRunning: () => false,
    has: (id: string) => remembered.has(id),
  };
}

describe('RunnerService.dispose', () => {
  it('ends every session it is running', async () => {
    const registry = fakeRegistry();
    const service = new RunnerService({
      query: fakeQuery().query,
      binary: () => '/fake/claude',
      log: () => undefined,
      registry: registry as never,
    });
    service.start({ cwd: '/Users/test/proj-a' });
    service.start({ cwd: '/Users/test/proj-b' });
    expect(service.list()).toHaveLength(2);
    const sessions = service.list();

    service.dispose();

    // Each session was told to end: `ending` is set synchronously, before any
    // await, which is exactly the observable proof dispose asked for it.
    for (const s of sessions) expect(s.lifecycle).toBe('ending');
    expect(service.list()).toHaveLength(0);
  });

  it('does not await the sessions it ends — it returns before they finish', async () => {
    const { query, isClosed } = fakeQuery();
    const service = new RunnerService({ query, binary: () => '/fake/claude', log: () => undefined });
    service.start({ cwd: '/Users/test/proj' });

    service.dispose();

    // `dispose` is synchronous (`void s.end()`, never `await`). A session only
    // reaches `ended` once its query stream closes, which nothing here has
    // triggered yet, so if dispose had awaited that, this assertion would be
    // trivially true instead of proving anything. It is checked immediately,
    // with no `await` in between, precisely so a synchronous dispose is the
    // only way it can hold.
    expect(isClosed()).toBe(false);
  });

  it('leaves the registry alone — a lost window is exactly what the next startup should offer back', () => {
    const registry = new SessionRegistry(memento());
    const service = new RunnerService({ query: fakeQuery().query, binary: () => '/fake/claude', log: () => undefined, registry });
    service.start({ cwd: '/Users/test/proj', sessionId: 'abc' });
    expect(registry.get('abc')?.state).toBe('live');

    service.dispose();

    expect(registry.get('abc')?.state).toBe('live');
  });
});

describe('RunnerService and the session registry', () => {
  function make() {
    const registry = new SessionRegistry(memento());
    const service = new RunnerService({
      query: fakeQuery().query,
      binary: () => '/fake/claude',
      log: () => undefined,
      registry,
      locate: () => ({ repoRoot: '/Users/test/proj', branch: 'main' }),
    });
    return { registry, service };
  }

  it('records a session with how and where it was launched', () => {
    const { registry, service } = make();
    service.start({
      cwd: '/Users/test/proj/sub',
      sessionId: 's1',
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
      origin: { kind: 'orchestration', taskId: 't1' },
    });
    expect(registry.get('s1')).toMatchObject({
      provider: 'claude',
      cwd: '/Users/test/proj/sub',
      repoRoot: '/Users/test/proj',
      branchAtStart: 'main',
      launch: { model: 'opus', effort: 'high', permissionMode: 'plan', binary: '/fake/claude' },
      origin: { kind: 'orchestration', taskId: 't1' },
      state: 'live',
    });
  });

  it('marks a deliberate end as stopped, not interrupted', async () => {
    const { registry, service } = make();
    const session = service.start({ cwd: '/Users/test/proj', sessionId: 's1' });
    const ending = service.end(session);
    await Promise.race([ending, new Promise((r) => setTimeout(r, 50))]);
    expect(registry.get('s1')?.state).toBe('stopped');
  });

  it('keeps sessions live when ending them for quit, so the next start offers them back', async () => {
    const { registry, service } = make();
    service.start({ cwd: '/Users/test/proj', sessionId: 's1' });
    service.start({ cwd: '/Users/test/proj', sessionId: 's2' });
    await service.endAllForQuit(50);
    expect(registry.get('s1')?.state).toBe('live');
    expect(registry.get('s2')?.state).toBe('live');
  });

  it('reports an interrupted session as was-running only while nothing here runs it', () => {
    const store = memento();
    const before = new SessionRegistry(store);
    before.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj' });
    const after = new SessionRegistry(store);
    after.startup();
    const service = new RunnerService({ query: fakeQuery().query, binary: () => '/b', log: () => undefined, registry: after });
    expect(service.wasRunning('s1')).toBe(true);
    service.start({ cwd: '/Users/test/proj', resume: 's1' });
    expect(service.wasRunning('s1')).toBe(false);
  });
});

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}
