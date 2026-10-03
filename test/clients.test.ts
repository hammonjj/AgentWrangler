/**
 * Prompts, toasts and navigation reach the client that asked (#126).
 *
 * Fake clients over the real `ClientRegistry`, plus the real `DashboardHost`
 * with recorded dependencies for the end-to-end half: a message from one
 * client's pane runs in that client's request context, and what it causes
 * (a confirm, a pick, a row click, a new conversation, a delegation) lands
 * on that client and no other.
 */
import { describe, expect, it } from 'vitest';
import { createAccessGate, ownerContext, type RequestContext } from '../src/core/access';
import { ClientRegistry, channelFromDialogs, type ClientChannel, type ClientPrompt, type NavigateTarget } from '../src/core/clients';
import { currentRequest, outsideRequest, runInRequest, scopedMethods } from '../src/core/requestScope';
import { createShellChannel } from '../src/core/web/shellChannel';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import type { HostDialogs } from '../src/host/hostServices';
import { DashboardHost } from '../src/ui/dashboardHost';
import type { PaneChannel } from '../src/ui/paneChannel';
import type { DashboardToHost } from '../src/shared/messages';
import type { HostToShell, ShellPromptValue } from '../src/shared/shellProtocol';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A client that records everything it is sent, and answers prompts when the test says. */
function fakeClient(connectionId: string, opts: { isOpen?: boolean } = {}) {
  const prompts: { request: ClientPrompt; answer(value: ShellPromptValue): void }[] = [];
  const toasts: string[] = [];
  const navigations: NavigateTarget[] = [];
  const channel: ClientChannel = {
    connectionId,
    kind: 'window',
    openUrl: () => undefined,
    showFile: () => undefined,
    showCommand: () => undefined,
    isOpen: opts.isOpen ?? true,
    prompt: (request) => new Promise((resolve) => prompts.push({ request, answer: resolve })),
    toast: (text) => toasts.push(text),
    navigate: (target) => navigations.push(target),
  };
  return { channel, prompts, toasts, navigations, ctx: ownerContext('browser', { connectionId }) };
}

function rig(opts: { windowOpen?: boolean } = {}) {
  const log: string[] = [];
  const registry = new ClientRegistry({ log: (m) => log.push(m), navigationFallback: 'window' });
  const window = fakeClient('window', { isOpen: opts.windowOpen ?? true });
  const a = fakeClient('web-1');
  const b = fakeClient('web-2');
  const regs = {
    window: registry.register(window.channel),
    a: registry.register(a.channel),
    b: registry.register(b.channel),
  };
  return { registry, window, a, b, regs, log };
}

describe('request scope', () => {
  it('carries the context through awaits and timers, and not outside the run', async () => {
    const ctx = ownerContext('browser', { connectionId: 'web-1' });
    expect(currentRequest()).toBeUndefined();
    const seen = await runInRequest(ctx, async () => {
      await flush();
      return new Promise<RequestContext | undefined>((resolve) => setTimeout(() => resolve(currentRequest()), 1));
    });
    expect(seen).toBe(ctx);
    expect(currentRequest()).toBeUndefined();
  });

  it('outsideRequest runs as the app, even inside a request', () => {
    const ctx = ownerContext('browser', { connectionId: 'web-1' });
    runInRequest(ctx, () => {
      expect(currentRequest()).toBe(ctx);
      outsideRequest(() => expect(currentRequest()).toBeUndefined());
      expect(currentRequest()).toBe(ctx);
    });
  });

  it('scopedMethods runs every method in the context', async () => {
    const ctx = ownerContext('cli');
    const obj = scopedMethods(ctx, {
      sync: () => currentRequest(),
      later: async () => {
        await flush();
        return currentRequest();
      },
    });
    expect(obj.sync()).toBe(ctx);
    expect(await obj.later()).toBe(ctx);
  });
});

