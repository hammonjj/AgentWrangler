import * as crypto from 'node:crypto';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Shared webview HTML shell: strict CSP (no inline code), one css + one js
 * bundle from dist/webview.
 *
 * Host-neutral. VSCode rewrites local paths into `vscode-webview-resource:`
 * URIs and reports the scheme to put in the CSP; an Electron window loads the
 * same file off disk and uses `'self'`. Both differ only in those three
 * strings, so they are arguments rather than two copies of the document.
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
   * Stylesheets to load before the bundle's own, in order. The Electron shell
   * puts the `--vscode-*` token shim here; in VSCode the host injects those
   * values itself and this is empty.
   */
  extraStylesheets?: string[];
  /**
   * A class on `<body>`, so a host can style the document it owns without the
   * panes knowing. The Electron shell sets `aw-shell`, which is what gives the
   * window its inset — in VSCode that space comes from the editor's own chrome
   * around the tab, and there is no chrome in a window.
   *
   * It also settles a specificity question: the pane bundles set `body {…}`
   * and are loaded last, so a plain `body` rule in the shell's stylesheet would
   * lose. `body.aw-shell` wins on specificity rather than on order.
   */
  bodyClass?: string;
}

export function renderWebviewHtml(opts: WebviewHtmlOptions): string {
  const { bundleName, title, cssHref, jsSrc, cspSource, extraStylesheets = [], bodyClass } = opts;
  const nonce = getNonce();
  const links = [...extraStylesheets, cssHref].map((href) => `<link rel="stylesheet" href="${href}">`).join('\n');
  const bodyAttr = bodyClass ? ` class="${bodyClass}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${links}
<title>${title}</title>
</head>
<body${bodyAttr}>
${BODY[bundleName]}
<script nonce="${nonce}" src="${jsSrc}"></script>
</body>
</html>`;
}
