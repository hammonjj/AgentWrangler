import { describe, expect, it } from 'vitest';
import {
  CANCEL_LABEL,
  DISMISS_LABEL,
  emptyModalHost,
  modalFromPrompt,
  modalHostReceive,
  modalHostReset,
  modalHostStep,
  presentationOf,
  stepModal,
  trapFocus,
  type ModalEvent,
  type ModalHostEffect,
  type ModalHostState,
  type ModalModel,
  type PickModal,
} from '../src/shared/modalModel';
import type { HostToShell, ShellPrompt } from '../src/shared/shellProtocol';

function steps(model: ModalModel, events: ModalEvent[]) {
  let m = model;
  for (const e of events) {
    const s = stepModal(m, e);
    if (s.done) return s;
    m = s.model;
  }
  return { done: false as const, model: m };
}

/** The pick after these events, which must not have finished it. */
function pickAfter(model: ModalModel, events: ModalEvent[]): PickModal {
  const s = steps(model, events);
  if (s.done || s.model.kind !== 'pick') throw new Error('expected an open pick');
  return s.model;
}

const PICK: ShellPrompt = {
  kind: 'pick',
  placeHolder: 'Open which session?',
  items: [
    { label: '$(bell) frontend-fix', description: 'waiting' },
    { label: 'backend-api', description: 'frontend proxy', detail: '/Users/test/proj/api' },
    { label: 'docs', detail: '/Users/test/proj/docs' },
  ],
};

describe('a prompt becomes a modal', () => {
  it('a plain notice is a toast, anything to decide is a modal', () => {
    expect(presentationOf({ kind: 'message', level: 'info', message: 'Copied', items: [] })).toBe('toast');
    expect(presentationOf({ kind: 'message', level: 'info', message: 'Copied', items: [], modal: true })).toBe('modal');
    expect(presentationOf({ kind: 'message', level: 'warn', message: 'Careful', items: [] })).toBe('modal');
    expect(presentationOf({ kind: 'message', level: 'info', message: 'Open?', items: ['Open'] })).toBe('modal');
    expect(presentationOf({ kind: 'input' })).toBe('modal');
  });

  it('a message gets its buttons and a Cancel; a notice gets one OK', () => {
    const m = modalFromPrompt({ kind: 'message', level: 'warn', message: 'Close?', detail: 'It ends.', items: ['Close session'] });
    expect(m).toMatchObject({ kind: 'message', title: 'Close?', detail: 'It ends.', initial: 0 });
    expect(m.kind === 'message' && m.buttons.map((b) => [b.label, b.value])).toEqual([
      ['Close session', 'Close session'],
      [CANCEL_LABEL, undefined],
    ]);
    const notice = modalFromPrompt({ kind: 'message', level: 'error', message: 'Failed', items: [] });
    expect(notice.kind === 'message' && notice.buttons.map((b) => b.label)).toEqual([DISMISS_LABEL]);
  });

  it('defaultToCancel puts the first focus, and Enter, on Cancel', () => {
    const m = modalFromPrompt({ kind: 'message', level: 'warn', message: 'Delete?', items: ['Delete'], defaultToCancel: true });
    expect(m.kind === 'message' && m.buttons[m.initial].label).toBe(CANCEL_LABEL);
    expect(stepModal(m, { type: 'submit' })).toEqual({ done: true, value: undefined });
  });

  it('a button answers with its label; Escape with cancelled', () => {
    const m = modalFromPrompt({ kind: 'message', level: 'info', message: 'Which?', items: ['One', 'Two'] });
    expect(stepModal(m, { type: 'button', index: 1 })).toEqual({ done: true, value: 'Two' });
    expect(stepModal(m, { type: 'cancel' })).toEqual({ done: true, value: undefined });
  });

  it('an input answers with what was typed, empty included', () => {
    const m = modalFromPrompt({ kind: 'input', title: 'Name', prompt: 'Your own name', value: 'old' });
    expect(m).toMatchObject({ kind: 'input', title: 'Name', prompt: 'Your own name', value: 'old', password: false });
    expect(steps(m, [{ type: 'text', text: 'new' }, { type: 'submit' }])).toEqual({ done: true, value: 'new' });
    // Blank is a deliberate answer ("use its own title again"), not a cancel.
    expect(steps(m, [{ type: 'text', text: '' }, { type: 'submit' }])).toEqual({ done: true, value: '' });
  });

  it('a password input is masked, and a refused answer comes back with why', () => {
    const m = modalFromPrompt({ kind: 'input', title: 'Token', password: true, value: 'x', error: 'Too short.' });
    expect(m).toMatchObject({ kind: 'input', password: true, error: 'Too short.', value: 'x' });
  });

  it('an input with only a prompt uses it as the title', () => {
    expect(modalFromPrompt({ kind: 'input', prompt: 'Branch name' })).toMatchObject({ title: 'Branch name' });
    expect(modalFromPrompt({ kind: 'input', prompt: 'Branch name' })).not.toHaveProperty('prompt');
  });

  it('a folder is chosen in the folder browser: its host path is the answer, cancelled is undefined', () => {
    const m = modalFromPrompt({ kind: 'pickFolder', openLabel: 'Add project' });
    expect(m).toEqual({ kind: 'folder', title: 'Add project', openLabel: 'Add project' });
    expect(modalFromPrompt({ kind: 'pickFolder' })).toEqual({ kind: 'folder', title: 'Choose a folder' });
    expect(stepModal(m, { type: 'choose', path: '/Users/test/proj' })).toEqual({ done: true, value: '/Users/test/proj' });
    expect(stepModal(m, { type: 'choose', path: undefined })).toEqual({ done: true, value: undefined });
    expect(stepModal(m, { type: 'cancel' })).toEqual({ done: true, value: undefined });
    // Typing means nothing to it.
    expect(stepModal(m, { type: 'text', text: 'x' })).toEqual({ done: false, model: m });
  });
});

