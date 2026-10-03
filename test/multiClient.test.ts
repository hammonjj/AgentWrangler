/**
 * Several browsers, one daemon (#132, plan §7.2 and §8): every client sees the
 * same truth, and an ask answered anywhere disappears everywhere.
 *
 * A real `WebServer` with `ws`, the real connection layer and client registry,
 * the real `DashboardHost` and `ConversationHost` per connection, and the real
 * approval actions (`src/app/approvals.ts`) and remote service, over a fake
 * app: a store, live session handles that hold their asks the way a session
 * host does, and nothing else. On the other end, plain `ws` clients, and for
 * view state the real browser shim.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createAccessGate, ownerContext, type AccessGate, type RequestContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { Emitter, type Disposable } from '../src/core/events';
import { DecoratedSessions } from '../src/core/sessionView';
import type { CommandOutcome, SessionHandle } from '../src/core/session/sessionHandle';
import { createBrowserConnections, type BrowserConnections } from '../src/core/web/browserConnections';
import { WebServer } from '../src/core/web/server';
import { createApprovalActions, pendingPermissions } from '../src/app/approvals';
import { MemoryAuditLog } from '../src/remote/audit';
import { MirrorStore } from '../src/remote/mirrorStore';
import { RemoteControlService, type RemoteConfig } from '../src/remote/service';
import type { RemoteClose, RemoteInvocation, RemoteMessageRef, RemoteTransport } from '../src/remote/transport';
import type { BlockPatch, ConvBlock } from '../src/shared/conversation';
import type { AgentSession } from '../src/shared/model';
import type { RemoteAsk, RemoteNotice } from '../src/shared/remote';
import { SHELL_PANE } from '../src/shared/shellProtocol';
import type { SessionActions } from '../src/ui/actions';
import { DashboardHost, type RunnerOwnership } from '../src/ui/dashboardHost';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { guardSessionActions, SESSION_ACTION_NAMES } from '../src/ui/guardedActions';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';
import { paneChannel } from '../src/ui/paneChannel';
import { isMutatingPaneMessage } from '../src/ui/paneMutations';

const KEY = 'claude:synthetic-1';
const OTHER = 'claude:synthetic-2';

const disposable = () => ({ dispose() {} });
const noEvent = (): Disposable => disposable();

function recorder(): never {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return () => ({ dispose() {} });
      },
    },
  ) as never;
}

// ---- the app, faked ----

/**
 * A live session as a session host presents it: it holds the blocks and the
 * pending asks, and settles an ask once. A second answer to the same request
 * is `stale`, as `RunnerView` says. Every answer records who called it, so the
 * structural test can say they all came through `approvals.ts`.
 */
class FakeRunner {
  readonly provider = 'claude' as const;
  readonly lifecycle = 'running' as const;
  readonly canSend = true;
  readonly composer = { busy: false } as SessionHandle['composer'];
  readonly blocks: ConvBlock[] = [];
  /** `decide:req-1` per answer that reached the agent. */
  readonly applied: string[] = [];
  /** The stack of every answer call, settled or not. */
  readonly callers: string[] = [];
  private appends = new Emitter<ConvBlock[]>();
  private patches = new Emitter<BlockPatch>();

  constructor(
    readonly sessionId: string,
    private changed: Emitter<void>,
  ) {}

  get pendingQuestion() {
    return this.blocks.find((b): b is Extract<ConvBlock, { kind: 'question' }> => b.kind === 'question' && b.state === 'pending');
  }
  get pendingPlan() {
    return this.blocks.find((b): b is Extract<ConvBlock, { kind: 'plan' }> => b.kind === 'plan' && b.state === 'pending');
  }

  onAppend = (l: (blocks: ConvBlock[]) => void) => this.appends.event(l);
  onPatch = (l: (patch: BlockPatch) => void) => this.patches.event(l);
  onComposer = noEvent;
  onReset = noEvent;
  onLifecycle = noEvent;
  history = async () => ({ blocks: [], truncated: false });
  snapshot = () => ({ blocks: this.blocks.map((b) => ({ ...b })), truncated: false });
  fullBlockText = () => undefined;
  send = async () => 'applied' as const;

  /** The agent says something, or asks something. */
  append(block: ConvBlock): void {
    this.blocks.push({ ...block });
    this.appends.fire([block]);
    // As `RunnerService` does: an ask opening changes the row and the remote.
    if (block.kind === 'permission' || block.kind === 'question' || block.kind === 'plan') this.changed.fire();
  }

  async decide(requestId: string, decision: 'allow' | 'always' | 'deny'): Promise<CommandOutcome> {
    return this.settle('decide', 'permission', requestId, { state: decision === 'deny' ? 'denied' : 'allowed' });
  }
  async answer(requestId: string, answers: Record<string, string>): Promise<CommandOutcome> {
    return this.settle('answer', 'question', requestId, { state: 'allowed', answers });
  }
  async decidePlan(requestId: string, approve: boolean): Promise<CommandOutcome> {
    return this.settle('plan', 'plan', requestId, { state: approve ? 'allowed' : 'denied' });
  }

