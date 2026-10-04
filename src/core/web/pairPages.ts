/**
 * The pairing pages (#137): small server-rendered forms, no script.
 *
 * - `/pair/new` on loopback: a signed-in browser on the Mac starts pairing and
 *   is shown the QR code and the code.
 * - `/pair` on the LAN: the device being paired, opened from the QR code, with
 *   the code filled in and a name to give itself.
 *
 * Every form carries a token that must equal a cookie set with the form
 * (`PAIR_FORM_COOKIE`), and every POST must also carry this server's `Origin`.
 * Styling is `/pair.css`, served by the server: the CSP allows no inline style.
 */
import { formatPairingCode } from './pairing';

export const PAIR_CSS_PATH = '/pair.css';

/** The CSP for these pages: no script at all, forms only to this origin. */
export const PAIR_PAGE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const PAIR_CSS = `
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; padding: 24px 16px; display: flex; justify-content: center; background: Canvas; color: CanvasText; }
main { width: 100%; max-width: 420px; }
h1 { font-size: 1.4rem; margin: 0 0 12px; }
p { line-height: 1.45; margin: 0 0 12px; }
.muted { opacity: 0.75; font-size: 0.92rem; }
.error { color: #c62828; font-weight: 600; }
form { display: flex; flex-direction: column; gap: 12px; margin: 16px 0; }
label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
input[type=text] { font: inherit; font-size: 1.1rem; padding: 10px 12px; border-radius: 8px; border: 1px solid #8888; }
input.code { font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
button { font: inherit; font-size: 1.05rem; font-weight: 600; padding: 12px; border-radius: 8px; border: 0; background: #2f6fde; color: #fff; }
.qr { background: #fff; padding: 8px; border-radius: 8px; width: 100%; max-width: 320px; margin: 8px 0 16px; }
.qr svg { display: block; width: 100%; height: auto; }
.code-big { font-family: ui-monospace, Menlo, monospace; font-size: 2rem; letter-spacing: 0.15em; margin: 4px 0 12px; }
a.button { display: block; text-align: center; text-decoration: none; font-weight: 600; font-size: 1.05rem; padding: 12px; border-radius: 8px; background: #2f6fde; color: #fff; }
h2 { font-size: 1.1rem; margin: 20px 0 8px; }
ol { padding-left: 22px; line-height: 1.5; margin: 0 0 12px; }
li { margin-bottom: 8px; }
code { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="same-origin">' +
    `<title>${escapeHtml(title)}</title><link rel="stylesheet" href="${PAIR_CSS_PATH}"></head>` +
    `<body><main>${body}</main></body></html>\n`
  );
}

/** The LAN `/pair` form: the code (filled in from the QR code's link) and a name. */
export function pairFormPage(input: { code: string; name: string; token: string; error?: string }): string {
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : '';
  return page(
    'Pair with Agent Wrangler',
    '<h1>Pair with Agent Wrangler</h1>' +
      '<p>This lets this device open Agent Wrangler on your Mac, over your home network, until you revoke it.</p>' +
      error +
      '<form method="post" action="/pair">' +
      `<input type="hidden" name="token" value="${escapeHtml(input.token)}">` +
      '<label>Pairing code' +
      `<input class="code" type="text" name="code" value="${escapeHtml(input.code)}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required maxlength="16"></label>` +
      '<label>Name for this device' +
      `<input type="text" name="name" value="${escapeHtml(input.name)}" maxlength="60" autocomplete="off"></label>` +
      '<button type="submit">Pair this device</button>' +
      '</form>' +
      '<p class="muted">The code is shown on the Mac, by <code>aw web pair</code> or the Pair a device page. It works once, for five minutes.</p>',
  );
}

/** Loopback `/pair/new`, before an offer: one button, or why there is none. */
export function pairStartPage(input: { token: string; lanReady: boolean; error?: string }): string {
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : '';
  const action = input.lanReady
    ? '<form method="post" action="/pair/new">' +
      `<input type="hidden" name="token" value="${escapeHtml(input.token)}">` +
      '<button type="submit">Show a pairing code</button></form>'
    : '<p class="error">Home-network access is off. Turn on “Allow devices on my home network” in Agent Wrangler’s Preferences (Browser), then reload this page.</p>';
  return page(
    'Pair a device',
    '<h1>Pair a phone or tablet</h1>' +
      '<p>Shows a QR code for a device on your home network to scan. The code works once, for five minutes.</p>' +
      '<p class="muted">Scanning the code opens a short setup page on the device that installs Agent Wrangler’s certificate, then pairs it. A PC can open the address shown under the code instead.</p>' +
      error +
      action,
  );
}

