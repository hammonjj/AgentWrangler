/**
 * What opening Agent Wrangler.app does (#142), as a function of its effects so
 * it is tested with fakes (`main.ts` wires the real ones):
 *
 * 1. **Make sure the core daemon is running** on this build: install or update
 *    its LaunchAgent and start it (`CoreDaemonAgent.ensure`, the same work as
 *    `aw daemon start`). Agents are in session hosts, so an update restarts
 *    the daemon and nothing else.
 * 2. **Ask it for a single-use loopback sign-in link** over the control socket
 *    (`web.link`, as `aw web open` asks). This is the same user on the same
 *    Mac, which is what the socket's token proves. The browser may already
 *    hold a device cookie; the launcher cannot know, and a fresh link costs
 *    nothing: `/login` keeps the device it already has.
 * 3. **Open it in the default browser**, and exit, so nothing lingers in the
 *    Dock (the bundle is `LSUIElement` as well).
 *
 * "Open at login" is the LaunchAgent's `RunAtLoad`, not this.
 *
 * `--dry-run` changes nothing: it starts, installs and opens nothing, says
 * what it would do, and if the daemon is already running on this build asks
 * for a link (proving the path end to end) and prints it with its token
 * removed.
 */

export interface LaunchDaemon {
  /** Install, update or start the daemon as needed; resolves once it answers. Throws a user-worded error. */
  ensure(): Promise<{ outcome: string; manifest: { pid: number; build: string } }>;
  /** For `--dry-run`: running on this build, running on another, or not running. */
  check(): Promise<{ state: 'current' | 'other-build' | 'not-running' | 'old-app'; pid?: number; build?: string }>;
}

export interface LaunchDeps {
  daemon: LaunchDaemon;
  /** One `web.link` over the control socket; undefined while nothing answers. */
  requestLink(): Promise<{ url: string } | undefined>;
  /** Hand the link to the default browser. */
  open(url: string): Promise<void>;
  /** Something went wrong and nobody is watching a terminal: a dialog. */
  alert(message: string, detail: string): Promise<void>;
  log(message: string): void;
  /** What a terminal sees (`--dry-run`). */
  out(text: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LaunchOptions {
  dryRun: boolean;
  /** How long to wait for the web server once the daemon answers. Default 20 s. */
  linkTimeoutMs?: number;
  linkIntervalMs?: number;
}

/** Exit codes: 0 opened (or, dry, would open); 1 could not; 2 bad arguments. */
export async function launch(deps: LaunchDeps, opts: LaunchOptions): Promise<number> {
  const { log } = deps;
  const linkWait = {
    timeoutMs: opts.linkTimeoutMs ?? 20_000,
    intervalMs: opts.linkIntervalMs ?? 250,
    now: deps.now,
    sleep: deps.sleep,
  };

  if (opts.dryRun) {
    const st = await deps.daemon.check();
    switch (st.state) {
      case 'not-running':
        deps.out('dry run: the core daemon is not running; it would be installed or started, then a browser opened.\n');
        return 0;
      case 'other-build':
        deps.out(`dry run: the core daemon is running build ${st.build} (pid ${st.pid}); it would be moved onto this build, then a browser opened.\n`);
        return 0;
      case 'old-app':
        deps.out('dry run: an older Agent Wrangler app is running the core; it would have to be quit first.\n');
        return 1;
      case 'current':
        break;
    }
    let url: string;
    try {
      url = await waitForLoginLink(deps.requestLink, linkWait);
    } catch (err) {
      deps.out(`dry run: the core daemon is running (pid ${st.pid}) but gave no sign-in link: ${message(err)}\n`);
      return 1;
    }
    deps.out(`dry run: the core daemon is running (pid ${st.pid}, build ${st.build}); would open ${redactLink(url)}\n`);
    return 0;
  }

  try {
    const { outcome, manifest } = await deps.daemon.ensure();
    log(`launcher: core daemon ${outcome}, pid ${manifest.pid}, build ${manifest.build}`);
  } catch (err) {
    log(`launcher: the core daemon did not start: ${message(err)}`);
    await deps.alert('Agent Wrangler did not start', message(err));
    return 1;
  }

  let url: string;
  try {
    url = await waitForLoginLink(deps.requestLink, linkWait);
  } catch (err) {
    log(`launcher: no sign-in link: ${message(err)}`);
    await deps.alert(
      'Agent Wrangler could not be opened in your browser',
      `${message(err)}\n\nThe background service is still running, and so are your agents. "aw daemon status" says how it is; "aw web open" tries again.`,
    );
    return 1;
  }

  try {
    // Not logged: the link is a credential until it is used.
    await deps.open(url);
    log(`launcher: opened ${loopbackOrigin(url) ?? 'the workbench'} in the default browser`);
    return 0;
  } catch (err) {
    log(`launcher: could not open the browser: ${message(err)}`);
    await deps.alert('Agent Wrangler could not open your browser', `${message(err)}\n\n"aw web open" tries again.`);
    return 1;
  }
}

/** The arguments the launcher takes: `--dry-run`, and nothing else. */
export function parseLauncherArgs(argv: readonly string[]): { dryRun: boolean } | { error: string } {
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else {
      return {
        error:
          `Agent Wrangler's launcher takes no arguments but --dry-run (got ${JSON.stringify(a)}). ` +
          'If this came from the aw command, it is from an older install: run npm run cli:install.',
      };
    }
  }
  return { dryRun };
}

/**
 * The origin a sign-in link belongs to, if it is one the launcher may open:
 * plain http on loopback with an explicit port. Anything else (a LAN https
 * link, another host, a malformed answer) is refused rather than opened.
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

/** A link with its query (the single-use token) removed, for a terminal or a log. */
export function redactLink(link: string): string {
  try {
    const url = new URL(link);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return '(malformed link)';
  }
}

/** Why a sign-in link could not be had, worded for the dialog. */
export class LoginLinkError extends Error {}

/**
 * Ask for a sign-in link until one comes or `timeoutMs` passes.
 *
 * Just after the daemon starts, the control socket answers before the web
 * server has bound its port, so "the browser workbench is not running" is
 * retried like "nothing answers" until the deadline; the last error is what
 * is then reported.
 */
export async function waitForLoginLink(
  attempt: () => Promise<{ url: string } | undefined>,
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
        throw new LoginLinkError(`The background service offered a sign-in link that is not on this Mac: ${redactLink(link.url)}`);
      }
    } catch (err) {
      if (err instanceof LoginLinkError) throw err;
      last = message(err);
    }
    if (now() >= deadline) throw new LoginLinkError(last);
    await sleep(opts.intervalMs);
  }
}

/**
 * `display alert` with the message and detail as `argv`, never spliced into
 * the script: an error message can contain anything, and inside an
 * AppleScript literal it could close the string and run whatever followed.
 */
export function alertArgs(messageText: string, detail: string): string[] {
  const script = ['on run argv', 'display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"OK"} default button "OK"', 'end run'];
  return [...script.flatMap((line) => ['-e', line]), '--', messageText, detail];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