  private settle(call: string, kind: ConvBlock['kind'], requestId: string, patch: Partial<ConvBlock>): CommandOutcome {
    this.callers.push(new Error().stack ?? '');
    const block = this.blocks.find((b) => b.kind === kind && 'requestId' in b && b.requestId === requestId && 'state' in b && b.state === 'pending');
    if (!block) return 'stale';
    Object.assign(block, patch);
    this.applied.push(`${call}:${requestId}`);
    this.patches.fire({ id: block.id, block: patch });
    this.changed.fire();
    return 'applied';
  }
}

function sessionRow(key: string): AgentSession {
  const sessionId = key.split(':')[1];
  return { key, sessionId, provider: 'claude', cwd: '/Users/test/proj', status: 'busy', title: `session ${sessionId}`, lastActivityAt: 1 } as AgentSession;
}

type ActionSpies = { [K in keyof SessionActions]: ReturnType<typeof vi.fn> } & SessionActions;

/**
 * The app as the panes, the remote and the approvals see it. `actions` is
 * every `SessionActions` method as a spy; the three approval methods are the
 * real ones, the rest record and do nothing, except a row click, which shows
 * the session in the clicking client's pane exactly as `createApp` does.
 */
function fakeApp(registry: ClientRegistry, log: string[]) {
  const rows = new Map<string, AgentSession>([KEY, OTHER].map((k) => [k, sessionRow(k)]));
  const storeUpdates = new Emitter<void>();
  const store = {
    get sessions() {
      return [...rows.values()];
    },
    get: (key: string) => rows.get(key),
    nicknameOf: (key: string) => rows.get(key)?.nickname,
    onDidUpdate: (l: () => void) => storeUpdates.event(l),
  };
  const runnersChanged = new Emitter<void>();
  const runners = new Map([KEY, OTHER].map((k) => [k.split(':')[1], new FakeRunner(k.split(':')[1], runnersChanged)]));
  const executors = {
    get: (id: string | undefined) => (id ? runners.get(id) : undefined) as SessionHandle | undefined,
    owns: (id: string | undefined) => (id ? runners.has(id) : false),
    onDidChange: (l: () => void) => runnersChanged.event(l),
  };
  // As `createApp` builds it, over the same handles.
  const ownership: RunnerOwnership = {
    owns: executors.owns,
    pendingQuestion: (id) => {
      const q = id ? runners.get(id)?.pendingQuestion : undefined;
      return q ? { requestId: q.requestId, questions: q.questions } : undefined;
    },
    pendingPlan: (id) => {
      const p = id ? runners.get(id)?.pendingPlan : undefined;
      return p ? { requestId: p.requestId, plan: p.plan } : undefined;
    },
    pendingPermission: (id) => {
      const handle = id ? runners.get(id) : undefined;
      const requestId = handle ? pendingPermissions(handle).at(-1) : undefined;
      const ask = handle?.blocks.find((b) => b.kind === 'permission' && b.requestId === requestId);
      return ask?.kind === 'permission' ? { requestId: ask.requestId, toolName: ask.toolName, ask: { summary: ask.summary } } : undefined;
    },
    onDidChange: executors.onDidChange,
  };
  const decideByHook = vi.fn(async () => false);
  const approvals = createApprovalActions({
    store,
    live: (id) => executors.get(id),
    decideByHook,
    flash: (message, timeoutMs) => registry.dialogs.flash(message, timeoutMs),
    log: (line) => log.push(line),
  });
  const actions = Object.fromEntries(Object.keys(SESSION_ACTION_NAMES).map((name) => [name, vi.fn()])) as unknown as ActionSpies;
  actions.smartOpen.mockImplementation((key: string) => {
    if (rows.has(key)) registry.surface.show(key);
  });
  actions.decidePermission.mockImplementation(approvals.decidePermission);
  actions.answerQuestion.mockImplementation(approvals.answerQuestion);
  actions.decidePlan.mockImplementation(approvals.decidePlan);

  return {
    store,
    executors,
    ownership,
    actions,
    decideByHook,
    runner: (key: string) => runners.get(key.split(':')[1])!,
    rename(key: string, nickname: string) {
      rows.set(key, { ...rows.get(key)!, nickname });
      storeUpdates.fire();
    },
  };
}

type App = ReturnType<typeof fakeApp>;

/** The table host with everything it reads that is not under test held still. */
function dashboardHost(transport: Parameters<typeof paneChannel>[0], app: App, registry: ClientRegistry, access: { context: RequestContext; gate: AccessGate }) {
  const projects: never[] = [];
  return new DashboardHost(
    paneChannel(transport, 'dashboard'),
    app.store as never,
    { isArchived: () => false, onDidChange: noEvent, toggle() {}, set() {} } as never,
    app.actions,
    { hookHealth: undefined, onDidChangeHookHealth: noEvent },
    { usage: {} as never, enabled: false, onDidChange: noEvent, refresh: async () => undefined },
    { usage: {} as never, enabled: false, onDidChange: noEvent, refresh: async () => undefined },
    { value: undefined, onDidChange: noEvent, set() {} } as never,
    app.ownership,
    { value: projects, refresh: async () => projects, onDidChange: noEvent, add() {}, remove() {}, setFavourite() {} },
    { newConversation: async () => undefined, browseForProject: async () => undefined },
    { refresh: async () => undefined, isPaused: () => false, onDidChange: noEvent } as never,
    { get: <T>(_k: string, d?: T) => d as T, onDidChange: noEvent, update: async () => undefined } as never,
    registry.dialogs,
    { value: [], onDidChange: noEvent } as never,
    access,
  );
}