/** Loopback `/pair/new` after starting: the QR code, the code and the link. */
export function pairOfferPage(input: { svg: string; code: string; url: string; setupUrl?: string; expiresAt: number; token: string }): string {
  const until = new Date(input.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  // With a setup page the full link is the thing to type (the code is in it); without one, the pairing page and the code.
  const manual = input.setupUrl
    ? `<p>Or, with no camera, open this address in the device’s browser:</p><p><code>${escapeHtml(input.setupUrl)}</code></p>`
    : `<p>Or open this address on the device and type the code:</p><p><code>${escapeHtml(input.url.replace(/\?.*$/, ''))}</code></p>`;
  return page(
    'Pair a device',
    '<h1>Scan with the device’s camera</h1>' +
      `<div class="qr">${input.svg}</div>` +
      manual +
      `<p class="code-big">${escapeHtml(formatPairingCode(input.code))}</p>` +
      `<p class="muted">Works once, until ${escapeHtml(until)} (five minutes). Anyone who uses it first gets in as you, so only show it to the device you are pairing.</p>` +
      '<form method="post" action="/pair/new">' +
      `<input type="hidden" name="token" value="${escapeHtml(input.token)}">` +
      '<button type="submit">New code</button></form>',
  );
}

/** A short message page (refusals, lockout). */
export function pairMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/**
 * The page the QR code opens, over plain HTTP: the one thing a device that
 * does not trust the certificate yet can load. It leads, in order, to the
 * certificate (a profile for an iPhone or iPad, a PEM file for Windows and
 * the rest), to the trust switch iOS keeps in Settings, and on to `/pair` over
 * HTTPS with the code already in the link. Which steps show follows the
 * device's `User-Agent`; a device nobody guessed gets both.
 */
export function setupPage(input: { mobileconfigHref: string; pemHref: string; pairUrl: string; userAgent: string }): string {
  const ios = /iPhone|iPad|iPod/.test(input.userAgent);
  const notSafari = ios && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(input.userAgent);
  const windows = /Windows/.test(input.userAgent);
  const showIos = ios || !windows;
  const showWindows = windows || !ios;
  const parts: string[] = [
    '<h1>Set up this device</h1>',
    '<p>Two short steps, then this device can open Agent Wrangler on your Mac over your home network. The link on this page works for five minutes, from when the Mac showed the QR code.</p>',
  ];
  if (showIos) {
    if (notSafari) {
      parts.push(
        '<p class="error">This browser cannot install the certificate profile. Open this page in Safari: tap and hold the address bar, choose Copy, open Safari (the blue compass icon), paste into its address bar and go.</p>',
      );
    }
    parts.push(
      '<h2>iPhone or iPad</h2><ol>' +
        `<li>Tap <a href="${escapeHtml(input.mobileconfigHref)}">Download the certificate profile</a>, then tap Allow when asked.</li>` +
        '<li>Open the Settings app (grey gear icon). Tap “Profile Downloaded” near the top, then Install at the top right, enter your passcode, and tap Install again.</li>' +
        '<li>Still in Settings: General → About → Certificate Trust Settings (at the very bottom). Switch on “Agent Wrangler Local CA” and tap Continue.</li>' +
        '</ol>',
    );
  }
  if (showWindows) {
    parts.push(
      '<h2>Windows</h2><ol>' +
        `<li>Click <a href="${escapeHtml(input.pemHref)}">Download the certificate</a>. Rename the downloaded <code>.pem</code> file to end in <code>.crt</code>.</li>` +
        '<li>Double-click it, click Install Certificate, choose Current User, then “Place all certificates in the following store”, Browse, Trusted Root Certification Authorities, OK, Next, Finish, and Yes on the warning.</li>' +
        '<li>Close and reopen the browser (Edge and Chrome use this store).</li>' +
        '</ol>',
    );
  }
  parts.push(
    '<h2>Then pair</h2>' +
      `<p><a class="button" href="${escapeHtml(input.pairUrl)}">Continue to pairing</a></p>` +
      '<p class="muted">If this says the connection is not private, the certificate step above is not finished yet.</p>',
  );
  return page('Set up this device', parts.join(''));
}
