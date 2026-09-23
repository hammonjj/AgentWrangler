import { describe, expect, it } from 'vitest';
import { askKeyFor, doneNoticeFor, remoteAskFor } from '../src/shared/remote';
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
    expect(ask?.kind === 'permission' && ask.subject).toBeUndefined();
    expect(ask?.context.repository).toBeUndefined();
  });
});

describe('doneNoticeFor', () => {
  const done = (extra: Partial<SessionDTO> = {}): SessionDTO =>
    blocked({
      status: 'done',
      permissionRequestId: undefined,
      blockedReason: undefined,
      blockedAsk: undefined,
      ...extra,
    });

  it('announces a finished agent with where it was working', () => {
    expect(doneNoticeFor(done())).toEqual({
      title: '✅ test-session finished',
      body: 'proj · dev\nIt is idle until you send it something.',
      tone: 'info',
    });
  });

  it('prefers the nickname, as every other surface does', () => {
    expect(doneNoticeFor(done({ nickname: 'the refactor' }))?.title).toBe('✅ the refactor finished');
  });

  it('says nothing about a session that is not finished', () => {
    expect(doneNoticeFor(blocked())).toBeUndefined();
    expect(doneNoticeFor(done({ status: 'busy' }))).toBeUndefined();
    expect(doneNoticeFor(done({ status: 'ended' }))).toBeUndefined();
  });

  it('stays quiet about an archived session', () => {
    expect(doneNoticeFor(done({ archived: true }))).toBeUndefined();
  });

  it('announces a finished Codex session too: no decision is being offered', () => {
    expect(doneNoticeFor(done({ provider: 'codex' }))?.title).toBe('✅ test-session finished');
  });

  it('carries no transcript content, and copes with no project or branch', () => {
    const notice = doneNoticeFor(done({ projectName: undefined, gitBranch: undefined }));
    expect(notice?.body).toBe('It is idle until you send it something.');
  });
});

/** A session this window runs, parked on a question its runner raised. */
function asking(questions: unknown[], extra: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-q',
    key: 'claude:sess-q',
    title: 'test-session',
    status: 'blocked',
    lastActivityAt: 1000,
    runnerOwned: true,
    projectName: 'proj',
    pendingQuestion: { requestId: 'req_7', questions: questions as never },
    ...extra,
  };
}

const ONE_QUESTION = [
  {
    question: 'Which database?',
    header: 'Database',
    options: [
      { label: 'Postgres', description: 'the boring one' },
      { label: 'SQLite', description: 'the small one' },
    ],
  },
];

describe('remoteAskFor, for a question', () => {
  it('projects a runner-owned question, one button per option', () => {
    const ask = remoteAskFor(asking(ONE_QUESTION));
    expect(ask).toMatchObject({
      askKey: 'claude:sess-q#req_7',
      requestId: 'req_7',
      kind: 'question',
      toolName: 'AskUserQuestion',
      question: 'Which database?',
      header: 'Database',
    });
    expect(ask?.choices.map((c) => [c.action, c.label])).toEqual([
      ['opt0', 'Postgres'],
      ['opt1', 'SQLite'],
    ]);
    expect(ask?.note).toBeUndefined();
  });

  it('keeps the options whole, so the card can show what each one means', () => {
    const ask = remoteAskFor(asking(ONE_QUESTION));
    expect(ask?.kind === 'question' && ask.options).toEqual([
      { label: 'Postgres', description: 'the boring one' },
      { label: 'SQLite', description: 'the small one' },
    ]);
  });

  it('says who is asking and what, for the notification preview', () => {
    expect(remoteAskFor(asking(ONE_QUESTION))?.title).toBe('test-session is asking: Which database?');
  });

  describe('is only answerable when buttons can say it', () => {
    const unbuttonable = (questions: unknown[]) => {
      const ask = remoteAskFor(asking(questions));
      expect(ask).toBeDefined();
      expect(ask?.choices).toEqual([]);
      return ask?.note ?? '';
    };

    it('publishes a stepper of several questions read-only', () => {
      expect(unbuttonable([...ONE_QUESTION, ...ONE_QUESTION])).toMatch(/more than one question/);
    });

    it('publishes a multi-select read-only', () => {
      expect(unbuttonable([{ ...ONE_QUESTION[0], multiSelect: true }])).toMatch(/more than one answer/);
    });

    it('publishes a question with more options than an action row holds read-only', () => {
      const many = [{ ...ONE_QUESTION[0], options: Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` })) }];
      expect(unbuttonable(many)).toMatch(/too many options/);
    });

    it('still publishes: knowing an agent is waiting is most of the point', () => {
      // The alternative — skipping it — is the case this slice exists to avoid.
      expect(remoteAskFor(asking([{ ...ONE_QUESTION[0], multiSelect: true }]))).toBeDefined();
    });
  });

  it('is not offered for a session this window does not run', () => {
    // A question is settled by resolving a promise in one process's heap.
    expect(remoteAskFor(asking(ONE_QUESTION, { runnerOwned: undefined }))).toBeUndefined();
  });

  it('does not need the status to say blocked: the pending ask is the evidence', () => {
    // A Codex question never touches the Claude hook log, so its status can be
    // anything the provider last reported.
    expect(remoteAskFor(asking(ONE_QUESTION, { status: 'busy' }))).toBeDefined();
  });

  it('is skipped when archived or paused, like every other ask', () => {
    expect(remoteAskFor(asking(ONE_QUESTION, { archived: true }))).toBeUndefined();
    expect(remoteAskFor(asking(ONE_QUESTION, { paused: true }))).toBeUndefined();
  });

  it('yields to a permission prompt on the same session', () => {
    const both = asking(ONE_QUESTION, { permissionRequestId: '1-2', blockedReason: 'Bash' });
    expect(remoteAskFor(both)?.kind).toBe('permission');
  });
});

/** A session this window runs, parked on a plan. */
function planning(extra: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-p',
    key: 'claude:sess-p',
    title: 'test-session',
    status: 'blocked',
    lastActivityAt: 1000,
    runnerOwned: true,
    pendingPlan: { requestId: 'req_9', plan: '# Plan\n\nrewrite everything' },
    ...extra,
  };
}

describe('remoteAskFor, for a plan', () => {
  it('projects a runner-owned plan with one button', () => {
    const ask = remoteAskFor(planning());
    expect(ask).toMatchObject({
      askKey: 'claude:sess-p#req_9',
      kind: 'plan',
      toolName: 'ExitPlanMode',
      plan: '# Plan\n\nrewrite everything',
    });
    expect(ask?.choices.map((c) => c.action)).toEqual(['approve']);
  });

  it('offers no rejection, and says where to find one', () => {
    // Rejecting a plan carries feedback to the model. A rejection with none is
    // a worse act than the local button, not a smaller one.
    const ask = remoteAskFor(planning());
    expect(ask?.choices.some((c) => c.action !== 'approve')).toBe(false);
    expect(ask?.note).toMatch(/Request changes in Agent Wrangler/);
  });

  it('carries how much of the plan is not shown', () => {
    const ask = remoteAskFor(planning({ pendingPlan: { requestId: 'req_9', plan: 'half', more: 4200 } }));
    expect(ask?.kind === 'plan' && ask.more).toBe(4200);
  });

  it('is not offered for a session this window does not run', () => {
    expect(remoteAskFor(planning({ runnerOwned: undefined }))).toBeUndefined();
  });
});
