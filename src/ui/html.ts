import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Shared webview HTML shell: strict CSP (no inline code), one css + one js
 * bundle from dist/webview.
 */
export type BundleName = 'dashboard' | 'conversation' | 'workbench';

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
  workbench:
    '<div id="wb">' +
    '<div id="wbTable"><div id="app"></div></div>' +
    '<div id="wbSplit" role="separator" aria-orientation="vertical" tabindex="0" ' +
    'aria-label="Resize the table and the conversation" title="Drag to resize · double-click to reset"></div>' +
    '<div id="wbConv"><div id="convApp"></div></div>' +
    '</div>',
};

export function buildWebviewHtml(opts: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  bundleName: BundleName;
  title: string;
}): string {
  const { webview, extensionUri, bundleName, title } = opts;
  const nonce = getNonce();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', `${bundleName}.css`));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', `${bundleName}.js`));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>${title}</title>
</head>
<body>
${BODY[bundleName]}
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
