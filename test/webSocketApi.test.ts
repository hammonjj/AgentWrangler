/**
 * The browser WebSocket API (#128): a real `WebServer` with `ws`, the real
 * connection layer, the real `ConversationHost` over fakes of the app, a fake
 * table host, and on the other end either a plain `ws` client or the real
 * browser shim (`src/webview/webshim`) and `paneApi`, run in Node against
 * stubbed `window`/`document`/`location` and a `WebSocket` that sends the
 * cookie a browser would.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createAccessGate, type RequestContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { Emitter } from '../src/core/events';
import { createBrowserConnections, SnapshotCoalescer, type BrowserConnections, type ConnectionLimits, type EnvelopeTransport } from '../src/core/web/browserConnections';
import { CommandResults } from '../src/core/web/commandResults';
import { WebServer } from '../src/core/web/server';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import { RECONNECT_EVENT, SHELL_PANE, WIRE_PROTOCOL } from '../src/shared/shellProtocol';
import { emptyModalHost, modalHostReceive, modalHostStep, type ModalEvent, type ModalHostEffect, type ModalHostState } from '../src/shared/modalModel';
import { runInRequest } from '../src/core/requestScope';
import type { AgentSession } from '../src/shared/model';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';
import { paneChannel } from '../src/ui/paneChannel';
import { isMutatingPaneMessage } from '../src/ui/paneMutations';

const KEY = 'claude:synthetic-1';
const OTHER = 'claude:synthetic-2';

// ---- the app, faked ----

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

const disposable = () => ({ dispose() {} });

function sessionRow(key: string): AgentSession {
  return { key, sessionId: key.split(':')[1], provider: 'claude', cwd: '/Users/test/proj', status: 'waiting' } as AgentSession;
}

/** One Claude conversation per key, live, whose `send` is recorded and can be held. */
function fakeSessions() {
  const delivered: string[] = [];
  let hold: Promise<void> | undefined;
  let onSend: (() => void) | undefined;
  const handles = new Map<string, SessionHandle>();
  for (const key of [KEY, OTHER]) {
    const row = sessionRow(key);
    handles.set(row.sessionId, {
      provider: 'claude', sessionId: row.sessionId, liveSession: row, canSend: true, lifecycle: 'running',
      composer: { busy: false },
      onReset: disposable, onAppend: disposable, onPatch: disposable, onComposer: disposable,
      history: async () => ({ blocks: [], truncated: false }), snapshot: () => ({ blocks: [], truncated: false }),
      send: async (text: string) => {
        delivered.push(text);
        onSend?.();
        await hold;
        return 'applied';
      },
      interrupt: async () => 'applied', decide: async () => 'applied', answer: async () => 'applied', decidePlan: async () => 'applied',
      setPermissionMode: async () => 'applied', setModel: async () => 'applied', setEffort: async () => 'applied',
      fullBlockText: () => undefined,
    } as unknown as SessionHandle);
  }
  return {
    delivered,
    store: { onDidUpdate: disposable, get: (key: string) => (key === KEY || key === OTHER ? sessionRow(key) : undefined) },
    executors: { onDidChange: disposable, get: (id: string) => handles.get(id) },
    /** Hold every send until the returned function is called; `during` runs as each one is delivered. */
    holdSends(during?: () => void): () => void {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      onSend = during;
      return () => {
        hold = undefined;
        onSend = undefined;
        release();
      };
    },
  };
}

type Sessions = ReturnType<typeof fakeSessions>;
type HostArgs = ConstructorParameters<typeof ConversationHost>;

/** The table host, faked: a snapshot on `ready` and on every store update. */
function fakeDashboard(transport: EnvelopeTransport, updates: Emitter<void>, snapshot: () => object) {
  const ch = paneChannel(transport, 'dashboard');
  const post = () => void ch.postMessage({ type: 'snapshot', nowMs: Date.now(), ...snapshot() });
  const subs = [
    ch.onDidReceiveMessage((m: { type?: string }) => {
      if (m.type === 'ready') post();
    }),
    updates.event(post),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()), post: (body: object) => void ch.postMessage(body) };
}

// ---- the server ----

