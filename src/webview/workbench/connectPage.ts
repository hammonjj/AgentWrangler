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
  /** Sub-steps, for a step that is itself a short procedure. */
  list?: string[];
  /** Only offered in a browser on the Mac. */
  actions?: Action[];
}

const STEPS: Step[] = [
  {
    id: 'lan',
    title: 'Allow devices on your home network',
    body: [
      'In Preferences, under Browser, switch on "Allow devices on my home network". Agent Wrangler then also serves the workbench over HTTPS on this Mac\'s home-network addresses, port 7392. Preferences lists the addresses under the switch.',
      'Only do this on a network you trust. Never forward the port from your router.',
    ],
  },
  {
    id: 'trust',
    title: 'Trust the certificate on the device',
    body: ['Agent Wrangler signs its own certificate, so each device has to trust it once.'],
    list: [
      'On this Mac, download the profile below and AirDrop it to the device (or mail it to yourself).',
      'On an iPhone or iPad: Settings → General → VPN & Device Management → Agent Wrangler Local CA → Install.',
      'Then Settings → General → About → Certificate Trust Settings, and turn on full trust for it.',
      'Other systems: install the PEM file as a trusted certificate authority.',
    ],
    actions: [
      { label: 'Download profile for iPhone / iPad', href: '/ca.mobileconfig' },
      { label: 'Download PEM', href: '/ca.pem' },
    ],
  },
  {
    id: 'pair',
    title: 'Pair the device',
    body: ['Pairing gives the device its own sign-in. The code works once, for five minutes.'],
    list: [
      'Start pairing here, or run "aw web pair" in a terminal on the Mac.',
      'Scan the QR code with the device\'s camera and open the link.',
      'Without a camera, open https://<your-mac>.local:7392/pair on the device and type the code.',
      'Tap "Pair this device". It stays signed in for 30 days from last use.',
    ],
    actions: [{ label: 'Start pairing a device', href: '/pair/new' }],
  },
  {
    id: 'open',
    title: 'Open the workbench on the device',
    body: [
      'Once paired, the device opens the workbench itself. To come back later, use https://<your-mac>.local:7392/ in its browser. Add it to the home screen on a phone if you like.',
      'To sign a device out for good, press Revoke beside it in Preferences → Browser → Devices.',
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

  const intro = el('p', 'aw-page-note', 'Open Agent Wrangler on your phone or another computer on your home network. Four steps, once per device.');
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
    if (step.list) {
      const ul = el('ol', 'aw-connect-sub');
      for (const line of step.list) ul.appendChild(el('li', undefined, line));
      item.appendChild(ul);
    }

    if (step.actions && onMac) {
      const row = el('p', 'aw-connect-actions');
      for (const a of step.actions) {
        const link = el('a', 'aw-page-button', a.label);
        link.href = a.href;
        row.appendChild(link);
      }
      item.appendChild(row);
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
