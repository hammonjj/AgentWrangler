/**
 * Files dropped on the composer.
 *
 * Both halves live here because both bundles need one of them and neither may
 * import the other's world: the webview reads paths out of a drop's
 * `DataTransfer` and cannot touch the disk, the extension host reads the disk
 * and writes the text that goes in the message.
 */

/** Extension → the media type the Messages API wants, for the images we can attach. */
const IMAGE_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** What to attach `file` as, or nothing when it is not an image the API accepts. */
export function imageMediaType(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return undefined;
  return IMAGE_TYPE_BY_EXT[file.slice(dot + 1).toLowerCase()];
}

/**
 * The local path a `file:` URI names, or nothing for any other scheme.
 *
 * Dropped URIs are percent-encoded, so a path with a space in it arrives as
 * `%20` and has to be decoded before anything can be read from it.
 */
export function fileUriToPath(uri: string): string | undefined {
  const match = /^file:\/\/([^/]*)(\/[^?#]*)/i.exec(uri.trim());
  if (!match) return undefined;
  const [, authority, encoded] = match;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined; // a malformed escape is not a path worth guessing at
  }
  // `localhost` is the spec's way of saying "this machine"; a real authority is
  // a UNC share, which keeps its slashes.
  const host = authority && authority.toLowerCase() !== 'localhost' ? `//${authority}` : '';
  // `file:///c:/…` is a drive letter, not a root directory.
  if (!host && /^\/[a-zA-Z]:/.test(decoded)) return decoded.slice(1);
  return host + decoded;
}

/**
 * Local paths out of a `text/uri-list` payload: one URI per line, `#` for a
 * comment (RFC 2483). The Finder and VSCode's own explorer both fill it in.
 * Anything that is not a `file:` URI — a dragged link, say — is not ours.
 */
export function fileUrisToPaths(uriList: string): string[] {
  const out: string[] = [];
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const file = fileUriToPath(trimmed);
    if (file !== undefined) out.push(file);
  }
  return out;
}

/** `file` relative to `cwd`, or nothing when it lives outside it. */
export function relativeToCwd(cwd: string, file: string): string | undefined {
  const root = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  if (!root) return undefined;
  if (file === root) return '.';
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined;
}

/**
 * How a dropped file is named in the message: `@`-prefixed, relative to the
 * session's folder when it is inside it and absolute when it is not, which is
 * what dragging a file into the TUI writes.
 */
export function mentionForPath(cwd: string, file: string): string {
  const shown = relativeToCwd(cwd, file) ?? file;
  // Without the quotes a path with a space in it reads as a mention of its
  // first word followed by a sentence.
  return /\s/.test(shown) ? `@"${shown}"` : `@${shown}`;
}
