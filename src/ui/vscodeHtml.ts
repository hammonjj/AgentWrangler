import * as vscode from 'vscode';
import { renderWebviewHtml, type BundleName } from './html';

/**
 * `renderWebviewHtml` with VSCode's three strings filled in: local files
 * rewritten to `vscode-webview-resource:` URIs, and the scheme those live under
 * declared to the CSP. The theme variables the panes use are injected by VSCode
 * itself, so no extra stylesheet is needed here — that is the Electron shell's
 * job.
 */
export function buildWebviewHtml(opts: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  bundleName: BundleName;
  title: string;
}): string {
  const { webview, extensionUri, bundleName, title } = opts;
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name)).toString();

  return renderWebviewHtml({
    bundleName,
    title,
    cssHref: asset(`${bundleName}.css`),
    jsSrc: asset(`${bundleName}.js`),
    cspSource: webview.cspSource,
  });
}
