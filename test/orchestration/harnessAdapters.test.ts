/**
 * The Claude Code and Codex adapters (#30, plan §6.2): what they send to
 * #4's `SessionExecutors`, and what they say they can do.
 */
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import type { LaunchRequest, SessionHandle } from '../../src/core/session/sessionHandle';
import { SessionExecutors } from '../../src/core/session/sessionExecutors';
import { CodexRunnerService } from '../../src/codex/runner';
import { ClaudeCodeHarness } from '../../src/orchestration/harness/claudeCodeHarness';
import { CodexHarness } from '../../src/orchestration/harness/codexHarness';
import type { AttemptLaunch } from '../../src/orchestration/harness/types';
import type { ModelChoice } from '../../src/shared/conversation';

const MODELS: ModelChoice[] = [
  { value: 'haiku', label: 'Haiku', provider: 'anthropic' },
  { value: 'gpt-6-luna', label: 'Luna', provider: 'openai' },
];

const origin = { kind: 'orchestration', missionId: 'm1', taskId: 't1', attemptId: 'a1' } as const;

function recorder() {
  const requests: LaunchRequest[] = [];
  const calls: string[] = [];
  const handle = {
    sessionId: 'sid',
    setEffort: async (e: string) => {
      calls.push(`setEffort:${e}`);
      return 'applied' as const;
    },
    send: async (t: string) => {
      calls.push(`send:${t}`);
      return 'applied' as const;
    },
  } as unknown as SessionHandle;
  return {
    requests,
    calls,
    sessions: {
      launch: async (r: LaunchRequest) => {
        requests.push(r);
        calls.push('launch');
        return handle;
      },
    },
  };
}

describe('ClaudeCodeHarness', () => {
  const req = (over: Partial<AttemptLaunch> = {}): AttemptLaunch => ({
    cwd: '/Users/test/proj-wt',
    prompt: 'Fix it',
    target: { harness: 'claude-code', model: 'sonnet', effortNative: 'high' },
    origin,
    permissionMode: 'acceptEdits',
    ...over,
  });

  it('launches one Claude session with the target, origin, prompt and a pre-assigned id', async () => {
    const r = recorder();
    const h = new ClaudeCodeHarness({ sessions: r.sessions, models: () => MODELS });
    await h.launch(req());
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({
      provider: 'claude',
      cwd: '/Users/test/proj-wt',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      initialPrompt: 'Fix it',
      origin,
    });
    expect(r.requests[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.requests[0].resume).toBeUndefined();
  });

  it('keeps a chosen id, resumes instead when asked, and sends no effort for `none`', async () => {
    const r = recorder();
    const h = new ClaudeCodeHarness({ sessions: r.sessions, models: () => MODELS });
    await h.launch(req({ sessionId: 'chosen' }));
    await h.launch(req({ resume: 'old', target: { harness: 'claude-code', model: 'haiku', effortNative: 'none' } }));
    expect(r.requests[0].sessionId).toBe('chosen');
    expect(r.requests[1]).toMatchObject({ resume: 'old', model: 'haiku' });
    expect(r.requests[1].sessionId).toBeUndefined();
    expect(r.requests[1].effort).toBeUndefined();
  });

  it('refuses another harness\'s target, offers only Anthropic models, and changes effort by /effort', async () => {
    const h = new ClaudeCodeHarness({ sessions: recorder().sessions, models: () => MODELS });
    await expect(h.launch(req({ target: { harness: 'codex', model: 'x', effortNative: 'low' } }))).rejects.toThrow(/cannot launch a codex target/);
    expect((await h.models()).map((m) => m.value)).toEqual(['haiku']);
    expect(h.capabilities()).toMatchObject({ preassignedSessionId: true, midSessionEffortChange: 'slash-command', reportsCost: true });
  });
});

describe('CodexHarness', () => {
  const req = (over: Partial<AttemptLaunch> = {}): AttemptLaunch => ({
    cwd: '/Users/test/proj-wt',
    prompt: 'Fix it',
    target: { harness: 'codex', model: 'gpt-6-sol', effortNative: 'medium' },
    origin,
    permissionMode: 'acceptEdits',
    ...over,
  });

  it('starts a thread with model and effort, then sends the prompt; no permission mode', async () => {
    const r = recorder();
    const h = new CodexHarness({ sessions: r.sessions, models: () => MODELS });
    await h.launch(req());
    expect(r.requests[0]).toMatchObject({ provider: 'codex', cwd: '/Users/test/proj-wt', model: 'gpt-6-sol', effort: 'medium', origin });
    expect(r.requests[0].permissionMode).toBeUndefined();
    expect(r.requests[0].initialPrompt).toBeUndefined();
    expect(r.calls).toEqual(['launch', 'send:Fix it']);
  });

  it('sets the effort on a resumed thread before its first turn (per-turn effort)', async () => {
    const r = recorder();
    const h = new CodexHarness({ sessions: r.sessions, models: () => MODELS });
    await h.launch(req({ resume: 'thread-9', target: { harness: 'codex', model: 'gpt-6-astra', effortNative: 'high' } }));
    expect(r.requests[0]).toMatchObject({ resume: 'thread-9' });
    expect(r.calls).toEqual(['launch', 'setEffort:high', 'send:Fix it']);
    expect(h.capabilities().midSessionEffortChange).toBe('per-turn');
    expect((await h.models()).map((m) => m.value)).toEqual(['gpt-6-luna']);
  });

  it('runs end to end over the real Codex executor: thread/start, then turn/start with the prompt', async () => {
    const server = new FakeServer();
    const service = new CodexRunnerService(server as never);
    const h = new CodexHarness({ sessions: new SessionExecutors([service]), models: () => MODELS });
    const handle = await h.launch(req());
    // (`model/list` is the executor refreshing the model catalog.)
    expect(server.calls.map((c) => c.method).filter((m) => m !== 'model/list')).toEqual(['thread/start', 'turn/start']);
    expect(server.calls[0].params).toMatchObject({ cwd: '/Users/test/proj-wt', model: 'gpt-6-sol', config: { model_reasoning_effort: 'medium' } });
    expect(server.calls.find((c) => c.method === 'turn/start')?.params).toMatchObject({ threadId: 'thread-1', model: 'gpt-6-sol' });
    expect(handle.origin).toEqual(origin);
    expect(handle.composer.effort).toBe('medium');
    service.dispose();
  });
});

class FakeServer {
  notifications = new Emitter<unknown>();
  requests = new Emitter<unknown>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  onNotification = this.notifications.event;
  onRequest = this.requests.event;
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
  respond(): void {}
  dispose(): void {}
}
