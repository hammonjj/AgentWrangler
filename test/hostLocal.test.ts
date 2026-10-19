/**
 * The former host-local actions, per client kind (#140): a link, a file, a
 * command each go to the client that asked and are shown where it is; only the
 * window and a loopback browser's explicit button ever act on the host.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGate, ownerContext } from '../src/core/access';
import {
  ClientRegistry,
  channelFromDialogs,
  type ClientChannel,
  type ClientCommand,
  type ClientFile,
  type ClientKind,
} from '../src/core/clients';
import { runInRequest } from '../src/core/requestScope';
import { appPathRoots, createFileViewRoute, readFileView } from '../src/core/web/fileView';
import { createPathAllowlist, isSecretName, isWithin } from '../src/core/web/pathAllowlist';
import { DEVICE_COOKIE, WebServer } from '../src/core/web/server';
import { createShellChannel } from '../src/core/web/shellChannel';
import type { HostDialogs, HostShell } from '../src/host/hostServices';
import { FILE_VIEW_MAX_BYTES, fileViewUrl, isDiffFile, parseShellToHost, type HostToShell } from '../src/shared/shellProtocol';
import { resumeInTerminal } from '../src/ui/terminal';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';
import { diffClass, formatBytes } from '../src/webview/common/hostView';
import type { AgentSession } from '../src/shared/model';
import type { WranglerConfig } from '../src/core/config';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-hostlocal-')));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- routing per client kind ----

function fakeClient(connectionId: string, kind: ClientKind, isOpen = true) {
  const urls: string[] = [];
  const files: ClientFile[] = [];
  const commands: ClientCommand[] = [];
  const channel: ClientChannel = {
    connectionId,
    kind,
    isOpen,
    prompt: async () => undefined,
    toast: () => undefined,
    navigate: () => undefined,
    openUrl: (u) => urls.push(u),
    showFile: (f) => files.push(f),
    showCommand: (c) => commands.push(c),
  };
  return { channel, urls, files, commands, ctx: ownerContext('browser', { connectionId }) };
}

describe('the registry shell routes to the asking client', () => {
  function rig(windowOpen = true) {
    const log: string[] = [];
    const registry = new ClientRegistry({ log: (m) => log.push(m), navigationFallback: 'window' });
    const window = fakeClient('window', 'window', windowOpen);
    const local = fakeClient('web-1', 'loopback');
    const remote = fakeClient('web-2', 'lan');
    for (const c of [window, local, remote]) registry.register(c.channel);
    return { registry, window, local, remote, log };
  }

  it('sends each action to the originating client only, whatever its kind', () => {
    const { registry, window, local, remote } = rig();
    for (const who of [window, local, remote]) {
      runInRequest(who.ctx, () => {
        registry.shell.openExternal('https://example.test/pr/1');
        registry.shell.openFile('/Users/test/proj/a.txt');
        registry.shell.revealInFileManager('/Users/test/proj/b.txt');
        registry.shell.runInTerminal?.('claude --resume abc', { cwd: '/Users/test/proj', name: 'claude: x' });
      });
      expect(who.urls).toEqual(['https://example.test/pr/1']);
      expect(who.files).toEqual([
        { path: '/Users/test/proj/a.txt', intent: 'open' },
        { path: '/Users/test/proj/b.txt', intent: 'reveal' },
      ]);
      expect(who.commands).toEqual([{ command: 'claude --resume abc', cwd: '/Users/test/proj', name: 'claude: x' }]);
    }
    // Nothing leaked sideways: each saw exactly one round.
    expect([window.urls.length, local.urls.length, remote.urls.length]).toEqual([1, 1, 1]);
  });

  it('with no originating client, goes to the window while it is open', () => {
    const { registry, window, local, remote } = rig(true);
    registry.shell.openFile('/Users/test/proj/a.txt');
    expect(window.files).toHaveLength(1);
    expect(local.files).toHaveLength(0);
    expect(remote.files).toHaveLength(0);
  });

  it('with no originating client and the window closed, does nothing and says so', () => {
    const { registry, window, local, remote, log } = rig(false);
    registry.shell.openExternal('https://example.test/');
    registry.shell.runInTerminal?.('claude --resume abc', { cwd: '/x', name: 'n' });
    expect([window.urls, local.urls, remote.urls, window.commands, local.commands, remote.commands].flat()).toEqual([]);
    expect(log.filter((l) => l.includes('no client'))).toHaveLength(2);
  });

  it('a request whose client has gone is treated as having none (the window, if open)', () => {
    const { registry, window, remote } = rig();
    const reg = registry.register(fakeClient('web-3', 'lan').channel);
    reg.dispose();
    runInRequest(ownerContext('browser', { connectionId: 'web-3' }), () => registry.shell.openFile('/Users/test/p'));
    expect(window.files).toHaveLength(1);
    expect(remote.files).toHaveLength(0);
  });
});

describe('the window client acts on the Mac', () => {
  function native() {
    const calls: string[] = [];
    const shell: HostShell = {
      openExternal: (u) => calls.push(`url:${u}`),
      openFile: (p) => calls.push(`open:${p}`),
      revealInFileManager: (p) => calls.push(`reveal:${p}`),
      runInTerminal: (c, o) => calls.push(`run:${c}@${o.cwd}`),
    };
    const errors: string[] = [];
    const dialogs = { error: (m: string) => errors.push(m) } as unknown as HostDialogs;
    const channel = channelFromDialogs({ connectionId: 'window', dialogs, shell, isOpen: () => true, navigate: () => undefined });
    return { calls, errors, channel, dialogs };
  }

  it('is of kind window and uses the native shell', () => {
    const { calls, channel } = native();
    expect(channel.kind).toBe('window');
    channel.openUrl('https://example.test/');
    channel.showFile({ path: '/p/a', intent: 'open' });
    channel.showFile({ path: '/p/b', intent: 'reveal' });
    channel.showCommand({ command: 'claude --resume x', cwd: '/p', name: 'n' });
    expect(calls).toEqual(['url:https://example.test/', 'open:/p/a', 'reveal:/p/b', 'run:claude --resume x@/p']);
  });

  it('says so when the host has no terminal', () => {
    const errors: string[] = [];
    const channel = channelFromDialogs({
      connectionId: 'window',
      dialogs: { error: (m: string) => errors.push(m) } as unknown as HostDialogs,
      shell: { openExternal: () => undefined, openFile: () => undefined, revealInFileManager: () => undefined },
      isOpen: () => true,
      navigate: () => undefined,
    });
    channel.showCommand({ command: 'c', cwd: '/p', name: 'n' });
    expect(errors).toHaveLength(1);
  });
});

describe('a browser connection shows things in the browser', () => {
  function browser(kind: 'loopback' | 'lan', withHost = true) {
    const posted: HostToShell[] = [];
    const host: string[] = [];
    const hostShell: HostShell = {
      openExternal: (u) => host.push(`url:${u}`),
      openFile: (p) => host.push(`open:${p}`),
      revealInFileManager: (p) => host.push(`reveal:${p}`),
      runInTerminal: (c, o) => host.push(`run:${c}@${o.cwd}`),
    };
    const shell = createShellChannel({
      connectionId: 'web-1',
      kind,
      post: (e) => posted.push(e.body),
      conversation: () => undefined,
      ...(withHost ? { hostShell } : {}),
    });
    return { shell, posted, host };
  }

  it('openUrl goes to the browser as openUrl, http(s) only, and never to the host', () => {
    const { shell, posted, host } = browser('loopback');
    shell.channel.openUrl('https://example.test/pr/1');
    shell.channel.openUrl('javascript:alert(1)');
    shell.channel.openUrl('file:///etc/passwd');
    expect(posted).toEqual([{ type: 'openUrl', url: 'https://example.test/pr/1' }]);
    expect(host).toEqual([]);
  });

  it('"Open in its own tab" asks the browser for a new tab and leaves this conversation alone (#146)', () => {
    const { shell, posted } = browser('lan');
    shell.channel.navigate({ kind: 'tab', key: 'claude:k1' });
    expect(posted).toEqual([{ type: 'openTab', key: 'claude:k1' }]);
  });

  it('hands a window-menu action to the host, and only the two it knows (#146)', () => {
    const seen: string[] = [];
    const shell = createShellChannel({
      connectionId: 'web-1',
      kind: 'lan',
      post: () => undefined,
      conversation: () => undefined,
      appAction: (a) => seen.push(a),
    });
    shell.receive({ type: 'appAction', action: 'restartCodex' });
    shell.receive({ type: 'appAction', action: 'removeHooks' });
    shell.receive({ type: 'appAction', action: 'rm -rf' });
    shell.receive({ type: 'appAction' });
    expect(seen).toEqual(['restartCodex', 'removeHooks']);
    expect(parseShellToHost({ type: 'appAction', action: 'removeHooks' })).toEqual({ type: 'appAction', action: 'removeHooks' });
    expect(parseShellToHost({ type: 'appAction', action: 'refresh' })).toBeUndefined();
  });

  it('a LAN client is shown the file and the command, with no host actions, and cannot trigger one', () => {
    const { shell, posted, host } = browser('lan');
    expect(shell.channel.kind).toBe('lan');
    shell.channel.showFile({ path: '/Users/test/proj/a.txt', intent: 'open' });
    shell.channel.showCommand({ command: 'claude --resume abc', cwd: '/Users/test/proj', name: 'claude: x' });
    expect(posted).toEqual([
      { type: 'showFile', id: 1, path: '/Users/test/proj/a.txt', name: 'a.txt', intent: 'open', hostActions: false },
      { type: 'showCommand', id: 2, command: 'claude --resume abc', cwd: '/Users/test/proj', title: 'claude: x', hostActions: false },
    ]);
    for (const m of [
      { type: 'hostAction', id: 1, action: 'open' },
      { type: 'hostAction', id: 1, action: 'reveal' },
      { type: 'hostAction', id: 2, action: 'run' },
    ]) shell.receive(m);
    expect(host).toEqual([]);
  });

  it('a loopback client may ask for exactly what was offered, on this Mac', () => {
    const { shell, posted, host } = browser('loopback');
    shell.channel.showFile({ path: '/Users/test/proj/a.txt', intent: 'open' });
    shell.channel.showCommand({ command: 'claude --resume abc', cwd: '/Users/test/proj', name: 'n' });
    expect(posted.map((m) => (m as { hostActions?: boolean }).hostActions)).toEqual([true, true]);
    shell.receive({ type: 'hostAction', id: 1, action: 'open' });
    shell.receive({ type: 'hostAction', id: 1, action: 'reveal' });
    shell.receive({ type: 'hostAction', id: 2, action: 'run' });
    expect(host).toEqual(['open:/Users/test/proj/a.txt', 'reveal:/Users/test/proj/a.txt', 'run:claude --resume abc@/Users/test/proj']);
  });

  it('ignores an unknown id and an action that does not fit what was offered', () => {
    const { shell, host } = browser('loopback');
    shell.channel.showFile({ path: '/Users/test/proj/a.txt', intent: 'open' });
    shell.channel.showCommand({ command: 'c', cwd: '/p', name: 'n' });
    shell.receive({ type: 'hostAction', id: 99, action: 'open' });
    shell.receive({ type: 'hostAction', id: 1, action: 'run' });
    shell.receive({ type: 'hostAction', id: 2, action: 'open' });
    expect(host).toEqual([]);
  });

  it('without a host shell even a loopback client has no host actions', () => {
    const { shell, posted } = browser('loopback', false);
    shell.channel.showFile({ path: '/p/a', intent: 'reveal' });
    expect((posted[0] as { hostActions: boolean }).hostActions).toBe(false);
  });

  it('parses hostAction and rejects what is malformed', () => {
    expect(parseShellToHost({ type: 'hostAction', id: 3, action: 'run' })).toEqual({ type: 'hostAction', id: 3, action: 'run' });
    expect(parseShellToHost({ type: 'hostAction', id: 3, action: 'rm' })).toBeUndefined();
    expect(parseShellToHost({ type: 'hostAction', id: 'x', action: 'open' })).toBeUndefined();
    expect(parseShellToHost({ type: 'hostAction', id: 1.5, action: 'open' })).toBeUndefined();
  });
});

// ---- resume command production ----

describe('Resume and Release in a browser show the command', () => {
  const id = '0b8f6c9e-3a4d-4c53-9d0e-1a2b3c4d5e6f';
  const session = (cwd: string): AgentSession => ({ sessionId: id, cwd, title: 'a task', provider: 'claude' }) as unknown as AgentSession;
  const config = (() => ({ claudeBinaryPath: 'claude' })) as unknown as () => WranglerConfig;

  it('hands a remote client `claude --resume <id>` and the folder, and opens nothing', () => {
    const registry = new ClientRegistry({ log: () => undefined });
    const remote = fakeClient('web-2', 'lan');
    registry.register(remote.channel);
    const errors: string[] = [];
    runInRequest(remote.ctx, () =>
      resumeInTerminal(session(tmp), config, registry.shell, { error: (m: string) => errors.push(m) } as unknown as HostDialogs),
    );
    expect(errors).toEqual([]);
    expect(remote.commands).toEqual([{ command: `claude --resume ${id}`, cwd: tmp, name: 'claude: a task' }]);
  });

  it('refuses a malformed session id rather than build a command from it', () => {
    const registry = new ClientRegistry({ log: () => undefined });
    const remote = fakeClient('web-2', 'lan');
    registry.register(remote.channel);
    const errors: string[] = [];
    runInRequest(remote.ctx, () =>
      resumeInTerminal({ ...session(tmp), sessionId: 'x; rm -rf /' }, config, registry.shell, { error: (m: string) => errors.push(m) } as unknown as HostDialogs),
    );
    expect(remote.commands).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

// ---- the allowlist ----

describe('path allowlist', () => {
  it('allows inside a root and refuses outside, relative, missing and traversal', async () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'x');
    const allow = createPathAllowlist(() => [root]);
    expect(await allow.check(path.join(root, 'src', 'a.ts'))).toEqual({ ok: true, realPath: path.join(root, 'src', 'a.ts') });
    expect((await allow.check(root)).ok).toBe(true);
    expect(await allow.check(path.join(tmp, 'outside.txt'))).toEqual({ ok: false, reason: 'outside' });
    expect(await allow.check(path.join(root, '..', 'outside.txt'))).toEqual({ ok: false, reason: 'outside' });
    expect(await allow.check(`${root}/src/../../outside.txt`)).toEqual({ ok: false, reason: 'outside' });
    expect(await allow.check('src/a.ts')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(await allow.check(path.join(root, 'nope'))).toEqual({ ok: false, reason: 'not-found' });
    expect(await allow.check(`${root}/src/a.ts\0.png`)).toEqual({ ok: false, reason: 'not-absolute' });
  });

  it('is not fooled by a sibling with the same prefix', async () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(tmp, 'proj-evil'));
    fs.writeFileSync(path.join(tmp, 'proj-evil', 'f'), 'x');
    expect((await createPathAllowlist(() => [root]).check(path.join(tmp, 'proj-evil', 'f'))).ok).toBe(false);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
  });

  it('follows symlinks: a link out of a root does not pass, a link inside does', async () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(tmp, 'private.txt'), 'x');
    fs.writeFileSync(path.join(root, 'real.txt'), 'x');
    fs.symlinkSync(path.join(tmp, 'private.txt'), path.join(root, 'out.txt'));
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'in.txt'));
    const allow = createPathAllowlist(() => [root]);
    expect((await allow.check(path.join(root, 'out.txt'))).ok).toBe(false);
    expect((await allow.check(path.join(root, 'in.txt'))).ok).toBe(true);
  });

  it('resolves a root that is itself a symlink', async () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'f.txt'), 'x');
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link);
    expect((await createPathAllowlist(() => [link]).check(path.join(link, 'f.txt'))).ok).toBe(true);
  });

  it('refuses secrets by name even inside a root', async () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    for (const n of ['abc.key', '.env', '.env.local', 'cert.pem', 'id_rsa']) fs.writeFileSync(path.join(root, n), 'x');
    const allow = createPathAllowlist(() => [root]);
    for (const n of ['abc.key', '.env', '.env.local', 'cert.pem', 'id_rsa']) {
      expect(await allow.check(path.join(root, n))).toEqual({ ok: false, reason: 'secret' });
    }
    expect(isSecretName('/x/notes.txt')).toBe(false);
  });

  it('never treats the filesystem root, a missing root or a relative root as allowing anything', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x');
    const allow = createPathAllowlist(() => ['/', path.join(tmp, 'gone'), 'relative/dir', undefined, '']);
    expect((await allow.check(path.join(tmp, 'f.txt'))).ok).toBe(false);
  });

  it('asks for the roots on every call, so a new session is allowed at once', async () => {
    const roots: string[] = [];
    const allow = createPathAllowlist(() => roots);
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x');
    expect((await allow.check(path.join(tmp, 'f.txt'))).ok).toBe(false);
    roots.push(tmp);
    expect((await allow.check(path.join(tmp, 'f.txt'))).ok).toBe(true);
  });

  it('appPathRoots covers cwds, worktrees, transcript dirs and orchestration', () => {
    const roots = appPathRoots(
      () => [{ cwd: '/Users/test/proj', worktreePath: '/Users/test/proj-wt', transcriptPath: '/Users/test/.claude/projects/p/s.jsonl' }, {}],
      '/Users/test/data',
    )();
    expect(roots).toEqual([
      '/Users/test/data/orchestration',
      '/Users/test/proj',
      '/Users/test/proj-wt',
      '/Users/test/.claude/projects/p',
    ]);
  });
});

// ---- reading a file for the viewer ----

describe('readFileView', () => {
  it('returns a text file whole', async () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'hello\nworld\n');
    const out = await readFileView(f, f);
    expect(out).toEqual({ ok: true, view: { path: f, name: 'a.txt', size: 12, kind: 'text', text: 'hello\nworld\n', truncated: false } });
  });

  it('bounds a big file and says it was cut', async () => {
    const f = path.join(tmp, 'big.log');
    fs.writeFileSync(f, 'x'.repeat(1000));
    const out = await readFileView(f, f, 100);
    expect(out.ok && out.view.text).toBe('x'.repeat(100));
    expect(out.ok && out.view.truncated).toBe(true);
    expect(out.ok && out.view.size).toBe(1000);
    expect(FILE_VIEW_MAX_BYTES).toBe(256 * 1024);
  });

  it('does not show half a character where the cut lands', async () => {
    const f = path.join(tmp, 'u.txt');
    fs.writeFileSync(f, 'é'.repeat(10)); // 2 bytes each
    const out = await readFileView(f, f, 5);
    expect(out.ok && out.view.text).toBe('éé');
    expect(out.ok && out.view.truncated).toBe(true);
  });

  it('marks .diff and .patch as diffs', async () => {
    const f = path.join(tmp, 'm-a1.diff');
    fs.writeFileSync(f, '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    const out = await readFileView(f, f);
    expect(out.ok && out.view.kind).toBe('diff');
    expect(isDiffFile('x.patch')).toBe(true);
    expect(isDiffFile('x.txt')).toBe(false);
  });

  it('offers a binary for download instead of its bytes', async () => {
    const f = path.join(tmp, 'a.png');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    const out = await readFileView(f, f);
    expect(out.ok && out.view.kind).toBe('binary');
    expect(out.ok && out.view.text).toBeUndefined();
  });

  it('treats invalid UTF-8 as binary', async () => {
    const f = path.join(tmp, 'latin.txt');
    fs.writeFileSync(f, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xff, 0xfe]));
    const out = await readFileView(f, f);
    expect(out.ok && out.view.kind).toBe('binary');
  });

  it('reads an empty file, and refuses a directory', async () => {
    const f = path.join(tmp, 'empty');
    fs.writeFileSync(f, '');
    const out = await readFileView(f, f);
    expect(out.ok && out.view.text).toBe('');
    expect(await readFileView(tmp, tmp)).toEqual({ ok: false, reason: 'not-a-file' });
  });
});

// ---- the endpoint ----

describe('GET /api/view', () => {
  let server: WebServer;
  let port: number;
  let cookie: string;
  let root: string;

  beforeEach(async () => {
    root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    const web = path.join(tmp, 'web');
    fs.mkdirSync(web);
    for (const n of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(web, n), '/**/');
    server = new WebServer({
      port: 0,
      webviewDir: web,
      dataDir: path.join(tmp, 'data'),
      gate: createAccessGate({ audit: { write: () => undefined } }),
      log: () => undefined,
      page: renderBrowserWorkbenchHtml,
      onClient: (socket) => socket.close(),
      routes: [createFileViewRoute({ allowlist: createPathAllowlist(() => [root]), log: () => undefined })],
    });
    port = await server.listen();
    const login = await get(`/login?code=${new URL(server.loginLink().url).searchParams.get('code')}`, false);
    cookie = String(login.headers['set-cookie']?.[0]).split(';')[0];
    expect(cookie.startsWith(DEVICE_COOKIE)).toBe(true);
  });
  afterEach(() => server.dispose());

  function get(target: string, signedIn = true): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: target, agent: false, headers: { host: `127.0.0.1:${port}`, ...(signedIn ? { cookie } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('needs a signed-in device', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
    expect((await get(fileViewUrl(path.join(root, 'a.txt')), false)).status).toBe(401);
  });

  it('serves a text file as JSON', async () => {
    const f = path.join(root, 'a.txt');
    fs.writeFileSync(f, 'hi');
    const r = await get(fileViewUrl(f));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(JSON.parse(r.body.toString())).toMatchObject({ path: f, name: 'a.txt', kind: 'text', text: 'hi', truncated: false, size: 2 });
  });

  it('bounds a large file', async () => {
    const f = path.join(root, 'big.txt');
    fs.writeFileSync(f, 'y'.repeat(FILE_VIEW_MAX_BYTES + 500));
    const v = JSON.parse((await get(fileViewUrl(f))).body.toString());
    expect(v.text.length).toBe(FILE_VIEW_MAX_BYTES);
    expect(v.truncated).toBe(true);
  });

  it('refuses paths outside the allowlist, and traversal, with 403', async () => {
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret');
    expect((await get(fileViewUrl(path.join(tmp, 'outside.txt')))).status).toBe(403);
    expect((await get(fileViewUrl(`${root}/../outside.txt`))).status).toBe(403);
    expect((await get(fileViewUrl('/etc/hosts'))).status).toBe(403);
    expect((await get(`${fileViewUrl(path.join(tmp, 'outside.txt'))}&download=1`)).status).toBe(403);
  });

  it('400 for no or a relative path, 404 for a missing file or a directory', async () => {
    expect((await get('/api/view')).status).toBe(400);
    expect((await get(fileViewUrl('a.txt'))).status).toBe(400);
    expect((await get(fileViewUrl(path.join(root, 'nope')))).status).toBe(404);
    expect((await get(fileViewUrl(root))).status).toBe(404);
  });

  it('answers a binary with no text, and downloads it as an attachment', async () => {
    const f = path.join(root, 'a.bin');
    const bytes = Buffer.from([1, 2, 0, 3, 255]);
    fs.writeFileSync(f, bytes);
    const v = JSON.parse((await get(fileViewUrl(f))).body.toString());
    expect(v.kind).toBe('binary');
    expect(v.text).toBeUndefined();
    const d = await get(fileViewUrl(f, true));
    expect(d.status).toBe(200);
    expect(d.headers['content-disposition']).toContain('attachment');
    expect(d.headers['x-content-type-options']).toBe('nosniff');
    expect(d.body.equals(bytes)).toBe(true);
  });

  it('serves a diff file as kind diff', async () => {
    const f = path.join(root, 'm-a1.diff');
    fs.writeFileSync(f, '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(JSON.parse((await get(fileViewUrl(f))).body.toString()).kind).toBe('diff');
  });

  it('refuses a symlink that leaves the root', async () => {
    fs.writeFileSync(path.join(tmp, 'private.txt'), 'x');
    fs.symlinkSync(path.join(tmp, 'private.txt'), path.join(root, 'link.txt'));
    expect((await get(fileViewUrl(path.join(root, 'link.txt')))).status).toBe(403);
  });
});

// ---- the viewer's pure parts ----

describe('viewer helpers', () => {
  it('classes unified-diff lines', () => {
    expect(diffClass('+added')).toBe('aw-hv-add');
    expect(diffClass('-removed')).toBe('aw-hv-del');
    expect(diffClass('@@ -1 +1 @@')).toBe('aw-hv-hunk');
    expect(diffClass('+++ b/x')).toBe('aw-hv-meta');
    expect(diffClass('--- a/x')).toBe('aw-hv-meta');
    expect(diffClass(' context')).toBe('aw-hv-ctx');
  });
  it('formats sizes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
  });
});
