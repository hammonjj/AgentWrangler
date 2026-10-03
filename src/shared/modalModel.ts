/**
 * The browser shell's in-page modals (#133): what a `prompt` on the shell
 * channel becomes, how it reacts to keys and clicks, and what goes back as the
 * `promptResult`. It replaces the stopgap `confirm()`/`prompt()` in the browser
 * and does in a page what the palette window and native dialogs do in the app.
 *
 * Pure, so it can be tested without a DOM: `src/webview/workbench/modalHost.ts`
 * draws a `ModalModel` and turns DOM events into `ModalEvent`s, and the host
 * queue below decides what is on screen and what is sent.
 *
 * Answers follow `ShellPromptValue`: a button's label for `message`, the text
 * for `input` and `pickFolder`, the row's index in the *original* list for
 * `pick` (never the filtered one), and `undefined` for cancelled.
 */

import { paletteMatches, stripCodicons, type PaletteRow } from './palette';
import type { HostToShell, ShellPrompt, ShellPromptValue, ShellToHost } from './shellProtocol';

export const CANCEL_LABEL = 'Cancel';
export const DISMISS_LABEL = 'OK';

export interface MessageModal {
  kind: 'message';
  level: 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
  /** What each button answers with; `undefined` is the cancel. */
  buttons: Array<{ label: string; value: string | undefined; primary?: boolean }>;
  /** The button that has focus when the modal opens. */
  initial: number;
}

export interface InputModal {
  kind: 'input';
  title: string;
  prompt?: string;
  /** Why the last answer was refused: the host checked it and asked again. */
  error?: string;
  value: string;
  placeholder?: string;
  password: boolean;
  /** `pickFolder`: a path on the Mac the app runs on; blank is cancelled. */
  folder: boolean;
}

export interface PickModal {
  kind: 'pick';
  title: string;
  rows: PaletteRow[];
  query: string;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  /** Indices into `rows` that match `query`, in order. */
  visible: number[];
  /** Position in `visible` of the highlighted row; -1 when nothing matches. */
  active: number;
}

export type ModalModel = MessageModal | InputModal | PickModal;

export type ModalEvent =
  /** The field changed: the input's text, or the pick's filter. */
  | { type: 'text'; text: string }
  /** Arrow keys and paging in a pick. */
  | { type: 'move'; delta: number }
  | { type: 'moveTo'; edge: 'first' | 'last' }
  /** Enter in a field, or a row clicked (by its position in `visible`). */
  | { type: 'submit'; visibleIndex?: number }
  /** A message button, by its position in `buttons`. */
  | { type: 'button'; index: number }
  /** Escape, the Cancel button, a click outside. */
  | { type: 'cancel' };

export type ModalStep = { done: false; model: ModalModel } | { done: true; value: ShellPromptValue };

/**
 * Some prompts are not worth a modal: a plain informational line with nothing
 * to choose is a toast, answered at once, as a notification would be.
 */
export function presentationOf(prompt: ShellPrompt): 'toast' | 'modal' {
  if (prompt.kind !== 'message') return 'modal';
  return prompt.level === 'info' && prompt.items.length === 0 && !prompt.modal && prompt.detail === undefined ? 'toast' : 'modal';
}

export function modalFromPrompt(prompt: ShellPrompt): ModalModel {
  switch (prompt.kind) {
    case 'message': {
      const buttons: MessageModal['buttons'] =
        prompt.items.length === 0
          ? [{ label: DISMISS_LABEL, value: undefined, primary: true }]
          : [
              ...prompt.items.map((label, i) => ({ label, value: label, primary: i === 0 })),
              { label: CANCEL_LABEL, value: undefined },
            ];
      return {
        kind: 'message',
        level: prompt.level,
        title: prompt.message,
        ...(prompt.detail ? { detail: prompt.detail } : {}),
        buttons,
        initial: prompt.defaultToCancel ? buttons.length - 1 : 0,
      };
    }
    case 'input':
      return {
        kind: 'input',
        title: prompt.title ?? prompt.prompt ?? 'Enter a value',
        ...(prompt.title && prompt.prompt ? { prompt: prompt.prompt } : {}),
        ...(prompt.error ? { error: prompt.error } : {}),
        value: prompt.value ?? '',
        ...(prompt.placeHolder ? { placeholder: prompt.placeHolder } : {}),
        password: prompt.password === true,
        folder: false,
      };
    case 'pickFolder':
      return {
        kind: 'input',
        title: prompt.openLabel ?? 'Choose a folder',
        prompt: 'A folder on the Mac running Agent Wrangler, as a full path.',
        value: '',
        placeholder: '/Users/you/project',
        password: false,
        folder: true,
      };
    case 'pick': {
      const rows = prompt.items.map((item) => ({ ...item, label: stripCodicons(item.label) }));
      return filtered({
        kind: 'pick',
        title: prompt.placeHolder ?? 'Choose one',
        rows,
        query: '',
        matchOnDescription: prompt.matchOnDescription === true,
        matchOnDetail: prompt.matchOnDetail === true,
        visible: [],
        active: -1,
      });
    }
  }
}

function filtered(m: PickModal): PickModal {
  const opts = { matchOnDescription: m.matchOnDescription, matchOnDetail: m.matchOnDetail };
  const visible = m.rows.flatMap((row, i) => (paletteMatches(row, m.query, opts) ? [i] : []));
  return { ...m, visible, active: visible.length > 0 ? 0 : -1 };
}

