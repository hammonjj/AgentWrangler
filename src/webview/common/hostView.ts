/**
 * What a browser does with the actions that used to happen on the Mac (#140):
 * a link, a file to look at, a command to run.
 *
 * - `openUrl` opens in this browser (`window.open`, `noopener`), never on the host.
 * - `showFile` fetches the read-only view from the daemon (`FILE_VIEW_ROUTE`)
 *   and shows it in a modal: text, a unified diff with its additions and
 *   deletions marked, or a download link for a binary. A reveal shows the host
 *   path with Copy path and Download beside it.
 * - `showCommand` shows `claude --resume <id>` in a selectable box and copies
 *   it through `navigator.clipboard` (a secure context only: on plain http the
 *   text is selected for the user to copy).
 *
 * A loopback client also gets "on this Mac" buttons (`hostActions`), which ask
 * the host to do what it offered (`hostAction`, by id); a LAN client never does.
 *
 * The app shell's modal host (#133) can draw these itself: the view is offered
 * first as a cancelable `aw:host-view` event on `window`, and only drawn here
 * (plain DOM, classes only, no inline styles) if nobody called `preventDefault`.
 */
import { fileViewUrl, type FileView, type HostToShell, type ShellToHost } from '../../shared/shellProtocol';

export type HostViewMessage = Extract<HostToShell, { type: 'showFile' | 'showCommand' }>;

export const HOST_VIEW_EVENT = 'aw:host-view';

export interface HostViewDeps {
  sendShell(body: ShellToHost): void;
  toast(text: string): void;
}

/** A link: this browser's own tab, never the host. http and https only. */
export function openUrlHere(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function showHostView(msg: HostViewMessage, deps: HostViewDeps): void {
  const offered = new CustomEvent(HOST_VIEW_EVENT, { detail: msg, cancelable: true });
  if (!window.dispatchEvent(offered)) return; // the modal host took it
  const modal = openModal(msg.type === 'showCommand' ? msg.title : msg.name);
  if (msg.type === 'showCommand') drawCommand(modal, msg, deps);
  else drawFile(modal, msg, deps);
}

// ---- the plain modal ----

interface Modal {
  body: HTMLElement;
  actions: HTMLElement;
  close(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function openModal(title: string): Modal {
  const backdrop = el('div', 'aw-hv-backdrop');
  const dialog = el('div', 'aw-hv');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);
  const head = el('div', 'aw-hv-head');
  head.appendChild(el('div', 'aw-hv-title', title));
  const body = el('div', 'aw-hv-body');
  const actions = el('div', 'aw-hv-actions');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const x = el('button', 'aw-hv-btn', 'Close');
  x.type = 'button';
  x.addEventListener('click', close);
  actions.appendChild(x);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  dialog.append(head, body, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  x.focus();
  return { body, actions, close };
}

function button(modal: Modal, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'aw-hv-btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  modal.actions.insertBefore(b, modal.actions.lastElementChild);
  return b;
}

/** Copy through the Clipboard API where the page may use it. False means the user must copy by hand. */
export async function copyText(text: string): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---- a command ----

function drawCommand(modal: Modal, msg: Extract<HostViewMessage, { type: 'showCommand' }>, deps: HostViewDeps): void {
  modal.body.appendChild(el('p', 'aw-hv-note', 'Run this in a terminal on the machine where the session should continue:'));
  const box = el('textarea', 'aw-hv-command');
  box.readOnly = true;
  box.rows = 2;
  box.value = msg.command;
  modal.body.appendChild(box);
  modal.body.appendChild(el('p', 'aw-hv-note', `In the folder ${msg.cwd} on the Mac running Agent Wrangler.`));
  const status = el('p', 'aw-hv-note');
  modal.body.appendChild(status);
  const copy = async () => {
    if (await copyText(msg.command)) status.textContent = 'Copied to the clipboard.';
    else {
      box.focus();
      box.select();
      status.textContent = 'Selected: copy it with the keyboard (the clipboard needs a secure page).';
    }
  };
  button(modal, 'Copy', () => void copy());
  if (msg.hostActions) {
    button(modal, 'Run in Terminal on this Mac', () => {
      deps.sendShell({ type: 'hostAction', id: msg.id, action: 'run' });
      modal.close();
    });
  }
  box.focus();
  box.select();
  void copy();
}

// ---- a file ----

function drawFile(modal: Modal, msg: Extract<HostViewMessage, { type: 'showFile' }>, deps: HostViewDeps): void {
  modal.body.appendChild(el('p', 'aw-hv-path', msg.path));
  const content = el('div', 'aw-hv-content', 'Loading…');
  modal.body.appendChild(content);
  button(modal, 'Copy path', () => {
    void copyText(msg.path).then((ok) => deps.toast(ok ? 'Copied the path.' : 'The clipboard needs a secure page: select the path to copy it.'));
  });
  const link = el('a', 'aw-hv-btn', 'Download');
  link.href = fileViewUrl(msg.path, true);
  link.setAttribute('download', msg.name);
  modal.actions.insertBefore(link, modal.actions.lastElementChild);
  if (msg.hostActions) {
    button(modal, 'Open on this Mac', () => deps.sendShell({ type: 'hostAction', id: msg.id, action: 'open' }));
    button(modal, 'Show in Finder on this Mac', () => deps.sendShell({ type: 'hostAction', id: msg.id, action: 'reveal' }));
  }
  if (msg.intent === 'reveal') {
    // Revealing is about where the file is: the path is the answer, and the
    // content is a click away rather than fetched unasked.
    content.textContent = '';
    const show = el('button', 'aw-hv-btn', 'View contents');
    show.type = 'button';
    show.addEventListener('click', () => void load(content, msg.path));
    content.appendChild(show);
    return;
  }
  void load(content, msg.path);
}

async function load(into: HTMLElement, path: string): Promise<void> {
  into.textContent = 'Loading…';
  let view: FileView;
  try {
    const res = await fetch(fileViewUrl(path), { credentials: 'same-origin' });
    if (!res.ok) {
      into.textContent = res.status === 403 ? 'This file is not available in the browser.' : res.status === 404 ? 'The file no longer exists.' : 'Could not load the file.';
      return;
    }
    view = (await res.json()) as FileView;
  } catch {
    into.textContent = 'Could not load the file.';
    return;
  }
  into.textContent = '';
  if (view.kind === 'binary' || view.text === undefined) {
    into.textContent = `${view.name} is a binary file (${formatBytes(view.size)}). Use Download.`;
    return;
  }
  const pre = el('pre', view.kind === 'diff' ? 'aw-hv-text aw-hv-diff' : 'aw-hv-text');
  if (view.kind === 'diff') {
    for (const line of view.text.split('\n')) pre.appendChild(el('span', `aw-hv-line ${diffClass(line)}`, line || ' '));
  } else {
    pre.textContent = view.text;
  }
  into.appendChild(pre);
  if (view.truncated) into.appendChild(el('p', 'aw-hv-note', `Showing the first part of ${formatBytes(view.size)}. Use Download for the rest.`));
}

/** The class a unified-diff line is drawn with. */
export function diffClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'aw-hv-meta';
  if (line.startsWith('@@')) return 'aw-hv-hunk';
  if (line.startsWith('+')) return 'aw-hv-add';
  if (line.startsWith('-')) return 'aw-hv-del';
  return 'aw-hv-ctx';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
