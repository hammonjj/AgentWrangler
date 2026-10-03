/**
 * Upload, download and the folder browser (#139), over a real `WebServer` and
 * temp directories.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGate, ownerContext, type AccessAuditRecord } from '../src/core/access';
import { createShellChannel } from '../src/core/web/shellChannel';
import { WebFiles, sanitizeName, UPLOAD_MAX_AGE_MS } from '../src/core/web/files';
import { DEVICE_COOKIE, WebServer } from '../src/core/web/server';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';
import type { DirListing } from '../src/shared/files';

const CAP = 1024;

let dir: string;
let home: string;
let project: string;
let outside: string;
let server: WebServer;
let files: WebFiles;
let port: number;
let host: string;
let cookie: string;
let audit: AccessAuditRecord[];
let logs: string[];
let roots: string[];

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-files-')));
  home = path.join(dir, 'home');
  project = path.join(home, 'work', 'proj');
  outside = path.join(dir, 'outside');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'project notes');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  const webviewDir = path.join(dir, 'dist', 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
  audit = [];
  logs = [];
  roots = [project];
  const gate = createAccessGate({ audit: { write: (r) => audit.push(r) } });
  files = new WebFiles({
    dataDir: path.join(dir, 'data'),
    gate,
    log: (l) => logs.push(l),
    downloadRoots: () => roots,
    projects: () => [{ name: 'proj', dir: project }],
    home,
    maxUploadBytes: CAP,
    uploadsPerMinute: 50,
    maxDirEntries: 5,
  });
  server = new WebServer({
    port: 0,
    webviewDir,
    dataDir: path.join(dir, 'data'),
    gate,
    log: () => undefined,
    page: renderBrowserWorkbenchHtml,
    onClient: (socket) => socket.close(),
    files,
  });
  port = await server.listen();
  host = `127.0.0.1:${port}`;
  const login = await request(`/login?code=${new URL(server.loginLink().url).searchParams.get('code')}`);
  cookie = `${DEVICE_COOKIE}=${String(login.headers['set-cookie']?.[0]).split(';')[0].split('=')[1]}`;
  audit.length = 0;
});

afterEach(() => {
  files.dispose();
  server.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(
  pathname: string,
  opts: { method?: string; headers?: Record<string, string | undefined>; body?: Buffer | string; chunked?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    for (const [k, v] of Object.entries(opts.headers ?? {})) if (v !== undefined) headers[k] = v;
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    if (body && !opts.chunked && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method ?? 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const all = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: all, text: all.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (opts.chunked) {
      req.write(body ?? '');
      req.end();
    } else req.end(body);
  });
}

function upload(
  name: string,
  body: Buffer | string,
  extra: Record<string, string | undefined> = {},
  opts: { chunked?: boolean } = {},
): Promise<Reply> {
  return request('/upload', {
    method: 'POST',
    body,
    ...(opts.chunked ? { chunked: true } : {}),
    headers: {
      cookie,
      origin: `http://${host}`,
      'x-aw-upload': '1',
      'x-aw-filename': encodeURIComponent(name),
      'x-aw-conversation': 'claude:synthetic-1',
      ...extra,
    },
  });
}

const get = (p: string, withCookie = true) => request(p, { headers: { cookie: withCookie ? cookie : undefined } });
const download = (p: string, withCookie = true) => get(`/files?path=${encodeURIComponent(p)}`, withCookie);
const dirs = async (q: string) => {
  const r = await get(`/api/dirs${q}`);
  return { status: r.status, listing: r.status === 200 ? (JSON.parse(r.text) as DirListing) : undefined };
};

describe('POST /upload', () => {
  it('stores the file in the conversation’s staging directory, 0600 in a 0700 directory, and answers with the host path', async () => {
    const r = await upload('report.txt', 'hello host');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as { path: string; name: string; size: number };
    expect(body).toMatchObject({ name: 'report.txt', size: 10 });
    expect(path.dirname(body.path)).toBe(files.stagingDir('claude:synthetic-1'));
    expect(path.basename(body.path)).toMatch(/^[0-9a-f-]{36}-report\.txt$/);
    expect(fs.readFileSync(body.path, 'utf8')).toBe('hello host');
    expect(fs.statSync(body.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(body.path)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(path.dirname(body.path))).mode & 0o777).toBe(0o700);
    expect(files.isStaged(body.path)).toBe(true);
    expect(files.isStaged(path.join(project, 'notes.txt'))).toBe(false);
    expect(fs.readdirSync(path.dirname(body.path)).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('keeps only a basename, whatever the client sent', async () => {
    for (const [sent, kept] of [
      ['../../etc/passwd', 'passwd'],
      ['..\\..\\evil.sh', 'evil.sh'],
      ['/abs/path/a.txt', 'a.txt'],
      ['..', 'file'],
      ['', 'file'],
      ['a\nb.txt', 'ab.txt'],
    ] as const) {
      const r = await upload(sent, 'x', { 'x-aw-filename': encodeURIComponent(sent) });
      const body = JSON.parse(r.text) as { path: string; name: string };
      expect(body.name).toBe(kept);
      expect(path.dirname(body.path)).toBe(files.stagingDir('claude:synthetic-1'));
    }
    expect(sanitizeName('%E0%A4%A')).toBeUndefined();
    expect(sanitizeName('x'.repeat(500) + '.png')!.length).toBeLessThanOrEqual(120);
    expect(sanitizeName('x'.repeat(500) + '.png')).toMatch(/\.png$/);
  });

  it('refuses a body over the cap with 413, and leaves nothing behind', async () => {
    const r = await upload('big.bin', Buffer.alloc(CAP + 1));
    expect(r.status).toBe(413);
    const staged = fs.existsSync(files.stagingDir('claude:synthetic-1')) ? fs.readdirSync(files.stagingDir('claude:synthetic-1')) : [];
    expect(staged).toEqual([]);
    expect((await upload('ok.bin', Buffer.alloc(CAP))).status).toBe(200);
  });

  it('needs a Content-Length', async () => {
    expect((await upload('a.txt', 'abc', {}, { chunked: true })).status).toBe(411);
  });

  it('needs the device cookie (401), this Origin (403) and X-AW-Upload: 1 (400)', async () => {
    expect((await upload('a.txt', 'x', { cookie: undefined })).status).toBe(401);
    expect((await upload('a.txt', 'x', { cookie: `${DEVICE_COOKIE}=nope` })).status).toBe(401);
    expect((await upload('a.txt', 'x', { origin: undefined })).status).toBe(403);
    expect((await upload('a.txt', 'x', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await upload('a.txt', 'x', { origin: `http://localhost:${port}` })).status).toBe(403);
    expect((await upload('a.txt', 'x', { 'x-aw-upload': undefined })).status).toBe(400);
    expect((await upload('a.txt', 'x', { 'x-aw-upload': '0' })).status).toBe(400);
    expect((await upload('a.txt', 'x', { 'x-aw-conversation': undefined })).status).toBe(400);
    expect((await upload('a.txt', 'x', { host: 'evil.example' })).status).toBe(421);
    expect(fs.existsSync(path.join(dir, 'data', 'uploads'))).toBe(false);
    expect((await upload('a.txt', 'x')).status).toBe(200);
  });

  it('is rate limited per device', async () => {
    for (let i = 0; i < 50; i++) expect((await upload(`f${i}.txt`, 'x')).status).toBe(200);
    const r = await upload('f6.txt', 'x');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
  });

  it('is audited with ids and sizes, never the name or the content', async () => {
    await upload('Quarterly-Secrets.pdf', 'very private content');
    const lines = audit.filter((a) => a.action === 'file.upload');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'authorized', via: 'browser', resource: { kind: 'file', size: 20 } });
    const everything = JSON.stringify(audit) + logs.join('\n');
    expect(everything).not.toContain('Quarterly');
    expect(everything).not.toContain('private');
    expect(everything).not.toContain(files.stagingDir('claude:synthetic-1'));
  });

  it('other methods on /upload, and a GET, are not an upload', async () => {
    expect((await request('/upload', { method: 'PUT', headers: { cookie, origin: `http://${host}` } })).status).toBe(405);
    expect((await get('/upload')).status).toBe(404);
  });
});

describe('cleanup of old uploads', () => {
  it('removes files older than 7 days (and the directory they leave), keeps newer ones', async () => {
    const a = JSON.parse((await upload('old.txt', 'x')).text) as { path: string };
    const b = JSON.parse((await upload('new.txt', 'x', { 'x-aw-conversation': 'claude:other' })).text) as { path: string };
    const old = (Date.now() - UPLOAD_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(a.path, old, old);
    expect(files.cleanup()).toBe(1);
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(path.dirname(a.path))).toBe(false);
    expect(fs.existsSync(b.path)).toBe(true);
  });

  it('runs when started', () => {
    const d = files.stagingDir('claude:x');
    fs.mkdirSync(d, { recursive: true });
    const stale = path.join(d, 'stale.txt');
    fs.writeFileSync(stale, 'x');
    const old = (Date.now() - UPLOAD_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(stale, old, old);
    files.start();
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('GET /files', () => {
  it('serves a file in an allowed root as an attachment, with nosniff and a Content-Length', async () => {
    const r = await download(path.join(project, 'notes.txt'));
    expect(r.status).toBe(200);
    expect(r.text).toBe('project notes');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="notes\.txt"/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-length']).toBe('13');
    expect(r.headers['content-type']).toBe('application/octet-stream');
  });

  it('serves a staged upload too', async () => {
    const up = JSON.parse((await upload('mine.txt', 'staged')).text) as { path: string };
    expect((await download(up.path)).text).toBe('staged');
  });

  it('needs the device cookie', async () => {
    expect((await download(path.join(project, 'notes.txt'), false)).status).toBe(401);
  });

  it('refuses everything outside the roots with 403', async () => {
    for (const p of [path.join(outside, 'secret.txt'), '/etc/hosts', path.join(home, 'work'), home, project + '-sibling', path.join(outside, 'nope.txt')]) {
      expect((await download(p)).status, p).toBe(403);
    }
    expect(logs.some((l) => l.includes('refused a download'))).toBe(true);
    expect(logs.join('\n')).not.toContain(outside);
  });

  it('refuses `..` that climbs out of a root, in the raw query too', async () => {
    expect((await download(path.join(project, '..', '..', '..', 'outside', 'secret.txt'))).status).toBe(403);
    expect((await get(`/files?path=${encodeURIComponent(project)}/%2e%2e/%2e%2e/%2e%2e/outside/secret.txt`)).status).toBe(403);
    expect((await get(`/files?path=${encodeURIComponent(project)}/../../../outside/secret.txt`)).status).toBe(403);
  });

  it('refuses a symlink that leaves the root, to a file or to a directory', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link.txt'));
    fs.symlinkSync(outside, path.join(project, 'linkdir'));
    expect((await download(path.join(project, 'link.txt'))).status).toBe(403);
    expect((await download(path.join(project, 'linkdir', 'secret.txt'))).status).toBe(403);
  });

  it('follows a symlink that stays inside', async () => {
    fs.symlinkSync(path.join(project, 'notes.txt'), path.join(project, 'alias.txt'));
    expect((await download(path.join(project, 'alias.txt'))).text).toBe('project notes');
  });

  it('a missing file inside a root is 404, a directory is 404, a relative or empty path is 400', async () => {
    expect((await download(path.join(project, 'missing.txt'))).status).toBe(404);
    expect((await download(project)).status).toBe(404);
    expect((await download('notes.txt')).status).toBe(400);
    expect((await get('/files')).status).toBe(400);
    expect((await get('/files?path=%00')).status).toBe(400);
  });

  it('the roots follow the store: a new session’s folder is allowed at once, and a worktree of one', async () => {
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'w.txt'), 'w');
    expect((await download(path.join(wt, 'w.txt'))).status).toBe(403);
    roots = [project, wt];
    expect((await download(path.join(wt, 'w.txt'))).status).toBe(200);
  });

  it('a root that is the home folder or `/` grants nothing', async () => {
    fs.writeFileSync(path.join(home, 'dot.txt'), 'x');
    roots = [home, '/', os.homedir()];
    expect((await download(path.join(home, 'dot.txt'))).status).toBe(403);
  });

  it('never serves .ssh, .gnupg or .aws, even inside a root', async () => {
    fs.mkdirSync(path.join(project, '.ssh'));
    fs.writeFileSync(path.join(project, '.ssh', 'id'), 'key');
    expect((await download(path.join(project, '.ssh', 'id'))).status).toBe(403);
  });

  it('is audited by an id of the file and its size, never the path or name', async () => {
    await download(path.join(project, 'notes.txt'));
    const line = audit.find((a) => a.action === 'file.download');
    expect(line).toMatchObject({ event: 'authorized', resource: { kind: 'file', size: 13 } });
    expect(line?.resource?.id).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(audit)).not.toContain('notes');
    expect(JSON.stringify(audit)).not.toContain(project);
  });
});

describe('GET /api/dirs', () => {
  beforeEach(() => {
    for (const n of ['b-dir', 'a-dir', '.hidden-dir']) fs.mkdirSync(path.join(home, n));
    fs.writeFileSync(path.join(home, 'a-file.txt'), 'x');
  });

  it('starts at the home folder with the known projects first: directories only, no dotfiles', async () => {
    const { status, listing } = await dirs('');
    expect(status).toBe(200);
    expect(listing!.path).toBe(home);
    expect(listing!.projects).toEqual([{ name: 'proj', path: project }]);
    expect(listing!.entries.map((e) => e.name)).toEqual(['a-dir', 'b-dir', 'work']);
    expect(listing!.entries[0].path).toBe(path.join(home, 'a-dir'));
    expect(listing!.parent).toBeUndefined();
    expect(listing!.hidden).toBe(false);
  });

  it('shows dotfolders on request', async () => {
    const { listing } = await dirs('?hidden=1');
    expect(listing!.entries.map((e) => e.name)).toContain('.hidden-dir');
    expect(listing!.hidden).toBe(true);
  });

  it('walks down, and up as far as the home folder', async () => {
    const { listing } = await dirs(`?path=${encodeURIComponent(path.join(home, 'work'))}`);
    expect(listing!.entries).toEqual([{ name: 'proj', path: project }]);
    expect(listing!.projects).toEqual([]);
    expect(listing!.parent).toBe(home);
  });

  it('bounds the entries in one listing', async () => {
    for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(home, `many-${String(i).padStart(2, '0')}`));
    const { listing } = await dirs('');
    expect(listing!.entries).toHaveLength(5);
    expect(listing!.truncated).toBe(true);
  });

  it('refuses outside the home folder and the known projects, however it is spelled', async () => {
    for (const p of [outside, '/', '/etc', path.join(home, '..'), path.join(home, '..', 'outside'), `${home}/work/../../outside`]) {
      expect((await dirs(`?path=${encodeURIComponent(p)}`)).status, p).toBe(403);
    }
    expect((await dirs(`?path=${encodeURIComponent('relative/dir')}`)).status).toBe(400);
    expect((await dirs(`?path=${encodeURIComponent(path.join(home, 'nope'))}`)).status).toBe(404);
  });

  it('refuses a symlink out of the home folder', async () => {
    fs.symlinkSync(outside, path.join(home, 'escape'));
    expect((await dirs(`?path=${encodeURIComponent(path.join(home, 'escape'))}`)).status).toBe(403);
  });

  it('allows a known project outside the home folder', async () => {
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'sub'), { recursive: true });
    const f2 = new WebFiles({ dataDir: path.join(dir, 'data2'), gate: createAccessGate(), log: () => undefined, downloadRoots: () => [], projects: () => [{ name: 'e', dir: elsewhere }], home });
    expect(await f2.folderAllowed(path.join(elsewhere, 'sub'))).toBe(true);
    expect(await f2.folderAllowed(outside)).toBe(false);
  });

  it('needs the cookie', async () => {
    expect((await get('/api/dirs', false)).status).toBe(401);
  });

  it('chooses only what the browser may offer (folderAllowed)', async () => {
    expect(await files.folderAllowed(project)).toBe(true);
    expect(await files.folderAllowed(home)).toBe(true);
    expect(await files.folderAllowed(path.join(project, 'notes.txt'))).toBe(false);
    for (const p of [outside, '/etc', 'relative', '', path.join(home, '..')]) expect(await files.folderAllowed(p)).toBe(false);
  });
});

describe('the rule: a client’s path is not a host path', () => {
  it('a folder a browser “picks” is checked, and refused if the host would not have listed it', async () => {
    const answer = async (value: string, allowed?: (d: string) => Promise<boolean>) => {
      const posted: Array<{ body: { type: string; id?: number } }> = [];
      const shell = createShellChannel({
        connectionId: 'web-1',
        post: (e) => posted.push(e as never),
        conversation: () => undefined,
        ...(allowed ? { folderAllowed: allowed } : {}),
      });
      const p = shell.channel.prompt({ kind: 'pickFolder' });
      shell.receive({ type: 'promptResult', id: posted[0].body.id, value });
      return p;
    };
    const allowed = (d: string) => files.folderAllowed(d);
    expect(await answer(project, allowed)).toBe(project);
    expect(await answer(outside, allowed)).toBeUndefined();
    expect(await answer('/etc', allowed)).toBeUndefined();
    expect(await answer(project)).toBeUndefined(); // no check wired: nothing is accepted
  });

  it('a dropped path from a remote device is refused unless it is a staged upload; the window’s is read as before', async () => {
    const run = async (deviceId: string | undefined, paths: string[], allow?: (p: string) => boolean) => {
      const posted: unknown[] = [];
      let listener: (m: unknown) => void = () => undefined;
      const webview = {
        postMessage: async (m: unknown) => (posted.push(m), true),
        onDidReceiveMessage: (l: (m: unknown) => void) => ((listener = l), { dispose() {} }),
      };
      const d = () => ({ dispose() {} });
      const stub = (o: object) => o as never;
      new ConversationHost(
        webview as never,
        stub({ onDidUpdate: d }),
        stub({}),
        stub({}),
        stub({ onDidChange: d }),
        stub({}),
        stub({}),
        stub({}),
        stub({}),
        () => undefined,
        { dialogs: stub({}), offerDictationSetup: async () => undefined, ...(allow ? { allowRemotePath: allow } : {}) },
        { context: ownerContext('browser', deviceId ? { deviceId } : {}), gate: createAccessGate() },
      );
      listener({ type: 'dropPaths', paths });
      await new Promise((r) => setTimeout(r, 20));
      return posted.find((m) => (m as { type?: string }).type === 'dropped') as { mentions: string[]; notes: string[] };
    };
    const secret = path.join(outside, 'secret.txt');
    const staged = JSON.parse((await upload('s.txt', 'x')).text) as { path: string };

    const remote = await run('dev-1', [secret, staged.path], (p) => files.isStaged(p));
    expect(remote.mentions).toHaveLength(1);
    expect(remote.mentions[0]).toContain(path.basename(staged.path));
    expect(remote.notes).toHaveLength(1);
    expect(remote.notes[0]).toContain('secret.txt');

    const none = await run('dev-1', [secret]); // no policy wired: nothing is allowed
    expect(none.mentions).toEqual([]);

    const local = await run(undefined, [secret]);
    expect(local.mentions).toHaveLength(1);
  });
});
