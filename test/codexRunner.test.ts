import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { CodexRunner, CodexRunnerService } from '../src/codex/runner';
import { LiveSessionSource } from '../src/ui/conversation/runnerSource';

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
    await service.start('/Users/test/proj', 'gpt-test', { effort: 'high' });
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
    expect((await new LiveSessionSource(runner).init()).blocks).toEqual(history);
    expect(runner.composer.model).toBe('gpt-resumed');
    expect(runner.session.status).toBe('done');
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
    expect((await new LiveSessionSource(runner).init()).blocks).toEqual(history);
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
    expect(runner.session.status).toBe('done');
  });

  it('changes effort per turn: sent on the next turn/start, and kept for the turns after (#30)', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj', 'gpt-test');
    const composers: any[] = [];
    runner.onComposer((c) => composers.push({ ...c }));

    await runner.send('first');
    expect(server.calls[0].params.effort).toBeUndefined();

    expect(await runner.setEffort('high')).toBe('applied');
    expect(composers.at(-1)?.effort).toBe('high');
    await runner.send('second');
    await runner.send('third');
    expect(server.calls.slice(1).map((c) => c.params.effort)).toEqual(['high', 'high']);

    expect(await runner.setEffort('')).toBe('applied');
    await runner.send('fourth');
    expect(server.calls[3].params.effort).toBeUndefined();
    expect(runner.composer.effort).toBeUndefined();

    runner.shutdown();
    expect(await runner.setEffort('low')).toBe('gone');
  });

  it('carries the latest token usage and the model on its turn end (#27)', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj', 'gpt-test');
    const ends: any[] = [];
    runner.onTurnEnd((raw) => ends.push(raw));
    await runner.send('hello');
    const tokenUsage = { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 }, modelContextWindow: 100 };
    server.notifications.fire({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage } });
    server.notifications.fire({ method: 'thread/tokenUsage/updated', params: { threadId: 'other', turnId: 'x', tokenUsage: {} } });
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    expect(ends).toEqual([
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' }, usageUpdate: { turnId: 'turn-1', tokenUsage }, model: 'gpt-test' },
    ]);
  });

  it('uses the final assistant message to distinguish Waiting from Done', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj');

    await runner.send('finish it');
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Finished. Which option do you prefer?' } });
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    expect(runner.session.status).toBe('waiting');

    await runner.send('option one');
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Implemented option one. All tests pass.' } });
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    expect(runner.session.status).toBe('done');
  });

  it.each(['failed', 'interrupted', 'cancelled'])('keeps a %s turn waiting for review', async (status) => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj');
    await runner.send('do it');
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Partial result.' } });
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status } } });
    expect(runner.session.status).toBe('waiting');
  });

  it('corrects the idle status when the final message lands after turn completion', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj');
    await runner.send('do it');
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    expect(runner.session.status).toBe('waiting'); // no final text yet: safe default
    server.notifications.fire({
      method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Implemented. All tests pass.' } },
    });
    expect(runner.session.status).toBe('done');
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
    expect(runner.session).toMatchObject({ status: 'blocked', blockedReason: 'Approval' });
    expect(await runner.decide(appended[0].requestId, 'allow')).toBe('applied');
    expect(server.responses).toEqual([{ id: 9, result: { decision: 'accept' } }]);
    expect(runner.session.status).toBe('waiting');
  });

  it('marks a server question Blocked until it is answered', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj');
    const appended: any[] = [];
    runner.onAppend((blocks) => appended.push(...blocks));
    server.requests.fire({
      id: 10,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', options: [] }] },
    });
    expect(runner.session).toMatchObject({ status: 'blocked', blockedReason: 'Question' });
    expect(await runner.answer(appended[0].requestId, { choice: 'One' })).toBe('applied');
    expect(runner.session.status).toBe('waiting');
  });

  it('is a session handle: lifecycle follows turns, patches land in the snapshot, turn ends carry the raw payload', async () => {
    const server = new FakeServer();
    const runner = new CodexRunner(server as any, 'thread-1', '/Users/test/proj');
    const lifecycles: string[] = [];
    const ends: unknown[] = [];
    runner.onLifecycle((l) => lifecycles.push(l));
    runner.onTurnEnd((raw) => ends.push(raw));
    expect(runner.provider).toBe('codex');
    expect(runner.sessionId).toBe('thread-1');
    expect(runner.lifecycle).toBe('idle');

    await runner.send('hello');
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Hi' } });
    const completed = { threadId: 'thread-1', turn: { status: 'completed' } };
    server.notifications.fire({ method: 'turn/completed', params: completed });

    expect(lifecycles).toEqual(['running', 'idle']);
    expect(ends).toEqual([completed]);
    const snap = runner.snapshot();
    expect(snap.blocks.find((b) => b.kind === 'assistant')).toMatchObject({ text: 'Hi' });
    expect(await runner.decidePlan()).toBe('unsupported');
  });

  it('ends by releasing the thread through its service', async () => {
    const server = new FakeServer();
    const service = new CodexRunnerService(server as any);
    const runner = await service.launch({ provider: 'codex', cwd: '/Users/test/proj' });
    await runner.end();
    expect(runner.lifecycle).toBe('ended');
    expect(service.owns('thread-1')).toBe(false);
    expect(server.calls).toContainEqual({ method: 'thread/unsubscribe', params: { threadId: 'thread-1' } });
    expect(await runner.send('too late')).toBe('gone');
    service.dispose();
  });
});
