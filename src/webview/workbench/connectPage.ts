/**
 * Connect a device: the steps for opening the workbench on a phone or another
 * computer on the home network. Each step can be ticked off; ticks are kept in
 * this browser's localStorage so a reload does not lose the place. The step
 * that acts on the Mac (starting pairing) is a link only a browser on the Mac
 * gets, because the server answers it on loopback alone.
 */

import { PAIR_OFFER_PATH, type PairOfferReply } from '../../shared/pairOffer';

const STORE_KEY = 'aw.connect.done';

interface Step {
  id: string;
  title: string;
  /** Plain paragraphs. */
  body: string[];
  /** Shows the pairing QR code in place. Only offered in a browser on the Mac. */
  pairing?: boolean;
  /** The same step for each kind of device, as numbered sub-steps. */
  platforms?: Platform[];
  /** Help, not a step: no checkbox, and not counted. */
  reference?: boolean;
}

interface Platform {
  name: string;
  list: string[];
}

const STEPS: Step[] = [
  {
    id: 'lan',
    title: 'Allow devices on your home network',
    body: [
      'Do this on the Mac that runs Agent Wrangler, in this browser window. Agent Wrangler then also serves the workbench over HTTPS on the Mac\'s home-network addresses, on port 7392.',
      'Only do this on a network you trust. Never forward the port from your router.',
    ],
    platforms: [
      {
        name: 'On the Mac',
        list: [
          'Look at the bar across the top of this page. Click "Preferences", the link just left of "Connect".',
          'Scroll down the Preferences page until you see the heading "Browser".',
          'Under "Browser", find the checkbox or switch labelled "Allow devices on my home network". Turn it on. "Open in a browser" above it must already be on.',
          'If macOS asks "Do you want the application to accept incoming network connections?", click Allow.',
          'Click "Connect" in the top bar to come back here.',
        ],
      },
    ],
  },
  {
    id: 'scan',
    title: 'Scan the QR code on the device',
    body: [
      'One code does the rest: it opens a short setup page on the device that installs Agent Wrangler\'s certificate and then pairs the device. The code works once and expires after five minutes, so have the device in your hand first. The device must be on the same Wi-Fi as this Mac.',
    ],
    pairing: true,
    platforms: [
      {
        name: 'On the Mac',
        list: ['Click "Show the QR code" above. A QR code slides open under the button, with a web address under it.'],
      },
      {
        name: 'iPhone or iPad',
        list: [
          'Open the Camera app (the grey camera icon on the Home Screen) and point it at the QR code on the Mac\'s screen. A yellow link appears at the top of the viewfinder. Tap it.',
          'If iOS asks to allow the app to find devices on your local network, tap Allow. If you tapped Don\'t Allow before, see "If the page will not load" below.',
          'The setup page must open in Safari, because only Safari can install the certificate. If it opened in Chrome, tap and hold the address bar, choose Copy, open Safari (the blue compass icon), paste into its address bar and go.',
          'Tap "Download the certificate profile" and tap Allow. Open the Settings app (grey gear icon). Tap "Profile Downloaded" near the top, tap Install at the top right, enter your passcode, and tap Install again. It says "Not Verified"; that is expected.',
          'Still in Settings: General → About → scroll to the very bottom → Certificate Trust Settings. Switch on "Agent Wrangler Local CA" so it turns green, and tap Continue.',
          'Go back to the setup page in Safari and tap "Continue to pairing". Then tap "Pair this device". The workbench opens, signed in.',
        ],
      },
      {
        name: 'Windows',
        list: [
          'A PC cannot scan the QR code. On the Mac\'s pairing page, select the web address shown under the QR code and copy it (right-click it, then Copy). Get it to the PC by email, a chat message, or by typing it.',
          'On the PC, open Edge or Chrome, click the address bar at the top of the window, paste the address and press Enter. The setup page opens.',
          'Click "Download the certificate". Open File Explorer (the yellow folder icon on the taskbar), find the downloaded file in Downloads, click it once, press F2 and rename it so it ends in .crt. If you cannot see the extension, click View in the toolbar, then Show, then "File name extensions".',
          'Double-click it, click "Install Certificate…", choose "Current User", Next. Choose "Place all certificates in the following store", click Browse…, pick "Trusted Root Certification Authorities", OK, Next, Finish. Click Yes on the Security Warning.',
          'Close every Edge or Chrome window and open the browser again. Firefox does not use the Windows store: in Firefox, type about:config in the address bar, press Enter, click "Accept the Risk and Continue", search for security.enterprise_roots.enabled, and click the toggle at the right of that row so it reads true.',
          'Open the same address again and click "Continue to pairing", then "Pair this device". The workbench opens, signed in.',
        ],
      },
    ],
  },
  {
    id: 'open',
    title: 'Open the workbench on the device later',
    body: ['The device stays signed in for 30 days from the last time it is used. Save a shortcut to get back to it:'],
    platforms: [
      {
        name: 'iPhone or iPad',
        list: [
          'In Safari, tap the Share button: the square with an arrow pointing up, in the bar at the bottom of the screen (at the top right on an iPad).',
          'Scroll down the list that slides up and tap "Add to Home Screen", then tap Add at the top right.',
        ],
      },
      {
        name: 'Windows',
        list: [
          'In Edge, click the three dots "…" at the top right of the window, then Apps, then "Install this site as an app". Click Install.',
          'In Chrome, click the three dots at the top right, then "Cast, save, and share", then "Install page as app…". Click Install.',
        ],
      },
      {
        name: 'To sign a device out',
        list: [
          'On the Mac, click "Preferences" in the top bar of this page and scroll to "Browser".',
          'Find the device under "Devices" and click Revoke twice. It is signed out at once.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'If the page will not load',
    reference: true,
    body: ['"This site can\'t be reached" or "took too long to respond" on the device means it cannot reach the Mac. Check these in order:'],
    platforms: [
      {
        name: 'Any device',
        list: [
          'The device is on the same Wi-Fi network as the Mac, not a guest network, a cellular connection, or a VPN. Some routers also have a setting called "client isolation" or "AP isolation" that stops devices on Wi-Fi seeing each other; it must be off.',
          'Step 1 is done and the QR code is less than five minutes old. Show a new one if in doubt.',
        ],
      },
      {
        name: 'iPhone or iPad',
        list: [
          'Open the Settings app and scroll down to the list of apps. Tap the browser you are using (Chrome or Safari).',
          'Switch on "Local Network" so it turns green. iOS blocks a browser from reaching devices at home until this is on. Then scan the QR code again.',
        ],
      },
    ],
  },
];

function loadDone(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDone(done: Set<string>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...done]));
  } catch {
    // Storage may be blocked; the ticks then last until the page closes.
  }
}

