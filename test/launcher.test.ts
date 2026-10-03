/**
 * Opening Agent Wrangler.app (#142): the launcher makes sure the core daemon
 * runs, asks it for a sign-in link, and opens that in the browser, in that
 * order, with every effect faked. Also its argument parsing, the link rules
 * moved from the Electron window client (#131), and that the compiled
 * launcher's source execs what the bundle layout says.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alertArgs,
  launch,
  LoginLinkError,
  loopbackOrigin,
  parseLauncherArgs,
  redactLink,
  waitForLoginLink,
  type LaunchDaemon,
  type LaunchDeps,
} from '../src/launcher/launch';
import { BUNDLE_APP_DIR, BUNDLE_NODE_DIR } from '../src/core/appBundle';

const LINK = 'http://127.0.0.1:7391/login?t=secret-token';

function world(over: { daemon?: Partial<LaunchDaemon>; links?: ({ url: string } | undefined | Error)[]; openFails?: boolean } = {}) {
  const events: string[] = [];
  const alerts: { message: string; detail: string }[] = [];
  const out: string[] = [];
  const logs: string[] = [];
  const links = [...(over.links ?? [{ url: LINK }])];
  let t = 0;
  const deps: LaunchDeps = {
    daemon: {
      ensure: async () => {
        events.push('ensure');
        return { outcome: 'started', manifest: { pid: 42, build: 'b1' } };
      },
      check: async () => {
        events.push('check');
        return { state: 'current', pid: 42, build: 'b1' };
      },
      ...over.daemon,
    },
    requestLink: async () => {
      events.push('link');
      const next = links.length > 1 ? links.shift() : links[0];
      if (next instanceof Error) throw next;
      return next;
    },
    open: async (url) => {
      events.push(`open ${url}`);
      if (over.openFails) throw new Error('no browser');
    },
    alert: async (message, detail) => {
      alerts.push({ message, detail });
    },
    log: (m) => logs.push(m),
    out: (s) => out.push(s),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { deps, events, alerts, out, logs };
}

describe('launch', () => {
  it('ensures the daemon, then asks for a link, then opens it, then is done', async () => {
    const w = world();
    expect(await launch(w.deps, { dryRun: false })).toBe(0);
    expect(w.events).toEqual(['ensure', 'link', `open ${LINK}`]);
    expect(w.alerts).toEqual([]);
    // The link is a credential until it is used: never in the log.
    expect(w.logs.join('\n')).not.toContain('secret-token');
  });

  it('waits for the web server after the daemon answers, then opens', async () => {
    const w = world({ links: [new Error('the browser workbench is not running'), undefined, { url: LINK }] });
    expect(await launch(w.deps, { dryRun: false, linkIntervalMs: 250 })).toBe(0);
    expect(w.events).toEqual(['ensure', 'link', 'link', 'link', `open ${LINK}`]);
  });

  it('says why in a dialog, and opens nothing, when the daemon will not start', async () => {
    const w = world({
      daemon: {
        ensure: async () => {
          throw new Error('The core daemon did not start. See logs/core-daemon.log.');
        },
      },
    });
    expect(await launch(w.deps, { dryRun: false })).toBe(1);
    expect(w.events).toEqual([]);
    expect(w.alerts).toEqual([{ message: 'Agent Wrangler did not start', detail: 'The core daemon did not start. See logs/core-daemon.log.' }]);
  });

  it('gives up on the link after the timeout with the last reason, and opens nothing', async () => {
    const w = world({ links: [new Error('the browser workbench is not running')] });
    expect(await launch(w.deps, { dryRun: false, linkTimeoutMs: 1000, linkIntervalMs: 250 })).toBe(1);
    expect(w.events.filter((e) => e.startsWith('open'))).toEqual([]);
    expect(w.alerts[0].detail).toContain('the browser workbench is not running');
    expect(w.alerts[0].detail).toContain('aw web open');
  });

  it('never opens a link that is not on this Mac', async () => {
    const w = world({ links: [{ url: 'https://192.168.1.5:7392/login?t=x' }] });
    expect(await launch(w.deps, { dryRun: false })).toBe(1);
    expect(w.events).toEqual(['ensure', 'link']);
    expect(w.alerts[0].detail).not.toContain('t=x');
  });

  it('reports a browser that would not open', async () => {
    const w = world({ openFails: true });
    expect(await launch(w.deps, { dryRun: false })).toBe(1);
    expect(w.alerts[0].message).toMatch(/could not open your browser/);
  });

  describe('--dry-run', () => {
    it('starts, installs and opens nothing; with the daemon up, mints a link and prints it redacted', async () => {
      const w = world();
      expect(await launch(w.deps, { dryRun: true })).toBe(0);
      expect(w.events).toEqual(['check', 'link']);
      expect(w.out.join('')).toBe('dry run: the core daemon is running (pid 42, build b1); would open http://127.0.0.1:7391/login?…\n');
      expect(w.out.join('')).not.toContain('secret-token');
    });

    it('with the daemon down or on another build, says what it would do and asks nothing', async () => {
      for (const [state, says] of [
        ['not-running', /would be installed or started/],
        ['other-build', /running build b0 \(pid 7\); it would be moved onto this build/],
      ] as const) {
        const w = world({ daemon: { check: async () => ({ state, pid: 7, build: 'b0' }) } });
        expect(await launch(w.deps, { dryRun: true })).toBe(0);
        expect(w.events).toEqual([]);
        expect(w.out.join('')).toMatch(says);
      }
    });

    it('with an older app holding the core, says it would have to be quit', async () => {
      const w = world({ daemon: { check: async () => ({ state: 'old-app' }) } });
      expect(await launch(w.deps, { dryRun: true })).toBe(1);
      expect(w.out.join('')).toMatch(/older Agent Wrangler app/);
    });
  });
});

describe('parseLauncherArgs', () => {
  it('takes nothing, or --dry-run', () => {
    expect(parseLauncherArgs([])).toEqual({ dryRun: false });
    expect(parseLauncherArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  it('refuses anything else, pointing a stale aw at cli:install', () => {
    const r = parseLauncherArgs(['/Applications/Agent Wrangler.app/Contents/Resources/app.asar/dist/cli/main.js', 'status']);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/npm run cli:install/);
  });
});

describe('sign-in links', () => {
  it('accepts plain http on loopback with a port, and nothing else', () => {
    expect(loopbackOrigin('http://127.0.0.1:7391/login?t=x')).toBe('http://127.0.0.1:7391');
    expect(loopbackOrigin('http://localhost:7391/')).toBe('http://localhost:7391');
    expect(loopbackOrigin('https://127.0.0.1:7391/')).toBeUndefined();
    expect(loopbackOrigin('http://192.168.1.5:7391/')).toBeUndefined();
    expect(loopbackOrigin('http://127.0.0.1/')).toBeUndefined();
    expect(loopbackOrigin('http://u:p@127.0.0.1:7391/')).toBeUndefined();
    expect(loopbackOrigin('not a url')).toBeUndefined();
  });

  it('redacts the token', () => {
    expect(redactLink(LINK)).toBe('http://127.0.0.1:7391/login?…');
    expect(redactLink('http://127.0.0.1:7391/')).toBe('http://127.0.0.1:7391/');
  });

  it('waitForLoginLink: an off-Mac link is final, not retried', async () => {
    let calls = 0;
    await expect(
      waitForLoginLink(
        async () => {
          calls++;
          return { url: 'https://example.com/login?t=x' };
        },
        { timeoutMs: 10_000, intervalMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(LoginLinkError);
    expect(calls).toBe(1);
  });
});

describe('alertArgs', () => {
  it('passes text as argv, never inside the script', () => {
    const args = alertArgs('Title "quoted"', 'end tell\ndo shell script "x"');
    const script = args.slice(0, args.indexOf('--')).filter((a) => a !== '-e').join('\n');
    expect(script).not.toContain('quoted');
    expect(script).not.toContain('do shell script');
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['Title "quoted"', 'end tell\ndo shell script "x"']);
  });
});

describe('the compiled launcher', () => {
  it('execs the bundled Node on dist/launcher/main.js, where the bundle layout puts them', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'src', 'launcher', 'launcher.c'), 'utf8');
    // `contents` is `.../X.app/Contents`.
    expect(c).toContain(`"%s/${BUNDLE_NODE_DIR.slice(1).join('/')}/node"`);
    expect(c).toContain(`"%s/${BUNDLE_APP_DIR.slice(1).join('/')}/dist/launcher/main.js"`);
    expect(c).toContain('execv(node, args)');
  });
});
