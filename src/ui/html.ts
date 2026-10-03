import * as crypto from 'node:crypto';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Shared webview HTML shell: strict CSP (no inline code), one css + one js
 * bundle from dist/webview.
 *
 * Host-neutral: where the stylesheet and script are, and what the CSP allows
 * them from, are arguments. The web server (`src/core/web/server.ts`) is the
 * one caller today, through `renderBrowserWorkbenchHtml`.
 */
export type BundleName = 'dashboard' | 'conversation' | 'workbench' | 'preferences';

/**
 * The markup each bundle finds when it loads.
 *
 * The roots are in the document rather than created by the bundle, because the
 * workbench imports the two pane modules for their side effects and an ES
 * import is evaluated before the importing module's body — so by the time the
 * workbench's own code runs, both panes have already looked for their roots.
 *
 * `#app` and `#convApp` are two different ids for the same reason: those were
 * both `#app` when each pane had a webview to itself, and they now share one.
 */
const BODY: Record<BundleName, string> = {
  dashboard: '<div id="app"></div>',
  conversation: '<div id="convApp"></div>',
  preferences: '<div id="prefsApp"></div>',
  workbench:
    '<div id="wb">' +
    '<div id="wbTable"><div id="app"></div></div>' +
    '<div id="wbSplit" role="separator" aria-orientation="vertical" tabindex="0" ' +
    'aria-label="Resize the table and the conversation" title="Drag to resize · double-click to reset"></div>' +
    '<div id="wbConv"><div id="convApp"></div></div>' +
    '</div>',
};

export interface WebviewHtmlOptions {
  bundleName: BundleName;
  title: string;
  /** Where the bundle's stylesheet is, as the document will see it. */
  cssHref: string;
  /** Where the bundle's script is, as the document will see it. */
  jsSrc: string;
  /**
   * What the CSP should allow styles and images from — VSCode's
   * `webview.cspSource`, or `'self'` in a window loading its own files.
   */
  cspSource: string;
  /**
   * Stylesheets to load before the bundle's own, in order. The browser page
   * puts the `--vscode-*` token shim here; in VSCode the host injects those
   * values itself and this is empty.
   */
  extraStylesheets?: string[];
  /**
   * A class on `<body>`, so a host can style the document it owns without the
   * panes knowing. The browser page sets `aw-shell`, which is what gives the
   * page its inset — in VSCode that space comes from the editor's own chrome
   * around the tab, and there is no chrome in a page.
   *
   * It also settles a specificity question: the pane bundles set `body {…}`
   * and are loaded last, so a plain `body` rule in the shell's stylesheet would
   * lose. `body.aw-shell` wins on specificity rather than on order.
   */
  bodyClass?: string;
  /**
   * Scripts to run before the bundle, in order, under the same nonce. The
   * browser page puts its bridge (the web shim) here.
   */
  preScripts?: string[];
  /**
   * What `connect-src` allows. Absent, the CSP has none and `default-src
   * 'none'` blocks every fetch and socket, which is wrong for a browser that
   * talks over a WebSocket.
   */
  connectSrc?: string;
  /**
   * The script nonce. Absent, a fresh one. A server that also sends the CSP as
   * a header (#127) generates it, so the header and the document agree.
   */
  nonce?: string;
  /** `<meta name content>` pairs for the scripts to read (the browser's build, #128). */
  meta?: Record<string, string>;
  /** The viewport meta's content. Absent, the plain one every host has always had. */
  viewport?: string;
}

/** What any other host gets: unchanged since the first webview. */
const DEFAULT_VIEWPORT = 'width=device-width, initial-scale=1.0';

/**
 * What a phone browser gets (#134): `viewport-fit=cover` lets the page draw under
 * the notch and the home indicator (the shell pads by `env(safe-area-inset-*)`),
 * and `interactive-widget=resizes-content` makes Chrome on Android shrink the
 * layout for its keyboard, as iOS's visual viewport is followed in script. No
 * `maximum-scale`: blocking pinch-zoom is an accessibility failure, and fields
 * are 16px so iOS has no reason to zoom on focus.
 */
export const BROWSER_VIEWPORT = 'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content';

export function renderWebviewHtml(opts: WebviewHtmlOptions): string {
  const { bundleName, title, cssHref, jsSrc, cspSource, extraStylesheets = [], bodyClass, preScripts = [], connectSrc } = opts;
  const nonce = opts.nonce ?? getNonce();
  const metas = Object.entries(opts.meta ?? {}).map(([name, content]) => `\n<meta name="${attr(name)}" content="${attr(content)}">`).join('');
  const links = [...extraStylesheets, cssHref].map((href) => `<link rel="stylesheet" href="${href}">`).join('\n');
  const bodyAttr = bodyClass ? ` class="${bodyClass}"` : '';
  const connect = connectSrc ? ` connect-src ${connectSrc};` : '';
  const scripts = [...preScripts, jsSrc].map((src) => `<script nonce="${nonce}" src="${src}"></script>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;${connect}">
<meta name="viewport" content="${attr(opts.viewport ?? DEFAULT_VIEWPORT)}">${metas}
${links}
<title>${title}</title>
</head>
<body${bodyAttr}>
${BODY[bundleName]}
${scripts}
</body>
</html>`;
}

/**
 * The workbench as a browser loads it (#127): the shim first, and every asset by the URL the server's manifest gives it (hashed,
 * so it can be cached for good).
 */
export function renderBrowserWorkbenchHtml(opts: { asset: (name: string) => string; nonce: string; connectSrc: string; build: string }): string {
  return renderWebviewHtml({
    // What the shim compares the server's `hello` with (#128).
    meta: { 'aw-build': opts.build },
    viewport: BROWSER_VIEWPORT,
    bundleName: 'workbench',
    title: 'Agent Wrangler',
    cssHref: opts.asset('workbench.css'),
    jsSrc: opts.asset('workbench.js'),
    cspSource: "'self'",
    extraStylesheets: [opts.asset('theme.css')],
    // `aw-web`: the workbench starts its app shell's routes and layout (#133).
    bodyClass: 'aw-shell aw-web',
    preScripts: [opts.asset('webshim.js')],
    connectSrc: opts.connectSrc,
    nonce: opts.nonce,
  });
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
