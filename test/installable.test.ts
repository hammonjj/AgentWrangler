import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPLE_TOUCH_ICON_PATH, INSTALL_ICONS, WEB_MANIFEST_PATH, webAppManifest } from '../src/shared/installable';
import { renderBrowserWorkbenchHtml, renderWebviewHtml } from '../src/ui/html';

const ICONS_DIR = path.join(__dirname, '..', 'src', 'webview', 'icons');

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('installable workbench (#162): the manifest', () => {
  it('is a standalone app at /, named Agent Wrangler, with its own id', () => {
    const m = webAppManifest();
    expect(m).toMatchObject({
      name: 'Agent Wrangler',
      short_name: 'Agent Wrangler',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    // Distinct from the relay PWA's (which has none, so it is its start_url on its own origin).
    expect(m.id).toBe('/?app=workbench');
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('has 192 and 512 icons and a maskable one, every one in the served list', () => {
    const icons = webAppManifest().icons;
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.filter((i) => i.purpose === 'maskable')).toHaveLength(1);
    for (const icon of icons) expect(Object.keys(INSTALL_ICONS)).toContain(icon.src);
    expect(Object.keys(INSTALL_ICONS)).toContain(APPLE_TOUCH_ICON_PATH);
  });

  it('every served icon is a committed PNG of the size it claims', () => {
    const claimed = new Map(webAppManifest().icons.map((i) => [i.src, i.sizes]));
    claimed.set(APPLE_TOUCH_ICON_PATH, '180x180');
    for (const [urlPath, file] of Object.entries(INSTALL_ICONS)) {
      expect(file).toMatch(/^[a-z0-9-]+\.png$/);
      const { width, height } = pngSize(path.join(ICONS_DIR, file));
      expect(`${width}x${height}`, urlPath).toBe(claimed.get(urlPath));
    }
  });
});

describe('installable workbench (#162): the page', () => {
  const html = renderBrowserWorkbenchHtml({ asset: (n) => `/${n}`, nonce: 'n', connectSrc: "'self'", build: 'b' });

  it('links the manifest and the touch icon, with theme colours and the standalone metas', () => {
    expect(html).toContain(`<link rel="manifest" href="${WEB_MANIFEST_PATH}">`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`);
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Agent Wrangler">');
    expect(html).toContain('<title>Agent Wrangler</title>');
  });

  it("lets the manifest load under the page's CSP, and inlines no style or script", () => {
    expect(html).toMatch(/Content-Security-Policy" content="[^"]*manifest-src 'self'/);
    expect(html).not.toMatch(/<style|style="/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it('registers no service worker', () => {
    expect(html).not.toContain('serviceWorker');
  });

  it('another host gets none of it', () => {
    const other = renderWebviewHtml({ bundleName: 'dashboard', title: 't', cssHref: '/a.css', jsSrc: '/a.js', cspSource: "'self'" });
    expect(other).not.toContain('manifest');
    expect(other).not.toContain('apple-touch-icon');
  });
});
