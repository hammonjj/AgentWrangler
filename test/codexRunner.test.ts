import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { CodexRunner, CodexRunnerService } from '../src/codex/runner';

class FakeServer {
  notifications = new Emitter<any>();
  requests = new Emitter<any>();
  calls: { method: string; params: any }[] = [];
  responses: any[] = [];
  onNotification = this.notifications.event;
  onRequest = this.requests.event;
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, model: 'gpt-resumed' } };
    if (method === 'thread/fork') return { thread: { id: 'thread-forked', model: 'gpt-forked' } };
    if (method === 'model/list') return { data: [] };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  dispose(): void {}
}

describe('CodexRunner', () => {
  it('starts a thread with the selected model and provider-specific effort', async () => {
    const server = new FakeServer();
    const service = new CodexRunnerService(server as any);
    await service.start('/Users/test/proj', 'gpt-test', 'high');
    expect(server.calls[0]).toEqual({
      method: 'thread/start',
      params: { cwd: '/Users/test/proj', model: 'gpt-test', config: { model_reasoning_effort: 'high' } },
    });
    service.dispose();
  });

  it('resumes an existing thread with its transcript and releases only this client', async () => {
    const server = new FakeServer();
    const service = new CodexRunnerService(server as any);
    const history: any[] = [{ kind: 'assistant', id: 'old-answer', text: 'Existing answer' }];

    const runner = await service.resume('thread-existing', '/Users/test/proj', history);

    expect(server.calls[0]).toEqual({ method: 'thread/resume', params: { threadId: 'thread-existing' } });
    expect((await runner.init()).blocks).toEqual(history);
    expect(runner.composer.model).toBe('gpt-resumed');
    expect(service.owns('THREAD-EXISTING')).toBe(true);

    service.release('thread-existing');
    expect(service.owns('thread-existing')).toBe(false);
    expect(server.calls).toContainEqual({ method: 'thread/unsubscribe', params: { threadId: 'thread-existing' } });
    service.dispose();
  });

  it('forks an externally owned thread into a controllable conversation', async () => {
    const server = new FakeServer();
    const service = new CodexRunnerService(server as any);
    const history: any[] = [{ kind: 'user', id: 'old-prompt', text: 'Existing prompt' }];

    const runner = await service.fork('thread-external', '/Users/test/proj', history);

    expect(server.calls[0]).toEqual({ method: 'thread/fork', params: { threadId: 'thread-external' } });
    expect(runner.threadId).toBe('thread-forked');
    expect((await runner.init()).blocks).toEqual(history);
    expect(runner.composer.model).toBe('gpt-forked');
    expect(service.owns('thread-forked')).toBe(true);
    service.dispose();
  });

  it('submits turns and reduces streamed assistant messages', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj', 'gpt-test');
    const appended: any[] = [];
    const patched: any[] = [];
    runner.onAppend((blocks) => appended.push(...blocks));
    runner.onPatch((patch) => patched.push(patch));

    await runner.send('hello');
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Hi' } });
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: ' there' } });
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });

    expect(server.calls[0]).toMatchObject({ method: 'turn/start', params: { threadId: 'thread-1' } });
    expect(appended.map((block) => block.kind)).toEqual(['user', 'assistant']);
    expect(patched.at(-1)?.block.text).toBe('Hi there');
    expect(runner.composer.busy).toBe(false);
  });

  it('surfaces and answers server approval requests for its own thread', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj');
    const appended: any[] = [];
    runner.onAppend((blocks) => appended.push(...blocks));
    server.requests.fire({
      id: 9,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test', reason: 'Run tests' },
    });
    expect(appended[0]).toMatchObject({ kind: 'permission', body: 'npm test', state: 'pending' });
    expect(await runner.decide(appended[0].requestId, 'allow')).toBe(true);
    expect(server.responses).toEqual([{ id: 9, result: { decision: 'accept' } }]);
  });
});