describe('a pick', () => {
  it('drops codicons and starts on the first row', () => {
    const m = modalFromPrompt(PICK) as PickModal;
    expect(m.rows[0].label).toBe('frontend-fix');
    expect(m.visible).toEqual([0, 1, 2]);
    expect(m.active).toBe(0);
    expect(m.title).toBe('Open which session?');
  });

  it('filters by subsequence on the label only, unless told to match more', () => {
    const m = modalFromPrompt(PICK) as PickModal;
    expect(pickAfter(m, [{ type: 'text', text: 'fnt' }]).visible).toEqual([0]);
    const wider = pickAfter(modalFromPrompt({ ...PICK, matchOnDescription: true } as ShellPrompt), [{ type: 'text', text: 'fnt' }]);
    expect(wider.visible).toEqual([0, 1]);
    const detail = pickAfter(modalFromPrompt({ ...PICK, matchOnDetail: true } as ShellPrompt), [{ type: 'text', text: 'proj/doc' }]);
    expect(detail.visible).toEqual([2]);
  });

  it('answers with the index in the original list, not the filtered one', () => {
    const m = modalFromPrompt(PICK);
    expect(steps(m, [{ type: 'text', text: 'docs' }, { type: 'submit' }])).toEqual({ done: true, value: 2 });
    // 'c' leaves backend-api and docs: the second of those is row 2.
    expect(steps(m, [{ type: 'text', text: 'c' }, { type: 'submit', visibleIndex: 1 }])).toEqual({ done: true, value: 2 });
  });

  it('arrows move the highlight within the matches, clamped', () => {
    const m = modalFromPrompt(PICK);
    expect(pickAfter(m, [{ type: 'move', delta: 1 }, { type: 'move', delta: 1 }, { type: 'move', delta: 1 }]).active).toBe(2);
    expect(pickAfter(m, [{ type: 'move', delta: -5 }]).active).toBe(0);
    expect(pickAfter(m, [{ type: 'moveTo', edge: 'last' }]).active).toBe(2);
    expect(steps(m, [{ type: 'moveTo', edge: 'last' }, { type: 'submit' }])).toEqual({ done: true, value: 2 });
  });

  it('Enter with nothing matching does nothing', () => {
    const m = modalFromPrompt(PICK);
    const none = steps(m, [{ type: 'text', text: 'zzz' }, { type: 'submit' }]);
    expect(none.done).toBe(false);
    expect((none as { model: PickModal }).model.active).toBe(-1);
  });
});

describe('focus', () => {
  it('Tab wraps forwards and backwards and never leaves', () => {
    expect(trapFocus(3, 0, false)).toBe(1);
    expect(trapFocus(3, 2, false)).toBe(0);
    expect(trapFocus(3, 0, true)).toBe(2);
    expect(trapFocus(3, -1, false)).toBe(0);
    expect(trapFocus(3, -1, true)).toBe(2);
    expect(trapFocus(1, 0, false)).toBe(0);
    expect(trapFocus(0, -1, false)).toBe(-1);
  });
});

