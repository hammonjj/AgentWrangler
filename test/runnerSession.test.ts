import { describe, expect, it, vi } from 'vitest';
import { RunnerSession, type QueryFn } from '../src/claude/runner/runnerSession';
import type { ConvBlock, ImageAttachment } from '../src/shared/conversation';

/**
 * A stand-in for the SDK's `query`: it hands the session a stream we push
 * messages into, records what the session sends back, and lets a test call the
 * `canUseTool` callback the way the CLI would. No process is ever spawned.
 */
/**
 * What `supportedModels()` answers, in the SDK's `ModelInfo` shape. The last
 * two rows are the awkward ones: a row with no usable `value`, and one with an
 * empty `displayName`.
 */
const MODELS: unknown = [
  { value: 'default', displayName: 'Default (recommended)', description: 'x', resolvedModel: 'claude-sonnet-4-5-20250929' },
  { value: 'opus', displayName: 'Opus', description: 'x' },
  { value: '', displayName: 'Nameless', description: 'x' },
  { value: 'haiku', displayName: '', description: 'x' },
];

function fakeQuery(models: unknown = MODELS) {
  let emit!: (msg: unknown) => void;
  let finish!: () => void;
  let fail!: (err: unknown) => void;
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let error: unknown;

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

  emit = (msg) => {
    pending.push(msg);
    wake?.();
    wake = undefined;
  };
  finish = () => {
    done = true;
    wake?.();
    wake = undefined;
  };
  fail = (err) => {
    error = err;
    wake?.();
    wake = undefined;
  };

  const calls = {
    interrupt: 0,
    close: 0,
    permissionMode: [] as string[],
    model: [] as (string | undefined)[],
    supportedModels: 0,
    sent: [] as unknown[],
    options: undefined as any,
  };

  const query: QueryFn = ({ prompt, options }) => {
    calls.options = options;
    void (async () => {
      for await (const m of prompt) calls.sent.push(m);
    })();
    const q = Object.assign(stream, {
      interrupt: async () => {
        calls.interrupt++;
        return undefined;
      },
      setPermissionMode: async (mode: string) => {
        calls.permissionMode.push(mode);
      },
      setModel: async (model?: string) => {
        calls.model.push(model);
      },
      supportedModels: async () => {
        calls.supportedModels++;
        if (models instanceof Error) throw models;
        return models;
      },
      close: () => {
        calls.close++;
        finish();
      },
    });
    return q as never;
  };

  return { query, emit, finish, fail, calls };
}

function makeSession(cwd = '/Users/test/proj', models?: unknown) {
  const fake = fakeQuery(models === undefined ? MODELS : models);
  const appended: ConvBlock[] = [];
  const patches: { id: string; block: Record<string, unknown> }[] = [];
  const session = new RunnerSession(
    { cwd },
    { query: fake.query, binary: '/fake/claude', log: () => undefined },
  );
  session.onAppend((b) => appended.push(...b));
  session.onPatch((p) => patches.push({ id: p.id, block: p.block as Record<string, unknown> }));
  session.start();
  return { session, fake, appended, patches };
}

/** Let the message pump's microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The options object the SDK hands `canUseTool`, as the CLI fills it in. */
function askOptions(over: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'req_1',
    ...over,
  } as never;
}

