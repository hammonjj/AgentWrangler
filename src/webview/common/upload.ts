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
  UPLOAD_HEADER,
  UPLOAD_PATH,
  type UploadResult,
} from '../../shared/files';

/** Send `file` to the host for the conversation `sessionKey`. Throws an `Error` whose message can be shown. */
export async function uploadFile(file: File, sessionKey: string): Promise<UploadResult> {
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
