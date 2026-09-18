/**
 * Where the window's documents come from.
 *
 * Not `file://`. A file URL has an opaque origin, so `style-src 'self'` matches
 * nothing and the CSP the panes are written against — no inline styles, no
 * inline scripts, one nonce'd bundle — cannot be expressed. Serving the same
 * files from a registered standard scheme gives the window a real origin
 * (`aw://bundle`), which is both the CSP source and the thing that makes
 * `fetch` and relative URLs behave.
 *
 * It also draws the line the extension got from VSCode for free: only what is
 * under `dist/webview` is reachable, whatever the document asks for.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { protocol } from 'electron';
import { ORIGIN, SCHEME } from './channels';
import { renderWebviewHtml, type BundleName } from '../ui/html';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
};

/**
 * Must run before `app.whenReady()`: a scheme cannot be privileged once the
 * first renderer exists. `standard` is what gives it an origin; `secure` is
 * what stops Chromium treating it as untrusted and blocking the bundle.
 */
export function registerBundleScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** The URL to load for a bundle's document. */
export function documentUrl(bundle: BundleName): string {
  return `${ORIGIN}/${bundle}.html`;
}

/**
 * Serve `dist/webview`, plus a generated document per bundle.
 *
 * The documents are generated rather than written to disk because they carry a
 * fresh nonce each time, which is the whole point of having one: a document on
 * disk would ship its nonce with it and any script that could read the file
 * could use it.
 */
export function serveBundles(distDir: string): void {
  const root = path.resolve(distDir, 'webview');

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    const document = /^(dashboard|conversation|workbench)\.html$/.exec(name);
    if (document) {
      const bundle = document[1] as BundleName;
      return new Response(
        renderWebviewHtml({
          bundleName: bundle,
          title: 'Agent Wrangler',
          cssHref: `${ORIGIN}/${bundle}.css`,
          jsSrc: `${ORIGIN}/${bundle}.js`,
          cspSource: ORIGIN,
          // The 56 `--vscode-*` values, the body defaults and the toast rules.
          // First, so a pane stylesheet can override anything it wants to.
          extraStylesheets: [`${ORIGIN}/theme.css`],
        }),
        { headers: { 'content-type': TYPES['.html'] } },
      );
    }

    // Everything else is a file under dist/webview, and nothing above it. The
    // resolve-and-compare is the guard: `..` in the path resolves out of `root`
    // and fails this, rather than being stripped and silently allowed.
    const file = path.resolve(root, name);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = await fs.readFile(file);
      return new Response(new Uint8Array(body), {
        headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