describe('ClientRegistry: scoped to the originating client', () => {
  it('a confirm started by one client appears only on that one', async () => {
    const { registry, window, a, b } = rig();
    const answer = runInRequest(a.ctx, () => registry.dialogs.warn('Close it?', { modal: true }, 'Close session'));
    await flush();
    expect(a.prompts).toHaveLength(1);
    expect(a.prompts[0].request).toMatchObject({ kind: 'message', level: 'warn', message: 'Close it?', items: ['Close session'], modal: true });
    expect(b.prompts).toHaveLength(0);
    expect(window.prompts).toHaveLength(0);
    a.prompts[0].answer('Close session');
    expect(await answer).toBe('Close session');
  });

  it('a pick started by another client appears only there, and answers with the item', async () => {
    const { registry, window, a, b } = rig();
    const items = [{ label: 'one' }, { label: 'two', description: 'second' }];
    const picked = runInRequest(b.ctx, () => registry.dialogs.pick(items, { placeHolder: 'Which?' }));
    await flush();
    expect(b.prompts).toHaveLength(1);
    expect(b.prompts[0].request).toEqual({ kind: 'pick', items: [{ label: 'one' }, { label: 'two', description: 'second' }], placeHolder: 'Which?' });
    expect(a.prompts).toHaveLength(0);
    expect(window.prompts).toHaveLength(0);
    b.prompts[0].answer(1);
    expect(await picked).toBe(items[1]);
  });

  it('an answer that is not one of the buttons reads as dismissed', async () => {
    const { registry, a } = rig();
    const answer = runInRequest(a.ctx, () => registry.dialogs.info('Hello', 'Open'));
    await flush();
    a.prompts[0].answer('Something else');
    expect(await answer).toBeUndefined();
  });

  it('flash goes to the originating client only', () => {
    const { registry, window, a, b } = rig();
    runInRequest(a.ctx, () => registry.dialogs.flash('Copied'));
    expect(a.toasts).toEqual(['Copied']);
    expect(b.toasts).toEqual([]);
    expect(window.toasts).toEqual([]);
  });

  it('navigation goes to the originating client only', () => {
    const { registry, window, a, b } = rig();
    runInRequest(b.ctx, () => registry.surface.show('claude:k1'));
    runInRequest(b.ctx, () => registry.surface.showSession({ sessionId: 's' } as SessionHandle));
    expect(b.navigations.map((n) => n.kind)).toEqual(['session', 'handle']);
    expect(a.navigations).toEqual([]);
    expect(window.navigations).toEqual([]);
  });
});

describe('ClientRegistry: a client that disconnects mid-prompt', () => {
  it('resolves the prompt as cancelled', async () => {
    const { registry, a, regs } = rig();
    const answer = runInRequest(a.ctx, () => registry.dialogs.input({ title: 'Name' }));
    await flush();
    expect(a.prompts).toHaveLength(1);
    regs.a.dispose();
    expect(await answer).toBeUndefined();
    // The client answering after it has gone changes nothing.
    a.prompts[0].answer('late');
    expect(await answer).toBeUndefined();
  });

  it('a request whose client has gone is treated as the app acting by itself', async () => {
    const { registry, window, a, b, regs } = rig();
    regs.a.dispose();
    const answer = await runInRequest(a.ctx, () => registry.dialogs.warn('Sure?', {}, 'Yes'));
    expect(answer).toBeUndefined();
    expect(window.prompts).toHaveLength(0);
    expect(b.prompts).toHaveLength(0);
    expect(b.toasts).toEqual(['Sure?']);
  });
});