// ---- the server ----

interface Rig {
  server: WebServer;
  conns: BrowserConnections;
  registry: ClientRegistry;
  app: App;
  gate: AccessGate;
  port: number;
  cookie: string;
  hosts: ConversationHost[];
  log: string[];
}

let dir: string;
let rig: Rig;

async function startRig(): Promise<Rig> {
  const log: string[] = [];
  const registry = new ClientRegistry({ log: (m) => log.push(m) });
  const app = fakeApp(registry, log);
  const hosts: ConversationHost[] = [];
  const webviewDir = path.join(dir, 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
  const gate = createAccessGate();
  let server!: WebServer;
  const conns = createBrowserConnections({
    clients: registry,
    log: (m) => log.push(m),
    build: () => server.build(),
    isMutating: isMutatingPaneMessage,
    // Every snapshot straight out: convergence, not coalescing, is under test here.
    limits: { pingIntervalMs: 0, snapshotIntervalMs: 0, hiddenSnapshotIntervalMs: 0 },
    createPanes: (transport, context) => {
      const access = { context, gate };
      const conversation = new ConversationHost(
        paneChannel(transport, 'conversation'),
        app.store as never,
        recorder(), recorder(),
        app.executors as never,
        { touch() {} },
        app.actions,
        recorder(), recorder(), () => undefined,
        { dialogs: registry.dialogs, offerDictationSetup: async () => undefined },
        access,
      );
      hosts.push(conversation);
      return { dashboard: dashboardHost(transport, app, registry, access), conversation };
    },
  });
  server = new WebServer({
    port: 0,
    webviewDir,
    dataDir: path.join(dir, 'data'),
    gate,
    log: (m) => log.push(m),
    page: renderBrowserWorkbenchHtml,
    onClient: (ws, context: RequestContext) => conns.attach(ws, context),
  });
  const port = await server.listen();
  const code = new URL(server.loginLink().url).searchParams.get('code');
  const cookie = await new Promise<string>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: `/login?code=${code}`, headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
        res.resume();
        resolve(String(res.headers['set-cookie']?.[0]).split(';')[0]);
      })
      .on('error', reject);
  });
  return { server, conns, registry, app, gate, port, cookie, hosts, log };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-multiclient-'));
});

afterEach(() => {
  rig?.conns.dispose();
  rig?.server.dispose();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until<T>(check: () => T | undefined | false, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 60));

// ---- a browser tab, as its two panes behave ----

interface Frame {
  pane: string;
  body: { type: string; [k: string]: unknown };
}

type Row = AgentSession & { pendingQuestion?: { requestId: string } };

class Tab {
  readonly frames: Frame[] = [];
  readonly ws: WebSocket;
  private seq = 0;

  constructor(
    r: Rig,
    private readonly name: string,
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, { headers: { origin: `http://127.0.0.1:${r.port}`, cookie: r.cookie } });
    this.ws.on('message', (data) => this.frames.push(JSON.parse(String(data))));
  }

  /** Connected, and both panes have said `ready`: the table, and the conversation it remembers. */
  async open(key?: string): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.post('dashboard', { type: 'ready' });
    this.post('conversation', { type: 'ready', ...(key ? { key } : {}) });
    await until(() => this.snapshot(), `${this.name}'s table`);
    if (key) await until(() => this.init(), `${this.name}'s conversation`);
    return this;
  }

  post(pane: string, body: object): void {
    this.ws.send(JSON.stringify({ pane, body, commandId: `${this.name}.${++this.seq}` }));
  }

  of(pane: string, type: string): Frame['body'][] {
    return this.frames.filter((f) => f.pane === pane && f.body.type === type).map((f) => f.body);
  }

  /** The table as it stands now. */
  snapshot(): { sessions: Row[] } | undefined {
    return this.of('dashboard', 'snapshot').at(-1) as never;
  }
  row(key: string): Row | undefined {
    return this.snapshot()?.sessions.find((s) => s.key === key);
  }
  init(): { session: AgentSession; blocks: ConvBlock[] } | undefined {
    return this.of('conversation', 'init').at(-1) as never;
  }
  /** The first patch to block `id`: how an ask's card is settled. */
  patchFor(id: string): { state?: string; answers?: Record<string, string> } | undefined {
    return (this.of('conversation', 'patch').find((p) => p.id === id) as { block: { state?: string } } | undefined)?.block;
  }
  toasts(): string[] {
    return this.of(SHELL_PANE, 'toast').map((t) => t.text as string);
  }

  /** What the conversation pane shows: its last init, with every append and patch since applied. */
  blocks(): ConvBlock[] {
    let blocks: ConvBlock[] = [];
    for (const f of this.frames) {
      if (f.pane !== 'conversation') continue;
      if (f.body.type === 'init') blocks = (f.body.blocks as ConvBlock[]).map((b) => ({ ...b }));
      else if (f.body.type === 'append') blocks.push(...(f.body.blocks as ConvBlock[]).map((b) => ({ ...b })));
      else if (f.body.type === 'patch') {
        const b = blocks.find((x) => x.id === f.body.id);
        if (b) Object.assign(b, f.body.block);
      }
    }
    return blocks;
  }
}