interface Rig {
  server: WebServer;
  conns: BrowserConnections;
  port: number;
  cookie: string;
  sessions: Sessions;
  updates: Emitter<void>;
  /** Server-side sockets, newest last. */
  sockets: WebSocket[];
  hosts: { conversation: ConversationHost; disposed: boolean }[];
  /** Post as each connection's table host, by connection order. */
  dashboardPosts: ((body: object) => void)[];
  /** The clients connected, for asking one a question (#126/#133). */
  clients: ClientRegistry;
  /** Each connection's own request context, by connection order. */
  contexts: RequestContext[];
  log: string[];
}

let dir: string;
let rig: Rig;

async function startRig(opts: { limits?: Partial<ConnectionLimits>; snapshot?: () => object } = {}): Promise<Rig> {
  const sessions = fakeSessions();
  const updates = new Emitter<void>();
  const log: string[] = [];
  const sockets: WebSocket[] = [];
  const hosts: Rig['hosts'] = [];
  const dashboardPosts: Rig['dashboardPosts'] = [];
  const contexts: RequestContext[] = [];
  const clients = new ClientRegistry({ log: (m) => log.push(m) });
  const webviewDir = path.join(dir, 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
  const gate = createAccessGate();
  let server!: WebServer;
  const conns = createBrowserConnections({
    clients,
    log: (m) => log.push(m),
    build: () => server.build(),
    isMutating: isMutatingPaneMessage,
    results: new CommandResults(),
    limits: { pingIntervalMs: 0, ...opts.limits },
    createPanes: (transport, context) => {
      contexts.push(context);
      const conversation = new ConversationHost(
        paneChannel(transport, 'conversation'),
        sessions.store as unknown as HostArgs[1],
        recorder(), recorder(),
        sessions.executors as unknown as HostArgs[4],
        recorder(), recorder(), recorder(), recorder(), () => undefined, recorder(),
        { context, gate },
      );
      const entry = { conversation, disposed: false };
      hosts.push(entry);
      const dashboard = fakeDashboard(transport, updates, opts.snapshot ?? (() => ({ sessions: [{ key: KEY }] })));
      dashboardPosts.push(dashboard.post);
      return {
        dashboard,
        conversation: Object.assign(conversation, {
          dispose: () => {
            entry.disposed = true;
            ConversationHost.prototype.dispose.call(conversation);
          },
        }),
      };
    },
  });
  server = new WebServer({
    port: 0,
    webviewDir,
    dataDir: path.join(dir, 'data'),
    gate,
    log: (m) => log.push(m),
    page: renderBrowserWorkbenchHtml,
    onClient: (ws, context: RequestContext) => {
      sockets.push(ws);
      conns.attach(ws, context);
    },
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
  return { server, conns, port, cookie, sessions, updates, sockets, hosts, dashboardPosts, clients, contexts, log };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-wsapi-'));
});

afterEach(() => {
  rig?.conns.dispose();
  rig?.server.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

// ---- a plain client ----

interface Frame {
  pane: string;
  body: { type: string; [k: string]: unknown };
}

class Client {
  readonly frames: Frame[] = [];
  readonly ws: WebSocket;
  socket: net.Socket | undefined;
  closeCode: number | undefined;
  private seq = 0;

  constructor(r: Rig, opts: { deflate?: boolean } = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, {
      headers: { origin: `http://127.0.0.1:${r.port}`, cookie: r.cookie },
      perMessageDeflate: opts.deflate ?? true,
    });
    this.ws.on('upgrade', (res) => (this.socket = res.socket as net.Socket));
    this.ws.on('message', (data) => this.frames.push(JSON.parse(String(data))));
    this.ws.on('close', (code) => (this.closeCode = code));
  }

  async open(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    return this;
  }

  post(pane: string, body: object, commandId = `tab-a.${++this.seq}`): string {
    this.ws.send(JSON.stringify({ pane, body, commandId }));
    return commandId;
  }

  of(pane: string, type: string): Frame[] {
    return this.frames.filter((f) => f.pane === pane && f.body.type === type);
  }
}

// ---- the tests ----

describe('handshake', () => {
  it('the server says hello first, with the protocol and the build the page carries', async () => {
    rig = await startRig();
    const c = await new Client(rig).open();
    const hello = await until(() => c.frames[0], 'hello');
    expect(hello).toEqual({ pane: SHELL_PANE, body: { type: 'hello', protocol: WIRE_PROTOCOL, build: rig.server.build() } });
    expect(rig.server.build()).toMatch(/^[0-9a-f]{16}$/);
    const page = await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: rig.port, path: '/', headers: { host: `127.0.0.1:${rig.port}`, cookie: rig.cookie }, agent: false }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      });
    });
    expect(page).toContain(`<meta name="aw-build" content="${rig.server.build()}">`);
    // A rebuild is another build.
    const before = rig.server.build();
    fs.writeFileSync(path.join(dir, 'webview', 'workbench.js'), '/* rebuilt */\n');
    expect(rig.server.build()).not.toBe(before);
  });

  it('negotiates permessage-deflate', async () => {
    rig = await startRig();
    const c = await new Client(rig).open();
    expect(c.ws.extensions).toContain('permessage-deflate');
  });

  it('acknowledges every pane envelope, in a batch', async () => {
    rig = await startRig();
    const c = await new Client(rig).open();
    const a = c.post('dashboard', { type: 'ready' });
    const b = c.post('conversation', { type: 'ready' });
    const acks = await until(() => c.of(SHELL_PANE, 'ack').length > 0 && c.of(SHELL_PANE, 'ack'), 'ack');
    expect(acks.flatMap((f) => f.body.ids as string[])).toEqual([a, b]);
  });
});