describe('ClientRegistry: app-initiated prompts', () => {
  it('never wait on a modal: they resolve at once as cancelled and every client is told', async () => {
    const { registry, window, a, b, log } = rig();
    expect(await registry.dialogs.warn('Hooks cannot run', {}, 'Install')).toBeUndefined();
    expect(await registry.dialogs.input({ title: 'Key for endpoint' })).toBeUndefined();
    expect(await registry.dialogs.pick([{ label: 'x' }], { placeHolder: 'Pick a model' })).toBeUndefined();
    expect(await registry.dialogs.pickFolder()).toBeUndefined();
    for (const c of [window, a, b]) {
      expect(c.prompts).toHaveLength(0);
      expect(c.toasts).toHaveLength(4);
      expect(c.toasts[0]).toBe('Hooks cannot run');
      expect(c.toasts[1]).toMatch(/^Key for endpoint: /);
      expect(c.toasts[2]).toMatch(/^Pick a model: /);
    }
    expect(log.filter((l) => l.includes('taking the default'))).toHaveLength(4);
  });

  it('an app-initiated toast goes to every client', () => {
    const { registry, window, a, b } = rig();
    registry.dialogs.flash('Paused 3 agents');
    registry.dialogs.error('Something failed');
    for (const c of [window, a, b]) expect(c.toasts).toEqual(['Paused 3 agents', 'Something failed']);
  });

  it('work started inside a request but run outside it is the app’s', async () => {
    const { registry, a, b } = rig();
    const answer = runInRequest(a.ctx, () => outsideRequest(() => registry.dialogs.info('Done', 'Open')));
    expect(await answer).toBeUndefined();
    expect(a.prompts).toHaveLength(0);
    expect(b.toasts).toEqual(['Done']);
  });

  it('navigation goes to the window when it is open', () => {
    const { registry, window, a, b } = rig({ windowOpen: true });
    registry.surface.show('claude:k1', { preserveFocus: false });
    expect(window.navigations).toEqual([{ kind: 'session', key: 'claude:k1', preserveFocus: false }]);
    expect(a.navigations).toEqual([]);
    expect(b.navigations).toEqual([]);
  });

  it('navigation goes nowhere when the window is closed', () => {
    const { registry, window, a, b } = rig({ windowOpen: false });
    registry.surface.show('claude:k1');
    expect(window.navigations).toEqual([]);
    expect(a.navigations).toEqual([]);
    expect(b.navigations).toEqual([]);
  });

  it('isOpen: the originating client’s, or whether any client is on screen', () => {
    const { registry, a } = rig({ windowOpen: false });
    expect(registry.surface.isOpen).toBe(true); // two browsers are connected
    expect(runInRequest(a.ctx, () => registry.surface.isOpen)).toBe(true);
    const lonely = new ClientRegistry({ log: () => undefined });
    expect(lonely.surface.isOpen).toBe(false);
  });
});

describe('channelFromDialogs: the window’s native dialogs', () => {
  it('maps prompts back to HostDialogs calls and picks to indexes', async () => {
    const calls: string[] = [];
    const dialogs: HostDialogs = {
      info: async (m, ...items) => (calls.push(`info:${m}`), items[0]),
      warn: async (m, o, ...items) => (calls.push(`warn:${m}:${o.modal ? 'modal' : ''}`), items[1]),
      error: (m) => void calls.push(`error:${m}`),
      flash: (m) => void calls.push(`flash:${m}`),
      input: async (o) => (calls.push(`input:${o.title}:${o.validateInput?.('') ?? 'ok'}`), 'typed'),
      pick: async (items) => items[1],
      pickFolder: async () => '/Users/test/proj',
    };
    const navigations: NavigateTarget[] = [];
    const registry = new ClientRegistry({ log: () => undefined });
    registry.register(channelFromDialogs({ connectionId: 'window', dialogs, isOpen: () => true, navigate: (t) => navigations.push(t) }));
    const ctx = ownerContext('browser', { connectionId: 'window' });
    await runInRequest(ctx, async () => {
      expect(await registry.dialogs.info('hi', 'A')).toBe('A');
      expect(await registry.dialogs.warn('sure?', { modal: true }, 'A', 'B')).toBe('B');
      registry.dialogs.error('bad');
      expect(await registry.dialogs.input({ title: 'T', validateInput: (v) => (v ? undefined : 'empty') })).toBe('typed');
      const items = [{ label: 'x' }, { label: 'y' }];
      expect(await registry.dialogs.pick(items)).toBe(items[1]);
      expect(await registry.dialogs.pickFolder()).toBe('/Users/test/proj');
      registry.dialogs.flash('note');
      registry.surface.openInTab('claude:k1');
    });
    expect(calls).toEqual(['info:hi', 'warn:sure?:modal', 'error:bad', 'input:T:empty', 'flash:note']);
    expect(navigations).toEqual([{ kind: 'tab', key: 'claude:k1' }]);
  });
});