const PERMISSION: ConvBlock = { kind: 'permission', id: 'p-1', requestId: 'req-p1', toolName: 'Bash', summary: 'Run the tests', state: 'pending' };
const QUESTION: ConvBlock = {
  kind: 'question',
  id: 'q-1',
  requestId: 'req-q1',
  questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] as never,
  state: 'pending',
};
const PLAN: ConvBlock = { kind: 'plan', id: 'plan-1', requestId: 'req-plan1', plan: '# Plan\n\nRewrite the parser.', state: 'pending' };

const ALREADY = /already been answered/;

/** Two tabs on one conversation, with `ask` open in it and on both screens. */
async function twoTabsOn(ask: ConvBlock): Promise<[Tab, Tab]> {
  rig = await startRig();
  rig.app.runner(KEY).append(ask);
  const a = await new Tab(rig, 'a').open(KEY);
  const b = await new Tab(rig, 'b').open(KEY);
  for (const tab of [a, b]) {
    expect(tab.init()?.blocks.find((x) => x.id === ask.id)).toMatchObject({ state: 'pending' });
  }
  return [a, b];
}

/** The outcome the last call of an approval spy resolved with. */
async function lastOutcome(spy: ReturnType<typeof vi.fn>): Promise<unknown> {
  return spy.mock.results.at(-1)?.value;
}

// ---- the tests ----

describe('two clients, one permission', () => {
  it('both see it; A allows from the conversation; B\'s card and row clear; B\'s late answers are stale and only B is told', async () => {
    const [a, b] = await twoTabsOn(PERMISSION);
    for (const tab of [a, b]) expect(tab.row(KEY)).toMatchObject({ status: 'blocked', permissionRequestId: 'req-p1' });

    a.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });

    // B's card is settled by the handle's patch, and its row by the next snapshot.
    for (const tab of [a, b]) {
      await until(() => tab.patchFor('p-1')?.state === 'allowed', 'the card to settle');
      await until(() => tab.row(KEY)?.permissionRequestId === undefined, 'the row to clear');
      expect(tab.row(KEY)?.status).toBe('busy');
    }
    expect(rig.app.runner(KEY).applied).toEqual(['decide:req-p1']);

    // B pressed the row's Allow and the card's before its screen caught up.
    b.post('dashboard', { type: 'action', key: KEY, action: 'allow', requestId: 'req-p1' });
    await until(() => b.toasts().length === 1, 'the toast for the row');
    expect(await lastOutcome(rig.app.actions.decidePermission)).toBe('stale');
    b.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'deny' });
    await until(() => b.toasts().length === 2, 'the toast for the card');
    expect(await lastOutcome(rig.app.actions.decidePermission)).toBe('stale');
    expect(b.toasts()).toEqual([
      'Agent Wrangler: that prompt for session synthetic-1 has already been answered.',
      'Agent Wrangler: that prompt for session synthetic-1 has already been answered.',
    ]);

    // Nothing reached the agent twice, and A was told nothing about B's presses.
    await settle();
    expect(rig.app.runner(KEY).applied).toEqual(['decide:req-p1']);
    expect(a.toasts()).toEqual([]);
    expect(rig.app.decideByHook).not.toHaveBeenCalled();
  });

  it('the same from the table: A allows on its row, B\'s card clears', async () => {
    const [a, b] = await twoTabsOn(PERMISSION);
    a.post('dashboard', { type: 'action', key: KEY, action: 'allow', requestId: 'req-p1' });
    await until(() => b.patchFor('p-1')?.state === 'allowed', 'B\'s card to settle');
    await until(() => b.row(KEY)?.permissionRequestId === undefined, 'B\'s row to clear');
    b.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
    await until(() => b.toasts().length === 1, 'the toast');
    expect(b.toasts()[0]).toMatch(ALREADY);
    expect(a.toasts()).toEqual([]);
    expect(rig.app.runner(KEY).applied).toEqual(['decide:req-p1']);
  });

  it('a press for a prompt that has been replaced lands on neither', async () => {
    const [a, b] = await twoTabsOn(PERMISSION);
    a.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
    await until(() => b.patchFor('p-1'), 'B\'s card to settle');
    // The agent asks again; B answers the old one from a stale row.
    rig.app.runner(KEY).append({ ...PERMISSION, id: 'p-2', requestId: 'req-p2' } as ConvBlock);
    await until(() => b.row(KEY)?.permissionRequestId === 'req-p2', 'the new prompt on B\'s row');
    b.post('dashboard', { type: 'action', key: KEY, action: 'deny', requestId: 'req-p1' });
    await until(() => b.toasts().length === 1, 'the toast');
    expect(rig.app.runner(KEY).applied).toEqual(['decide:req-p1']);
    expect(b.row(KEY)?.permissionRequestId).toBe('req-p2');
  });
});