describe('exactly-once', () => {
  it('a send resent with the same commandId is delivered once, and the resend gets the first result', async () => {
    rig = await startRig();
    const c = await new Client(rig).open();
    c.post('conversation', { type: 'ready', key: KEY });
    await until(() => c.of('conversation', 'init').length > 0, 'init');
    const send = { type: 'send', text: 'hello', requestId: 's1', sessionKey: KEY };
    c.post('conversation', send, 'tab-a.send-1');
    c.post('conversation', send, 'tab-a.send-1');
    await until(() => c.of('conversation', 'sendResult').length >= 2, 'two results');
    expect(rig.sessions.delivered).toEqual(['hello']);
    expect(c.of('conversation', 'sendResult').map((f) => f.body)).toEqual([
      { type: 'sendResult', requestId: 's1', adopted: false },
      { type: 'sendResult', requestId: 's1', adopted: false },
    ]);

    // On another connection of the same device, too: that is what a resend after a drop is.
    const d = await new Client(rig).open();
    d.post('conversation', { type: 'ready', key: KEY });
    await until(() => d.of('conversation', 'init').length > 0, 'init');
    d.post('conversation', send, 'tab-a.send-1');
    await until(() => d.of('conversation', 'sendResult').length > 0, 'replayed result');
    expect(rig.sessions.delivered).toEqual(['hello']);

    // A new commandId is a new send.
    d.post('conversation', { ...send, requestId: 's2' }, 'tab-a.send-2');
    await until(() => rig.sessions.delivered.length === 2, 'second send');
  });

  it('a resend that arrives while the first is still running waits for its result', async () => {
    rig = await startRig();
    const release = rig.sessions.holdSends();
    const c = await new Client(rig).open();
    c.post('conversation', { type: 'ready', key: KEY });
    await until(() => c.of('conversation', 'init').length > 0, 'init');
    const send = { type: 'send', text: 'once', requestId: 's1', sessionKey: KEY };
    c.post('conversation', send, 'tab-a.s');
    await until(() => rig.sessions.delivered.length === 1, 'delivery');
    const d = await new Client(rig).open();
    d.post('conversation', { type: 'ready', key: KEY });
    await until(() => d.of('conversation', 'init').length > 0, 'init');
    d.post('conversation', send, 'tab-a.s');
    await new Promise((r) => setTimeout(r, 30));
    expect(d.of('conversation', 'sendResult')).toEqual([]);
    release();
    await until(() => d.of('conversation', 'sendResult').length > 0, 'forwarded result');
    expect(rig.sessions.delivered).toEqual(['once']);
  });

  it('reads are not remembered: an archive request asked again is answered again', async () => {
    expect(isMutatingPaneMessage('conversation', { type: 'archive', requestId: 'r1' })).toBe(false);
    expect(isMutatingPaneMessage('conversation', { type: 'ready' })).toBe(false);
    expect(isMutatingPaneMessage('conversation', { type: 'send', text: 'x' })).toBe(true);
    expect(isMutatingPaneMessage('dashboard', { type: 'action', key: KEY, action: 'close' })).toBe(true);
    expect(isMutatingPaneMessage('dashboard', { type: 'refresh' })).toBe(false);
    expect(isMutatingPaneMessage('dashboard', { type: 'made-up' })).toBe(true);
  });

  it('the cache forgets after ten minutes, and holds a bounded number per device', () => {
    let now = 0;
    const results = new CommandResults({ now: () => now, maxPerDevice: 3 });
    const t = results.connection('dev');
    const post = () => undefined;
    expect(t.admit('a', 'conversation', {}, post)).toBe(true);
    expect(t.admit('a', 'conversation', {}, post)).toBe(false);
    now += 10 * 60_000;
    expect(t.admit('a', 'conversation', {}, post)).toBe(true);
    for (const id of ['b', 'c', 'd', 'e']) t.admit(id, 'conversation', {}, post);
    expect(results.size('dev')).toBe(3);
    expect(t.admit('b', 'conversation', {}, post)).toBe(true); // evicted, so new again
  });
});

