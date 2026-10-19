/**
 * `POST /dictation` (#141): a browser's recording, transcribed on the Mac.
 *
 * A phone has no use for the host's microphone; it records with
 * `MediaRecorder` and uploads the audio here. The body is the raw audio, the
 * `Content-Type` its container. The reply is `{text}` (empty for silence) or
 * `{error, remedy?}` with a status that says why.
 *
 * Refused before any audio is read, in order: no `x-aw-dictation` header
 * (403; with the `Origin` check the server already made, what stops another
 * site posting audio at a signed-in browser), the access gate (403), a
 * content type that is not audio we take (415), a declared length over the
 * caps (413). While reading, a body that outgrows the cap is cut off (413).
 * One transcription at a time (429): Whisper uses the whole machine.
 */
import type * as http from 'node:http';
import { DictationSetupError } from '../dictation';
import {
  DICTATION_DURATION_HEADER,
  DICTATION_HEADER,
  DICTATION_MAX_BYTES,
  DICTATION_MAX_MS,
  DICTATION_PATH,
  audioExtension,
} from '../../shared/webCapabilities';
import type { WebRoute } from './server';

export interface DictationRouteOptions {
  /** Audio in, text out: `DictationService.transcribeAudio`; a fake in tests. */
  transcribe(audio: Buffer, ext: string): Promise<string>;
  log(line: string): void;
}

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-type': 'application/json; charset=utf-8',
} as const;

function reply(res: http.ServerResponse, status: number, body: object): void {
  if (res.headersSent) return;
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(body));
}

export function createDictationRoute(opts: DictationRouteOptions): WebRoute {
  let busy = false;
  return {
    methods: ['POST'],
    match: (pathname) => pathname === DICTATION_PATH,
    async handle(ctx) {
      const { req, res } = ctx;
      if (req.headers[DICTATION_HEADER] !== '1') return reply(res, 403, { error: 'Missing the dictation header.' });
      if (!ctx.gate.admit(ctx.context, 'dictation.use')) return reply(res, 403, { error: 'Not permitted.' });
      const ext = audioExtension(req.headers['content-type']);
      if (!ext) return reply(res, 415, { error: 'That is not audio Agent Wrangler can read.' });
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > DICTATION_MAX_BYTES) {
        return tooLong(req, res);
      }
      const duration = req.headers[DICTATION_DURATION_HEADER];
      if (duration !== undefined && !(Number(duration) <= DICTATION_MAX_MS)) return tooLong(req, res);
      if (busy) return reply(res, 429, { error: 'Another recording is being transcribed. Try again in a moment.' });

      const audio = await readCapped(req, DICTATION_MAX_BYTES);
      if (audio === 'too-big') return tooLong(req, res);
      if (audio === 'aborted') return;
      if (audio.length === 0) return reply(res, 400, { error: 'The recording was empty.' });

      busy = true;
      try {
        const text = await opts.transcribe(audio, ext);
        reply(res, 200, { text });
      } catch (err) {
        if (err instanceof DictationSetupError) {
          reply(res, 503, { error: err.message, remedy: err.remedy });
        } else {
          opts.log(`dictation upload: ${(err as Error).message}`);
          reply(res, 500, { error: `Could not transcribe: ${(err as Error).message}` });
        }
      } finally {
        busy = false;
      }
    },
  };
}

function tooLong(req: http.IncomingMessage, res: http.ServerResponse): void {
  reply(res, 413, { error: 'That recording is too long. Keep it under five minutes.' });
  // Not worth reading the rest of what we have refused.
  res.once('finish', () => req.destroy());
}

/** The body, or `'too-big'` the moment it passes `max`, or `'aborted'` if the client went away. */
function readCapped(req: http.IncomingMessage, max: number): Promise<Buffer | 'too-big' | 'aborted'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | 'too-big' | 'aborted') => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        chunks.length = 0;
        finish('too-big');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish('aborted'));
    req.on('aborted', () => finish('aborted'));
    req.on('close', () => finish('aborted'));
  });
}