describe('two clients, one question', () => {
  it('A answers on its row; B\'s card and row clear; B\'s late answer is stale and only B is told', async () => {
    const [a, b] = await twoTabsOn(QUESTION);
    for (const tab of [a, b]) expect(tab.row(KEY)?.pendingQuestion?.requestId).toBe('req-q1');

    a.post('dashboard', { type: 'answerQuestion', key: KEY, requestId: 'req-q1', answers: { 'Which database?': 'Postgres' } });
    for (const tab of [a, b]) {
      await until(() => tab.patchFor('q-1')?.state === 'allowed', 'the card to settle');
      await until(() => tab.row(KEY) && tab.row(KEY)?.pendingQuestion === undefined, 'the row to clear');
    }
    expect(b.patchFor('q-1')).toMatchObject({ answers: { 'Which database?': 'Postgres' } });

    b.post('conversation', { type: 'answer', requestId: 'req-q1', answers: { 'Which database?': 'SQLite' } });
    await until(() => b.toasts().length === 1, 'the toast');
    expect(await lastOutcome(rig.app.actions.answerQuestion)).toBe('stale');
    expect(b.toasts()).toEqual(['Agent Wrangler: that question for session synthetic-1 has already been answered.']);
    // Once, not twice: the table used to add its own line on top of the action's.
    b.post('dashboard', { type: 'answerQuestion', key: KEY, requestId: 'req-q1', answers: { 'Which database?': 'SQLite' } });
    await until(() => b.toasts().length === 2, 'the second toast');
    await settle();
    expect(b.toasts()).toHaveLength(2);
    expect(a.toasts()).toEqual([]);
    expect(rig.app.runner(KEY).applied).toEqual(['answer:req-q1']);
  });
});

describe('two clients, one plan', () => {
  it('A approves in its conversation; B\'s card clears; B\'s late rejection is stale and only B is told', async () => {
    const [a, b] = await twoTabsOn(PLAN);
    a.post('conversation', { type: 'plan', requestId: 'req-plan1', decision: 'approve' });
    for (const tab of [a, b]) await until(() => tab.patchFor('plan-1')?.state === 'allowed', 'the card to settle');

    b.post('conversation', { type: 'plan', requestId: 'req-plan1', decision: 'deny', feedback: 'no' });
    await until(() => b.toasts().length === 1, 'the toast');
    expect(await lastOutcome(rig.app.actions.decidePlan)).toBe('stale');
    expect(b.toasts()).toEqual(['Agent Wrangler: that plan for session synthetic-1 has already been answered.']);
    await settle();
    expect(a.toasts()).toEqual([]);
    expect(rig.app.runner(KEY).applied).toEqual(['plan:req-plan1']);
  });
});

// ---- Discord ----

/** A transport that records, and presses buttons when told to. */
class FakeTransport implements RemoteTransport {
  readonly id = 'fake';
  connected = true;
  published: { interactionId: string; ask: RemoteAsk }[] = [];
  closed: { ref: RemoteMessageRef; outcome: RemoteClose }[] = [];
  replies: string[] = [];
  private seq = 0;
  private invoke = new Emitter<RemoteInvocation>();
  onDidInvoke = (l: (i: RemoteInvocation) => void): Disposable => this.invoke.event(l);
  onDidChangeConnection = noEvent;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publish(interactionId: string, ask: RemoteAsk): Promise<RemoteMessageRef> {
    this.published.push({ interactionId, ask });
    return { channelId: 'C1', messageId: `M${this.seq++}` };
  }
  async update(): Promise<void> {}
  async close(ref: RemoteMessageRef, _ask: RemoteAsk, outcome: RemoteClose): Promise<void> {
    this.closed.push({ ref, outcome });
  }
  async reply(_invocation: RemoteInvocation, text: string): Promise<void> {
    this.replies.push(text);
  }
  async notify(_notice: RemoteNotice): Promise<void> {}
  dispose(): void {}
  press(choiceId: string): void {
    const last = this.published.at(-1)!;
    this.invoke.fire({ interactionId: last.interactionId, choiceId, actor: { id: 'U-allowed', displayName: 'Tester' }, scope: { guildId: 'G1', channelId: 'C1' } });
  }
}

const REMOTE: RemoteConfig = { enabled: true, notificationsEnabled: true, guildId: 'G1', channelId: 'C1', authorizedUserIds: ['U-allowed'] };

/** The remote service as the app wires it: the decorated store, and the actions behind Discord's gate. */
function remote(r: Rig) {
  const sessions = new DecoratedSessions(
    r.app.store as never,
    {
      isArchived: () => false,
      isPaused: () => false,
      runnerOwned: (id) => r.app.ownership.owns(id),
      pendingQuestion: (id) => r.app.ownership.pendingQuestion?.(id) as never,
      pendingPlan: (id) => r.app.ownership.pendingPlan?.(id),
      pendingPermission: (id) => r.app.ownership.pendingPermission?.(id),
    },
    [r.app.ownership],
  );
  const transport = new FakeTransport();
  const svc = new RemoteControlService(
    sessions,
    guardSessionActions(r.app.actions, { context: ownerContext('discord'), gate: r.gate }),
    new MirrorStore(path.join(dir, 'mirrors.json')),
    () => REMOTE,
    new MemoryAuditLog(),
  );
  svc.setTransport(transport);
  return { svc, transport, dispose: () => (svc.dispose(), sessions.dispose()) };
}

