/**
 * The folder browser for a remote browser (#139): the answer to `pickFolder`
 * when the folder is on the host, not on the device in your hand.
 *
 * Two pieces, so the app shell's modal host (#133) can use the first and the
 * shim can use both:
 *
 * - `mountFolderBrowser(container, options)`: a self-contained view. It draws
 *   into `container`, fetches listings from `GET /api/dirs`, and calls
 *   `onChoose` once, with a **host path** or `undefined` for cancelled. It owns
 *   nothing outside `container`.
 * - `pickFolderPlain(openLabel)`: a plain fallback that puts the view in an
 *   overlay on the page and resolves with the answer. No modal framework.
 *
 * Everything shown is labelled as being on the host: a path chosen here is a
 * place on the machine running Agent Wrangler, whatever device this is. The
 * host checks the answer again; this only offers what it listed.
 *
 * Classes only (`aw-fb*`, in `theme/vscodeTokens.css`): the CSP has no inline styles.
 */
import { DIRS_PATH, type DirListing } from '../../shared/files';

export interface FolderBrowserOptions {
  /** The confirm button's label. Default "Choose this folder". */
  openLabel?: string;
  /** Called once: the chosen host path, or `undefined` when cancelled. */
  onChoose(path: string | undefined): void;
  /** Where listings come from. Default: `GET /api/dirs`. A test or another transport may supply its own. */
  fetchDirs?(path: string | undefined, hidden: boolean): Promise<DirListing>;
}

export async function fetchDirs(path: string | undefined, hidden: boolean): Promise<DirListing> {
  const q = new URLSearchParams();
  if (path) q.set('path', path);
  if (hidden) q.set('hidden', '1');
  const res = await fetch(`${DIRS_PATH}?${q}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 403 ? 'That folder is not available.' : `The host answered ${res.status}.`);
  return (await res.json()) as DirListing;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function mountFolderBrowser(container: HTMLElement, options: FolderBrowserOptions): { dispose(): void } {
  const load = options.fetchDirs ?? fetchDirs;
  let hidden = false;
  let current: DirListing | undefined;
  let done = false;
  let seq = 0;

  const root = el('div', 'aw-fb');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Choose a folder on the host');
  const title = el('div', 'aw-fb-title', 'Choose a folder on the Mac running Agent Wrangler');
  const hint = el('div', 'aw-fb-hint', 'These folders are on the host, not on this device.');
  const bar = el('div', 'aw-fb-bar');
  const up = el('button', 'aw-fb-up', 'Up');
  up.type = 'button';
  const where = el('div', 'aw-fb-path');
  const toggleLabel = el('label', 'aw-fb-toggle');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggleLabel.append(toggle, document.createTextNode(' Show hidden'));
  bar.append(up, where, toggleLabel);
  const list = el('div', 'aw-fb-list');
  list.setAttribute('role', 'listbox');
  const status = el('div', 'aw-fb-status');
  status.setAttribute('role', 'status');
  const actions = el('div', 'aw-fb-actions');
  const cancel = el('button', 'aw-fb-cancel', 'Cancel');
  cancel.type = 'button';
  const choose = el('button', 'aw-fb-choose', options.openLabel ?? 'Choose this folder');
  choose.type = 'button';
  choose.disabled = true;
  actions.append(cancel, choose);
  root.append(title, hint, bar, list, status, actions);
  container.replaceChildren(root);

  const finish = (value: string | undefined): void => {
    if (done) return;
    done = true;
    options.onChoose(value);
  };

  const row = (label: string, detail: string, target: string, className: string): HTMLElement => {
    const r = el('button', `aw-fb-row ${className}`);
    r.type = 'button';
    r.setAttribute('role', 'option');
    r.append(el('span', 'aw-fb-name', label), el('span', 'aw-fb-detail', detail));
    r.addEventListener('click', () => void go(target));
    return r;
  };

  const render = (l: DirListing): void => {
    current = l;
    where.textContent = l.path;
    where.title = l.path;
    up.disabled = !l.parent;
    choose.disabled = false;
    list.replaceChildren();
    if (l.projects.length > 0) {
      list.append(el('div', 'aw-fb-heading', 'Projects'));
      for (const p of l.projects) list.append(row(p.name, p.path, p.path, 'aw-fb-project'));
      list.append(el('div', 'aw-fb-heading', 'Folders in your home folder'));
    }
    for (const e of l.entries) list.append(row(e.name, '', e.path, 'aw-fb-dir'));
    if (l.entries.length === 0) list.append(el('div', 'aw-fb-empty', 'No folders here.'));
    status.textContent = l.truncated ? 'Only the first folders are shown; open one to narrow it down.' : '';
  };

  const go = async (target: string | undefined): Promise<void> => {
    const mine = ++seq;
    status.textContent = 'Loading…';
    try {
      const l = await load(target, hidden);
      if (mine === seq && !done) render(l);
    } catch (err) {
      if (mine === seq) status.textContent = err instanceof Error ? err.message : 'Could not list that folder.';
    }
  };

  up.addEventListener('click', () => current?.parent && void go(current.parent));
  toggle.addEventListener('change', () => {
    hidden = toggle.checked;
    void go(current?.path);
  });
  cancel.addEventListener('click', () => finish(undefined));
  choose.addEventListener('click', () => finish(current?.path));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(undefined);
  });

  void go(undefined);
  return {
    dispose() {
      done = true;
      root.remove();
    },
  };
}

/** The plain fallback: the view in an overlay on the page. Resolves with the host path, or `undefined`. */
export function pickFolderPlain(openLabel?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const overlay = el('div', 'aw-fb-overlay');
    document.body.appendChild(overlay);
    const view = mountFolderBrowser(overlay, {
      ...(openLabel !== undefined ? { openLabel } : {}),
      onChoose: (value) => {
        view.dispose();
        overlay.remove();
        resolve(value);
      },
    });
  });
}
