import { describe, expect, it } from 'vitest';
import { RunnerService } from '../src/claude/runner/runnerService';
import { SessionRegistry } from '../src/core/session/sessionRegistry';
import type { QueryFn } from '../src/claude/runner/claudeSdkSession';
import { inProcessHosts } from '../src/sessionHost/inProcessHosts';

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

/** A `RunnerService` on in-process hosts: the app's code path, without a process per session. */
function makeService(over: { query?: QueryFn; registry?: SessionRegistry; locate?: (cwd: string) => { repoRoot?: string; branch?: string } } = {}) {
  const hosts = inProcessHosts({ query: over.query ?? fakeQuery().query });
  const service = new RunnerService({
    binary: () => '/fake/claude',
    log: () => undefined,
    registry: over.registry,
    locate: over.locate,
    hosts: { supervisor: hosts },
  });
  return { service, hosts };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('RunnerService: every Claude conversation runs in a session host (#122)', () => {
  it('starts every session in a host, with its id chosen before the host starts', () => {
    const { service, hosts } = makeService();
    const a = service.start({ cwd: '/Users/test/proj-a' });
    const b = service.start({ cwd: '/Users/test/proj-b', sessionId: 'bbbbbbbb-0000-4000-8000-000000000001' });

    expect(hosts.launches).toHaveLength(2);
    expect(hosts.launches[0]).toMatchObject({ cwd: '/Users/test/proj-a', binary: '/fake/claude' });
    expect(hosts.launches[0].sessionId).toMatch(UUID);
    expect(hosts.launches[0].resume).toBeFalsy();
    expect(hosts.launches[1]).toMatchObject({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000001' });
    // The view knows the id from the start, as the registry and the pane do.
    expect(a.sessionId).toBe(hosts.launches[0].sessionId);
    for (const s of [a, b]) expect(s.hosted).toBe(true);
    expect(service.liveCount()).toBe(2);
    service.dispose();
  });

  it('resumes a conversation an older build ran in its own process, in a host', async () => {
    // What an upgrade from a build with in-process sessions leaves behind: a
    // record still `live`, its process gone with the old app, no host.
    const store = memento();
    const before = new SessionRegistry(store);
    before.live({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', provider: 'claude', cwd: '/Users/test/proj', launch: { model: 'opus' } });

    const registry = new SessionRegistry(store);
    const startup = registry.startup();
    // Not lost: interrupted, so its row offers Resume (and auto-resume may pick it).
    expect(startup.interrupted.map((r) => r.sessionId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);

    const { service, hosts } = makeService({ registry });
    expect(service.wasRunning('aaaaaaaa-0000-4000-8000-000000000001')).toBe(true);
    const view = await service.resume({ cwd: '/Users/test/proj', resume: 'aaaaaaaa-0000-4000-8000-000000000001' });

    expect(hosts.launches).toEqual([
      expect.objectContaining({ cwd: '/Users/test/proj', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', resume: true }),
    ]);
    expect(view.hosted).toBe(true);
    expect(registry.get('aaaaaaaa-0000-4000-8000-000000000001')?.state).toBe('live');
    expect(service.wasRunning('aaaaaaaa-0000-4000-8000-000000000001')).toBe(false);
    service.dispose();
  });
});

describe('RunnerService.dispose', () => {
  it('lets every session go without ending it: each keeps running in its host', () => {
    const { query, isClosed } = fakeQuery();
    const { service } = makeService({ query });
    service.start({ cwd: '/Users/test/proj-a' });
    service.start({ cwd: '/Users/test/proj-b' });
    const sessions = service.list();
    expect(sessions).toHaveLength(2);

    service.dispose();

    for (const s of sessions) expect(s.lifecycle).not.toBe('ending');
    expect(isClosed()).toBe(false);
    expect(service.list()).toHaveLength(0);
  });

  it('leaves the registry alone — the next start adopts the session from its host', () => {
    const registry = new SessionRegistry(memento());
    const { service } = makeService({ registry });
    service.start({ cwd: '/Users/test/proj', sessionId: 'abc' });
    expect(registry.get('abc')?.state).toBe('live');

    service.dispose();

    expect(registry.get('abc')?.state).toBe('live');
  });
});

describe('RunnerService and the session registry', () => {
  function make() {
    const registry = new SessionRegistry(memento());
    const { service } = makeService({ registry, locate: () => ({ repoRoot: '/Users/test/proj', branch: 'main' }) });
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

  it('Quit and Stop All Agents ends every session and keeps it live, so the next start offers it back', async () => {
    const { registry, service } = make();
    const s1 = service.start({ cwd: '/Users/test/proj', sessionId: 's1' });
    const s2 = service.start({ cwd: '/Users/test/proj', sessionId: 's2' });
    await service.endAllForQuit(50);
    for (const s of [s1, s2]) expect(['ending', 'ended']).toContain(s.lifecycle);
    expect(registry.get('s1')?.state).toBe('live');
    expect(registry.get('s2')?.state).toBe('live');
  });

  it('reports an interrupted session as was-running only while nothing here runs it', () => {
    const store = memento();
    const before = new SessionRegistry(store);
    before.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj' });
    const after = new SessionRegistry(store);
    after.startup();
    const { service } = makeService({ registry: after });
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