function isMacBrowser(): boolean {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isOfferReply(v: unknown): v is PairOfferReply {
  const o = v as Partial<PairOfferReply> | null;
  return !!o && typeof o.qr === 'string' && o.qr.startsWith('data:image/svg+xml;') && typeof o.code === 'string' && typeof o.address === 'string' && typeof o.expiresAt === 'number';
}

/** The button and the QR code that opens under it. A new click is a new code. */
function pairingPanel(): HTMLElement {
  const wrap = el('div', 'aw-pair');
  const row = el('p', 'aw-connect-actions');
  const button = el('button', 'aw-page-button', 'Show the QR code');
  button.type = 'button';
  row.appendChild(button);
  const status = el('p', 'aw-pair-status');
  status.setAttribute('role', 'status');
  const panel = el('div', 'aw-pair-panel');
  panel.hidden = true;
  const qr = el('img', 'aw-pair-qr');
  qr.alt = 'Pairing QR code';
  const address = el('code', 'aw-pair-address');
  const code = el('p', 'aw-pair-code');
  const until = el('p', 'aw-connect-text');
  panel.append(qr, el('p', 'aw-connect-text', 'No camera? Open this address in the device’s browser:'), address, code, until);
  wrap.append(row, status, panel);

  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = '';
    void fetch(PAIR_OFFER_PATH, { method: 'POST', credentials: 'same-origin' })
      .then(async (r) => {
        const body = (await r.json().catch(() => undefined)) as unknown;
        if (r.ok && isOfferReply(body)) {
          qr.src = body.qr;
          address.textContent = body.address;
          code.textContent = body.code;
          until.textContent = `Works once, until ${new Date(body.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Anyone who uses it first gets in as you, so only show it to the device you are pairing.`;
          panel.hidden = false;
          button.textContent = 'New code';
        } else {
          panel.hidden = true;
          const error = (body as { error?: unknown } | undefined)?.error;
          status.textContent = typeof error === 'string' ? error : `Could not start pairing (${r.status}).`;
        }
      })
      .catch(() => {
        status.textContent = 'Could not reach Agent Wrangler. Try again.';
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return wrap;
}

export function mountConnectPage(root: HTMLElement): void {
  const done = loadDone();
  const onMac = isMacBrowser();
  const counted = STEPS.filter((s) => !s.reference);

  const intro = el('p', 'aw-page-note', 'Open Agent Wrangler on your phone or another computer on your home network. Three steps, once per device, for iPhone, iPad and Windows.');
  const progress = el('p', 'aw-connect-progress');
  progress.setAttribute('aria-live', 'polite');
  const list = el('ol', 'aw-connect-steps');

  if (!onMac) {
    root.append(el('p', 'aw-page-note', 'The QR code can be started only from a browser on the Mac running Agent Wrangler. You can read the steps here, but do the first two from the Mac.'));
  }

  const updateProgress = () => {
    progress.textContent = `${counted.filter((s) => done.has(s.id)).length} of ${counted.length} steps done`;
  };

  STEPS.forEach((step, index) => {
    const item = el('li', 'aw-connect-step');
    item.classList.toggle('is-done', done.has(step.id));

    const head = el('div', 'aw-connect-head');
    const num = el('span', 'aw-connect-num', step.reference ? '?' : String(index + 1));
    num.setAttribute('aria-hidden', 'true');
    const title = el('h3', 'aw-connect-title', step.title);
    head.append(num, title);
    item.appendChild(head);

    for (const p of step.body) item.appendChild(el('p', 'aw-connect-text', p));
    if (step.pairing && onMac) item.appendChild(pairingPanel());

    for (const platform of step.platforms ?? []) {
      item.appendChild(el('h4', 'aw-connect-platform', platform.name));
      const ul = el('ol', 'aw-connect-sub');
      for (const line of platform.list) ul.appendChild(el('li', undefined, line));
      item.appendChild(ul);
    }

    if (!step.reference) {
      const label = el('label', 'aw-connect-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = done.has(step.id);
      box.addEventListener('change', () => {
        if (box.checked) done.add(step.id);
        else done.delete(step.id);
        item.classList.toggle('is-done', box.checked);
        saveDone(done);
        updateProgress();
      });
      label.append(box, document.createTextNode(' Done'));
      item.appendChild(label);
    }

    list.appendChild(item);
  });

  updateProgress();
  root.append(intro, progress, list);
}
