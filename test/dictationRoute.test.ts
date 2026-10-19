/**
 * `POST /dictation` (#141): auth, caps and content types, against the real
 * web server and a fake transcriber. No ffmpeg, whisper or microphone.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGate } from '../src/core/access';
import { DictationSetupError } from '../src/core/dictation';
import { createDictationRoute } from '../src/core/web/dictationRoute';
import { DEVICE_COOKIE, WebServer } from '../src/core/web/server';
import { DICTATION_DURATION_HEADER, DICTATION_HEADER, DICTATION_MAX_BYTES } from '../src/shared/webCapabilities';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';

interface Reply {
  status: number;
  json: { text?: string; error?: string; remedy?: string };
}

let dir: string;
let server: WebServer;
let port: number;
let host: string;
let cookie: string;
let calls: { bytes: number; ext: string }[];
let transcribe: (audio: Buffer, ext: string) => Promise<string>;
let gateAllows: boolean;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dict-route-'));
  const webviewDir = path.join(dir, 'dist', 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
  calls = [];
  gateAllows = true;
  transcribe = async (audio, ext) => {
    calls.push({ bytes: audio.length, ext });
    return 'hello there';
  };
  const base = createAccessGate();
  server = new WebServer({
    port: 0,
    webviewDir,
    dataDir: path.join(dir, 'data'),
    gate: { ...base, admit: (ctx, action, resource) => (action === 'dictation.use' ? gateAllows : base.admit(ctx, action, resource)) },
    log: () => undefined,
    page: renderBrowserWorkbenchHtml,
    onClient: (socket) => socket.close(),
    routes: [createDictationRoute({ transcribe: (a, e) => transcribe(a, e), log: () => undefined })],
  });
  port = await server.listen();
  host = `127.0.0.1:${port}`;
  const code = new URL(server.loginLink().url).searchParams.get('code');
  const login = await raw('GET', `/login?code=${code}`, undefined, {});
  cookie = String(login.headers['set-cookie']?.[0]).split(';')[0]!.split('=')[1]!;
});

afterEach(() => {
  server.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function raw(method: string, pathname: string, body: Buffer | undefined, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // A refused oversized upload may close the socket on us mid-write.
    req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE' ? resolve({ status: 413, headers: {}, body: '{}' }) : reject(err)));
    req.end(body);
  });
}

async function upload(
  body: Buffer,
  opts: { type?: string; headers?: Record<string, string>; auth?: boolean; origin?: string | null; custom?: boolean } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    'content-type': opts.type ?? 'audio/webm;codecs=opus',
    'content-length': String(body.length),
    ...(opts.origin === null ? {} : { origin: opts.origin ?? `http://${host}` }),
    ...(opts.auth === false ? {} : { cookie: `${DEVICE_COOKIE}=${cookie}` }),
    ...(opts.custom === false ? {} : { [DICTATION_HEADER]: '1' }),
    ...opts.headers,
  };
  const r = await raw('POST', '/dictation', body, headers);
  let json: Reply['json'] = {};
  try {
    json = JSON.parse(r.body) as Reply['json'];
  } catch {
    // plain-text refusals from the server itself
  }
  return { status: r.status, json };
}

const audio = (n = 2048) => Buffer.alloc(n, 1);

describe('POST /dictation', () => {
  it('transcribes an upload and returns the text', async () => {
    const r = await upload(audio());
    expect(r.status).toBe(200);
    expect(r.json.text).toBe('hello there');
    expect(calls).toEqual([{ bytes: 2048, ext: 'webm' }]);
  });

  it('takes iOS Safari audio/mp4', async () => {
    const r = await upload(audio(), { type: 'audio/mp4' });
    expect(r.status).toBe(200);
    expect(calls[0]!.ext).toBe('m4a');
  });

  it('refuses without a device cookie (401), without Origin or from another one (403), without the header (403)', async () => {
    expect((await upload(audio(), { auth: false })).status).toBe(401);
    expect((await upload(audio(), { origin: null })).status).toBe(403);
    expect((await upload(audio(), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await upload(audio(), { custom: false })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses when the access gate does', async () => {
    gateAllows = false;
    expect((await upload(audio())).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses anything that is not audio it takes (415)', async () => {
    for (const type of ['text/plain', 'application/octet-stream', 'video/mp4', 'audio/x-unknown', '']) {
      expect((await upload(audio(), { type })).status).toBe(415);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a declared length over 10 MB, and a claimed duration over five minutes (413)', async () => {
    const big = await upload(Buffer.alloc(DICTATION_MAX_BYTES + 1024, 1));
    expect(big.status).toBe(413);
    const long = await upload(audio(), { headers: { [DICTATION_DURATION_HEADER]: String(5 * 60 * 1000 + 1) } });
    expect(long.status).toBe(413);
    const junk = await upload(audio(), { headers: { [DICTATION_DURATION_HEADER]: 'abc' } });
    expect(junk.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('accepts a duration at the ceiling', async () => {
    const r = await upload(audio(), { headers: { [DICTATION_DURATION_HEADER]: String(5 * 60 * 1000) } });
    expect(r.status).toBe(200);
  });

  it('refuses an empty body (400)', async () => {
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('says what is missing when whisper or ffmpeg is (503 with the remedy)', async () => {
    transcribe = async () => {
      throw new DictationSetupError('whisper.cpp is needed to transcribe, and was not found.', 'install-whisper');
    };
    const r = await upload(audio());
    expect(r.status).toBe(503);
    expect(r.json.remedy).toBe('install-whisper');
    expect(r.json.error).toContain('whisper.cpp');
  });

  it('reports a failed transcription (500)', async () => {
    transcribe = async () => {
      throw new Error('ffmpeg could not read the recording');
    };
    const r = await upload(audio());
    expect(r.status).toBe(500);
    expect(r.json.error).toContain('Could not transcribe');
  });

  it('transcribes one recording at a time (429), and is free again afterwards', async () => {
    let release!: () => void;
    transcribe = () => new Promise<string>((resolve) => (release = () => resolve('first')));
    const first = upload(audio());
    await new Promise((r) => setTimeout(r, 50));
    expect((await upload(audio())).status).toBe(429);
    release();
    expect((await first).json.text).toBe('first');
    transcribe = async () => 'again';
    expect((await upload(audio())).json.text).toBe('again');
  });

  it('is still 405 for a POST nobody registered', async () => {
    const r = await raw('POST', '/other', Buffer.alloc(1), { origin: `http://${host}`, cookie: `${DEVICE_COOKIE}=${cookie}` });
    expect(r.status).toBe(405);
  });
});