export function stepModal(model: ModalModel, event: ModalEvent): ModalStep {
  if (event.type === 'cancel') return { done: true, value: undefined };
  switch (model.kind) {
    case 'message':
      if (event.type === 'button') {
        const button = model.buttons[event.index];
        return button ? { done: true, value: button.value } : { done: false, model };
      }
      if (event.type === 'submit') return { done: true, value: model.buttons[model.initial]?.value };
      return { done: false, model };
    case 'input':
      if (event.type === 'text') return { done: false, model: { ...model, value: event.text } };
      if (event.type === 'submit') {
        if (!model.folder) return { done: true, value: model.value };
        const path = model.value.trim();
        return { done: true, value: path || undefined };
      }
      return { done: false, model };
    case 'pick': {
      if (event.type === 'text') return { done: false, model: filtered({ ...model, query: event.text }) };
      const n = model.visible.length;
      if (event.type === 'move') {
        if (n === 0) return { done: false, model };
        const active = Math.min(n - 1, Math.max(0, model.active + event.delta));
        return { done: false, model: { ...model, active } };
      }
      if (event.type === 'moveTo') {
        if (n === 0) return { done: false, model };
        return { done: false, model: { ...model, active: event.edge === 'first' ? 0 : n - 1 } };
      }
      if (event.type === 'submit') {
        const at = event.visibleIndex ?? model.active;
        const index = model.visible[at];
        // Enter with nothing matching does nothing, as the palette's does.
        return index === undefined ? { done: false, model } : { done: true, value: index };
      }
      return { done: false, model };
    }
  }
}

// ---- focus ----

/**
 * Tab inside a modal: the next focusable element, wrapping at both ends, so
 * focus never leaves the dialog. `current` is -1 when focus is outside it.
 */
export function trapFocus(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

// ---- the queue: which prompt is on screen, and what is sent ----

export interface OpenModal {
  id: number;
  model: ModalModel;
}

export interface ModalHostState {
  current?: OpenModal;
  /** Prompts asked while another was open, oldest first. One modal at a time. */
  queue: Array<{ id: number; prompt: ShellPrompt }>;
}

export type ModalHostEffect =
  | { type: 'send'; body: ShellToHost }
  | { type: 'toast'; text: string; timeoutMs?: number }
  /** A modal is on screen now: a new one, or the next in the queue. Draw it. */
  | { type: 'open'; modal: OpenModal }
  /** The model changed in place (filtering, typing). */
  | { type: 'update'; modal: OpenModal }
  /** Nothing is on screen any more: restore focus. */
  | { type: 'close' };

export interface ModalHostStep {
  state: ModalHostState;
  effects: ModalHostEffect[];
}

export function emptyModalHost(): ModalHostState {
  return { queue: [] };
}

/** Take the next queued prompt, if any; toasts are answered on the way past. */
function advance(queue: ModalHostState['queue'], effects: ModalHostEffect[]): ModalHostState {
  const rest = [...queue];
  for (let next = rest.shift(); next; next = rest.shift()) {
    if (presentationOf(next.prompt) === 'toast') {
      answerAsToast(next.id, next.prompt, effects);
      continue;
    }
    const modal = { id: next.id, model: modalFromPrompt(next.prompt) };
    effects.push({ type: 'open', modal });
    return { current: modal, queue: rest };
  }
  effects.push({ type: 'close' });
  return { queue: [] };
}

function answerAsToast(id: number, prompt: ShellPrompt, effects: ModalHostEffect[]): void {
  if (prompt.kind === 'message') effects.push({ type: 'toast', text: prompt.message });
  effects.push({ type: 'send', body: { type: 'promptResult', id, value: null } });
}

/** A shell message from the host. Only `prompt` and `promptCancel` concern the modals. */
export function modalHostReceive(state: ModalHostState, message: HostToShell): ModalHostStep {
  const effects: ModalHostEffect[] = [];
  if (message.type === 'prompt') {
    if (state.current) return { state: { ...state, queue: [...state.queue, { id: message.id, prompt: message.prompt }] }, effects };
    if (presentationOf(message.prompt) === 'toast') {
      answerAsToast(message.id, message.prompt, effects);
      return { state, effects };
    }
    const modal = { id: message.id, model: modalFromPrompt(message.prompt) };
    return { state: { ...state, current: modal }, effects: [{ type: 'open', modal }] };
  }
  if (message.type === 'promptCancel') {
    // Answered elsewhere or timed out host-side: it goes, unanswered.
    if (state.current?.id === message.id) return { state: advance(state.queue, effects), effects };
    return { state: { ...state, queue: state.queue.filter((q) => q.id !== message.id) }, effects };
  }
  return { state, effects };
}

/** Someone did something in the open modal. */
export function modalHostStep(state: ModalHostState, event: ModalEvent): ModalHostStep {
  const current = state.current;
  if (!current) return { state, effects: [] };
  const step = stepModal(current.model, event);
  if (!step.done) {
    if (step.model === current.model) return { state, effects: [] };
    const modal = { id: current.id, model: step.model };
    return { state: { ...state, current: modal }, effects: [{ type: 'update', modal }] };
  }
  const effects: ModalHostEffect[] = [{ type: 'send', body: { type: 'promptResult', id: current.id, value: step.value ?? null } }];
  return { state: advance(state.queue, effects), effects };
}

/**
 * The connection dropped: the host has cancelled everything it asked this tab
 * (`shellChannel.dispose`), so nothing open or queued can be answered now.
 */
export function modalHostReset(state: ModalHostState): ModalHostStep {
  if (!state.current && state.queue.length === 0) return { state, effects: [] };
  return { state: emptyModalHost(), effects: [{ type: 'close' }] };
}
