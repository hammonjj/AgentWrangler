/**
 * Preferences → Browser → Devices (#137): every browser that can sign in, on
 * this Mac (`aw web open`) and paired over the home network (`aw web pair`),
 * each with a Revoke button. Revoking signs the device out for good and
 * disconnects its open tabs at once; it is two presses, so one stray click
 * does not do it.
 */
import type { PreferencesToHost, WebDeviceView } from '../../shared/preferences';

export const WEB_DEVICES_GROUP = 'Browser';
/** How long the second press has, after the first. */
const CONFIRM_MS = 4000;

let devices: WebDeviceView[] = [];
let container: HTMLElement | undefined;
let post: ((message: PreferencesToHost) => void) | undefined;
/** The device whose Revoke was pressed once, waiting for the second press. */
let arming: { id: string; timer: number } | undefined;

/** The block, created once per render of the window; filled now and on every update. */
export function createWebDevicesBlock(send: (message: PreferencesToHost) => void): HTMLElement {
  post = send;
  const block = document.createElement('div');
  block.className = 'pf-row pf-devices';
  const head = document.createElement('div');
  head.className = 'pf-head';
  const label = document.createElement('span');
  label.className = 'pf-label';
  label.textContent = 'Devices';
  head.append(label);
  const desc = document.createElement('p');
  desc.className = 'pf-desc';
  desc.textContent =
    'Browsers that can open Agent Wrangler: on this Mac (aw web open) and paired over your home network (aw web pair). Revoke signs one out for good and disconnects its open tabs at once.';
  const list = document.createElement('div');
  list.className = 'pf-devicelist';
  block.append(head, desc, list);
  container = list;
  draw();
  return block;
}

export function setWebDevices(next: WebDeviceView[]): void {
  devices = next;
  if (arming && !devices.some((d) => d.id === arming?.id)) disarm();
  draw();
}

function disarm(): void {
  if (arming) window.clearTimeout(arming.timer);
  arming = undefined;
}

function when(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function draw(): void {
  const list = container;
  if (!list) return;
  list.textContent = '';
  if (devices.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pf-desc';
    empty.textContent = 'None yet.';
    list.appendChild(empty);
    return;
  }
  for (const d of [...devices].sort((a, b) => b.lastSeen - a.lastSeen)) {
    const row = document.createElement('div');
    row.className = 'pf-device';
    const text = document.createElement('div');
    text.className = 'pf-devicetext';
    const name = document.createElement('span');
    name.className = 'pf-devicename';
    name.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'pf-devicemeta';
    meta.textContent = `${d.scope === 'lan' ? 'Home network' : 'This Mac'} · added ${when(d.createdAt)} · last seen ${when(d.lastSeen)} · ${d.id.slice(0, 8)}`;
    text.append(name, meta);
    const button = document.createElement('button');
    button.type = 'button';
    const armed = arming?.id === d.id;
    button.className = `pf-action danger${armed ? ' running' : ''}`;
    button.textContent = armed ? 'Press again to revoke' : 'Revoke';
    button.title = `Sign ${d.name} out for good and disconnect its open tabs.`;
    button.addEventListener('click', () => {
      if (arming?.id === d.id) {
        disarm();
        post?.({ type: 'revokeWebDevice', id: d.id });
        return;
      }
      disarm();
      arming = {
        id: d.id,
        timer: window.setTimeout(() => {
          arming = undefined;
          draw();
        }, CONFIRM_MS),
      };
      draw();
    });
    row.append(text, button);
    list.appendChild(row);
  }
}