describe('the modal host: prompt in, promptResult out', () => {
  function host() {
    let state: ModalHostState = emptyModalHost();
    const effects: ModalHostEffect[] = [];
    return {
      receive(m: HostToShell) {
        const s = modalHostReceive(state, m);
        state = s.state;
        effects.push(...s.effects);
      },
      act(e: ModalEvent) {
        const s = modalHostStep(state, e);
        state = s.state;
        effects.push(...s.effects);
      },
      reset() {
        const s = modalHostReset(state);
        state = s.state;
        effects.push(...s.effects);
      },
      get state() {
        return state;
      },
      effects,
      sent: () => effects.flatMap((e) => (e.type === 'send' ? [e.body] : [])),
      kinds: () => effects.map((e) => e.type),
    };
  }

  it('a confirm: opened, answered by its button, closed', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 7, prompt: { kind: 'message', level: 'warn', message: 'Close?', items: ['Close session'], modal: true } });
    expect(h.kinds()).toEqual(['open']);
    h.act({ type: 'button', index: 0 });
    expect(h.sent()).toEqual([{ type: 'promptResult', id: 7, value: 'Close session' }]);
    expect(h.kinds()).toEqual(['open', 'send', 'close']);
    expect(h.state.current).toBeUndefined();
  });

  it('a pick, filtered and chosen from the keyboard, answers with the original index', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 1, prompt: PICK });
    h.act({ type: 'text', text: 'c' });
    h.act({ type: 'move', delta: 1 });
    h.act({ type: 'submit' });
    expect(h.sent()).toEqual([{ type: 'promptResult', id: 1, value: 2 }]);
    expect(h.kinds().filter((k) => k === 'update')).toHaveLength(2);
  });

  it('Escape answers cancelled, as null on the wire', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 3, prompt: { kind: 'input', title: 'Name', password: true } });
    h.act({ type: 'cancel' });
    expect(h.sent()).toEqual([{ type: 'promptResult', id: 3, value: null }]);
  });

  it('a notice toasts and is answered at once', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 4, prompt: { kind: 'message', level: 'info', message: 'Copied', items: [] } });
    expect(h.effects).toEqual([
      { type: 'toast', text: 'Copied' },
      { type: 'send', body: { type: 'promptResult', id: 4, value: null } },
    ]);
    expect(h.state.current).toBeUndefined();
  });

  it('prompts asked while one is open wait their turn', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 1, prompt: { kind: 'input', title: 'First' } });
    h.receive({ type: 'prompt', id: 2, prompt: { kind: 'message', level: 'info', message: 'Noted', items: [] } });
    h.receive({ type: 'prompt', id: 3, prompt: { kind: 'input', title: 'Third' } });
    expect(h.kinds()).toEqual(['open']);
    h.act({ type: 'text', text: 'a' });
    h.act({ type: 'submit' });
    // The notice between them is toasted on the way past; the third opens without a close.
    expect(h.sent()).toEqual([
      { type: 'promptResult', id: 1, value: 'a' },
      { type: 'promptResult', id: 2, value: null },
    ]);
    expect(h.state.current?.id).toBe(3);
    expect(h.kinds().slice(-2)).toEqual(['send', 'open']);
  });

  it('promptCancel closes the open one unanswered, or drops a queued one', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 1, prompt: { kind: 'input', title: 'One' } });
    h.receive({ type: 'prompt', id: 2, prompt: { kind: 'input', title: 'Two' } });
    h.receive({ type: 'prompt', id: 3, prompt: { kind: 'input', title: 'Three' } });
    h.receive({ type: 'promptCancel', id: 2 });
    h.receive({ type: 'promptCancel', id: 1 });
    expect(h.state.current?.id).toBe(3);
    expect(h.sent()).toEqual([]);
    h.receive({ type: 'promptCancel', id: 3 });
    expect(h.kinds().at(-1)).toBe('close');
    expect(h.sent()).toEqual([]);
  });

  it('a dropped connection closes everything without answering', () => {
    const h = host();
    h.receive({ type: 'prompt', id: 1, prompt: { kind: 'input', title: 'One' } });
    h.receive({ type: 'prompt', id: 2, prompt: { kind: 'input', title: 'Two' } });
    h.reset();
    expect(h.state).toEqual(emptyModalHost());
    expect(h.kinds().at(-1)).toBe('close');
    expect(h.sent()).toEqual([]);
  });

  it('ignores what is not a prompt, and events with nothing open', () => {
    const h = host();
    h.receive({ type: 'toast', text: 'x' });
    h.act({ type: 'submit' });
    expect(h.effects).toEqual([]);
  });
});
