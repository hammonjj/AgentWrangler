/**
 * Connect a device: the steps for opening the workbench on a phone or another
 * computer on the home network. Each step can be ticked off; ticks are kept in
 * this browser's localStorage so a reload does not lose the place. The steps
 * that act on the Mac (downloading the certificate, starting pairing) are links
 * only a browser on the Mac gets, because the server answers them on loopback
 * alone.
 */

const STORE_KEY = 'aw.connect.done';

interface Action {
  label: string;
  href: string;
}

interface Step {
  id: string;
  title: string;
  /** Plain paragraphs. */
  body: string[];
  /** Only offered in a browser on the Mac. */
  actions?: Action[];
  /** The same step for each kind of device, as numbered sub-steps. */
  platforms?: Platform[];
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
          'Under that switch, Preferences lists the addresses the Mac is listening on, such as https://192.168.x.x:7392. Note one down for later.',
          'If macOS asks "Do you want the application to accept incoming network connections?", click Allow.',
          'Click "Connect" in the top bar to come back here.',
        ],
      },
    ],
  },
  {
    id: 'trust',
    title: 'Trust the certificate on the device',
    body: ['Agent Wrangler signs its own certificate, so each device has to trust it once. Until it does, the browser shows a security warning. First download the file for your device here on the Mac, with the button below; then follow the matching steps on the device.'],
    actions: [
      { label: 'Download for iPhone / iPad (.mobileconfig)', href: '/ca.mobileconfig' },
      { label: 'Download for Windows (.pem)', href: '/ca.pem' },
    ],
    platforms: [
      {
        name: 'iPhone or iPad',
        list: [
          'On the Mac, click "Download for iPhone / iPad" above. The file agent-wrangler-ca.mobileconfig lands in the Mac\'s Downloads folder. Open Finder, click Downloads in the sidebar on the left, and find it.',
          'Right-click the file, choose Share, then AirDrop, and pick the iPhone. Unlock the iPhone and tap Accept if asked. Without AirDrop, email the file to yourself and open it on the iPhone.',
          'The iPhone shows "Profile Downloaded". Open the Settings app (the grey gear icon on the Home Screen). Tap "Profile Downloaded" near the top of the Settings list. If it is not there, tap General, then scroll down and tap "VPN & Device Management".',
          'Tap "Agent Wrangler Local CA", then tap Install at the top right. Enter the iPhone passcode, tap Install again at the top right, and once more at the bottom. It says "Not Verified"; that is expected. Tap Done.',
          'Go back to the Settings home screen. Tap General, then About (the first row). Scroll to the very bottom and tap "Certificate Trust Settings".',
          'Under "Enable full trust for root certificates", switch on the toggle beside "Agent Wrangler Local CA" so it turns green. Tap Continue on the warning.',
        ],
      },
      {
        name: 'Windows',
        list: [
          'Get the .pem file to the PC. On the Mac, click "Download for Windows" above; the file agent-wrangler-ca.pem lands in the Mac\'s Downloads folder (Finder → Downloads in the sidebar). Then copy it to the PC with a USB drive, a shared network folder, OneDrive, or by emailing it to yourself.',
          'On the PC, open File Explorer (the yellow folder icon on the taskbar) and find the file. Click it once, press F2, and rename it to agent-wrangler-ca.crt. Click Yes if Windows warns about changing the extension. If you cannot see the .pem extension, click View in the File Explorer toolbar, then Show, then "File name extensions".',
          'Double-click agent-wrangler-ca.crt. A "Certificate" window opens. Click the "Install Certificate…" button.',
          'Choose "Current User" and click Next.',
          'Choose "Place all certificates in the following store" and click Browse…. In the list that opens, click "Trusted Root Certification Authorities" and click OK. Click Next, then Finish.',
          'Windows shows a Security Warning asking whether to install a certificate from "Agent Wrangler Local CA". Click Yes. You should then see "The import was successful".',
          'Close every Edge or Chrome window and open the browser again. Both read the Windows certificate store. Firefox does not: in Firefox, type about:config in the address bar, press Enter, click "Accept the Risk and Continue", search for security.enterprise_roots.enabled, and click the toggle button at the right of that row so it reads true.',
        ],
      },
    ],
  },
  {
    id: 'pair',
    title: 'Pair the device',
    body: ['Pairing gives the device its own sign-in. Do step 2 on the device first. The pairing code works once and expires after five minutes, so have the device in your hand before you start it.'],
    actions: [{ label: 'Start pairing a device', href: '/pair/new' }],
    platforms: [
      {
        name: 'iPhone or iPad',
        list: [
          'On the Mac, click "Start pairing a device" above, then click "Show a pairing code" on the page that opens. A QR code and an eight-character code such as K7QD-3MXA appear.',
          'On the iPhone, open the Camera app (the grey camera icon on the Home Screen) and point it at the QR code on the Mac\'s screen. A yellow link appears at the top of the viewfinder. Tap it.',
          'Safari opens the pairing page with the code already filled in. If Safari shows a certificate warning, step 2 is not finished.',
          'Tap the blue "Pair this device" button. The workbench opens, signed in.',
        ],
      },
      {
        name: 'Windows',
        list: [
          'On the Mac, click "Start pairing a device" above, then click "Show a pairing code" on the page that opens. Write down the eight-character code, such as K7QD-3MXA.',
          'On the PC, open Edge or Chrome and click the address bar at the top of the window. Type the address you noted in step 1, with /pair on the end, for example https://192.168.x.x:7392/pair, and press Enter. The Mac\'s name also works: on the Mac, open System Settings → General → Sharing, scroll to the bottom and read "Local hostname" (it ends in .local); then type https://that-name.local:7392/pair.',
          'Click the code box on the page, type the eight-character code, and click "Pair this device". The workbench opens, signed in.',
        ],
      },
    ],
  },
  {
    id: 'open',
    title: 'Open the workbench on the device',
    body: ['Once paired, the device opens the workbench by itself and stays signed in for 30 days from the last time it is used. To get back to it later, save a shortcut:'],
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

export function mountConnectPage(root: HTMLElement): void {
  const done = loadDone();
  const onMac = isMacBrowser();

  const intro = el('p', 'aw-page-note', 'Open Agent Wrangler on your phone or another computer on your home network. Four steps, once per device, for iPhone, iPad and Windows.');
  const progress = el('p', 'aw-connect-progress');
  progress.setAttribute('aria-live', 'polite');
  const list = el('ol', 'aw-connect-steps');

  if (!onMac) {
    root.append(el('p', 'aw-page-note', 'The certificate and pairing links work only in a browser on the Mac running Agent Wrangler. You can read the steps here, but do steps 2 and 3 from the Mac.'));
  }

  const updateProgress = () => {
    progress.textContent = `${done.size} of ${STEPS.length} steps done`;
  };

  STEPS.forEach((step, index) => {
    const item = el('li', 'aw-connect-step');
    item.classList.toggle('is-done', done.has(step.id));

    const head = el('div', 'aw-connect-head');
    const num = el('span', 'aw-connect-num', String(index + 1));
    num.setAttribute('aria-hidden', 'true');
    const title = el('h3', 'aw-connect-title', step.title);
    head.append(num, title);
    item.appendChild(head);

    for (const p of step.body) item.appendChild(el('p', 'aw-connect-text', p));
    if (step.actions && onMac) {
      const row = el('p', 'aw-connect-actions');
      for (const a of step.actions) {
        const link = el('a', 'aw-page-button', a.label);
        link.href = a.href;
        row.appendChild(link);
      }
      item.appendChild(row);
    }

    for (const platform of step.platforms ?? []) {
      item.appendChild(el('h4', 'aw-connect-platform', platform.name));
      const ul = el('ol', 'aw-connect-sub');
      for (const line of platform.list) ul.appendChild(el('li', undefined, line));
      item.appendChild(ul);
    }

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

    list.appendChild(item);
  });

  updateProgress();
  root.append(intro, progress, list);
}
