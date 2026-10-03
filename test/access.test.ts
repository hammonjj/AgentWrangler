/**
 * The access boundary (#123): every way in authorises before it acts.
 *
 * The structural half enumerates each dispatcher's entry points with mapped
 * types — every pane message type, every row action, every `SessionActions`
 * method, every control-backend method — so adding one without a sample here
 * is a type error. Each is then driven with an `authorize` that records and
 * refuses, and the test asserts that authorise ran exactly once, in a context
 * with a principal and a `via`, and that nothing behind the dispatcher ran.
 * The remote service's half lives in `remoteService.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ACTIONS,
  LOCAL_OWNER,
  authorize,
  createAccessGate,
  ownerContext,
  type AccessAuditRecord,
  type ActionName,
  type Authorizer,
  type BoundAccess,
  type PrincipalId,
  type RequestContext,
  type Via,
} from '../src/core/access';
import { DashboardHost } from '../src/ui/dashboardHost';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { guardSessionActions, AccessDeniedError } from '../src/ui/guardedActions';
import type { SessionActions } from '../src/ui/actions';
import type { PaneChannel } from '../src/ui/paneChannel';
import { createControlBackend } from '../src/app/controlBackend';
import type { AgentWranglerApp } from '../src/app/createApp';
import type { ControlBackend } from '../src/core/control/server';
import { ControlError } from '../src/core/control/server';
import { RPC_UNAUTHORIZED } from '../src/core/control/protocol';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import type { ConversationToHost, DashboardAction, DashboardToHost, HostToConversation } from '../src/shared/messages';
import type { AgentSession } from '../src/shared/model';

// ---- fakes ----

/** Every call on any dependency, by name. A refused request must leave this empty. */
type Calls = string[];

/**
 * A dependency that records any method called on it and returns a disposable,
 * so constructors can subscribe. Reading anything but a method is not
 * expected on a refused path, and would show up as a recorded call if it were.
 */
function recorder(calls: Calls, name: string): never {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return (..._args: unknown[]) => {
          calls.push(`${name}.${prop}`);
          return { dispose() {} };
        };
      },
    },
  ) as never;
}

/** An `authorize` that writes down what it was asked and refuses (or allows) it. */
function recordingAuthorizer(decision: 'allow' | 'deny' = 'deny') {
  const asked: { ctx: RequestContext; action: ActionName; resource?: string }[] = [];
  const fn: Authorizer = (ctx, action, resource) => {
    asked.push({ ctx, action, resource: resource?.id });
    return decision;
  };
  return { fn, asked };
}

function access(authorizeFn: Authorizer, via: Via = 'browser'): BoundAccess & { audit: AccessAuditRecord[] } {
  const audit: AccessAuditRecord[] = [];
  return {
    context: ownerContext(via, { connectionId: 'conn-1', deviceId: 'dev-1' }),
    gate: createAccessGate({ authorize: authorizeFn, audit: { write: (r) => audit.push(r) } }),
    audit,
  };
}

