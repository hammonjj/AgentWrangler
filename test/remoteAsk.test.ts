import { describe, expect, it } from 'vitest';
import { askKeyFor, remoteAskFor } from '../src/shared/remote';
import type { SessionDTO } from '../src/shared/model';

/** A session blocked on a permission prompt that can still be answered. */
function blocked(extra: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    key: 'claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 'test-session',
    status: 'blocked',
    lastActivityAt: 1000,
    permissionRequestId: '1234-999',
    blockedReason: 'Bash',
    blockedAsk: { summary: 'Run the unit tests', body: 'npm test', isCommand: true },
    projectName: 'proj',
    gitBranch: 'dev',
    ...extra,
  };
}

describe('remoteAskFor', () => {
  it('projects a blocked session into an ask', () => {
    const ask = remoteAskFor(blocked());
    expect(ask).toMatchObject({
      askKey: 'claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee#1234-999',
      sessionKey: 'claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      requestId: '1234-999',
      kind: 'permission',
      toolName: 'Bash',
      subject: { summary: 'Run the unit tests', body: 'npm test', isCommand: true },
      context: { agent: 'test-session', repository: 'proj', branch: 'dev' },
    });
  });

  it('titles the ask so a notification preview says who wants what', () => {
    expect(remoteAskFor(blocked())?.title).toBe('test-session needs permission for Bash');
  });

  it('prefers the name the user gave the session, as every other surface does', () => {
    const ask = remoteAskFor(blocked({ nickname: 'the deploy one', name: 'proj-cf' }));
    expect(ask?.context.agent).toBe('the deploy one');
    expect(ask?.title).toBe('the deploy one needs permission for Bash');
  });

  describe('is offered only when Agent Wrangler is offering it', () => {
    it('needs a pending request id — the marker is the whole gate', () => {
      expect(remoteAskFor(blocked({ permissionRequestId: undefined }))).toBeUndefined();
    });

    it('needs the session to be blocked', () => {
      for (const status of ['busy', 'waiting', 'done', 'stuck', 'ended'] as const) {
        expect(remoteAskFor(blocked({ status }))).toBeUndefined();
      }
    });

    it('skips archived sessions, which are deliberately out of the way', () => {
      expect(remoteAskFor(blocked({ archived: true }))).toBeUndefined();
    });

    it('skips paused sessions, which cannot act on an answer', () => {
      // A frozen process makes no progress until it is resumed, so a remote
      // button would appear to work and do nothing.
      expect(remoteAskFor(blocked({ paused: true }))).toBeUndefined();
    });

    it('skips providers with no marker to answer', () => {
      expect(remoteAskFor(blocked({ provider: 'codex' }))).toBeUndefined();
    });

    it('does NOT skip a session Agent Wrangler runs itself', () => {
      // Runner-owned sessions raise the same hook marker as any other, and a
      // marker is answerable from any process on the machine.
      expect(remoteAskFor(blocked({ runnerOwned: true }))).toBeDefined();
    });
  });

  describe('choices', () => {
    it('offers allow and deny, and no always, when the prompt suggested no rule', () => {
      const ask = remoteAskFor(blocked());
      expect(ask?.choices.map((c) => c.action)).toEqual(['allow', 'deny']);
    });

    it('offers always allow when Agent Wrangler has a rule, naming it', () => {
      const ask = remoteAskFor(
        blocked({ alwaysAllow: { rules: ['Bash(npm test:*)'], destination: 'your user settings' } }),
      );
      expect(ask?.choices.map((c) => c.action)).toEqual(['allow', 'always', 'deny']);
      const always = ask?.choices.find((c) => c.action === 'always');
      expect(always?.label).toBe('Always allow Bash(npm test:*)');
      expect(always?.detail).toContain('your user settings');
    });

    it('drops an always with an empty rule list rather than promising nothing', () => {
      const ask = remoteAskFor(blocked({ alwaysAllow: { rules: [], destination: 'session' } }));
      expect(ask?.choices.map((c) => c.action)).toEqual(['allow', 'deny']);
    });

    it('keeps a very long rule label scannable', () => {
      const ask = remoteAskFor(
        blocked({
          alwaysAllow: { rules: Array.from({ length: 12 }, (_, i) => `Bash(command-${i}:*)`), destination: 'session' },
        }),
      );
      const always = ask?.choices.find((c) => c.action === 'always');
      expect(always!.label.length).toBeLessThanOrEqual('Always allow '.length + 48);
      expect(always!.label.endsWith('…')).toBe(true);
    });

    it('only ever uses existing Agent Wrangler actions', () => {
      const ask = remoteAskFor(
        blocked({ alwaysAllow: { rules: ['Bash(ls:*)'], destination: 'session' } }),
      );
      for (const c of ask!.choices) expect(['allow', 'always', 'deny']).toContain(c.action);
    });
  });

  describe('identity', () => {
    it('changes when the prompt does, so a stale press is detectable', () => {
      const first = remoteAskFor(blocked())!;
      const second = remoteAskFor(blocked({ permissionRequestId: '1234-1000' }))!;
      expect(first.askKey).not.toBe(second.askKey);
      expect(first.sessionKey).toBe(second.sessionKey);
    });

    it('is stable for the same prompt', () => {
      expect(remoteAskFor(blocked())!.askKey).toBe(remoteAskFor(blocked())!.askKey);
    });

    it('composes the key the same way callers do', () => {
      expect(remoteAskFor(blocked())!.askKey).toBe(askKeyFor('claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '1234-999'));
    });
  });

  it('carries no path, pid or transcript location', () => {
    const ask = remoteAskFor(
      blocked({ cwd: '/Users/test/proj', pid: 4711, transcriptPath: '/Users/test/.claude/projects/x.jsonl' }),
    );
    const flat = JSON.stringify(ask);
    expect(flat).not.toContain('/Users/test');
    expect(flat).not.toContain('4711');
    expect(flat).not.toContain('.jsonl');
  });

  it('survives a session with nothing but the required fields', () => {
    const ask = remoteAskFor({
      provider: 'claude',
      sessionId: 'x',
      key: 'claude:x',
      title: 'x',
      status: 'blocked',
      lastActivityAt: 0,
      permissionRequestId: '1-2',
    });
    expect(ask?.toolName).toBe('a tool');
    expect(ask?.subject).toBeUndefined();
    expect(ask?.context.repository).toBeUndefined();
  });
});
