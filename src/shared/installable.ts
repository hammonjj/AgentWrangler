/**
 * The workbench as an installable web app (#162): its manifest and icons, which the
 * daemon's web server serves on loopback and on the LAN, and the `<head>` lines that
 * point at them.
 *
 * The icons are made by `scripts/make-web-icons.sh` from the app icon
 * (`build/icons/`), committed in `src/webview/icons/`, and copied by `esbuild.mjs` into
 * `dist/webview/icons/`. The relay loader (#175) ships the same files from its own site.
 *
 * No service worker, on purpose: the workbench is a live view of the daemon, and a cache
 * between them would fight the build handshake that reloads a tab onto a new build.
 */

/** Where the manifest is served. The page links it; the server answers it without a device cookie. */
export const WEB_MANIFEST_PATH = '/manifest.webmanifest';

/** The icons, by URL path, and the file in `dist/webview/icons/` each one is. */
export const INSTALL_ICONS: Readonly<Record<string, string>> = {
  '/icons/icon-192.png': 'icon-192.png',
  '/icons/icon-512.png': 'icon-512.png',
  '/icons/icon-maskable-512.png': 'icon-maskable-512.png',
  '/icons/apple-touch-icon.png': 'apple-touch-icon.png',
};

export const APPLE_TOUCH_ICON_PATH = '/icons/apple-touch-icon.png';

/** The workbench's own dark and light backgrounds (`--vscode-editor-background`). */
export const THEME_COLOR_DARK = '#1f1f1f';
export const THEME_COLOR_LIGHT = '#ffffff';

/**
 * Its `id`. The relay PWA lives on another origin, so the two are separate apps anyway;
 * a fixed id keeps this one the same app if `start_url` ever moves.
 */
export const WEB_APP_ID = '/?app=workbench';

export interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

/**
 * The manifest. Nothing in it is per-user or per-request, so the same document is served
 * to everyone who passes the Host check: it says no more than the sign-in page does.
 */
export function webAppManifest(): WebAppManifest {
  return {
    id: WEB_APP_ID,
    name: 'Agent Wrangler',
    short_name: 'Agent Wrangler',
    description: 'The coding agents on this Mac: who is busy, waiting on you, or done.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: THEME_COLOR_DARK,
    theme_color: THEME_COLOR_DARK,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** The `<head>` lines of the browser workbench that make it installable. */
export function installHeadHtml(): string {
  return [
    `<link rel="manifest" href="${WEB_MANIFEST_PATH}">`,
    `<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`,
    `<meta name="theme-color" content="${THEME_COLOR_DARK}" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="${THEME_COLOR_LIGHT}" media="(prefers-color-scheme: light)">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Agent Wrangler">',
    '<meta name="application-name" content="Agent Wrangler">',
  ].join('\n');
}
