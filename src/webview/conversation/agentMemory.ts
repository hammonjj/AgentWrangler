/**
 * The memory of the durable agent a conversation belongs to (#180), beside
 * the conversation: a strip under the header to read it, forget an item and
 * remember a new one, and a card at the end of the conversation for each
 * update the agent proposed, which is stored only when the user approves it.
 *
 * Every change is a click (or Return in the box) and goes to the host as one
 * `agentMemory` message, authorised there as `agent.write`. Nothing here
 * takes focus on its own, so an Enter meant for the composer never approves
 * anything. Built with the DOM API and classes: no inline styles, and the
 * agent's text is only ever text.
 */
import { MEMORY_KINDS, MEMORY_KIND_LABEL, MAX_MEMORY_ITEM, type AgentMemoryKind, type MemoryOp } from '../../shared/agentMemory';
import type { AgentMemoryPaneView } from '../../shared/durableAgents';
import type { ConversationToHost } from '../../shared/messages';

export interface MemoryStrip {
  /** The conversation's agent changed, or its memory did. Undefined: not an agent's conversation. */
  set(memory: AgentMemoryPaneView | undefined): void;
  /** The host's answer to a change from here. */
  result(requestId: string, error: string | undefined): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createMemoryStrip(strip: HTMLElement, cards: HTMLElement, post: (m: ConversationToHost) => void): MemoryStrip {
  let memory: AgentMemoryPaneView | undefined;
  /** Folded by default: the conversation is what the pane is for. Per pane, not per agent. */
  let open = false;
  let pending: string | undefined;
  let error: string | undefined;
  /** The add box, kept across repaints while the host answers. */
  let draft: { kind: AgentMemoryKind; text: string } = { kind: 'decision', text: '' };

  const send = (op: MemoryOp) => {
    if (!memory || pending) return;
    pending = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    error = undefined;
    post({ type: 'agentMemory', agentId: memory.agentId, op, requestId: pending });
    render();
  };

  function render(): void {
    const typing = document.activeElement instanceof HTMLInputElement && strip.contains(document.activeElement);
    strip.replaceChildren();
    cards.replaceChildren();
    strip.hidden = memory === undefined;
    cards.hidden = !memory || memory.proposals.length === 0;
    if (!memory) return;
    const m = memory;
    const busy = pending !== undefined;

    const head = el('button', 'memhead');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    const asks = m.proposals.length;
    head.textContent = `${open ? '▾' : '▸'} ${m.agentName}'s memory · ${m.items.length} note${m.items.length === 1 ? '' : 's'}${asks ? ` · ${asks} to approve` : ''}`;
    head.title = open ? 'Fold' : 'What this agent carries into every conversation. Correct it here.';
    head.addEventListener('click', () => {
      open = !open;
      render();
    });
    strip.append(head);

    if (open) {
      const list = el('ul', 'memlist');
      for (const item of m.items) {
        const li = el('li', 'memitem');
        li.append(el('span', 'memkind', MEMORY_KIND_LABEL[item.kind]), el('span', 'memtext', item.text));
        const forget = el('button', 'membtn', 'Forget');
        forget.type = 'button';
        forget.disabled = busy;
        forget.title = 'Remove it. Conversations started or resumed from now on no longer carry it.';
        forget.addEventListener('click', () => send({ op: 'forget', itemId: item.id }));
        li.append(forget);
        list.append(li);
      }
      if (m.items.length === 0) list.append(el('li', 'memnote', 'Nothing remembered yet.'));
      strip.append(list);

      const form = el('form', 'memform');
      const kind = el('select', 'memselect');
      kind.setAttribute('aria-label', 'Kind');
      for (const k of MEMORY_KINDS) {
        const o = el('option', undefined, MEMORY_KIND_LABEL[k]);
        o.value = k;
        o.selected = k === draft.kind;
        kind.append(o);
      }
      const text = el('input', 'meminput');
      text.maxLength = MAX_MEMORY_ITEM;
      text.placeholder = 'Remember…';
      text.value = draft.text;
      text.setAttribute('aria-label', 'Something to remember');
      const keep = () => (draft = { kind: kind.value as AgentMemoryKind, text: text.value });
      kind.addEventListener('change', keep);
      text.addEventListener('input', keep);
      const add = el('button', 'membtn primary', 'Remember');
      add.type = 'submit';
      add.disabled = busy;
      form.append(kind, text, add);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        keep();
        if (draft.text.trim()) send({ op: 'remember', kind: draft.kind, text: draft.text });
      });
      strip.append(form, el('div', 'memnote', `${m.chars.toLocaleString('en-US')} of ${m.cap.toLocaleString('en-US')} characters, sent to each new or resumed conversation as context, never as permission.`));
      // A repaint while typing (a proposal arrived) gives the box back with the caret where it was.
      if (typing) {
        text.focus();
        text.setSelectionRange(text.value.length, text.value.length);
      }
    }
    if (error) {
      const e = el('div', 'memerror', error);
      e.setAttribute('role', 'alert');
      strip.append(e);
    }

    // The agent's proposals, as cards at the end of the conversation: the same
    // place a question or a plan waits, and decided the same way, by a click.
    for (const p of m.proposals) {
      const card = el('div', 'blk ask memprop st-pending');
      const what =
        p.op === 'add' ? `${MEMORY_KIND_LABEL[p.kind]}: ${p.text}` : `Forget: ${m.items.find((i) => i.id === p.itemId)?.text ?? p.itemId}`;
      card.append(
        el('div', 'askhead', `${m.agentName} proposes a memory ${p.op === 'add' ? 'note' : 'change'}`),
        el('div', 'qtext', what),
        el('div', 'asknote', 'Stored only if you approve. It is context for later conversations, never permission to act.'),
      );
      const row = el('div', 'askrow');
      const approve = el('button', 'askbtn primary', 'Approve');
      approve.type = 'button';
      approve.disabled = busy;
      approve.addEventListener('click', () => send({ op: 'approve', proposalId: p.id }));
      const reject = el('button', 'askbtn', 'Reject');
      reject.type = 'button';
      reject.disabled = busy;
      reject.addEventListener('click', () => send({ op: 'reject', proposalId: p.id }));
      row.append(approve, reject);
      card.append(row);
      cards.append(card);
    }
  }

  return {
    set(next) {
      // Another agent's memory is another strip: nothing typed for one carries to the next.
      if (next?.agentId !== memory?.agentId) {
        draft = { kind: 'decision', text: '' };
        error = undefined;
        pending = undefined;
      }
      memory = next;
      render();
    },
    result(requestId, err) {
      if (requestId !== pending) return;
      pending = undefined;
      error = err;
      if (!err) draft = { kind: draft.kind, text: '' };
      render();
    },
  };
}
