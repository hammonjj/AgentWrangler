/**
 * The window-as-a-client's rules (#131): which login links the window loads,
 * where it may navigate, when it signs in again, and how it waits for the
 * daemon's web server.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LoginLinkError,
  loopbackOrigin,
  navigationVerdict,
  preferencesUrl,
  shouldSignInAgain,
  waitForLoginLink,
} from '../src/electron/windowClientPolicy';

const ORIGIN = 'http://127.0.0.1:7391';

it('the policy and the daemon-side wiring import no Electron', () => {
  const src = path.join(__dirname, '..', 'src');
  for (const f of ['electron/windowClientPolicy.ts', 'app/webWorkbench.ts', 'app/workbenchHosts.ts', 'daemon/clients.ts', 'daemon/startCore.ts']) {
    expect(fs.readFileSync(path.join(src, f), 'utf8'), f).not.toMatch(/from\s+['"]electron['"]/);
  }
});

describe('loopbackOrigin', () => {
  it('accepts a loopback http login link and returns its origin', () => {
    expect(loopbackOrigin('http://127.0.0.1:7391/login?code=abc')).toBe(ORIGIN);
    expect(loopbackOrigin('http://localhost:8000/login?code=abc')).toBe('http://localhost:8000');
  });

  it('refuses anything the window should not load', () => {
    expect(loopbackOrigin('https://192.168.1.5:7392/login?code=abc')).toBeUndefined(); // a LAN link
    expect(loopbackOrigin('http://example.com:7391/login')).toBeUndefined();
    expect(loopbackOrigin('http://127.0.0.1/login')).toBeUndefined(); // no explicit port
    expect(loopbackOrigin('http://user:pw@127.0.0.1:7391/')).toBeUndefined();
    expect(loopbackOrigin('file:///Users/test/proj/index.html')).toBeUndefined();
    expect(loopbackOrigin('not a url')).toBeUndefined();
  });
});

describe('preferencesUrl', () => {
  it('is the workbench route, on the origin the window already shows', () => {
    expect(preferencesUrl(ORIGIN)).toBe(`${ORIGIN}/#/preferences`);
    expect(navigationVerdict(preferencesUrl(ORIGIN), ORIGIN)).toBe('allow');
  });
});

describe('navigationVerdict', () => {
  it('allows the workbench origin only', () => {
    expect(navigationVerdict(`${ORIGIN}/`, ORIGIN)).toBe('allow');
    expect(navigationVerdict(`${ORIGIN}/login?code=x`, ORIGIN)).toBe('allow');
    expect(navigationVerdict('http://127.0.0.1:7392/', ORIGIN)).toBe('external'); // another port is another origin
    expect(navigationVerdict('http://localhost:7391/', ORIGIN)).toBe('external');
  });

  it('sends web and mail links to the real browser', () => {
    expect(navigationVerdict('https://github.com/hammonjj/AgentWrangler', ORIGIN)).toBe('external');
    expect(navigationVerdict('http://example.com/', ORIGIN)).toBe('external');
    expect(navigationVerdict('mailto:someone@example.com', ORIGIN)).toBe('external');
  });

  it('denies everything else', () => {
    expect(navigationVerdict('file:///etc/passwd', ORIGIN)).toBe('deny');
    expect(navigationVerdict('javascript:alert(1)', ORIGIN)).toBe('deny');
    expect(navigationVerdict('data:text/html,hi', ORIGIN)).toBe('deny');
    expect(navigationVerdict('aw://workbench', ORIGIN)).toBe('deny');
    expect(navigationVerdict('vscode://file/x', ORIGIN)).toBe('deny');
    expect(navigationVerdict('::', ORIGIN)).toBe('deny');
  });
});

describe('shouldSignInAgain', () => {
  it('only for a 401 from the workbench itself', () => {
    expect(shouldSignInAgain(401, `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(shouldSignInAgain(200, `${ORIGIN}/`, ORIGIN)).toBe(false);
    expect(shouldSignInAgain(401, 'https://example.com/', ORIGIN)).toBe(false);
    expect(shouldSignInAgain(401, 'garbage', ORIGIN)).toBe(false);
  });
});

describe('waitForLoginLink', () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it('retries while nothing answers or the web server is not up, then returns the link', async () => {
    const answers: (() => Promise<{ url: string } | undefined>)[] = [
      async () => undefined,
      async () => {
        throw new Error('The browser workbench is not running.');
      },
      async () => ({ url: `${ORIGIN}/login?code=abc` }),
    ];
    let calls = 0;
    const url = await waitForLoginLink(() => answers[calls++](), { timeoutMs: 10_000, intervalMs: 250, ...clock() });
    expect(url).toBe(`${ORIGIN}/login?code=abc`);
    expect(calls).toBe(3);
  });

  it('gives up at the deadline with the last error', async () => {
    const c = clock();
    await expect(
      waitForLoginLink(
        async () => {
          throw new Error('The browser workbench is not running. Turn on "Open in a browser".');
        },
        { timeoutMs: 1000, intervalMs: 250, ...c },
      ),
    ).rejects.toThrow(/not running/);
    expect(c.now()).toBeGreaterThanOrEqual(1000);
  });

  it('refuses a link the window will not load, without retrying', async () => {
    let calls = 0;
    await expect(
      waitForLoginLink(
        async () => {
          calls++;
          return { url: 'https://192.168.1.5:7392/login?code=abc' };
        },
        { timeoutMs: 10_000, intervalMs: 250, ...clock() },
      ),
    ).rejects.toBeInstanceOf(LoginLinkError);
    expect(calls).toBe(1);
  });
});
