/**
 * Files between a remote browser and the host (#139, plan §6): the wire shapes
 * of `POST /upload`, `GET /files` and `GET /api/dirs`.
 *
 * The rule behind all of it: a path typed or dragged in a remote browser is
 * not a path on the host. The browser never gets to name one; it uploads, and
 * is told the host path of the copy, or it asks the host to list directories
 * and chooses from what comes back.
 *
 * No Node or DOM imports: the server and the browser both use it.
 */

export const UPLOAD_PATH = '/upload';
export const FILES_PATH = '/files';
export const DIRS_PATH = '/api/dirs';

/** Required on an upload, so a plain cross-site form cannot make one (a custom header forces a preflight). */
export const UPLOAD_HEADER = 'x-aw-upload';
/** The file's name, url-encoded. The host keeps only its basename. */
export const FILENAME_HEADER = 'x-aw-filename';
/** The conversation (session key) it is for; it picks the staging directory. */
export const CONVERSATION_HEADER = 'x-aw-conversation';

/** The largest upload, per file. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The reply to a good upload. `path` is on the host. */
export interface UploadResult {
  path: string;
  name: string;
  size: number;
}

export interface DirEntry {
  name: string;
  /** Absolute, on the host. */
  path: string;
}

/** A project the host already knows, offered first in the folder browser. */
export interface DirProject {
  name: string;
  path: string;
}

/** The reply to `GET /api/dirs`. Everything in it is a path on the host. */
export interface DirListing {
  /** The directory listed (real path). With no path asked for, the home folder. */
  path: string;
  /** Its parent, when the user may go up to it. */
  parent?: string;
  home: string;
  /** Only on the starting view (no path asked for). */
  projects: DirProject[];
  /** Directories only, sorted. */
  entries: DirEntry[];
  /** There were more than `MAX_DIR_ENTRIES`; the rest are not shown. */
  truncated: boolean;
  hidden: boolean;
}

/** At most this many directories in one listing. */
export const MAX_DIR_ENTRIES = 500;
