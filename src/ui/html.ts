import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Shared webview HTML shell: strict CSP (no inline code), one css + one js
 * bundle from dist/webview.
 */
export function buildWebviewHtml(opts: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  bundleName: 'dashboard' | 'conversation';
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
<div id="app"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
