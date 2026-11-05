/**
 * Browser side of `POST /upload` and `GET /files` (#139, `src/core/web/files.ts`).
 *
 * A file in a remote browser has no path the host could read, so it is sent to
 * the host and the host's path for the copy comes back. Same origin, so the
 * device cookie rides along; the custom header is what a cross-site form
 * cannot add.
 */
import {
  CONVERSATION_HEADER,
  FILENAME_HEADER,
  FILES_PATH,
  MAX_UPLOAD_BYTES,
  RELAY_UPLOAD_CHUNK_BYTES,
  RELAY_UPLOAD_MAX_BYTES,
  UPLOAD_HEADER,
  UPLOAD_PATH,
  type UploadAck,
  type UploadChunk,
  type UploadResult,
} from '../../shared/files';

import { isRelayHost } from './relayHost';

/** How long the host may take to acknowledge one chunk before the upload is given up. */
const ACK_TIMEOUT_MS = 30_000;

const waiting = new Map<string, (ack: UploadAck) => void>();

/** The page passes each `uploadAck` pane message here. */
export function onUploadAck(ack: UploadAck): void {
  waiting.get(ack.id)?.(ack);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Over the relay there is no `POST /upload`: the file goes down the encrypted pane socket in
 * chunks, each acknowledged by the host before the next is sent (#200).
 */
async function uploadOverRelay(file: File, send: (chunk: UploadChunk) => void): Promise<UploadResult> {
  const limit = Math.floor(RELAY_UPLOAD_MAX_BYTES / 1024 / 1024);
  if (file.size > limit * 1024 * 1024) throw new Error(`${file.name} is over the ${limit} MB limit for uploads over remote control.`);
  const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const count = Math.max(1, Math.ceil(file.size / RELAY_UPLOAD_CHUNK_BYTES));
  try {
    for (let index = 0; index < count; index++) {
      const slice = file.slice(index * RELAY_UPLOAD_CHUNK_BYTES, (index + 1) * RELAY_UPLOAD_CHUNK_BYTES);
      const data = toBase64(new Uint8Array(await slice.arrayBuffer()));
      const answered = new Promise<UploadAck>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the host did not answer')), ACK_TIMEOUT_MS);
        waiting.set(id, (ack) => {
          clearTimeout(timer);
          resolve(ack);
        });
      });
      send({ id, name: file.name, index, count, size: file.size, data });
      const ack = await answered;
      if (ack.error) throw new Error(ack.error.replace(/\.$/, ''));
      if (index === count - 1) {
        if (!ack.result) throw new Error('the host did not report where it kept the file');
        return ack.result;
      }
    }
  } catch (err) {
    throw new Error(`Could not upload ${file.name}: ${(err as Error).message}.`);
  } finally {
    waiting.delete(id);
  }
  throw new Error(`Could not upload ${file.name}.`);
}

/**
 * Send `file` to the host for the conversation `sessionKey`. Throws an `Error` whose message can be shown.
 * `relaySend` posts one chunk as a pane message; it is what a remote-control page uses.
 */
export async function uploadFile(file: File, sessionKey: string, relaySend?: (chunk: UploadChunk) => void): Promise<UploadResult> {
  if (isRelayHost()) {
    if (!relaySend) throw new Error(`Could not upload ${file.name}: uploads are not available here.`);
    return uploadOverRelay(file, relaySend);
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is over the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.`);
  let res: Response;
  try {
    res = await fetch(UPLOAD_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        [UPLOAD_HEADER]: '1',
        [FILENAME_HEADER]: encodeURIComponent(file.name),
        [CONVERSATION_HEADER]: sessionKey,
        'content-type': 'application/octet-stream',
      },
      body: file,
    });
  } catch {
    throw new Error(`Could not upload ${file.name}: the connection to the host failed.`);
  }
  if (!res.ok) {
    const why = res.status === 413 ? 'it is too large' : res.status === 429 ? 'too many uploads, wait a minute' : `status ${res.status}`;
    throw new Error(`Could not upload ${file.name}: ${why}.`);
  }
  return (await res.json()) as UploadResult;
}

/** A link that downloads a file from the host, if it is in a folder a browser may read from. */
export function downloadUrl(hostPath: string): string {
  return `${FILES_PATH}?path=${encodeURIComponent(hostPath)}`;
}