describe('backpressure', () => {
  it('a connection over its buffered-bytes ceiling is closed with 1013', async () => {
    const big = 'x'.repeat(200_000);
    rig = await startRig({ limits: { maxBufferedBytes: 1000, snapshotIntervalMs: 0 }, snapshot: () => ({ big: `${big}${Math.random()}` }) });
    const c = await new Client(rig, { deflate: false }).open();
    c.post('dashboard', { type: 'ready' });
    for (let i = 0; i < 20; i++) rig.updates.fire();
    await until(() => c.closeCode !== undefined, 'close');
    expect(c.closeCode).toBe(1013);
    expect(rig.conns.size).toBe(0);
  });
});

describe('snapshot coalescing', () => {
  function rigCoalescer() {
    vi.useFakeTimers({ now: 0 });
    const sent: { body: { n: number; nowMs?: number } }[] = [];
    const c = new SnapshotCoalescer((e) => sent.push(e as never), { snapshotIntervalMs: 1000, hiddenSnapshotIntervalMs: 10_000 });
    let n = 0;
    const push = () => c.push({ pane: 'dashboard', body: { type: 'snapshot', n: ++n, nowMs: Date.now() } });
    return { c, sent, push };
  }

  it('at most one a second, the latest winning, restamped when held', () => {
    const { sent, push } = rigCoalescer();
    push(); // immediate
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(100);
      push();
    }
    expect(sent.map((e) => e.body.n)).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(sent.map((e) => e.body.n)).toEqual([1, 10]);
    expect(sent[1].body.nowMs).toBe(1000);
  });

  it('one per ten seconds while hidden, and back to one a second when shown', () => {
    const { c, sent, push } = rigCoalescer();
    c.setHidden(true);
    push();
    for (let i = 0; i < 99; i++) {
      vi.advanceTimersByTime(100);
      push();
    }
    expect(sent.length).toBe(1);
    expect(sent[0].body.n).toBe(1);
    vi.advanceTimersByTime(100);
    expect(sent.length).toBe(2);
    push();
    c.setHidden(false);
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBe(3);
  });

  it('a held snapshot goes out before any other table message (order kept)', async () => {
    rig = await startRig({ limits: { snapshotIntervalMs: 60_000 } });
    const c = await new Client(rig).open();
    c.post('dashboard', { type: 'ready' });
    await until(() => c.of('dashboard', 'snapshot').length === 1, 'first snapshot');
    rig.updates.fire();
    rig.updates.fire();
    await new Promise((r) => setTimeout(r, 30));
    expect(c.of('dashboard', 'snapshot')).toHaveLength(1);
    // What `missionAck` does: it must follow the snapshot that shows its outcome.
    rig.dashboardPosts[0]({ type: 'missionAck', missionId: 'm1', requestId: 'q1' });
    await until(() => c.of('dashboard', 'missionAck').length === 1, 'ack');
    const types = c.frames.filter((f) => f.pane === 'dashboard').map((f) => f.body.type);
    expect(types).toEqual(['snapshot', 'snapshot', 'missionAck']);
  });
});

// ---- the browser shim, end to end ----