describe('a Discord press while two clients are connected', () => {
  it.each([
    ['permission', PERMISSION, 'allow', 'decide:req-p1'],
    ['question', QUESTION, 'opt1', 'answer:req-q1'],
    ['plan', PLAN, 'approve', 'plan:req-plan1'],
  ] as const)('a %s: both clients clear, and neither is told anything', async (_kind, ask, choice, applied) => {
    const [a, b] = await twoTabsOn(ask);
    const discord = remote(rig);
    try {
      await until(() => discord.transport.published.length === 1, 'the Discord card');
      discord.transport.press(choice);
      await discord.svc.whenIdle();
      for (const tab of [a, b]) await until(() => tab.patchFor(ask.id)?.state === 'allowed', 'the card to settle');
      for (const tab of [a, b]) {
        await until(() => tab.row(KEY) && !tab.row(KEY)?.permissionRequestId && !tab.row(KEY)?.pendingQuestion, 'the row to clear');
      }
      await until(() => discord.transport.closed.length === 1, 'the Discord card to close');
      expect(rig.app.runner(KEY).applied).toEqual([applied]);
      await settle();
      // The press had no client behind it, so no browser is shown a line about it.
      expect(a.toasts()).toEqual([]);
      expect(b.toasts()).toEqual([]);
    } finally {
      discord.dispose();
    }
  });

  it('a client answering first closes the Discord card, and no client is told', async () => {
    const [a, b] = await twoTabsOn(PERMISSION);
    const discord = remote(rig);
    try {
      await until(() => discord.transport.published.length === 1, 'the Discord card');
      a.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
      await until(() => b.patchFor('p-1'), 'B\'s card to settle');
      await discord.svc.whenIdle();
      await until(() => discord.transport.closed.length === 1, 'the Discord card to close');
      expect(discord.transport.closed[0].outcome.outcome).toBe('answered-locally');
      await settle();
      expect(a.toasts()).toEqual([]);
      expect(b.toasts()).toEqual([]);
      expect(rig.app.runner(KEY).applied).toEqual(['decide:req-p1']);
    } finally {
      discord.dispose();
    }
  });

  it('a Discord press that reaches the action late is stale, logged, and toasted to nobody', async () => {
    rig = await startRig();
    rig.app.runner(KEY).append(PERMISSION);
    const a = await new Tab(rig, 'a').open(KEY);
    await rig.app.actions.decidePermission(KEY, 'allow', { expectedRequestId: 'req-p1' });
    // What the remote service would call, as Discord: no client behind the request.
    const outcome = await guardSessionActions(rig.app.actions, { context: ownerContext('discord'), gate: rig.gate }).decidePermission(KEY, 'allow', {
      expectedRequestId: 'req-p1',
    });
    expect(outcome).toBe('stale');
    await settle();
    expect(a.toasts()).toEqual([]);
    expect(rig.log.some((l) => ALREADY.test(l))).toBe(true);
  });
});

// ---- reconnect ----

describe('reconnecting after missed updates', () => {
  it('converges: the table and the conversation B gets back are what A has been shown all along', async () => {
    const [a, b] = await twoTabsOn(PERMISSION);
    b.ws.terminate();
    await until(() => rig.conns.size === 1, 'B to drop');

    // While B is away: the permission is answered, the agent says more, and the session is renamed.
    a.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
    await until(() => a.patchFor('p-1'), 'A\'s card to settle');
    rig.app.runner(KEY).append({ kind: 'assistant', id: 'r-1', text: 'Tests pass.' } as ConvBlock);
    rig.app.rename(KEY, 'Parser work');
    await until(() => a.of('conversation', 'append').length === 1, 'A to see the reply');
    await until(() => a.row(KEY)?.nickname === 'Parser work', 'A to see the rename');
    await until(() => (a.of('conversation', 'session').at(-1)?.session as AgentSession | undefined)?.nickname === 'Parser work', 'A\'s header');

    const b2 = await new Tab(rig, 'b').open(KEY);
    const init = b2.init()!;
    expect(init.session.nickname).toBe('Parser work');
    expect(init.blocks).toEqual([
      { ...PERMISSION, state: 'allowed' },
      { kind: 'assistant', id: 'r-1', text: 'Tests pass.' },
    ]);
    // What A built up from deltas is what B got in one go.
    expect(b2.blocks()).toEqual(a.blocks());
    const strip = (s: { nowMs?: unknown } | undefined) => ({ ...s, nowMs: 0 });
    expect(strip(b2.snapshot() as never)).toEqual(strip(a.snapshot() as never));
    expect(b2.row(KEY)).toMatchObject({ nickname: 'Parser work', status: 'busy' });
    expect(b2.row(KEY)?.permissionRequestId).toBeUndefined();
    expect(rig.conns.size).toBe(2);
    // The card B came back to offers nothing to press; an answer it had queued is stale, and only B hears so.
    b2.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
    await until(() => b2.toasts().length === 1, 'the toast');
    expect(b2.toasts()[0]).toMatch(ALREADY);
    expect(a.toasts()).toEqual([]);
    expect(rig.app.runner(KEY).applied).toEqual(['decide:req-p1']);
  });
});

// ---- view state ----