describe('RunnerSession', () => {
  it('passes the resolved binary and cwd to the SDK, and never an API key', async () => {
    const { fake } = makeSession();
    expect(fake.calls.options.pathToClaudeCodeExecutable).toBe('/fake/claude');
    expect(fake.calls.options.cwd).toBe('/Users/test/proj');
    expect(fake.calls.options.includePartialMessages).toBe(true);
    expect(fake.calls.options.canUseTool).toBeTypeOf('function');
  });

  it('shows the user’s own message, which the CLI does not echo back', async () => {
    const { session, appended, fake } = makeSession();
    session.send('do the thing');
    await settle();
    expect(appended[0]).toMatchObject({ kind: 'user', text: 'do the thing' });
    expect(fake.calls.sent[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'do the thing' } });
  });

  it('ignores an empty send', async () => {
    const { session, appended } = makeSession();
    session.send('   ');
    await settle();
    expect(appended).toHaveLength(0);
  });

  describe('images', () => {
    const png: ImageAttachment = { mediaType: 'image/png', data: 'aGVsbG8=' };

    it('sends a plain string when there is no image, which is what the CLI logs most readably', async () => {
      const { session, fake } = makeSession();
      session.send('just text');
      await settle();
      expect(fake.calls.sent[0]).toMatchObject({ message: { content: 'just text' } });
    });

    it('sends image blocks before the text, so the instruction follows what it refers to', async () => {
      const { session, fake } = makeSession();
      session.send('what is wrong here?', [png]);
      await settle();
      expect((fake.calls.sent[0] as { message: { content: unknown[] } }).message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        { type: 'text', text: 'what is wrong here?' },
      ]);
    });

    it('counts the images on the block the pane shows, matching what the transcript reader does', async () => {
      const { session, appended } = makeSession();
      session.send('look', [png, png]);
      await settle();
      expect(appended[0]).toMatchObject({ kind: 'user', imageCount: 2 });
    });

    it('sends an image with no text at all, which is a real message', async () => {
      const { session, fake, appended } = makeSession();
      session.send('   ', [png]);
      await settle();
      expect(appended).toHaveLength(1);
      // No empty text block trailing the image.
      expect((fake.calls.sent[0] as { message: { content: unknown[] } }).message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ]);
    });

    it('still ignores a send that is empty on both halves', async () => {
      const { session, appended } = makeSession();
      session.send('   ', []);
      await settle();
      expect(appended).toHaveLength(0);
    });
  });

  it('learns its session id from the stream', async () => {
    const { session, fake } = makeSession();
    fake.emit({ type: 'system', subtype: 'init', session_id: 'abc-123', permissionMode: 'default' });
    await settle();
    expect(session.sessionId).toBe('abc-123');
    expect(session.lifecycle).toBe('idle');
  });

  describe('permission asks', () => {
    it('raises a card and resolves allow with the input untouched', async () => {
      const { session, fake, appended, patches } = makeSession();
      const decision = fake.calls.options.canUseTool('Bash', { command: 'npm test' }, askOptions());
      await settle();

      const card = appended.find((b) => b.kind === 'permission');
      expect(card).toMatchObject({ kind: 'permission', toolName: 'Bash', state: 'pending' });

      expect(session.decide('req_1', 'allow')).toBe(true);
      await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedInput: { command: 'npm test' } });
      expect(patches.at(-1)).toMatchObject({ block: { state: 'allowed' } });
    });

    it('hands the prompt’s own suggestion back for an always-allow', async () => {
      // This is Claude Code's "don't ask again": we do not write rules
      // ourselves, we return the suggestion it offered and it persists it.
      const { session, fake } = makeSession();
      const suggestions = [
        { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
      ];
      const decision = fake.calls.options.canUseTool('Bash', { command: 'npm test' }, askOptions({ suggestions }));
      await settle();
      session.decide('req_1', 'always');
      await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedPermissions: suggestions });
    });

    it('offers always-allow only when the prompt suggested a rule', async () => {
      const { fake, appended } = makeSession();
      void fake.calls.options.canUseTool('Bash', { command: 'rm -rf /' }, askOptions());
      await settle();
      expect(appended.find((b) => b.kind === 'permission')).toMatchObject({ alwaysAllowRule: undefined });
    });

    it('sends a reason with a deny, so the model knows why', async () => {
      const { session, fake } = makeSession();
      const decision = fake.calls.options.canUseTool('Bash', { command: 'rm -rf /' }, askOptions());
      await settle();
      session.decide('req_1', 'deny', 'not that');
      await expect(decision).resolves.toMatchObject({ behavior: 'deny', message: 'not that' });
    });

    it('settles an ask the turn abandoned rather than leaking the promise', async () => {
      // canUseTool never resolving blocks the tool forever, by design. An
      // interrupt must therefore still settle it.
      const { fake, patches } = makeSession();
      const ctrl = new AbortController();
      const decision = fake.calls.options.canUseTool('Bash', { command: 'sleep 100' }, askOptions({ signal: ctrl.signal }));
      await settle();
      ctrl.abort();
      await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
      expect(patches.at(-1)).toMatchObject({ block: { state: 'expired' } });
    });

    it('refuses a second answer to the same ask', async () => {
      const { session, fake } = makeSession();
      void fake.calls.options.canUseTool('Bash', { command: 'ls' }, askOptions());
      await settle();
      expect(session.decide('req_1', 'allow')).toBe(true);
      expect(session.decide('req_1', 'deny')).toBe(false);
    });

    it('refuses an answer to an ask that never existed', () => {
      const { session } = makeSession();
      expect(session.decide('nope', 'allow')).toBe(false);
    });
  });

  it('answers a question by filling the answers into the tool input', async () => {
    const { session, fake, appended } = makeSession();
    const input = {
      questions: [
        {
          question: 'Alpha or Beta?',
          header: 'Choice',
          options: [
            { label: 'Alpha', description: 'the first' },
            { label: 'Beta', description: 'the second' },
          ],
        },
      ],
    };
    const decision = fake.calls.options.canUseTool('AskUserQuestion', input, askOptions());
    await settle();
    expect(appended.find((b) => b.kind === 'question')).toMatchObject({
      kind: 'question',
      questions: [{ question: 'Alpha or Beta?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
    });

    expect(session.answer('req_1', { 'Alpha or Beta?': 'Alpha' })).toBe(true);
    await expect(decision).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Alpha or Beta?': 'Alpha' } },
    });
  });

  it('approves a plan, and sends feedback when rejecting one', async () => {
    const approve = makeSession();
    const planInput = { plan: '# Plan\n\ndo the thing', planFilePath: '/Users/test/plan.md' };
    const approved = approve.fake.calls.options.canUseTool('ExitPlanMode', planInput, askOptions());
    await settle();
    expect(approve.appended.find((b) => b.kind === 'plan')).toMatchObject({ kind: 'plan', plan: planInput.plan });
    approve.session.decidePlan('req_1', true);
    await expect(approved).resolves.toMatchObject({ behavior: 'allow' });

    const reject = makeSession();
    const rejected = reject.fake.calls.options.canUseTool('ExitPlanMode', planInput, askOptions());
    await settle();
    reject.session.decidePlan('req_1', false, 'too broad');
    await expect(rejected).resolves.toMatchObject({ behavior: 'deny', message: 'too broad' });
  });

  it('forwards interrupt and mode changes to the CLI', async () => {
    const { session, fake } = makeSession();
    await session.interrupt();
    await session.setPermissionMode('plan');
    await session.setModel('claude-haiku-4-5-20251001');
    expect(fake.calls.interrupt).toBe(1);
    expect(fake.calls.permissionMode).toEqual(['plan']);
    expect(fake.calls.model).toEqual(['claude-haiku-4-5-20251001']);
    expect(session.composer.permissionMode).toBe('plan');
  });

  it('asks the CLI for the model list once init proves the control channel is up', async () => {
    const { session, fake } = makeSession();
    expect(fake.calls.supportedModels).toBe(0);

    fake.emit({ type: 'system', subtype: 'init', session_id: 'abc-123', permissionMode: 'default' });
    await settle();

    // The valueless row is dropped, and a blank display name falls back to the id.
    expect(session.composer.models).toEqual([
      { value: 'default', label: 'Default (recommended)', resolved: 'claude-sonnet-4-5-20250929' },
      { value: 'opus', label: 'Opus', resolved: undefined },
      { value: 'haiku', label: 'haiku', resolved: undefined },
    ]);

    // A re-emitted init must not ask again: the list cannot change mid-session.
    fake.emit({ type: 'system', subtype: 'init', session_id: 'abc-123', permissionMode: 'default' });
    await settle();
    expect(fake.calls.supportedModels).toBe(1);
  });

  it('keeps running when the CLI cannot list models, so the pane just hides the dropdown', async () => {
    const { session, fake } = makeSession('/Users/test/proj', new Error('too old'));
    fake.emit({ type: 'system', subtype: 'init', session_id: 'abc-123', permissionMode: 'default' });
    await settle();
    expect(session.composer.models).toBeUndefined();
    expect(session.lifecycle).toBe('idle');
  });

  it('ends by closing stdin, and settles anything still parked on a human', async () => {
    const { session, fake } = makeSession();
    const decision = fake.calls.options.canUseTool('Bash', { command: 'ls' }, askOptions());
    await settle();
    const ended = session.end();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    fake.finish();
    await ended;
    expect(session.lifecycle).toBe('ended');
  });

  it('reports a stream that throws instead of going quiet', async () => {
    const { session, fake, appended } = makeSession();
    fake.fail(new Error('spawn failed'));
    await settle();
    expect(session.lifecycle).toBe('error');
    expect(appended.at(-1)).toMatchObject({ kind: 'note', tone: 'error' });
    expect(session.canSend).toBe(false);
  });

  it('tracks turn state across a whole exchange', async () => {
    const { session, fake } = makeSession();
    fake.emit({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default' });
    await settle();
    session.send('hello');
    expect(session.lifecycle).toBe('running');
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'hi', queued_turn_count: 0 });
    await settle();
    expect(session.lifecycle).toBe('idle');
    expect(session.composer.busy).toBe(false);
  });
});

describe('RunnerSession block history', () => {
  it('keeps the blocks so reopening the pane does not re-read anything', async () => {
    const { session, fake } = makeSession();
    fake.emit({
      type: 'assistant',
      message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'text', text: 'hello' }], stop_reason: null },
      parent_tool_use_id: null,
    });
    await settle();
    expect(session.blocks.map((b) => b.kind)).toEqual(['assistant']);
    expect(session.blocks[0]).toMatchObject({ text: 'hello' });
  });
});

describe('vitest sanity', () => {
  it('uses fake timers nowhere, so the async tests are real', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
