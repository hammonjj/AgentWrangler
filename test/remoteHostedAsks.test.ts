import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askKind, pendingViews, permissionResult, planResult, questionResult } from '../src/claude/runner/askResults';
import { Emitter } from '../src/core/events';
import { daemonEntryFor, renderLaunchAgent } from '../src/remote/daemon/launchAgent';
import { HostedAsks, type HostLink } from '../src/remote/daemon/hostedAsks';
import { SourceSwitch, type FeedSource } from '../src/remote/daemon/sources';
import type { SessionDTO } from '../src/shared/model';
import { emptyHostState, type HostEvent, type HostManifest, type HostSnapshot, type RawAsk, type RawPermissionResult } from '../src/shared/sessionProtocol';

const bash: RawAsk = { requestId: 'r1', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [{ rule: 'x' }] };
const question: RawAsk = {
  requestId: 'r2',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: 'a' }, { label: '' }] }] },
};
const plan: RawAsk = { requestId: 'r3', toolName: 'ExitPlanMode', input: { plan: 'Do it' } };

describe('ask results', () => {
  it('builds the same canUseTool results RunnerView sends', () => {
    expect(permissionResult(bash, 'allow')).toEqual({ behavior: 'allow', updatedInput: bash.input });
    expect(permissionResult(bash, 'always')).toEqual({ behavior: 'allow', updatedInput: bash.input, updatedPermissions: bash.suggestions });
    expect(permissionResult(bash, 'deny')).toEqual({ behavior: 'deny', message: 'Denied from Agent Wrangler.' });
    expect(questionResult(question, { 'Which?': 'A' })).toEqual({
      behavior: 'allow',
      updatedInput: { ...question.input, answers: { 'Which?': 'A' } },
    });
    expect(planResult(plan, true)).toEqual({ behavior: 'allow', updatedInput: plan.input });
    expect(planResult(plan, false, ' ')).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/Keep planning/) });
  });

  it('shows the newest pending ask of each kind', () => {
    const older: RawAsk = { ...bash, requestId: 'r0', input: { command: 'ls' } };
    const v = pendingViews([older, bash, question, plan], '/Users/test/proj');
    expect(v.permission).toMatchObject({ requestId: 'r1', toolName: 'Bash', ask: { body: 'npm test', isCommand: true } });
    expect(v.question).toEqual({ requestId: 'r2', questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }] }] });
    expect(v.plan).toEqual({ requestId: 'r3', plan: 'Do it', more: undefined });
    expect(askKind('Read')).toBe('permission');
  });
});

class FakeLink implements HostLink {
  snap: HostSnapshot = { ...emptyHostState(), epoch: 'e', ring: { fromSeq: 0, truncated: false } };
  responded: { requestId: string; result: RawPermissionResult }[] = [];
  detached = false;
  private events = new Emitter<HostEvent>();
  constructor(sessionId: string, asks: RawAsk[]) {
    this.snap = { ...this.snap, sessionId, pendingAsks: asks };
  }
  snapshot() {
    return this.snap;
  }
  subscribe(_from: number, l: (e: HostEvent) => void) {
    return this.events.event(l);
  }
  start() {}
  async respondAsk(requestId: string, result: RawPermissionResult) {
    this.responded.push({ requestId, result });
    this.snap = { ...this.snap, pendingAsks: this.snap.pendingAsks.filter((a) => a.requestId !== requestId) };
    return 'applied' as const;
  }
  detach() {
    this.detached = true;
  }
}