describe('shell channel: a browser connection', () => {
  function browser() {
    const posted: HostToShell[] = [];
    const shown: string[] = [];
    const shell = createShellChannel({
      connectionId: 'web-1',
      kind: 'lan',
      post: (envelope) => {
        expect(envelope.pane).toBe('shell');
        posted.push(envelope.body);
      },
      conversation: () => ({
        show: (key) => shown.push(`show:${key}`),
        showSession: (h) => shown.push(`session:${h.sessionId}`),
        showDetail: () => shown.push('detail'),
      }),
    });
    const registry = new ClientRegistry({ log: () => undefined });
    const reg = registry.register(shell.channel);
    return { shell, registry, reg, posted, shown, ctx: ownerContext('browser', { connectionId: 'web-1' }) };
  }

  it('sends a prompt with an id and resolves with the promptResult', async () => {
    const { shell, registry, posted, ctx } = browser();
    const answer = runInRequest(ctx, () => registry.dialogs.warn('Close?', { modal: true, detail: 'It ends.' }, 'Close session'));
    await flush();
    expect(posted).toEqual([
      { type: 'prompt', id: 1, prompt: { kind: 'message', level: 'warn', message: 'Close?', items: ['Close session'], detail: 'It ends.', modal: true } },
    ]);
    shell.receive({ type: 'promptResult', id: 2, value: 'Close session' }); // not ours
    shell.receive({ type: 'nonsense' });
    shell.receive({ type: 'promptResult', id: 1, value: 'Close session' });
    expect(await answer).toBe('Close session');
  });

  it('a pick answers by index; null is cancelled', async () => {
    const { shell, registry, posted, ctx } = browser();
    const items = [{ label: 'a' }, { label: 'b' }];
    const first = runInRequest(ctx, () => registry.dialogs.pick(items));
    await flush();
    shell.receive({ type: 'promptResult', id: 1, value: 1 });
    expect(await first).toBe(items[1]);
    const second = runInRequest(ctx, () => registry.dialogs.pick(items));
    await flush();
    shell.receive({ type: 'promptResult', id: 2, value: null });
    expect(await second).toBeUndefined();
    expect(posted.map((p) => p.type)).toEqual(['prompt', 'prompt']);
  });

  it('checks input on each answer and asks again with the complaint', async () => {
    const { shell, registry, posted, ctx } = browser();
    const answer = runInRequest(ctx, () =>
      registry.dialogs.input({ title: 'Name', validateInput: (v) => (v.trim() ? undefined : 'A name cannot be blank.') }),
    );
    await flush();
    expect(posted[0]).toEqual({ type: 'prompt', id: 1, prompt: { kind: 'input', title: 'Name' } });
    shell.receive({ type: 'promptResult', id: 1, value: '  ' });
    await flush();
    expect(posted[1]).toEqual({ type: 'prompt', id: 2, prompt: { kind: 'input', title: 'Name', error: 'A name cannot be blank.', value: '  ' } });
    shell.receive({ type: 'promptResult', id: 2, value: 'Mine' });
    expect(await answer).toBe('Mine');
  });

  it('disconnecting mid-prompt resolves it as cancelled', async () => {
    const { shell, registry, reg, ctx } = browser();
    const answer = runInRequest(ctx, () => registry.dialogs.input({ title: 'Name' }));
    await flush();
    shell.dispose();
    reg.dispose();
    expect(await answer).toBeUndefined();
  });

  it('a closed channel resolves its own pending prompts too, without the registry', async () => {
    const { shell } = browser();
    const pending = shell.channel.prompt({ kind: 'input', title: 'x' });
    shell.dispose();
    expect(await pending).toBeUndefined();
    expect(await shell.channel.prompt({ kind: 'pickFolder' })).toBeUndefined();
  });

  it('navigation shows the conversation in this connection’s own pane and tells the shell', () => {
    const { registry, posted, shown, ctx } = browser();
    runInRequest(ctx, () => {
      registry.surface.show('claude:k1');
      registry.surface.showSession({ sessionId: 's2' } as SessionHandle);
    });
    expect(shown).toEqual(['show:claude:k1', 'session:s2']);
    expect(posted).toEqual([
      { type: 'navigate', target: 'conversation', key: 'claude:k1' },
      { type: 'navigate', target: 'conversation' },
    ]);
  });

  it('toasts go over the shell channel', () => {
    const { registry, posted, ctx } = browser();
    runInRequest(ctx, () => registry.dialogs.flash('Copied', 2500));
    expect(posted).toEqual([{ type: 'toast', text: 'Copied', timeoutMs: 2500 }]);
  });
});

