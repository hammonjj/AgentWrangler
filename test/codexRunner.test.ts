import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { CodexRunner } from '../src/codex/runner';

class FakeServer {
  notifications = new Emitter<any>();
  requests = new Emitter<any>();
  calls: { method: string; params: any }[] = [];
  responses: any[] = [];
  onNotification = this.notifications.event;
  onRequest = this.requests.event;
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
}

describe('CodexRunner', () => {
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
