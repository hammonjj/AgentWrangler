/**
 * The browser shell's in-page modal host (#133): draws the `prompt`s the host
 * asks this tab — a message with buttons, an input (masked for a password),
 * a filtered pick list, a folder path — and sends back the `promptResult`.
 *
 * The decisions are `src/shared/modalModel.ts`, pure and tested; this file is
 * only the DOM: build the dialog, turn keys and clicks into `ModalEvent`s,
 * carry out the effects. One modal at a time; prompts asked meanwhile queue.
 *
 * Accessibility, which is the point of doing this in the page at all:
 * `role="dialog"` (`alertdialog` for a warning) with `aria-modal`, labelled by
 * its title; everything behind it is `inert`; Tab and Shift-Tab cycle inside
 * it; Escape cancels; focus goes back where it was when the last one closes.
 * The pick is a combobox driving a listbox with `aria-activedescendant`, so
 * focus stays in the filter while the arrows move the highlight.
 *
 * Also here, so there is one modal at a time on screen: the file, diff and
 * command views of #140 (`aw:host-view`, taken with preventDefault and drawn in
 * this dialog) and the folder browser of #139 for `pickFolder`. A view waits
 * for an open prompt, and prompts that arrive while a view is open wait for it.
 *
 * Text is set with `textContent`, never parsed: titles and rows can carry
 * session titles and paths. Classes only (CSP); the rules are in workbench.css.
 */

import {
  emptyModalHost,
  modalHostReceive,
  modalHostReset,
  modalHostStep,
  trapFocus,
  type ModalEvent,
  type ModalHostEffect,
  type ModalHostState,
  type OpenModal,
  type PickModal,
} from '../../shared/modalModel';
import type { HostToShell, ShellToHost } from '../../shared/shellProtocol';
import { mountFolderBrowser } from '../common/folderBrowser';
import { HOST_VIEW_EVENT, drawHostView, hostViewTitle, type HostViewMessage } from '../common/hostView';

export interface ModalHostOptions {
  send(body: ShellToHost): void;
  toast(text: string, timeoutMs?: number): void;
  /** What a modal makes `inert` while it is open: the rest of the page. */
  background(): HTMLElement[];
  /** Where focus goes on close when the element it came from has gone. */
  fallbackFocus(): HTMLElement | null;
}

export interface ModalHost {
  /** A `prompt` or `promptCancel` from the host. Other shell messages are ignored. */
  receive(message: HostToShell): void;
  /** The connection dropped: everything open was cancelled host-side. */
  reset(): void;
  readonly isOpen: boolean;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
/** Rows PageUp/PageDown move by. */
const PAGE = 8;

export function createModalHost(opts: ModalHostOptions): ModalHost {
  let state: ModalHostState = emptyModalHost();
  /** Focus before the first modal opened; restored after the last closes. */
  let returnFocus: Element | null = null;
  let inerted: HTMLElement[] = [];
  /** A host view is on screen; prompts arriving meanwhile are held, in order. */
  let viewOpen = false;
  let held: HostToShell[] = [];
  let pendingViews: HostViewMessage[] = [];
  /** Tears down whatever the dialog mounted (the folder browser). */
  let unmount: (() => void) | undefined;

  const layer = document.createElement('div');
  layer.id = 'awModalLayer';
  layer.className = 'aw-modal-layer';
  layer.hidden = true;
  const dialog = document.createElement('div');
  dialog.className = 'aw-modal';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'awModalTitle');
  layer.appendChild(dialog);
  document.body.appendChild(layer);

  /** The pick's live parts, kept between renders so typing never loses the caret. */
  let pickList: HTMLElement | undefined;
  let pickField: HTMLInputElement | undefined;

  function dispatch(event: ModalEvent): void {
    const step = modalHostStep(state, event);
    state = step.state;
    run(step.effects);
  }