describe('HostedAsks', () => {
  let dir: string;
  let links: Map<string, FakeLink>;
  let alive: Set<string>;

  function manifest(hostId: string, sessionId: string): void {
    const m: Partial<HostManifest> = { v: 1, hostId, hostPid: 1, socketPath: `/tmp/${hostId}.sock`, sessionId, cwd: '/Users/test/proj', startedAt: 0 };
    fs.writeFileSync(path.join(dir, `${hostId}.json`), JSON.stringify(m));
    fs.writeFileSync(path.join(dir, `${hostId}.token`), 'tok');
    alive.add(hostId);
  }

  function watcher(): HostedAsks {
    return new HostedAsks({
      runDir: dir,
      build: 'b',
      log: () => undefined,
      connect: (m) => links.get(m.hostId)!,
      isAlive: (m) => alive.has(m.hostId),
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awha-'));
    links = new Map();
    alive = new Set();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('follows live hosts, offers their asks, and answers through the host', async () => {
    links.set('aaaaaaaa', new FakeLink('sess-1', [bash, question]));
    manifest('aaaaaaaa', 'sess-1');
    const w = watcher();
    w.scan();
    expect(w.owns('SESS-1')).toBe(true);
    expect(w.views('sess-1').permission?.requestId).toBe('r1');
    expect(w.views('sess-1').question?.requestId).toBe('r2');

    expect(await w.decide('sess-1', 'allow', 'nope')).toBe('stale');
    expect(await w.decide('sess-1', 'allow')).toBe('applied'); // the lone permission
    expect(await w.answer('sess-1', 'r2', { 'Which?': 'A' })).toBe('applied');
    expect(links.get('aaaaaaaa')!.responded.map((r) => r.requestId)).toEqual(['r1', 'r2']);
    expect(await w.decidePlan('sess-2', 'r3', true)).toBe('gone');
    w.dispose();
  });

  it('lets go of a host once it has gone, never ending it', () => {
    const link = new FakeLink('sess-1', []);
    links.set('aaaaaaaa', link);
    manifest('aaaaaaaa', 'sess-1');
    const w = watcher();
    w.scan();
    expect(w.count).toBe(1);
    alive.delete('aaaaaaaa');
    w.scan();
    expect(w.count).toBe(0);
    expect(link.detached).toBe(true);
    w.dispose();
  });
});

describe('SourceSwitch', () => {
  function feed(ready: boolean, sessions: SessionDTO[] = []): FeedSource & { set(r: boolean): void; calls: string[] } {
    const e = new Emitter<void>();
    const calls: string[] = [];
    const f = {
      sessions,
      ready,
      calls,
      onDidUpdate: (l: () => void) => e.event(l),
      set(r: boolean) {
        f.ready = r;
        e.fire();
      },
      decidePermission: async (key: string) => {
        calls.push(key);
        return 'applied' as const;
      },
      answerQuestion: async () => 'applied' as const,
      decidePlan: async () => 'applied' as const,
    };
    return f;
  }

  it('prefers the app when ready, falls back to its own, and is not ready with neither', async () => {
    const sw = new SourceSwitch();
    const app = feed(false);
    const own = feed(false);
    sw.set('app', app);
    sw.set('daemon', own);
    expect(sw.ready).toBe(false);
    expect(await sw.decidePermission('k', 'allow')).toBe('gone');
    own.set(true);
    expect(sw.source).toBe('daemon');
    app.set(true);
    expect(sw.source).toBe('app');
    await sw.decidePermission('k', 'allow');
    expect(app.calls).toEqual(['k']);
    sw.set('app', undefined);
    expect(sw.source).toBe('daemon');
    sw.dispose();
  });
});

describe('LaunchAgent', () => {
  it('renders a plist that restarts only on a crash, escaping paths', () => {
    const text = renderLaunchAgent({
      label: 'com.example.remote',
      program: '/Users/test/Library/Application Support/Agent Wrangler/runtimes/b1/Agent Wrangler Host.app/Contents/MacOS/Agent Wrangler Host',
      args: ['/x/dist/remoteDaemon/main.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', A: 'x&y' },
      logFile: '/Users/test/logs/remote-daemon.log',
    });
    expect(text).toContain('<string>com.example.remote</string>');
    expect(text).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(text).toContain('<string>x&amp;y</string>');
    expect(text.indexOf('<key>A</key>')).toBeLessThan(text.indexOf('<key>ELECTRON_RUN_AS_NODE</key>'));
  });

  it('finds the daemon entry beside the session host entry', () => {
    expect(daemonEntryFor('/a/app.asar/dist/sessionHost/main.js')).toBe('/a/app.asar/dist/remoteDaemon/main.js');
  });
});