/** Just enough of a browser for `webshim` and `paneApi`, against the rig. */
function stubBrowser(r: Rig, opts: { build?: string } = {}) {
  const win = new EventTarget() as EventTarget & { postMessage(data: unknown, origin: string): void; isSecureContext: boolean };
  win.isSecureContext = true;
  win.postMessage = (data) => win.dispatchEvent(new MessageEvent('message', { data }));
  const storage = new Map<string, string>();
  const reload = vi.fn();
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    body: null,
    documentElement: { dataset: {} as Record<string, string> },
    hasFocus: () => true,
    querySelector: (sel: string) => (sel === 'meta[name="aw-build"]' ? { content: opts.build ?? r.server.build() } : null),
    getElementById: () => null,
  });
  class BrowserSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { origin: `http://127.0.0.1:${r.port}`, cookie: r.cookie } });
      // A browser reports a refused connection as an event, not a throw. The
      // shim keeps retrying after its test has stopped the server.
      this.on('error', () => undefined);
    }
  }
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { protocol: 'http:', hostname: '127.0.0.1', host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, reload });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  vi.stubGlobal('WebSocket', BrowserSocket);
  return { win, reload, storage };
}

/** The two panes as their bundles behave: `ready` at load and on reconnect; the conversation with its saved key. */
async function loadWorkbench(r: Rig, opts: { build?: string; savedKey?: string } = {}) {
  const browser = stubBrowser(r, opts);
  if (opts.savedKey) browser.storage.set('aw.workbench.state', JSON.stringify({ conversation: { key: opts.savedKey } }));
  vi.resetModules();
  await import('../src/webview/webshim/main');
  const { paneApi } = await import('../src/webview/common/paneApi');
  const seen = { dashboard: [] as { type: string }[], conversation: [] as { type: string; session?: { key: string }; requestId?: string }[] };
  const dashboard = paneApi('dashboard');
  const conversation = paneApi<{ key: string }>('conversation');
  dashboard.onMessage((m) => seen.dashboard.push(m as never));
  conversation.onMessage((m) => {
    const msg = m as (typeof seen.conversation)[number];
    seen.conversation.push(msg);
    if (msg.type === 'init' && msg.session) conversation.setState({ key: msg.session.key });
  });
  const readyAll = () => {
    dashboard.post({ type: 'ready' });
    conversation.post({ type: 'ready', key: conversation.getState()?.key });
  };
  readyAll();
  dashboard.onReconnect(() => dashboard.post({ type: 'ready' }));
  conversation.onReconnect(() => conversation.post({ type: 'ready', key: conversation.getState()?.key }));
  return { ...browser, seen, dashboard, conversation };
}