  function run(effects: ModalHostEffect[]): void {
    for (const e of effects) {
      switch (e.type) {
        case 'send':
          opts.send(e.body);
          break;
        case 'toast':
          opts.toast(e.text, e.timeoutMs);
          break;
        case 'open':
          show(e.modal);
          break;
        case 'update':
          if (e.modal.model.kind === 'pick') renderPickRows(e.modal.model);
          break;
        case 'close':
          if (!viewOpen) finishPrompts();
          break;
      }
    }
  }

  function openLayer(): void {
    if (!layer.hidden) return;
    returnFocus = document.activeElement;
    inerted = opts.background().filter((el) => el !== layer && !el.inert);
    for (const el of inerted) el.inert = true;
    layer.hidden = false;
  }

  function show(modal: OpenModal): void {
    openLayer();
    render(modal);
  }

  /** No prompt left: a view that was waiting goes up; otherwise the layer closes. */
  function finishPrompts(): void {
    const next = pendingViews.shift();
    if (next) startView(next);
    else hide();
  }

  function hide(): void {
    unmount?.();
    unmount = undefined;
    layer.hidden = true;
    dialog.replaceChildren();
    pickList = pickField = undefined;
    for (const el of inerted) el.inert = false;
    inerted = [];
    // Nothing had focus (the body), or what had it is gone: the route's heading.
    const came = returnFocus instanceof HTMLElement && returnFocus !== document.body && returnFocus.isConnected;
    const back = came ? (returnFocus as HTMLElement) : opts.fallbackFocus();
    returnFocus = null;
    back?.focus();
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el('button', primary ? 'aw-modal-btn primary' : 'aw-modal-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- host views (#140) ----

  function startView(msg: HostViewMessage): void {
    openLayer();
    unmount?.();
    unmount = undefined;
    viewOpen = true;
    dialog.replaceChildren();
    pickList = pickField = undefined;
    dialog.className = 'aw-modal aw-modal-view';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-labelledby', 'awModalTitle');
    dialog.removeAttribute('aria-describedby');
    const title = el('h2', 'aw-modal-title', hostViewTitle(msg));
    title.id = 'awModalTitle';
    const body = el('div', 'aw-hv-body');
    const actions = el('div', 'aw-hv-actions');
    const close = el('button', 'aw-hv-btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeView);
    actions.appendChild(close);
    dialog.append(title, body, actions);
    close.focus();
    drawHostView({ body, actions, close: closeView }, msg, { sendShell: opts.send, toast: opts.toast });
  }

  function closeView(): void {
    if (!viewOpen) return;
    viewOpen = false;
    const next = pendingViews.shift();
    if (next) return startView(next);
    // Prompts that came in meanwhile, in the order they were asked.
    const replay = held;
    held = [];
    for (const message of replay) {
      const step = modalHostReceive(state, message);
      state = step.state;
      run(step.effects);
    }
    if (!state.current) hide();
  }

  window.addEventListener(HOST_VIEW_EVENT, (e) => {
    // Ours to draw: the shim then draws nothing of its own.
    e.preventDefault();
    const msg = (e as CustomEvent<HostViewMessage>).detail;
    if (viewOpen || state.current) pendingViews.push(msg);
    else startView(msg);
  });

  function render(modal: OpenModal): void {
    const m = modal.model;
    unmount?.();
    unmount = undefined;
    dialog.replaceChildren();
    pickList = pickField = undefined;
    dialog.className = `aw-modal aw-modal-${m.kind}`;
    dialog.setAttribute('aria-labelledby', 'awModalTitle');
    const title = el('h2', 'aw-modal-title', m.title);
    title.id = 'awModalTitle';
    dialog.appendChild(title);
    const described: string[] = [];
    let focus: HTMLElement | undefined;

    if (m.kind === 'folder') {
      // The host's own listing, mounted from `common/folderBrowser`. It has its
      // own title, Cancel and Escape; this dialog only frames it.
      dialog.setAttribute('role', 'dialog');
      title.hidden = true;
      const holder = el('div', 'aw-modal-folder-holder');
      dialog.appendChild(holder);
      const view = mountFolderBrowser(holder, {
        ...(m.openLabel ? { openLabel: m.openLabel } : {}),
        onChoose: (path) => dispatch({ type: 'choose', path }),
      });
      unmount = () => view.dispose();
      // This dialog is the one dialog role; the view is a region inside it,
      // and its title (the visible one) names both.
      dialog.setAttribute('aria-labelledby', view.titleId);
      // The first control in the browser: Up, then the list.
      queueMicrotask(() => holder.querySelector<HTMLElement>('button:not([disabled])')?.focus());
    } else if (m.kind === 'message') {
      dialog.setAttribute('role', m.level === 'info' ? 'dialog' : 'alertdialog');
      dialog.classList.add(`aw-modal-${m.level}`);
      if (m.detail) {
        const detail = el('p', 'aw-modal-detail', m.detail);
        detail.id = 'awModalDetail';
        described.push(detail.id);
        dialog.appendChild(detail);
      }
      const actions = el('div', 'aw-modal-actions');
      m.buttons.forEach((b, index) => {
        const node = button(b.label, () => dispatch({ type: 'button', index }), b.primary);
        if (index === m.initial) focus = node;
        actions.appendChild(node);
      });
      dialog.appendChild(actions);
    } else if (m.kind === 'input') {
      dialog.setAttribute('role', 'dialog');
      const field = el('input', 'aw-modal-field');
      field.id = 'awModalField';
      field.type = m.password ? 'password' : 'text';
      field.autocomplete = m.password ? 'current-password' : 'off';
      field.spellcheck = false;
      field.value = m.value;
      if (m.placeholder) field.placeholder = m.placeholder;
      field.setAttribute('aria-labelledby', 'awModalTitle');
      if (m.prompt) {
        const prompt = el('p', 'aw-modal-prompt', m.prompt);
        prompt.id = 'awModalPrompt';
        described.push(prompt.id);
        dialog.appendChild(prompt);
      }
      dialog.appendChild(field);
      if (m.error) {
        const error = el('p', 'aw-modal-error', m.error);
        error.id = 'awModalError';
        error.setAttribute('role', 'alert');
        field.setAttribute('aria-invalid', 'true');
        field.setAttribute('aria-errormessage', error.id);
        described.push(error.id);
        dialog.appendChild(error);
      }
      if (described.length) field.setAttribute('aria-describedby', described.join(' '));
      field.addEventListener('input', () => dispatch({ type: 'text', text: field.value }));
      field.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        dispatch({ type: 'submit' });
      });
      const actions = el('div', 'aw-modal-actions');
      actions.append(button('OK', () => dispatch({ type: 'submit' }), true), button('Cancel', () => dispatch({ type: 'cancel' })));
      dialog.appendChild(actions);
      focus = field;
    } else {
      dialog.setAttribute('role', 'dialog');
      const field = el('input', 'aw-modal-field');
      field.id = 'awModalField';
      field.type = 'text';
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.placeholder = 'Type to filter';
      field.setAttribute('role', 'combobox');
      field.setAttribute('aria-labelledby', 'awModalTitle');
      field.setAttribute('aria-autocomplete', 'list');
      field.setAttribute('aria-expanded', 'true');
      field.setAttribute('aria-controls', 'awModalList');
      const list = el('ul', 'aw-modal-list');
      list.id = 'awModalList';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-labelledby', 'awModalTitle');
      // Rows are chosen with the pointer or from the field; never a tab stop of their own.
      list.tabIndex = -1;
      list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
      list.addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-at]');
        if (row) dispatch({ type: 'submit', visibleIndex: Number(row.dataset.at) });
      });
      field.addEventListener('input', () => dispatch({ type: 'text', text: field.value }));
      field.addEventListener('keydown', (e) => {
        const move = (event: ModalEvent) => {
          e.preventDefault();
          dispatch(event);
        };
        if (e.isComposing) return;
        if (e.key === 'ArrowDown') move({ type: 'move', delta: 1 });
        else if (e.key === 'ArrowUp') move({ type: 'move', delta: -1 });
        else if (e.key === 'PageDown') move({ type: 'move', delta: PAGE });
        else if (e.key === 'PageUp') move({ type: 'move', delta: -PAGE });
        else if (e.key === 'Enter') move({ type: 'submit' });
      });
      dialog.append(field, list);
      const actions = el('div', 'aw-modal-actions');
      actions.append(button('Cancel', () => dispatch({ type: 'cancel' })));
      dialog.appendChild(actions);
      pickField = field;
      pickList = list;
      renderPickRows(m);
      focus = field;
    }

    if (described.length) dialog.setAttribute('aria-describedby', described.join(' '));
    else dialog.removeAttribute('aria-describedby');
    focus?.focus();
    if (focus instanceof HTMLInputElement && m.kind === 'input') focus.select();
  }

  function renderPickRows(m: PickModal): void {
    if (!pickList || !pickField) return;
    const rows = m.visible.map((index, at) => {
      const row = m.rows[index];
      const li = el('li', at === m.active ? 'aw-modal-row on' : 'aw-modal-row');
      li.id = `awModalOpt${at}`;
      li.dataset.at = String(at);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', at === m.active ? 'true' : 'false');
      const top = el('div', 'aw-modal-rowtop');
      top.appendChild(el('span', 'aw-modal-label', row.label));
      if (row.description) top.appendChild(el('span', 'aw-modal-desc', row.description));
      li.appendChild(top);
      if (row.detail) li.appendChild(el('div', 'aw-modal-rowdetail', row.detail));
      return li;
    });
    if (rows.length === 0) {
      const empty = el('li', 'aw-modal-empty', 'No matches');
      empty.setAttribute('role', 'presentation');
      rows.push(empty);
    }
    pickList.replaceChildren(...rows);
    if (m.active >= 0) {
      pickField.setAttribute('aria-activedescendant', `awModalOpt${m.active}`);
      pickList.children[m.active]?.scrollIntoView({ block: 'nearest' });
    } else {
      pickField.removeAttribute('aria-activedescendant');
    }
  }

  function cancelCurrent(): void {
    if (viewOpen) closeView();
    else dispatch({ type: 'cancel' });
  }

  // Keys the whole dialog answers: Escape anywhere in it, and Tab kept inside it.
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // The folder browser cancels itself; answering twice would cancel the next modal too.
      if ((e.target as HTMLElement).closest('.aw-fb')) return;
      e.preventDefault();
      // The panes listen on `window` for Escape (menus, dictation): this one is ours.
      e.stopPropagation();
      cancelCurrent();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hidden);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = trapFocus(items.length, at, e.shiftKey);
    e.preventDefault();
    items[next]?.focus();
  });

  // A click on the backdrop dismisses a question that has a cancel; a message
  // with a single OK is dismissed the same way. Never a decision by accident:
  // dismissing always answers "cancelled".
  layer.addEventListener('click', (e) => {
    if (e.target === layer) cancelCurrent();
  });

  // Focus that escapes anyway (a click into the page through a gap, a script)
  // is brought back.
  document.addEventListener('focusin', (e) => {
    if (layer.hidden || layer.contains(e.target as Node)) return;
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  });

  return {
    receive(message) {
      if (message.type !== 'prompt' && message.type !== 'promptCancel') return;
      if (viewOpen) {
        // A view is up: the question waits behind it, unless it is withdrawn first.
        if (message.type === 'prompt') held.push(message);
        else held = held.filter((h) => h.type !== 'prompt' || h.id !== message.id);
        return;
      }
      const step = modalHostReceive(state, message);
      state = step.state;
      run(step.effects);
    },
    reset() {
      held = [];
      const step = modalHostReset(state);
      state = step.state;
      run(step.effects);
    },
    get isOpen() {
      return !layer.hidden;
    },
  };
}
