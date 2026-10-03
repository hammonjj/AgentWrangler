/**
 * The window-as-a-client's rules (#131), as pure functions so they are tested
 * without Electron: which origin the window belongs to, where it may navigate,
 * when to sign in again, and how long to wait for a sign-in link.
 *
 * The window loads the core daemon's web workbench from a single-use loopback
 * login link (`web.link` over the control socket, the same as `aw web open`).
 * The link's origin, `http://127.0.0.1:<port>`, is the only one the window may
 * show; everything else is the real browser's business or nobody's.
 */
import { formatRoute } from '../shared/appRoutes';

/**
 * The origin a login link belongs to, if it is one the window may load:
 * plain http on loopback with an explicit port. Anything else (a LAN https
 * link, another host, a malformed answer) is refused rather than shown.
 */
export function loopbackOrigin(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:') return undefined;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return undefined;
  if (!url.port) return undefined;
  if (url.username || url.password) return undefined;
  return url.origin;
}

/**
 * Where the Preferences menu item takes the window (#135): the workbench's own
 * `#/preferences` route. A hash-only change when the page is already loaded,
 * so the connection and the table stay as they are.
 */
export function preferencesUrl(origin: string): string {
  return `${origin}/${formatRoute({ kind: 'preferences' })}`;
}

/**
 * - `allow`: the workbench's own origin; the window goes there;
 * - `external`: a web or mail link; it opens in the user's browser or mail app;
 * - `deny`: anything else (`file:`, `javascript:`, `data:`, custom schemes); nothing happens.
 */
export type NavigationVerdict = 'allow' | 'external' | 'deny';

export function navigationVerdict(target: string, origin: string): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'deny';
  }
  if (url.origin === origin && (url.protocol === 'http:' || url.protocol === 'https:')) return 'allow';
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return 'external';
  return 'deny';
}

/**
 * A page load the window should answer with a fresh login link: a 401 from
 * the workbench's own origin. The device cookie has expired or was revoked,
 * or the data directory's device list was reset; the window is this Mac's own
 * user, so it signs in again rather than showing "run aw web open".
 */
export function shouldSignInAgain(httpResponseCode: number, url: string, origin: string): boolean {
  if (httpResponseCode !== 401) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Why a sign-in link could not be had, for the window's error dialog. */
export class LoginLinkError extends Error {}

export interface LoginLinkAttempt {
  /** The link, or undefined: nothing answers on the control socket (yet). */
  (): Promise<{ url: string } | undefined>;
}

/**
 * Ask for a login link until one comes or `timeoutMs` passes.
 *
 * Just after the daemon starts, the control socket answers before the web
 * server has bound its port, so "the browser workbench is not running" is
 * retried like "nothing answers" until the deadline; the last error is what
 * the window then reports.
 */
export async function waitForLoginLink(
  attempt: LoginLinkAttempt,
  opts: { timeoutMs: number; intervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<string> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  let last = 'The Agent Wrangler background service is not answering.';
  for (;;) {
    try {
      const link = await attempt();
      if (link) {
        if (loopbackOrigin(link.url)) return link.url;
        throw new LoginLinkError(`The background service offered a sign-in link the window will not load: ${link.url}`);
      }
    } catch (err) {
      if (err instanceof LoginLinkError) throw err;
      last = err instanceof Error ? err.message : String(err);
    }
    if (now() >= deadline) throw new LoginLinkError(last);
    await sleep(opts.intervalMs);
  }
}
