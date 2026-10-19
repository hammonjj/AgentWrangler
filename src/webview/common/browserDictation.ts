/**
 * Dictation with the browser's own microphone (#141).
 *
 * The host can record its own microphone with ffmpeg. In a browser, and
 * above all on a phone, the microphone that matters is the
 * device's: `MediaRecorder` records it, the audio is uploaded to the daemon's
 * `POST /dictation`, and the same Whisper pipeline transcribes it there.
 * The text goes into the composer through the conversation pane's existing
 * `dictation` flow.
 *
 * Browser-only (it uses `navigator`, `MediaRecorder` and `fetch`). Which
 * recorder type to ask for, and whether the page may record at all, are the
 * pure functions in `shared/webCapabilities.ts`.
 */
import { isRelayHost } from './relayHost';
import {
  DICTATION_DURATION_HEADER,
  DICTATION_HEADER,
  DICTATION_MAX_BYTES,
  DICTATION_MAX_MS,
  DICTATION_PATH,
  pickRecorderMime,
  secureContextProblem,
} from '../../shared/webCapabilities';

/** 32 kbit/s: clear speech, and five minutes is about 1.2 MB. */
const RELAY_AUDIO_BPS = 32_000;

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The workbench is in a browser with the shim (it says so on `<html>`). */
export function isBrowserHost(): boolean {
  return document.documentElement.dataset.awHost === 'browser';
}

export interface BrowserDictation {
  /** Open the microphone. Rejects with a message fit to show beside the composer. */
  start(): Promise<void>;
  /**
   * Close it, upload what was said, and resolve with the text (`''` for silence). Over the
   * relay it resolves `undefined`: the text comes back later as a `dictation` message.
   */
  stop(): Promise<string | undefined>;
  /** Close the microphone and keep nothing. */
  cancel(): void;
}

/** `onLimit` is called when the recording reached the five-minute or 10 MB ceiling and stopped itself: call `stop()` to transcribe it. */
export function createBrowserDictation(opts: {
  onLimit(): void;
  /** Hand a recording to the host as a pane message; used instead of `POST /dictation` over the relay (#185). */
  sendAudio(audio: { mime: string; durationMs: number; data: string }): void;
}): BrowserDictation {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];
  let bytes = 0;
  let startedAt = 0;
  let limitTimer: number | undefined;
  let finished: Promise<Blob> | undefined;

  const release = () => {
    if (limitTimer !== undefined) window.clearTimeout(limitTimer);
    limitTimer = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    recorder = undefined;
  };

  return {
    async start() {
      const insecure = secureContextProblem({
        isSecureContext: window.isSecureContext,
        protocol: location.protocol,
        hostname: location.hostname,
      });
      if (insecure) throw new Error(insecure);
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser cannot record audio.');
      }
      const mimeType = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          throw new Error('Microphone access was refused. Allow it for this site in the browser settings, then try again.');
        }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone was found on this device.');
        throw new Error(`The microphone could not be opened: ${(err as Error).message}`);
      }
      chunks = [];
      bytes = 0;
      // Over the relay every byte is metered and the audio does not compress: speech needs little.
      const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), ...(isRelayHost() ? { audioBitsPerSecond: RELAY_AUDIO_BPS } : {}) });
      recorder = rec;
      finished = new Promise<Blob>((resolve) => {
        rec.addEventListener('stop', () => resolve(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' })), { once: true });
      });
      rec.addEventListener('dataavailable', (e) => {
        if (e.data.size === 0) return;
        chunks.push(e.data);
        bytes += e.data.size;
        // Stop short of what the endpoint would refuse: the user keeps what they said.
        if (bytes >= DICTATION_MAX_BYTES * 0.9 && rec.state === 'recording') {
          rec.stop();
          opts.onLimit();
        }
      });
      rec.start(1000);
      startedAt = Date.now();
      limitTimer = window.setTimeout(() => {
        if (rec.state === 'recording') {
          rec.stop();
          opts.onLimit();
        }
      }, DICTATION_MAX_MS - 2000);
    },

    async stop() {
      const rec = recorder;
      const done = finished;
      if (!rec || !done) return '';
      if (rec.state !== 'inactive') rec.stop();
      const blob = await done;
      const duration = Date.now() - startedAt;
      release();
      if (blob.size === 0) return '';
      if (isRelayHost()) {
        // No HTTP route over the relay: the audio goes down the encrypted pane socket, and the
        // host answers with a `dictation` message.
        opts.sendAudio({ mime: blob.type || 'audio/webm', durationMs: Math.min(duration, DICTATION_MAX_MS), data: await toBase64(blob) });
        return undefined;
      }
      const res = await fetch(DICTATION_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': blob.type || 'audio/webm',
          [DICTATION_HEADER]: '1',
          [DICTATION_DURATION_HEADER]: String(Math.min(duration, DICTATION_MAX_MS)),
        },
        body: blob,
      });
      let body: { text?: unknown; error?: unknown } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // Not JSON: the status below says enough.
      }
      if (!res.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : `Transcription failed (${res.status}).`);
      }
      return typeof body.text === 'string' ? body.text : '';
    },

    cancel() {
      const rec = recorder;
      chunks = [];
      if (rec && rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}