describe('the browser shim', () => {
  it('killing the socket mid-stream: it reconnects and the table and the same conversation come back, without a reload', async () => {
    rig = await startRig();
    const tab = await loadWorkbench(rig, { savedKey: KEY });
    await until(() => tab.seen.dashboard.some((m) => m.type === 'snapshot'), 'table');
    await until(() => tab.seen.conversation.find((m) => m.type === 'init'), 'conversation');
    expect(tab.seen.conversation.find((m) => m.type === 'init')?.session?.key).toBe(KEY);
    let reconnects = 0;
    tab.win.addEventListener(RECONNECT_EVENT, () => reconnects++);

    // Mid-stream: the table is being pushed to when the socket dies.
    rig.updates.fire();
    rig.updates.fire();
    rig.sockets[0].terminate();
    tab.seen.dashboard.length = 0;
    tab.seen.conversation.length = 0;

    await until(() => rig.sockets.length === 2, 'a second connection', 5000);
    await until(() => tab.seen.dashboard.some((m) => m.type === 'snapshot'), 'table again');
    const init = await until(() => tab.seen.conversation.find((m) => m.type === 'init'), 'conversation again');
    expect(init.session?.key).toBe(KEY);
    expect(reconnects).toBe(1);
    expect(tab.reload).not.toHaveBeenCalled();
    // The first connection's hosts are gone; one pair is left.
    expect(rig.hosts.map((h) => h.disposed)).toEqual([true, false]);
    expect(rig.conns.size).toBe(1);
  });

  it('a send whose acknowledgement was lost in the drop is resent, and delivered once', async () => {
    rig = await startRig();
    const tab = await loadWorkbench(rig, { savedKey: KEY });
    await until(() => tab.seen.conversation.find((m) => m.type === 'init'), 'conversation');
    // The socket dies the moment the send is delivered: before its ack and
    // its result can leave, so the tab cannot know it arrived.
    const release = rig.sessions.holdSends(() => rig.sockets[0].terminate());
    tab.conversation.post({ type: 'send', text: 'exactly once', requestId: 'r1', sessionKey: KEY });
    await until(() => rig.sessions.delivered.length === 1, 'delivery');
    await until(() => rig.sockets.length === 2 && rig.conns.size === 1, 'reconnected', 5000);
    await until(() => tab.seen.conversation.filter((m) => m.type === 'init').length >= 2, 'conversation again');
    release();
    const result = await until(() => tab.seen.conversation.find((m) => m.type === 'sendResult'), 'the first result');
    expect(result.requestId).toBe('r1');
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.sessions.delivered).toEqual(['exactly once']);
  });

  it('a prompt reaches the page, the in-page modal answers it, and a refused answer is asked again (#133)', async () => {
    rig = await startRig();
    const tab = await loadWorkbench(rig);
    await until(() => tab.seen.dashboard.some((m) => m.type === 'snapshot'), 'connected');
    // The app shell's half, without a DOM: the shim delivers the prompt as a
    // message, the modal host's model decides, `shellApi` sends the answer.
    const { shellApi } = await import('../src/webview/common/paneApi');
    let modals: ModalHostState = emptyModalHost();
    const toasts: string[] = [];
    const run = (effects: ModalHostEffect[]) => {
      for (const e of effects) {
        if (e.type === 'send') shellApi.post(e.body);
        if (e.type === 'toast') toasts.push(e.text);
      }
    };
    shellApi.onMessage((m) => {
      if (m.type === 'toast') toasts.push(m.text);
      const s = modalHostReceive(modals, m);
      modals = s.state;
      run(s.effects);
    });
    const act = (e: ModalEvent) => {
      const s = modalHostStep(modals, e);
      modals = s.state;
      run(s.effects);
    };

    const answer = runInRequest(rig.contexts[0], () =>
      rig.clients.dialogs.input({ title: 'Token', password: true, validateInput: (v) => (v.trim() ? undefined : 'A token cannot be blank.') }),
    );
    const first = await until(() => modals.current, 'the modal');
    expect(first.model).toMatchObject({ kind: 'input', title: 'Token', password: true });
    act({ type: 'text', text: ' ' });
    act({ type: 'submit' });
    // Refused host-side: the same question again, with why, and what was typed.
    const again = await until(() => (modals.current && modals.current.id !== first.id ? modals.current : undefined), 'asked again');
    expect(again.model).toMatchObject({ kind: 'input', error: 'A token cannot be blank.', value: ' ' });
    act({ type: 'text', text: 'secret' });
    act({ type: 'submit' });
    expect(await answer).toBe('secret');

    // A pick, chosen from the keyboard, comes back as the host's own object.
    const picked = runInRequest(rig.contexts[0], () =>
      rig.clients.dialogs.pick([{ label: 'alpha', id: 'a' }, { label: 'beta', id: 'b' }], { placeHolder: 'Which?' }),
    );
    await until(() => modals.current, 'the pick');
    act({ type: 'text', text: 'bt' });
    act({ type: 'submit' });
    expect((await picked)?.id).toBe('b');

    // And a toast is a toast.
    rig.clients.broadcast('Copied');
    await until(() => toasts.includes('Copied'), 'the toast');
  });

  it('a server on another build makes the page reload', async () => {
    rig = await startRig();
    const tab = await loadWorkbench(rig, { build: 'stale-build' });
    await until(() => tab.reload.mock.calls.length > 0, 'reload');
  });
});

// ---- traffic, measured ----

