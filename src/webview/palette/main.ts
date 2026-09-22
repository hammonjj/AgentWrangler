/**
 * The palette: the app's `showQuickPick` and `showInputBox`.
 *
 * One window for both, because they are the same interaction with a list that
 * may be empty — a field you type in, and rows that narrow as you do. The host
 * says which shape it wants, this answers once, and the window closes.
 *
 * It answers with an **index**, never a row: see `src/shared/palette.ts` for
 * why the objects the host is choosing between never cross the wire.
 */

import './palette.css';
import { createWebviewBridge, type WebviewBridge } from '../../shared/webviewBridge';
import {
  paletteMatches,
  stripCodicons,
  type HostToPalette,
  type PaletteRequest,
  type PaletteRow,
  type PaletteToHost,
} from '../../shared/palette';

declare function acquireVsCodeApi(): WebviewBridge<unknown>;

// See `paneApi.ts` for why this is a lambda and not the bare identifier.
const host = createWebviewBridge<unknown>(() => acquireVsCodeApi());
const post = (message: PaletteToHost) => host.postMessage(message);

const root = document.getElementById('paletteApp')!;

let request: PaletteRequest | undefined;
/** Indices into `request.rows`, in display order, after filtering. */
let shown: number[] = [];
let active = 0;
/** Set once an answer is sent, so a close cannot send a second one. */
let answered = false;

function answer(message: PaletteToHost): void {
  if (answered) return;
  answered = true;
  post(message);
}

const field = document.createElement('input');
field.type = 'text';
field.className = 'pl-field';
field.autocomplete = 'off';
field.spellcheck = false;

const titleEl = document.createElement('div');
titleEl.className = 'pl-title';

const promptEl = document.createElement('p');
promptEl.className = 'pl-prompt';

const errorEl = document.createElement('p');
errorEl.className = 'pl-error';
errorEl.hidden = true;

const listEl = document.createElement('div');
listEl.className = 'pl-list';
listEl.setAttribute('role', 'listbox');

const emptyEl = document.createElement('p');
emptyEl.className = 'pl-empty';
emptyEl.textContent = 'No matches';
emptyEl.hidden = true;

root.append(titleEl, promptEl, field, errorEl, listEl, emptyEl);

function renderRow(row: PaletteRow, index: number, position: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pl-row';
  el.setAttribute('role', 'option');
  if (position === active) el.classList.add('on');

  const top = document.createElement('div');
  top.className = 'pl-rowtop';
  const label = document.createElement('span');
  label.className = 'pl-label';
  label.textContent = stripCodicons(row.label);
  top.appendChild(label);
  if (row.description) {
    const desc = document.createElement('span');
    desc.className = 'pl-desc';
    desc.textContent = row.description;
    top.appendChild(desc);
  }
  el.appendChild(top);

  if (row.detail) {
    const detail = document.createElement('div');
    detail.className = 'pl-detail';
    detail.textContent = row.detail;
    el.appendChild(detail);
  }

  // `mousedown`, not `click`: the field has focus and a click would blur it
  // first, and on a list that re-renders as you type the row under the pointer
  // can be gone by the time `click` fires.
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    answer({ type: 'picked', index });
  });
  return el;
}

function renderList(): void {
  if (!request || request.kind !== 'pick') return;
  const rows = request.rows;
  shown = rows
    .map((_, i) => i)
    .filter((i) =>
      paletteMatches(rows[i], field.value, {
        matchOnDescription: request?.kind === 'pick' ? request.matchOnDescription : false,
        matchOnDetail: request?.kind === 'pick' ? request.matchOnDetail : false,
      }),
    );
  if (active >= shown.length) active = Math.max(0, shown.length - 1);

  listEl.replaceChildren(...shown.map((index, position) => renderRow(rows[index], index, position)));
  emptyEl.hidden = shown.length > 0;
  listEl.querySelector('.pl-row.on')?.scrollIntoView({ block: 'nearest' });
}

function show(next: PaletteRequest): void {
  request = next;
  answered = false;
  active = 0;

  const isPick = next.kind === 'pick';
  titleEl.textContent = isPick ? '' : next.title ?? '';
  titleEl.hidden = titleEl.textContent === '';
  promptEl.textContent = isPick ? '' : next.prompt ?? '';
  promptEl.hidden = promptEl.textContent === '';
  field.value = isPick ? '' : next.value ?? '';
  // A credential must not be left legible on screen; a pick is never one.
  field.type = !isPick && next.password ? 'password' : 'text';
  field.placeholder = (isPick ? next.placeholder : next.placeholder) ?? '';
  listEl.hidden = !isPick;
  emptyEl.hidden = true;
  errorEl.hidden = true;

  if (isPick) renderList();
  field.focus();
  field.select();
}

let validateTimer: number | undefined;

field.addEventListener('input', () => {
  if (!request) return;
  if (request.kind === 'pick') {
    active = 0;
    renderList();
    return;
  }
  if (!request.validates) return;
  // The host holds the rule — it is a function in its own process — so each
  // keystroke asks. Local IPC, and debounced so a fast typist sends a handful
  // rather than one per character.
  window.clearTimeout(validateTimer);
  const value = field.value;
  validateTimer = window.setTimeout(() => post({ type: 'validate', value }), 120);
});

field.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    answer({ type: 'cancelled' });
    return;
  }
  if (!request) return;

  if (request.kind === 'input') {
    if (e.key === 'Enter') {
      e.preventDefault();
      // A complaint on screen means the value is not acceptable; Enter must not
      // push it past the check the host just failed it on.
      if (!errorEl.hidden) return;
      answer({ type: 'submitted', value: field.value });
    }
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (shown.length === 0) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
    renderList();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (shown.length > 0) answer({ type: 'picked', index: shown[active] });
  }
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToPalette | undefined;
  if (!message) return;
  if (message.type === 'show') {
    show(message.request);
    return;
  }
  if (message.type === 'validation') {
    errorEl.textContent = message.message ?? '';
    errorEl.hidden = !message.message;
  }
});

post({ type: 'ready' });
