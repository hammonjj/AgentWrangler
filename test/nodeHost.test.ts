/**
 * The plain-Node host (#125): `createApp` on `createNodeHost` starts and stops
 * under vitest, which is plain Node.
 *
 * Nothing real is touched. HOME, CLAUDE_CONFIG_DIR and CODEX_HOME point into a
 * temp dir before the app's modules load (every `~/.claude`, `~/.codex`,
 * `~/.cache` and `~/Library` path is derived from them), the Keychain runner
 * is a fake, and the session-host runtime refuses to prepare, so no host can
 * be spawned. vitest runs each file in its own process, so the environment
 * changed here does not leak into other files.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SecurityRunner } from '../src/core/keychainSecrets';
import type { SessionHostRuntime } from '../src/core/session/hostSupervisor';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-node-host-'));
const home = path.join(root, 'home');
const dataDir = path.join(home, 'Library', 'Application Support', 'Agent Wrangler');

beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AW_') || key === 'AGENTWRANGLER_HOSTED') delete process.env[key];
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeSecurity(): SecurityRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    available: () => true,
    run: async (args) => {
      calls.push(args);
      return { code: 44, stdout: '', stderr: 'not found' }; // errSecItemNotFound
    },
  };
}

const refusingRuntime: SessionHostRuntime = {
  buildId: 'test',
  prepare: () => Promise.reject(new Error('no session hosts in this test')),
  gc: () => undefined,
};

describe('createNodeHost', () => {
  it('runs createApp: start, then dispose, with a temp data dir', async () => {
    expect(os.homedir()).toBe(home);
    // Before the app reads them: no usage reads (no network, no Claude login
    // token), and no Codex binary to find.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ showUsage: false, 'autoPause.enabled': false, codexBinaryPath: path.join(root, 'no-codex') }),
    );

    const { createNodeHost } = await import('../src/node/nodeHost');
    const { createApp } = await import('../src/app/createApp');

    const lines: string[] = [];
    const security = fakeSecurity();
    const host = createNodeHost({
      dataDir,
      log: (m) => lines.push(m),
      securityRunner: security,
      fixToolPath: false,
      sessionHosts: {
        runtime: refusingRuntime,
        runDir: path.join(dataDir, 'run'),
        fallbackRunDir: path.join(home, '.agentwrangler', 'run'),
        logDir: path.join(dataDir, 'logs'),
      },
    });
    expect(fs.existsSync(host.storageDir)).toBe(true);
    expect(host.storageDir.startsWith(dataDir)).toBe(true);

    const app = createApp(host);
    app.start();
    expect(lines).toContain('Agent Wrangler started');
    // Let the first scans and the hook check run against the empty temp home.
    await vi.waitFor(() => {
      expect(lines.some((l) => l.startsWith('hook install state'))).toBe(true);
      expect(lines.some((l) => l.startsWith('claude provider started'))).toBe(true);
    }, { timeout: 5000 });

    app.dispose();
    host.disposeAll();
    host.disposeAll(); // twice is fine

    // It looked in the temp home, never the real one (`userInfo` reads the
    // account, not HOME).
    expect(lines.some((l) => l.includes(home))).toBe(true);
    expect(lines.filter((l) => l.includes(os.userInfo().homedir))).toEqual([]);
  });

  it('keeps settings and state in the JSON files the app uses', async () => {
    const { createNodeHost } = await import('../src/node/nodeHost');
    const dir = path.join(root, 'state');
    const host = createNodeHost({
      dataDir: dir,
      log: () => undefined,
      securityRunner: fakeSecurity(),
      fixToolPath: false,
      sessionHosts: { runtime: refusingRuntime, runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb'), logDir: path.join(dir, 'logs') },
    });
    const changed: boolean[] = [];
    host.settings.onDidChange((affects) => changed.push(affects('showUsage')));
    await host.settings.update('showUsage', false);
    host.globalState.update('k', 1);
    host.workspaceState.update('w', 2);
    host.sessionState.update('s', 3);
    expect(changed).toEqual([true]);
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(read('settings.json')).toEqual({ showUsage: false });
    expect(read('state.json')).toEqual({ k: 1 });
    expect(read('surface.json')).toEqual({ w: 2 });
    expect(read('sessions.json')).toEqual({ s: 3 });
    expect(host.workspaceFolders()).toEqual([]);
    host.disposeAll();
  });

  it('logs to agent-wrangler.log in the data dir when given no log', async () => {
    const { createNodeHost } = await import('../src/node/nodeHost');
    const dir = path.join(root, 'logged');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const host = createNodeHost({
      dataDir: dir,
      securityRunner: fakeSecurity(),
      fixToolPath: false,
      sessionHosts: { runtime: refusingRuntime, runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb'), logDir: path.join(dir, 'logs') },
    });
    host.log('hello from the node host');
    host.disposeAll();
    host.log('after close: not written, and not thrown');
    spy.mockRestore();
    await vi.waitFor(() => expect(fs.readFileSync(path.join(dir, 'agent-wrangler.log'), 'utf8')).toMatch(/\] hello from the node host\n$/));
  });

  it('reads secrets through the Keychain runner', async () => {
    const { createNodeHost } = await import('../src/node/nodeHost');
    const dir = path.join(root, 'secrets');
    const security = fakeSecurity();
    const host = createNodeHost({
      dataDir: dir,
      log: () => undefined,
      securityRunner: security,
      fixToolPath: false,
      sessionHosts: { runtime: refusingRuntime, runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb'), logDir: path.join(dir, 'logs') },
    });
    expect(host.secrets.available).toBe(true);
    expect(await host.secrets.get('remote.discord.botToken')).toBeUndefined();
    expect(security.calls[0]).toContain('find-generic-password');
    host.disposeAll();
  });

  it('fixes PATH up unless told not to', async () => {
    const { createNodeHost } = await import('../src/node/nodeHost');
    const dir = path.join(root, 'path');
    const before = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      createNodeHost({
        dataDir: dir,
        log: () => undefined,
        securityRunner: fakeSecurity(),
        sessionHosts: { runtime: refusingRuntime, runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb'), logDir: path.join(dir, 'logs') },
      }).disposeAll();
      if (process.platform === 'darwin') expect(process.env.PATH.split(':')).toContain('/opt/homebrew/bin');
      else expect(process.env.PATH).toBe('/usr/bin:/bin');
    } finally {
      process.env.PATH = before;
    }
  });

  it('sends dialogs, shell, clipboard and notify to the current broker', async () => {
    const { createNodeHost } = await import('../src/node/nodeHost');
    const { createDefaultClientBroker } = await import('../src/node/clientBroker');
    const dir = path.join(root, 'broker');
    const lines: string[] = [];
    const host = createNodeHost({
      dataDir: dir,
      log: (m) => lines.push(m),
      securityRunner: fakeSecurity(),
      fixToolPath: false,
      sessionHosts: { runtime: refusingRuntime, runDir: path.join(dir, 'run'), fallbackRunDir: path.join(dir, 'fb'), logDir: path.join(dir, 'logs') },
    });
    const dialogs = host.dialogs; // held across the swap, as createApp's services hold it

    // The default: nothing interactive, nothing run on the host.
    expect(host.shell.runInTerminal).toBeUndefined();
    expect(host.notify).toBeUndefined(); // no native banner (#161)

    const terminal: string[] = [];
    const noticed: string[] = [];
    const copied: string[] = [];
    const base = createDefaultClientBroker({ log: () => undefined });
    host.useBroker({
      ...base,
      dialogs: { ...base.dialogs, warn: async (_m, _o, ...items) => items[0], pickFolder: async () => '/Users/test/proj' },
      shell: { ...base.shell, runInTerminal: (command) => terminal.push(command) },
      clipboard: { writeText: async (t) => void copied.push(t) },
      notify: ({ title }) => noticed.push(title),
    });
    expect(await dialogs.warn('Stop?', {}, 'Stop')).toBe('Stop');
    expect(await host.dialogs.pickFolder()).toBe('/Users/test/proj');
    host.shell.runInTerminal?.('claude --resume x', { cwd: '/Users/test/proj', name: 'x' });
    await host.clipboard.writeText('copied');
    host.notify?.({ title: 'Done', body: 'b' });
    expect(terminal).toEqual(['claude --resume x']);
    expect(copied).toEqual(['copied']);
    expect(noticed).toEqual(['Done']);

    host.useBroker(undefined);
    expect(await dialogs.warn('Stop?', {}, 'Stop')).toBeUndefined();
    expect(host.shell.runInTerminal).toBeUndefined();
    host.disposeAll();
  });
});

describe('the default client broker', () => {
  it('answers every question with cancel, and logs what it cannot show', async () => {
    const { createDefaultClientBroker } = await import('../src/node/clientBroker');
    const lines: string[] = [];
    const ran: string[] = [];
    const broker = createDefaultClientBroker({
      log: (m) => lines.push(m),
      processes: { execFile: (f) => void ran.push(f), pipe: async (f) => void ran.push(f) },
    });
    expect(await broker.dialogs.info('Hello', 'OK')).toBeUndefined();
    expect(await broker.dialogs.warn('Delete?', { modal: true }, 'Delete')).toBeUndefined();
    expect(await broker.dialogs.input({ title: 'Name' })).toBeUndefined();
    expect(await broker.dialogs.pick([{ label: 'a' }])).toBeUndefined();
    expect(await broker.dialogs.pickFolder()).toBeUndefined();
    broker.dialogs.error('broke');
    broker.dialogs.flash('copied');
    broker.shell.openExternal('https://example.com');
    broker.shell.openFile('/Users/test/proj/a.txt');
    broker.shell.revealInFileManager('/Users/test/proj');
    expect(broker.shell.runInTerminal).toBeUndefined();
    expect(lines).toEqual(expect.arrayContaining(['error: broke', 'flash: copied']));
    expect(lines.some((l) => l.startsWith('openExternal https://example.com'))).toBe(true);
    expect(ran).toEqual([]); // nothing opened on the host
  });

  it('has no native notification: osascript banners are Script Editor’s (#161)', async () => {
    const { createDefaultClientBroker } = await import('../src/node/clientBroker');
    const broker = createDefaultClientBroker({ log: () => undefined });
    expect(broker.notify).toBeUndefined();
  });

  it('copies with pbcopy, the text on stdin', async () => {
    const { createDefaultClientBroker } = await import('../src/node/clientBroker');
    const piped: { file: string; args: string[]; input: string }[] = [];
    const broker = createDefaultClientBroker({
      log: () => undefined,
      processes: { execFile: () => undefined, pipe: async (file, args, input) => void piped.push({ file, args, input }) },
    });
    await broker.clipboard.writeText('claude --resume abc');
    expect(piped).toEqual([{ file: '/usr/bin/pbcopy', args: [], input: 'claude --resume abc' }]);
  });
});

describe('the power assertion', () => {
  it('holds caffeinate -i -w <pid> while wanted, and only one', async () => {
    const { createPowerAssertion } = await import('../src/node/powerAssertion');
    const started: string[][] = [];
    const children: { killed?: string; exit?: () => void }[] = [];
    const assertion = createPowerAssertion({
      log: () => undefined,
      pid: 4242,
      spawn: (args) => {
        started.push(args);
        const c: { killed?: string; exit?: () => void } = {};
        children.push(c);
        return {
          kill: (sig) => { c.killed = sig ?? 'SIGTERM'; return true; },
          once: (event: string, fn: (...args: never[]) => void) => { if (event === 'exit') c.exit = fn as () => void; return undefined; },
        };
      },
    });
    expect(assertion.held).toBe(false);
    assertion.set(true);
    assertion.set(true);
    expect(started).toEqual([['-i', '-w', '4242']]);
    expect(assertion.held).toBe(true);
    assertion.set(false);
    expect(children[0].killed).toBe('SIGTERM');
    expect(assertion.held).toBe(false);

    // Ended from outside: no longer held, and the next want starts another.
    assertion.set(true);
    children[1].exit?.();
    expect(assertion.held).toBe(false);
    assertion.set(true);
    expect(started).toHaveLength(3);
    assertion.dispose();
    expect(children[2].killed).toBe('SIGTERM');
  });
});

describe('the sleep watcher', () => {
  it('reports a wake when a tick is far later than due', async () => {
    const { watchForSleep } = await import('../src/core/sleepWatcher');
    let now = 1_000_000;
    let tick: () => void = () => undefined;
    let cleared = false;
    const wakes: number[] = [];
    const watcher = watchForSleep({
      onWake: (gap) => wakes.push(gap),
      now: () => now,
      setInterval: (fn) => { tick = fn; return {}; },
      clearInterval: () => { cleared = true; },
    });
    now += 5000; tick();
    now += 20_000; tick(); // a busy loop, not a sleep
    expect(wakes).toEqual([]);
    now += 3_600_000; tick();
    expect(wakes).toEqual([3_600_000]);
    now += 5000; tick();
    expect(wakes).toHaveLength(1);
    watcher.dispose();
    expect(cleared).toBe(true);
  });
});

describe('no Electron anywhere (#142)', () => {
  it('has no electron import in src, and no electron dependency', () => {
    const repo = path.join(__dirname, '..');
    const srcRoot = path.join(repo, 'src');
    const files = fs
      .readdirSync(srcRoot, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)|import\(\s*['"]electron['"]\s*\)/.test(fs.readFileSync(path.join(srcRoot, f), 'utf8')));
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => d === 'electron' || d.startsWith('electron-'))).toEqual([]);
  });
});