describe('DashboardHost over two clients', () => {
  function paneChannel(): PaneChannel & { receive(m: DashboardToHost): void } {
    let listener: (m: DashboardToHost) => void = () => undefined;
    return {
      postMessage: async () => true,
      onDidReceiveMessage: (l) => {
        listener = l;
        return { dispose() {} };
      },
      receive: (m) => listener(m),
    };
  }

  /** Accepts any method call, so the host's constructor and unrelated paths run. */
  const anything = (overrides: Record<string, unknown> = {}): never =>
    new Proxy(overrides, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop in target) return target[prop as string];
        return () => ({ dispose() {} });
      },
    }) as never;

  function twoDashboards() {
    const { registry, window, a, b } = rig();
    const surface = registry.surface;
    const dialogs = registry.dialogs;
    // The app's actions and launcher, cut down to what each acceptance case needs:
    // they call the scoped dialogs and surface exactly as `createApp`'s do.
    const actions = anything({
      smartOpen: (key: string) => surface.show(key),
      closeSession: async (key: string) => {
        const ok = (await dialogs.warn(`Close ${key}?`, { modal: true }, 'Close session')) === 'Close session';
        if (ok) dialogs.flash('Closed');
        return ok;
      },
    });
    const launcher = anything({
      newConversation: async (cwd: string) => {
        await flush(); // a session host starting
        surface.showSession({ sessionId: `new-in-${cwd}` } as SessionHandle);
      },
      taskMenu: async () => {
        const route = await dialogs.pick([{ label: 'Delegate' }, { label: 'Cancel' }], { placeHolder: 'Task' });
        if (route?.label !== 'Delegate') return;
        await new Promise((r) => setTimeout(r, 2)); // the planner deciding
        surface.showSession({ sessionId: 'delegated' } as SessionHandle);
      },
    });
    const gate = createAccessGate({});
    const make = (ctx: RequestContext) => {
      const pane = paneChannel();
      new DashboardHost(
        pane, anything(), anything(), actions, anything(), anything(), anything(), anything(),
        anything(), anything(), launcher, anything(), anything(), dialogs, anything(),
        { context: ctx, gate }, anything(), anything(), anything(),
      );
      return pane;
    };
    return { window, a, b, paneA: make(a.ctx), paneB: make(b.ctx) };
  }

  it('a row click opens the conversation in the client that clicked', () => {
    const { window, a, b, paneB } = twoDashboards();
    paneB.receive({ type: 'rowClick', key: 'claude:k1' });
    expect(b.navigations).toEqual([{ kind: 'session', key: 'claude:k1' }]);
    expect(a.navigations).toEqual([]);
    expect(window.navigations).toEqual([]);
  });

  it('a row’s close confirm appears only in the client that pressed it', async () => {
    const { window, a, b, paneA } = twoDashboards();
    paneA.receive({ type: 'action', key: 'claude:k1', action: 'close', requestId: 'r1' });
    await flush();
    expect(a.prompts).toHaveLength(1);
    expect(b.prompts).toHaveLength(0);
    expect(window.prompts).toHaveLength(0);
    a.prompts[0].answer('Close session');
    await flush();
    expect(a.toasts).toEqual(['Closed']);
    expect(b.toasts).toEqual([]);
  });

  it('a new conversation opens in the client that started it, after the host starts', async () => {
    const { window, a, b, paneA } = twoDashboards();
    paneA.receive({ type: 'newConversation', cwd: '/Users/test/proj', provider: 'claude' });
    await flush();
    await flush();
    expect(a.navigations).toEqual([{ kind: 'handle', handle: { sessionId: 'new-in-/Users/test/proj' } }]);
    expect(b.navigations).toEqual([]);
    expect(window.navigations).toEqual([]);
  });

  it('a delegation asks and opens in the client that started it', async () => {
    const { window, a, b, paneB } = twoDashboards();
    paneB.receive({ type: 'taskMenu', cwd: '/Users/test/proj', provider: 'claude' });
    await flush();
    expect(b.prompts).toHaveLength(1);
    expect(a.prompts).toHaveLength(0);
    b.prompts[0].answer(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(b.navigations).toEqual([{ kind: 'handle', handle: { sessionId: 'delegated' } }]);
    expect(a.navigations).toEqual([]);
    expect(window.navigations).toEqual([]);
  });
});