/** A deterministic table: `rows` sessions, about 2 KB each, like a busy real one. */
function syntheticTable(rows: number) {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const words = ['agent', 'build', 'review', 'refactor', 'test', 'deploy', 'fix', 'parse', 'render', 'cache', 'index', 'stream', 'patch', 'merge', 'queue', 'token', 'model', 'route', 'socket', 'table'];
  const text = (n: number) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ');
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const sessions = Array.from({ length: rows }, (_, i) => ({
    key: `claude:${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`,
    provider: i % 3 === 0 ? 'codex' : 'claude',
    sessionId: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`,
    title: text(6),
    cwd: `/Users/test/proj-${i % 7}`,
    worktreePath: `/Users/test/proj-${i % 7}-${hex(6)}`,
    branch: `feat/${text(2).replace(' ', '-')}`,
    status: ['busy', 'waiting', 'done', 'blocked'][i % 4],
    model: 'synthetic-model',
    startedAtMs: 1_700_000_000_000 + Math.floor(rand() * 1e9),
    lastActivityMs: 1_700_000_000_000 + Math.floor(rand() * 1e9),
    tokens: { input: Math.floor(rand() * 1e6), output: Math.floor(rand() * 1e5), cacheRead: Math.floor(rand() * 1e7) },
    costUsd: Math.round(rand() * 10000) / 100,
    lastMessage: text(60),
    pending: i % 4 === 3 ? { tool: 'Bash', summary: text(20), requestId: hex(16) } : undefined,
    tasks: Array.from({ length: 3 }, () => ({ id: hex(8), label: text(4), state: 'running' })),
  }));
  return {
    snapshot: () => ({ sessions, usage: { fiveHour: rand(), weekly: rand() } }),
    /** One store update: a row's activity moves on. */
    tick: () => {
      const s = sessions[Math.floor(rand() * sessions.length)];
      s.lastActivityMs += 1000;
      s.tokens.output += 17;
    },
  };
}

describe('traffic per idle client', () => {
  /**
   * 40 store updates at 4 a second, i.e. ten seconds of a table with agents
   * running, run 10x faster (coalescing intervals scaled the same way).
   */
  async function measure(deflate: boolean, coalesce: boolean, hidden = false): Promise<{ bytes: number; snapshots: number; snapshotBytes: number }> {
    // ~85 KB of JSON, the size the prototype measured.
    const table = syntheticTable(80);
    const scale = 10;
    rig = await startRig({
      snapshot: table.snapshot,
      limits: coalesce ? { snapshotIntervalMs: 1000 / scale, hiddenSnapshotIntervalMs: 10_000 / scale } : { snapshotIntervalMs: 0, hiddenSnapshotIntervalMs: 0 },
    });
    const c = await new Client(rig, { deflate }).open();
    if (hidden) c.ws.send(JSON.stringify({ pane: SHELL_PANE, body: { type: 'visibility', hidden: true } }));
    c.post('dashboard', { type: 'ready' });
    await until(() => c.of('dashboard', 'snapshot').length === 1, 'first snapshot');
    const start = c.socket!.bytesRead;
    for (let i = 0; i < 40; i++) {
      table.tick();
      rig.updates.fire();
      await new Promise((r) => setTimeout(r, 250 / scale));
    }
    await new Promise((r) => setTimeout(r, (hidden ? 10_000 : 1000) / scale + 50));
    const bytes = c.socket!.bytesRead - start;
    const snapshots = c.of('dashboard', 'snapshot').length - 1;
    const snapshotBytes = JSON.stringify(c.of('dashboard', 'snapshot')[0]).length;
    c.ws.close();
    rig.conns.dispose();
    rig.server.dispose();
    return { bytes, snapshots, snapshotBytes };
  }

  it('coalescing and deflate cut it far below the prototype', async () => {
    const before = await measure(false, false);
    const deflateOnly = await measure(true, false);
    const after = await measure(true, true);
    const hidden = await measure(true, true, true);
    const perSecond = (b: number) => `${(b / 10 / 1024).toFixed(1)} KB/s`;
    if (process.env.AW_WS_BENCH) {
      console.log(
        [
          `snapshot: ${(before.snapshotBytes / 1024).toFixed(1)} KB JSON; 40 updates over 10 s`,
          `prototype (no deflate, every update): ${before.snapshots} snapshots, ${before.bytes} B, ${perSecond(before.bytes)}`,
          `deflate only:                         ${deflateOnly.snapshots} snapshots, ${deflateOnly.bytes} B, ${perSecond(deflateOnly.bytes)}`,
          `deflate + 1/s coalescing:             ${after.snapshots} snapshots, ${after.bytes} B, ${perSecond(after.bytes)}`,
          `deflate + hidden (1/10 s):            ${hidden.snapshots} snapshots, ${hidden.bytes} B, ${perSecond(hidden.bytes)}`,
        ].join('\n'),
      );
    }
    expect(before.snapshots).toBe(40);
    expect(after.snapshots).toBeLessThanOrEqual(12);
    expect(hidden.snapshots).toBeLessThanOrEqual(2);
    expect(deflateOnly.bytes).toBeLessThan(before.bytes / 3);
    expect(after.bytes).toBeLessThan(before.bytes / 10);
  }, 30_000);
});