describe('view state stays per client', () => {
  it('one client\'s selection never moves another\'s', async () => {
    rig = await startRig();
    const a = await new Tab(rig, 'a').open(KEY);
    const b = await new Tab(rig, 'b').open(OTHER);
    expect(a.init()?.session.key).toBe(KEY);
    expect(b.init()?.session.key).toBe(OTHER);

    // A row click on A: A's pane moves, and A is told to bring it forward.
    a.post('dashboard', { type: 'rowClick', key: OTHER });
    await until(() => a.init()?.session.key === OTHER, 'A to show the other session');
    expect(a.of(SHELL_PANE, 'navigate')).toEqual([{ type: 'navigate', target: 'conversation', key: OTHER }]);
    // A `show` from B's own pane: B moves.
    b.post('conversation', { type: 'openAttempt', sessionKey: KEY });
    await until(() => b.init()?.session.key === KEY, 'B to show the first session');
    await settle();

    expect(a.of('conversation', 'init').map((i) => (i.session as AgentSession).key)).toEqual([KEY, OTHER]);
    expect(b.of('conversation', 'init').map((i) => (i.session as AgentSession).key)).toEqual([OTHER, KEY]);
    expect(b.of(SHELL_PANE, 'navigate')).toEqual([]);
    expect(rig.hosts.map((h) => h.sessionKey)).toEqual([OTHER, KEY]);

    // The app showing something by itself (no client asked) moves nobody's pane.
    rig.registry.surface.show(KEY);
    await settle();
    expect(rig.hosts.map((h) => h.sessionKey)).toEqual([OTHER, KEY]);
  });

  it('a client\'s view of a session it is not showing is untouched by another answering there', async () => {
    rig = await startRig();
    rig.app.runner(KEY).append(PERMISSION);
    const a = await new Tab(rig, 'a').open(KEY);
    const b = await new Tab(rig, 'b').open(OTHER);
    a.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
    await until(() => b.row(KEY) && !b.row(KEY)?.permissionRequestId, 'B\'s table to clear');
    await settle();
    // B's table moved; B's conversation, on another session, did not.
    expect(b.of('conversation', 'patch')).toEqual([]);
    expect(b.of('conversation', 'init')).toHaveLength(1);
  });

  it('scroll, split and drafts live in each browser\'s own storage and never reach the server', async () => {
    rig = await startRig();
    const sent: string[] = [];
    const browser = (storage: Map<string, string>) => {
      const win = new EventTarget() as EventTarget & { postMessage(data: unknown, origin: string): void };
      win.postMessage = (data) => win.dispatchEvent(new MessageEvent('message', { data }));
      const r = rig;
      class BrowserSocket extends WebSocket {
        constructor(url: string) {
          super(url, { headers: { origin: `http://127.0.0.1:${r.port}`, cookie: r.cookie } });
          this.on('error', () => undefined);
        }
        override send(data: string): void {
          sent.push(String(data));
          super.send(data);
        }
      }
      vi.stubGlobal('window', win);
      vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, body: null, querySelector: () => ({ content: r.server.build() }), getElementById: () => null }));
      vi.stubGlobal('location', { protocol: 'http:', host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, reload: vi.fn() });
      vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
      vi.stubGlobal('WebSocket', BrowserSocket);
      return win;
    };
    const load = async (storage: Map<string, string>) => {
      const win = browser(storage);
      vi.resetModules();
      await import('../src/webview/webshim/main');
      const { paneApi, splitState } = await import('../src/webview/common/paneApi');
      const conversation = paneApi<{ key: string; scrollTop?: number; draft?: string }>('conversation');
      const dashboard = paneApi<{ collapsed: string[] }>('dashboard');
      return { win, conversation, dashboard, splitState };
    };

    // The desk: a conversation scrolled up, a draft half-typed, the divider moved.
    const desk = new Map<string, string>();
    const a = await load(desk);
    a.conversation.post({ type: 'ready', key: KEY });
    await until(() => rig.conns.size === 1, 'the desk to connect');
    a.conversation.setState({ key: KEY, scrollTop: 480, draft: 'half-typed reply' });
    a.dashboard.setState({ collapsed: ['Ended'] });
    a.splitState.set(0.3);
    await until(() => rig.hosts[0]?.sessionKey === KEY, 'the desk\'s conversation');

    // The phone: a browser of its own.
    const phone = new Map<string, string>();
    const b = await load(phone);
    await until(() => rig.conns.size === 2, 'the phone to connect');
    expect(b.conversation.getState()).toBeUndefined();
    expect(b.dashboard.getState()).toBeUndefined();
    expect(b.splitState.get()).toBeUndefined();
    b.conversation.setState({ key: OTHER, scrollTop: 0, draft: 'from the phone' });
    b.splitState.set(0.8);

    expect(JSON.parse(desk.get('aw.workbench.state')!)).toEqual({
      conversation: { key: KEY, scrollTop: 480, draft: 'half-typed reply' },
      dashboard: { collapsed: ['Ended'] },
      split: 0.3,
    });
    expect(JSON.parse(phone.get('aw.workbench.state')!)).toEqual({ conversation: { key: OTHER, scrollTop: 0, draft: 'from the phone' }, split: 0.8 });
    // Nothing of it went over the wire: the server keeps no view state to mix up.
    await settle();
    expect(sent.length).toBeGreaterThan(0);
    for (const line of sent) expect(line).not.toMatch(/half-typed|from the phone|scrollTop|split|collapsed/);
  });
});

// ---- no approval path around SessionActions ----