function channel<T>(): PaneChannel & { receive(m: T): void; posted: unknown[] } {
  let listener: (m: T) => void = () => undefined;
  const posted: unknown[] = [];
  return {
    postMessage: async (m) => {
      posted.push(m);
      return true;
    },
    onDidReceiveMessage: (l) => {
      listener = l as (m: T) => void;
      return { dispose() {} };
    },
    receive: (m: T) => listener(m),
    posted,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const KEY = 'claude:synthetic-1';

// ---- samples: one or more of every entry point, enforced by the types ----

type Samples<U extends { type: string }> = { [T in U['type']]: Extract<U, { type: T }>[] };

/** Every row action. A `Record`, so a new `DashboardAction` fails to compile here. */
const ROW_ACTIONS: Record<DashboardAction, true> = {
  openInTab: true, rename: true, resume: true, resumeHere: true, archive: true, copyId: true, close: true,
  dismiss: true, dismissHide: true, pause: true, unpause: true, allow: true, deny: true, always: true,
};

const DASHBOARD: Samples<DashboardToHost> = {
  ready: [{ type: 'ready' }],
  rowClick: [{ type: 'rowClick', key: KEY }],
  action: (Object.keys(ROW_ACTIONS) as DashboardAction[]).map((action) => ({ type: 'action', key: KEY, action, requestId: 'r1' })),
  answerQuestion: [{ type: 'answerQuestion', key: KEY, requestId: 'r1', answers: { q: 'a' } }],
  openExternal: [{ type: 'openExternal', url: 'https://example.com' }],
  refresh: [{ type: 'refresh' }],
  installHooks: [{ type: 'installHooks' }],
  setColumns: [{ type: 'setColumns', prefs: {} as never }],
  setDiscordNotifications: [{ type: 'setDiscordNotifications', value: false }],
  newConversation: [{ type: 'newConversation', cwd: '/Users/test/proj', provider: 'claude' }],
  taskMenu: [{ type: 'taskMenu', cwd: '/Users/test/proj' }],
  newMission: [{ type: 'newMission', cwd: '/Users/test/proj' }],
  mission: [{ type: 'mission', missionId: 'm1', op: { kind: 'approve' } as never, requestId: 'r1' }],
  setRunnerModel: [{ type: 'setRunnerModel', provider: 'anthropic', model: 'synthetic' }],
  setRunnerEffort: [{ type: 'setRunnerEffort', provider: 'openai', effort: 'high' }],
  browseProject: [{ type: 'browseProject' }],
  removeProject: [{ type: 'removeProject', dir: '/Users/test/proj' }],
  setProjectFavourite: [{ type: 'setProjectFavourite', dir: '/Users/test/proj', favourite: true }],
  refreshProjects: [{ type: 'refreshProjects' }],
  pauseAll: [{ type: 'pauseAll', pause: true }],
  analyticsQuery: [{ type: 'analyticsQuery', selection: {} as never }],
  analyticsDetail: [{ type: 'analyticsDetail', selection: {} as never, ref: { kind: 'metric', id: 'x' } as never }],
  analyticsProposal: [{ type: 'analyticsProposal', id: 'p1', decision: 'accept' }],
};

const CONVERSATION: Samples<ConversationToHost> = {
  ready: [{ type: 'ready' }],
  closeDetail: [{ type: 'closeDetail' }],
  delegationOfferDecision: [{ type: 'delegationOfferDecision', offerId: 'o1', outcome: 'accepted' }],
  send: [{ type: 'send', text: 'synthetic', requestId: 's1', sessionKey: KEY }],
  cancelSend: [{ type: 'cancelSend' }],
  interrupt: [{ type: 'interrupt' }],
  decide: [{ type: 'decide', requestId: 'r1', decision: 'allow' }],
  answer: [{ type: 'answer', requestId: 'r1', answers: { q: 'a' } }],
  plan: [{ type: 'plan', requestId: 'r1', decision: 'approve' }],
  setPermissionMode: [{ type: 'setPermissionMode', mode: 'default' }],
  setModel: [{ type: 'setModel', model: 'synthetic' }],
  setEffort: [{ type: 'setEffort', effort: 'high' }],
  adopt: [{ type: 'adopt' }],
  release: [{ type: 'release' }],
  openInTab: [{ type: 'openInTab' }],
  resumeHere: [{ type: 'resumeHere' }],
  installHooks: [{ type: 'installHooks' }],
  requestBlockText: [{ type: 'requestBlockText', id: 'b1' }],
  archive: [{ type: 'archive', requestId: 'r1' }],
  subagent: [{ type: 'subagent', id: 'b1', toolUseId: 't1' }],
  openDiff: [{ type: 'openDiff', file: '/Users/test/proj/a.ts', patch: '' }],
  openExternal: [{ type: 'openExternal', url: 'https://example.com' }],
  openFile: [{ type: 'openFile', path: '/Users/test/proj/a.ts' }],
  taskAction: [{ type: 'taskAction', missionId: 'm1', action: 'retry' as never }],
  proposalDecision: [{ type: 'proposalDecision', missionId: 'm1', decision: 'cancel' as never }],
  delegationAction: [{ type: 'delegationAction', missionId: 'm1', action: 'cancel' as never }],
  openAttempt: [{ type: 'openAttempt', sessionKey: KEY }],
  dictate: [{ type: 'dictate', action: 'start' }],
  fileSuggest: [{ type: 'fileSuggest', query: 'a' }],
  dropPaths: [{ type: 'dropPaths', paths: ['/Users/test/proj/a.ts'] }],
};

const all = <U extends { type: string }>(s: Samples<U>): U[] => Object.values(s).flat() as U[];

// ---- rigs ----

function dashboardRig(authorizeFn: Authorizer) {
  const calls: Calls = [];
  const webview = channel<DashboardToHost>();
  const acc = access(authorizeFn);
  const r = (n: string) => recorder(calls, n);
  const host = new DashboardHost(
    webview, r('store'), r('archive'), r('actions'), r('health'), r('usage'), r('codexUsage'), r('columns'),
    r('runners'), r('projects'), r('launcher'), r('pause'), r('settings'), r('dialogs'), r('models'),
    acc, r('tasks'), r('missions'), r('analytics'),
  );
  calls.length = 0; // the constructor's subscriptions
  return { host, calls, webview, acc };
}

function conversationRig(authorizeFn: Authorizer) {
  const calls: Calls = [];
  const webview = channel<ConversationToHost>();
  const acc = access(authorizeFn);
  const r = (n: string) => recorder(calls, n);
  const disposable = () => ({ dispose() {} });
  const session = { key: KEY, sessionId: 'synthetic-1', provider: 'claude', cwd: '/Users/test/proj', status: 'waiting' } as AgentSession;
  const act = (name: string) => async () => {
    calls.push(`handle.${name}`);
    return 'applied';
  };
  // A live session the pane is bound to, so every message has something it could act on.
  const handle = {
    provider: 'claude', sessionId: session.sessionId, liveSession: session, canSend: true, lifecycle: 'running',
    composer: { busy: true },
    onReset: disposable, onAppend: disposable, onPatch: disposable, onComposer: disposable,
    history: async () => ({ blocks: [], truncated: false }), snapshot: () => ({ blocks: [], truncated: false }),
    send: act('send'), interrupt: act('interrupt'), decide: act('decide'), answer: act('answer'), decidePlan: act('decidePlan'),
    setPermissionMode: act('setPermissionMode'), setModel: act('setModel'), setEffort: act('setEffort'),
    fullBlockText: () => {
      calls.push('handle.fullBlockText');
      return undefined;
    },
  } as unknown as SessionHandle;
  type Args = ConstructorParameters<typeof ConversationHost>;
  const host = new ConversationHost(
    webview,
    { onDidUpdate: disposable, get: () => session } as unknown as Args[1],
    r('provider'), r('codexProvider'),
    { onDidChange: disposable, get: () => handle } as unknown as Args[4],
    r('runners'), r('actions'), r('dictation'), r('files'), () => undefined, r('ui'),
    acc, r('tasks'),
  );
  host.showSession(handle);
  calls.length = 0; // binding touches the runner; that is not a request
  return { host, calls, webview, acc };
}

// ---- the policy ----

describe('authorize: single-user policy', () => {
  it('allows the owner every action, through every channel', () => {
    for (const via of ['browser', 'cli', 'discord', 'daemon'] as const) {
      for (const action of Object.keys(ACTIONS) as ActionName[]) {
        expect(authorize(ownerContext(via), action)).toBe('allow');
      }
    }
  });

  it('denies any other principal', () => {
    const stranger = { principal: { id: 'someone-else' as PrincipalId, kind: 'owner' as const }, via: 'browser' as const };
    expect(authorize(stranger, 'view.read')).toBe('deny');
    expect(authorize(stranger, 'session.send')).toBe('deny');
  });

  it('never treats a device or connection id as identity', () => {
    // A device or tab claiming to be the owner is still nobody...
    const forged = {
      principal: { id: 'device-x' as PrincipalId, kind: 'owner' as const },
      via: 'browser' as const,
      deviceId: LOCAL_OWNER.id,
      connectionId: LOCAL_OWNER.id,
    };
    expect(authorize(forged, 'session.send')).toBe('deny');
    // ...and the owner is the owner whatever device or tab it is on.
    expect(authorize(ownerContext('browser', { deviceId: 'anything', connectionId: 'anything' }), 'session.send')).toBe('allow');
  });
});

describe('access gate: audit', () => {
  it('audits a mutating action with principal, via and attribution ids, and not a read', () => {
    const records: AccessAuditRecord[] = [];
    const gate = createAccessGate({ audit: { write: (r) => records.push(r) } });
    const ctx = ownerContext('browser', { deviceId: 'dev-1', connectionId: 'conn-1' });
    expect(gate.admit(ctx, 'view.read')).toBe(true);
    expect(gate.admit(ctx, 'session.open', { kind: 'session', id: KEY })).toBe(true);
    expect(records).toEqual([]);
    expect(gate.admit(ctx, 'session.close', { kind: 'session', id: KEY })).toBe(true);
    expect(records).toEqual([
      { event: 'authorized', principal: 'local-owner', via: 'browser', action: 'session.close', resource: { kind: 'session', id: KEY }, deviceId: 'dev-1', connectionId: 'conn-1' },
    ]);
  });

  it('audits every refusal, reads included', () => {
    const records: AccessAuditRecord[] = [];
    const gate = createAccessGate({ authorize: () => 'deny', audit: { write: (r) => records.push(r) } });
    expect(gate.admit(ownerContext('cli'), 'view.read')).toBe(false);
    expect(records).toEqual([{ event: 'refused-unauthorised', principal: 'local-owner', via: 'cli', action: 'view.read' }]);
  });
});

// ---- the dispatchers ----

describe('DashboardHost: every message is authorised before it acts', () => {
  it.each(all(DASHBOARD).map((m) => [m.type === 'action' ? `action:${m.action}` : m.type, m] as const))(
    '%s: refused → authorised once, as the owner via browser, and nothing ran',
    async (_name, m) => {
      const auth = recordingAuthorizer('deny');
      const rig = dashboardRig(auth.fn);
      rig.webview.receive(m);
      await flush();
      expect(auth.asked).toHaveLength(1);
      expect(auth.asked[0].ctx.principal).toBe(LOCAL_OWNER);
      expect(auth.asked[0].ctx.via).toBe('browser');
      expect(rig.calls).toEqual([]);
      expect(rig.webview.posted).toEqual([]);
      expect(rig.acc.audit).toHaveLength(1);
      expect(rig.acc.audit[0]).toMatchObject({ event: 'refused-unauthorised', principal: 'local-owner', via: 'browser' });
      rig.host.dispose();
    },
  );

  it('allowed, a mutating message reaches its action and is audited', async () => {
    const auth = recordingAuthorizer('allow');
    const rig = dashboardRig(auth.fn);
    rig.webview.receive({ type: 'action', key: KEY, action: 'close' });
    rig.webview.receive({ type: 'setColumns', prefs: {} as never });
    await flush();
    expect(rig.calls).toEqual(['actions.closeSession', 'columns.set']);
    expect(rig.acc.audit.map((r) => [r.event, r.action, r.resource?.id])).toEqual([
      ['authorized', 'session.close', KEY],
      ['authorized', 'prefs.write', undefined],
    ]);
    rig.host.dispose();
  });
});

describe('ConversationHost: every message is authorised before it acts', () => {
  it.each(all(CONVERSATION).map((m) => [m.type, m] as const))(
    '%s: refused → authorised once, as the owner via browser, and nothing ran',
    async (_name, m) => {
      const auth = recordingAuthorizer('deny');
      const rig = conversationRig(auth.fn);
      rig.webview.receive(m);
      await flush();
      expect(auth.asked).toHaveLength(1);
      expect(auth.asked[0].ctx.principal).toBe(LOCAL_OWNER);
      expect(auth.asked[0].ctx.via).toBe('browser');
      expect(rig.calls).toEqual([]);
      // The one thing a refusal posts: a send is answered, so the composer is not left waiting.
      const posted = rig.webview.posted as HostToConversation[];
      if (m.type === 'send') expect(posted).toEqual([{ type: 'sendResult', requestId: 's1', error: 'Not permitted.' }]);
      else expect(posted).toEqual([]);
      rig.host.dispose();
    },
  );

  it('allowed, a mutating message reaches the session and is audited against it', async () => {
    const auth = recordingAuthorizer('allow');
    const rig = conversationRig(auth.fn);
    rig.webview.receive({ type: 'interrupt' });
    rig.webview.receive({ type: 'release' });
    await flush();
    expect(rig.calls).toEqual(['handle.interrupt', 'actions.release']);
    expect(rig.acc.audit.map((r) => [r.action, r.resource?.id, r.connectionId])).toEqual([
      ['session.interrupt', KEY, 'conn-1'],
      ['session.release', KEY, 'conn-1'],
    ]);
    rig.host.dispose();
  });
});

describe('guardSessionActions: the menu, the tray and the remote link', () => {
  const SAMPLES: { [K in keyof SessionActions]: (a: SessionActions) => unknown } = {
    smartOpen: (a) => a.smartOpen(KEY),
    openInTab: (a) => a.openInTab(KEY),
    rename: (a) => a.rename(KEY),
    adopt: (a) => a.adopt(KEY),
    adoptAndSend: (a) => a.adoptAndSend(KEY, 'synthetic', undefined, new AbortController().signal),
    release: (a) => a.release(KEY),
    closeSession: (a) => a.closeSession(KEY),
    pauseSession: (a) => a.pauseSession(KEY, true),
    pauseAll: (a) => a.pauseAll(true),
    resume: (a) => a.resume(KEY),
    copyId: (a) => a.copyId(KEY),
    reveal: (a) => a.reveal(KEY),
    refreshAll: (a) => a.refreshAll(),
    openExternal: (a) => a.openExternal('https://example.com'),
    openFile: (a) => a.openFile('/Users/test/proj/a.ts'),
    installHooks: (a) => a.installHooks(),
    decidePermission: (a) => a.decidePermission(KEY, 'allow'),
    answerQuestion: (a) => a.answerQuestion(KEY, 'r1', {}),
    decidePlan: (a) => a.decidePlan(KEY, 'r1', true),
  };

  it.each(Object.entries(SAMPLES))('%s: refused → nothing ran', async (_name, call) => {
    const calls: Calls = [];
    const auth = recordingAuthorizer('deny');
    const guarded = guardSessionActions(recorder(calls, 'actions'), access(auth.fn, 'discord'));
    const result = call(guarded);
    if (result instanceof Promise) {
      const settled = await result.then((v) => v, (e: unknown) => e);
      if (settled !== false) expect(settled).toBeInstanceOf(AccessDeniedError);
    }
    expect(auth.asked).toHaveLength(1);
    expect(auth.asked[0].ctx.via).toBe('discord');
    expect(calls).toEqual([]);
  });

  it('allowed, the call goes through', () => {
    const calls: Calls = [];
    const guarded = guardSessionActions(recorder(calls, 'actions'), access(recordingAuthorizer('allow').fn));
    void guarded.decidePermission(KEY, 'deny');
    expect(calls).toEqual(['actions.decidePermission']);
  });
});

describe('control backend (aw): every method is authorised before it acts', () => {
  function rig(decision: 'allow' | 'deny') {
    const calls: Calls = [];
    const session = { key: KEY, sessionId: 'synthetic-1', provider: 'claude', status: 'waiting', lastActivityAt: 1 } as AgentSession;
    const spy = (name: string, value?: unknown) => vi.fn(async () => {
      calls.push(name);
      return value;
    });
    const handle = { canSend: true, send: spy('handle.send', 'applied'), snapshot: () => ({ blocks: [], truncated: false, seq: 0 }) };
    const app = {
      store: { sessions: [session] },
      archive: { isArchived: () => false },
      sessions: { get: () => handle, onDidChange: () => ({ dispose() {} }), list: () => [] },
      sessionRegistry: { get: () => undefined },
      sessionCounts: () => ({ hosted: 0, local: 0 }),
      runBy: () => 'app',
      projects: { value: [] },
      stopSession: spy('stopSession', 'stopped'),
      proposeTask: spy('proposeTask', {}),
      delegate: spy('delegate', {}),
      taskList: () => {
        calls.push('taskList');
        return [];
      },
    } as unknown as AgentWranglerApp;
    const auth = recordingAuthorizer(decision);
    const backend = createControlBackend(app, { build: 'test', appPid: 1, startedAt: 0, gate: createAccessGate({ authorize: auth.fn }) });
    return { backend, calls, auth };
  }

  /** Every method but `describe`, the handshake's build info. A mapped type: a new method must be listed. */
  const METHODS: { [K in Exclude<keyof ControlBackend, 'describe'>]: (b: ControlBackend) => unknown } = {
    status: (b) => b.status(),
    sessions: (b) => b.sessions({ all: true }),
    session: (b) => b.session(KEY),
    subscribe: (b) => b.subscribe(KEY, 10, () => undefined, () => undefined),
    send: (b) => b.send(KEY, 'synthetic'),
    stop: (b) => b.stop(KEY, false),
    projects: (b) => b.projects(),
    proposeTask: (b) => b.proposeTask({ objective: 'synthetic', cwd: '/Users/test/proj' } as never),
    delegate: (b) => b.delegate({ objective: 'synthetic', cwd: '/Users/test/proj' } as never),
    tasks: (b) => b.tasks(),
    webLink: (b) => b.webLink(),
  };

  it.each(Object.entries(METHODS))('%s: refused → RPC_UNAUTHORIZED via cli, and nothing ran', async (_name, call) => {
    const r = rig('deny');
    let error: unknown;
    try {
      await call(r.backend);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe(RPC_UNAUTHORIZED);
    expect(r.auth.asked).toHaveLength(1);
    expect(r.auth.asked[0].ctx).toMatchObject({ principal: LOCAL_OWNER, via: 'cli' });
    expect(r.calls).toEqual([]);
  });

  it('allowed, send and stop act on the resolved session', async () => {
    const r = rig('allow');
    await r.backend.send(KEY, 'synthetic');
    await r.backend.stop(KEY, false);
    expect(r.calls).toEqual(['handle.send', 'stopSession']);
    expect(r.auth.asked.map((a) => [a.action, a.resource])).toEqual([
      ['session.send', KEY],
      ['session.close', KEY],
    ]);
  });
});
