import { describe, expect, it } from 'vitest';
import { RunnerService } from '../src/claude/runner/runnerService';
import type { QueryFn } from '../src/claude/runner/runnerSession';

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
    const registry = fakeRegistry();
    const service = new RunnerService({
      query: fakeQuery().query,
      binary: () => '/fake/claude',
      log: () => undefined,
      registry: registry as never,
    });
    const session = service.start({ cwd: '/Users/test/proj' });
    session.sessionId = 'abc';
    // RunnerSession only remembers itself in the registry on a lifecycle
    // change; simulate what `onLifecycle` would have recorded.
    registry.remember('abc');

    service.dispose();

    expect(registry.has('abc')).toBe(true);
  });
});