describe('no approval path bypasses SessionActions', () => {
  it('every surface answers through the action, and every answer that reaches a session comes from approvals.ts', async () => {
    const [a] = await twoTabsOn(PERMISSION);
    const { actions } = rig.app;
    const runner = rig.app.runner(KEY);

    a.post('dashboard', { type: 'action', key: KEY, action: 'allow', requestId: 'req-p1' });
    await until(() => actions.decidePermission.mock.calls.length === 1, 'the row\'s answer');
    a.post('conversation', { type: 'decide', requestId: 'req-p1', decision: 'allow' });
    await until(() => actions.decidePermission.mock.calls.length === 2, 'the card\'s answer');

    runner.append(QUESTION);
    a.post('dashboard', { type: 'answerQuestion', key: KEY, requestId: 'req-q1', answers: { x: 'y' } });
    await until(() => actions.answerQuestion.mock.calls.length === 1, 'the row\'s question');
    a.post('conversation', { type: 'answer', requestId: 'req-q1', answers: { x: 'y' } });
    await until(() => actions.answerQuestion.mock.calls.length === 2, 'the card\'s question');

    runner.append(PLAN);
    a.post('conversation', { type: 'plan', requestId: 'req-plan1', decision: 'approve' });
    await until(() => actions.decidePlan.mock.calls.length === 1, 'the card\'s plan');

    runner.append({ ...PERMISSION, id: 'p-9', requestId: 'req-p9' } as ConvBlock);
    const discord = remote(rig);
    try {
      await until(() => discord.transport.published.length === 1, 'the Discord card');
      discord.transport.press('deny');
      await discord.svc.whenIdle();
      expect(actions.decidePermission).toHaveBeenCalledTimes(3);
    } finally {
      discord.dispose();
    }

    expect(runner.applied).toEqual(['decide:req-p1', 'answer:req-q1', 'plan:req-plan1', 'decide:req-p9']);
    // Five calls reached the handle (the card's late question among them; the
    // card's late permission was refused before it); every one from the approval actions.
    expect(runner.callers).toHaveLength(5);
    for (const stack of runner.callers) expect(stack).toMatch(/src[\\/]app[\\/]approvals\.ts/);
  });

  /**
   * Every call shaped like an answer, in the main-process source. A call on
   * `actions` (a `SessionActions`) is the funnel itself and allowed anywhere.
   * Anything else must be listed here with the reason it is not a way round:
   * a new caller fails this test until someone has looked at it.
   */
  it('nothing outside the approval actions answers a session directly', () => {
    const allowed: Record<string, string> = {
      // The funnel: approvals answers through the live handle, and createApp hands it the hook path.
      'src/app/approvals.ts: live.decide': 'the approval actions',
      'src/app/approvals.ts: live.answer': 'the approval actions',
      'src/app/approvals.ts: live.decidePlan': 'the approval actions',
      'src/app/createApp.ts: provider.decidePermission': 'the hook path, handed to createApprovalActions as decideByHook',
      'src/claude/claudeProvider.ts: this.hooks.decide': 'the hook file itself, behind provider.decidePermission',
      // Wrappers that end in SessionActions.
      'src/ui/dashboardHost.ts: this.answerQuestion': 'the table\'s wrapper round actions.answerQuestion',
      'src/ui/conversation/conversationHost.ts: source.decide': 'a transcript card, whose source calls actions.decidePermission',
      'src/ui/conversation/transcriptSource.ts: this.decidePermission': 'the callback ConversationHost builds over actions.decidePermission',
      'src/remote/daemon/client.ts: a.decidePermission': 'the app end of the remote daemon link: guarded SessionActions',
      'src/remote/daemon/client.ts: a.answerQuestion': 'the app end of the remote daemon link: guarded SessionActions',
      'src/remote/daemon/client.ts: a.decidePlan': 'the app end of the remote daemon link: guarded SessionActions',
      'src/remote/daemon/sources.ts: this.active.decidePermission': 'the daemon feed switch: the app link above, or its local feed',
      'src/remote/daemon/sources.ts: this.active.answerQuestion': 'the daemon feed switch',
      'src/remote/daemon/sources.ts: this.active.decidePlan': 'the daemon feed switch',
      // Not an ask: the delegation offer's "not now".
      'src/ui/conversation/conversationHost.ts: this.suggestion.decide': 'a delegation offer, not an agent ask',
      // Known, and owned by #138: the remote daemon answers by itself while the
      // app is not running, where there is no SessionActions to go through. It
      // goes when Discord moves into the core daemon, beside the core's actions.
      'src/remote/daemon/localFeed.ts: this.hosted.decide': '#138',
      'src/remote/daemon/localFeed.ts: this.hosted.answer': '#138',
      'src/remote/daemon/localFeed.ts: this.hosted.decidePlan': '#138',
      'src/remote/daemon/localFeed.ts: this.provider.decidePermission': '#138',
    };
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (p !== path.join(root, 'src', 'webview')) walk(p);
        } else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(path.join(root, 'src'));
    const call = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*?)\??\.(decide|answer|decidePlan|decidePermission|answerQuestion)\??\.?\(/g;
    const found = new Set<string>();
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const m of line.matchAll(call)) {
          const receiver = m[1].replace(/\?/g, '');
          if (/(^|\.)actions$/.test(receiver)) continue;
          found.add(`${rel}: ${receiver}.${m[2]}`);
        }
      }
    }
    const unexpected = [...found].filter((f) => !(f in allowed));
    expect(unexpected).toEqual([]);
    // And the list is not stale: every entry still exists.
    expect(Object.keys(allowed).filter((k) => !found.has(k))).toEqual([]);
  });
});
