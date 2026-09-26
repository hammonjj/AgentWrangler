import './conversation.css';
import { fileUriToPath, fileUrisToPaths } from '../../shared/attachments';
import type {
  AskState,
  ComposerState,
  ConvBlock,
  ConversationCapabilities,
  ImageAttachment,
  ModelChoice,
  PermissionModeName,
  QuestionView,
} from '../../shared/conversation';
import { decodedBytes, IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from '../../shared/conversation';
import { describeDictation, spliceDictation } from '../../shared/dictationText';
import { renderMarkdown as mdToHtml } from '../../shared/markdown';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import { displayTitle, STATUS_LABEL, type SessionDTO, type SessionStatus } from '../../shared/model';
import { modelLabel } from '../../shared/modelName';
import { usageHeaderText, usageTitle } from '../../shared/sessionUsage';
import { paneApi } from '../common/paneApi';

// See `common/paneApi.ts`: one acquire, one message envelope and one state slot
// per pane, so the dashboard can share this webview.
const vscodeApi = paneApi<{ key: string }>('conversation');
const post = (msg: ConversationToHost) => vscodeApi.post(msg);

/** Rendered blocks kept in the DOM. Older ones are dropped with a notch. */
const MAX_BLOCK_NODES = 400;
/** Treat the view as "at the bottom" within this many pixels. */
const STICK_PX = 56;
/** Composer grows with the message up to this, then scrolls. */
const MAX_COMPOSER_PX = 180;
/**
 * How much of an ask card has to be on screen for it to count as seen. An ask
 * whose first line is the last pixel of the view has not been read, and the
 * strip that points at it should stay up.
 */
const ASK_HEAD_PX = 44;
/** Gap left above an ask card when the view is moved to it, so it does not sit flush. */
const ASK_TOP_GAP_PX = 8;
/** How often an expanded block re-asks for its full text while it is still streaming. */
const REFETCH_MS = 500;

/**
 * The modes worth offering. `bypassPermissions` is deliberately absent: it
 * needs an extra opt-in flag and turns every guard off at once, which is not
 * something a dropdown should do by accident.
 */
const MODES: { value: PermissionModeName; label: string }[] = [
  { value: 'default', label: 'Ask permission' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'auto', label: 'Auto (classifier)' },
  { value: 'plan', label: 'Plan mode' },
];

const app = document.getElementById('convApp')!;
app.innerHTML = `
<div id="hdr">
  <span id="pill" class="pill"></span>
  <span id="ttl"></span>
  <span id="meta"></span>
  <span id="convUsage" hidden></span>
  <span id="spacer"></span>
  <button id="release" class="hdrbtn" hidden title="Stop running this session here and resume it in a terminal">Release</button>
  <button id="pin" class="hdrbtn" title="Open this conversation in a tab of its own, which row clicks never swap away">Own tab</button>
</div>
<div id="banner" hidden></div>
<form id="findbar"><input id="find" type="search" placeholder="Find in conversation" aria-label="Find in conversation"><button>Find</button><button type="button" id="clearfind">Clear</button></form>
<div id="scroll"><div id="searchresults" hidden></div><button id="notch" hidden>Load earlier messages</button><div id="blocks"></div></div>
<button id="jump" hidden></button>
<button id="asknav" class="asknav" hidden></button>
<div id="composer">
  <div id="composerRead">
    <span id="composerNote"></span>
    <button id="adopt" class="askbtn primary" hidden></button>
  </div>
  <div id="composerWrite" hidden>
    <div id="composerBar">
      <select id="mode" title="Permission mode"></select>
      <select id="model" title="Model" hidden></select>
      <select id="effort" title="How hard Claude thinks before answering" hidden></select>
      <span id="queued" hidden></span>
      <span class="grow"></span>
    </div>
    <div id="slashcommands" role="listbox" hidden></div>
    <div id="mentions" class="mentions" role="listbox" hidden></div>
    <div id="composerInput">
      <div id="attachments" hidden></div>
      <div id="dictation" class="dictation" hidden>
        <div class="dicthead"><span class="dictdot" aria-hidden="true"></span><span id="dictLabel" class="dictlabel" role="status"></span><button id="dictClose" class="dictclose" title="Dismiss" aria-label="Dismiss" hidden>×</button></div>
        <div id="dictDetail" class="dictdetail" hidden></div>
        <div id="dictText" class="dicttext" aria-label="Provisional dictation"></div>
      </div>
      <textarea id="msg" rows="1" placeholder="Message Claude…  (Enter to send, Shift+Enter for a new line)"></textarea>
      <input id="attachpick" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <div id="composerActions">
        <button id="attach" class="clipbtn" title="Attach an image" aria-label="Attach an image"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d="M10.5 4.6v6a2.5 2.5 0 0 1-5 0V3.7a1.5 1.5 0 0 1 3 0v6.6a.5.5 0 0 1-1 0V5.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button id="mic" class="micbtn" title="Dictate a message" aria-label="Dictate a message"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><rect x="6" y="1.8" width="4" height="7.4" rx="2" fill="currentColor"/><path d="M3.9 7.4a4.1 4.1 0 0 0 8.2 0" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M8 11.5v2.4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg></button>
        <span class="grow"></span>
        <button id="send" class="askbtn primary" title="Send this message">Send</button>
      </div>
    </div>
  </div>
</div>
`;

const pill = document.getElementById('pill')!;
const ttl = document.getElementById('ttl')!;
const meta = document.getElementById('meta')!;
// Not `#usage`: that is the table pane's plan-usage strip, in the same
// document. Sharing the id made this line overwrite the plan cards.
const usageEl = document.getElementById('convUsage')!;
const banner = document.getElementById('banner')!;
const scroller = document.getElementById('scroll')!;
const notch = document.getElementById('notch')!;
const blocksEl = document.getElementById('blocks')!;
const jump = document.getElementById('jump')!;
const askNav = document.getElementById('asknav') as HTMLButtonElement;
const composerRead = document.getElementById('composerRead')!;
const composerWrite = document.getElementById('composerWrite')!;
const composerNote = document.getElementById('composerNote')!;
const adoptBtn = document.getElementById('adopt') as HTMLButtonElement;
const pinBtn = document.getElementById('pin') as HTMLButtonElement;
const releaseBtn = document.getElementById('release') as HTMLButtonElement;
const modeSel = document.getElementById('mode') as HTMLSelectElement;
const modelSel = document.getElementById('model') as HTMLSelectElement;
const effortSel = document.getElementById('effort') as HTMLSelectElement;
const queuedEl = document.getElementById('queued')!;
const msgEl = document.getElementById('msg') as HTMLTextAreaElement;
const micBtn = document.getElementById('mic') as HTMLButtonElement;
const dictEl = document.getElementById('dictation')!;
const dictLabel = document.getElementById('dictLabel')!;
const dictDetail = document.getElementById('dictDetail')!;
const dictText = document.getElementById('dictText')!;
const dictClose = document.getElementById('dictClose') as HTMLButtonElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const attachmentsEl = document.getElementById('attachments')!;
const attachBtn = document.getElementById('attach') as HTMLButtonElement;
const attachPick = document.getElementById('attachpick') as HTMLInputElement;
const mentionsEl = document.getElementById('mentions')!;
const composerInput = document.getElementById('composerInput')!;

/** Block id → its node, so a patch updates in place instead of re-rendering. */
const nodes = new Map<string, HTMLElement>();
/** Latest state of each block, since a patch is partial. */
const blockState = new Map<string, ConvBlock>();
/** Blocks the reader asked to see in full; a later patch must not collapse them. */
const expanded = new Set<string>();
/** Ids with a re-fetch already scheduled, so a streaming block asks once a tick, not once a delta. */
const refetching = new Set<string>();
/** Ids whose full text was fetched for a copy, so the reply lands on the clipboard and not on screen. */
const copyPending = new Set<string>();

let stick = true;
let newCount = 0;
let caps: ConversationCapabilities | undefined;

for (const m of MODES) {
  const opt = document.createElement('option');
  opt.value = m.value;
  opt.textContent = m.label;
  modeSel.appendChild(opt);
}

// ---- rendering helpers ----

function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}

/** Markdown → HTML. The shared renderer escapes any markup in the source. */
function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = mdToHtml(text);
  decorateCodeBlocks(el);
}

/**
 * The tail of a block that was too long for the wire, on request.
 *
 * The host caps what it sends so that opening a long conversation does not ship
 * a megabyte of text nobody will read; this is how the reader gets the rest of
 * the one block they *are* reading. It matters most on a plan: approving half a
 * plan is approving something you have not seen.
 */
function appendShowMore(el: HTMLElement, id: string, more: number | undefined): void {
  if (!more) return;
  const btn = document.createElement('button');
  btn.className = 'showmore';
  btn.textContent = `Show the rest (${more.toLocaleString()} more characters)`;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    // Remembered, so a patch that re-caps this block (a reply still streaming)
    // asks for the rest again instead of collapsing under the reader.
    expanded.add(id);
    const block = searchBlocks.get(id) ?? blockState.get(id);
    post({ type: 'requestBlockText', id, toolUseId: block?.kind === 'tool' ? block.toolUseId : undefined });
  });
  el.appendChild(btn);
}

/**
 * "Copy this reply", on every assistant block.
 *
 * What lands on the clipboard is the markdown source, not the rendered HTML:
 * that is what the agent actually wrote, and it is what pastes usefully into a
 * ticket, a commit message or another agent. Selecting the text by hand gets
 * you the rendering instead — bullets flattened, code fences gone — which is
 * the reason this button exists at all.
 *
 * Hover-revealed and absolutely positioned, the same as the `<pre>` copy
 * button, so a conversation being read is not a column of buttons. It is in the
 * tab order regardless, and `:focus` reveals it, so it is reachable without a
 * pointer.
 */
function flashCopy(btn: HTMLButtonElement, label: string, state: 'done' | 'busy' | 'fail' = 'done', ms = 1200): void {
  btn.dataset.state = state;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  setTimeout(() => {
    if (!btn.isConnected) return;
    delete btn.dataset.state;
    btn.title = COPY_REPLY_LABEL;
    btn.setAttribute('aria-label', COPY_REPLY_LABEL);
  }, ms);
}

const COPY_REPLY_LABEL = 'Copy this reply as markdown';
const COPY_GLYPH = `<svg class="cicon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M5.6 5.6V2.6h7.8v7.8h-3"/><rect x="2.6" y="5.6" width="7.8" height="7.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

function writeCopy(btn: HTMLButtonElement, text: string, label = 'Copied'): void {
  navigator.clipboard.writeText(text).then(
    () => flashCopy(btn, label),
    () => flashCopy(btn, 'Copy failed', 'fail', 1600),
  );
}

/** Write the just-arrived full text, flashing the block's rebuilt copy button. */
function finishPendingCopy(node: HTMLElement, text: string): void {
  const btn = node.querySelector('.blockcopy') as HTMLButtonElement | null;
  if (btn) writeCopy(btn, text);
  else void navigator.clipboard.writeText(text);
}

function appendBlockCopy(el: HTMLElement, b: ConvBlock): void {
  const btn = document.createElement('button');
  btn.className = 'blockcopy';
  btn.innerHTML = COPY_GLYPH;
  btn.title = COPY_REPLY_LABEL;
  btn.setAttribute('aria-label', COPY_REPLY_LABEL);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const block = searchBlocks.get(b.id) ?? blockState.get(b.id);
    const text = block && 'text' in block ? (block.text ?? '') : '';
    const more = block && 'more' in block ? block.more : undefined;
    // Under the wire cap the webview already holds the whole reply. Over it,
    // copying what is on screen would silently hand over a prefix, so the rest
    // is fetched first and the clipboard is written when it lands.
    if (!more) {
      writeCopy(btn, text);
      return;
    }
    copyPending.add(b.id);
    flashCopy(btn, 'Fetching the rest…', 'busy', 4000);
    post({ type: 'requestBlockText', id: b.id });
  });
  // Wrapped in a zero-height sticky spacer: the wrapper pins to the top of the
  // scroll viewport while any part of `el` is still on screen, but takes no
  // space in flow, so the button stays reachable on long replies instead of
  // scrolling away with the top of the bubble.
  const sticky = document.createElement('div');
  sticky.className = 'blockcopy-sticky';
  sticky.appendChild(btn);
  el.appendChild(sticky);
}

function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.querySelector('.copy')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      navigator.clipboard.writeText(code).then(
        () => {
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy'), 1200);
        },
        () => {
          btn.textContent = 'Copy failed';
          setTimeout(() => (btn.textContent = 'Copy'), 1600);
        },
      );
    });
    pre.appendChild(btn);
  }
}

function timeLabel(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function answeredLabel(state: AskState): string {
  switch (state) {
    case 'allowed':
      return 'Allowed.';
    case 'denied':
      return 'Denied.';
    case 'expired':
      return 'Answered elsewhere.';
    default:
      return '';
  }
}

// ---- block nodes ----

function buildNode(b: ConvBlock): HTMLElement {
  const el = document.createElement('div');
  el.dataset.id = b.id;
  fillNode(el, b);
  return el;
}

function fillNode(el: HTMLElement, b: ConvBlock): void {
  switch (b.kind) {
    case 'user': {
      el.className = 'blk user';
      el.innerHTML = '';
      const body = document.createElement('div');
      body.className = 'body';
      renderMarkdown(body, b.text);
      el.appendChild(body);
      appendShowMore(el, b.id, b.more);
      if (b.imageCount) {
        const img = document.createElement('div');
        img.className = 'sub';
        setText(img, `${b.imageCount} image${b.imageCount === 1 ? '' : 's'} attached`);
        el.appendChild(img);
      }
      break;
    }
    case 'assistant': {
      el.className = b.streaming ? 'blk assistant streaming' : 'blk assistant';
      el.innerHTML = '';
      const body = document.createElement('div');
      body.className = 'body';
      renderMarkdown(body, b.text);
      el.appendChild(body);
      appendShowMore(el, b.id, b.more);
      // Not while it is still being written: a reply copied mid-sentence is a
      // half-answer that looks like a whole one on the clipboard.
      if (!b.streaming) appendBlockCopy(el, b);
      break;
    }
    case 'thinking': {
      el.className = 'blk thinking';
      el.innerHTML = '';
      const d = document.createElement('details');
      d.open = true;
      const s = document.createElement('summary');
      setText(s, b.streaming ? 'Thinking…' : 'Thinking');
      const body = document.createElement('div');
      body.className = 'body';
      renderMarkdown(body, b.text);
      d.append(s, body);
      appendShowMore(d, b.id, b.more);
      el.appendChild(d);
      break;
    }
    case 'tool': {
      const children = el.querySelector(':scope > .subagent-work');
      el.className = `blk tool st-${b.state}`;
      el.innerHTML = '';
      const d = document.createElement('details');
      const s = document.createElement('summary');
      const name = document.createElement('span');
      name.className = 'tname';
      setText(name, b.name);
      const preview = document.createElement('span');
      preview.className = 'tin';
      setText(preview, b.inputPreview);
      s.append(name, preview);
      if (b.state !== 'done') {
        const st = document.createElement('span');
        st.className = 'tstate';
        setText(st, b.state === 'running' ? 'running' : 'failed');
        s.appendChild(st);
      }
      d.appendChild(s);

      if (b.input !== undefined) {
        const pre = document.createElement('pre');
        pre.className = 'tinput';
        let text: string;
        try {
          text = JSON.stringify(b.input, null, 2);
        } catch {
          text = String(b.input);
        }
        setText(pre, text);
        d.appendChild(pre);
      }
      if (b.result) {
        const diffs = b.result.diffs ?? (b.result.diff ? [b.result.diff] : []);
        for (const { file: filePath, patch } of diffs) {
          const file = document.createElement('div');
          file.className = 'sub difftop';
          const name = document.createElement('span');
          setText(name, filePath);
          // The +/- block below is for a glance. Anything worth reading properly
          // wants syntax highlighting and side-by-side, which is a real editor.
          const open = document.createElement('button');
          open.className = 'diffopen';
          open.textContent = 'Open in diff editor';
          open.title = 'Show this change side by side, with syntax highlighting';
          open.addEventListener('click', (e) => {
            e.stopPropagation();
            post({ type: 'openDiff', file: filePath, patch });
          });
          file.append(name, open);
          const pre = document.createElement('pre');
          pre.className = 'tdiff';
          renderDiff(pre, patch);
          d.append(file, pre);
        }
        if (b.result.text) {
          const pre = document.createElement('pre');
          pre.className = b.result.isError ? 'tresult err' : 'tresult';
          setText(pre, b.result.text + (b.result.truncated ? '\n… output truncated' : ''));
          d.appendChild(pre);
          if (b.result.truncated) appendShowMore(d, b.id, 1);
        }
      }
      el.appendChild(d);
      if (children) el.appendChild(children);
      if (activeProvider === 'claude' && (b.name === 'Agent' || b.name === 'Task')) {
        const load = document.createElement('button');
        load.className = 'subagent-load';
        load.textContent = 'Load subagent work';
        load.addEventListener('click', () => post({ type: 'subagent', id: b.id, toolUseId: b.toolUseId }));
        el.appendChild(load);
      }
      break;
    }
    case 'permission': {
      el.className = `blk ask permission st-${b.state}`;
      el.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'askhead';
      // Claude's own description if it gave one, since it says why; the tool
      // name alone only says what.
      setText(head, b.summary ?? `${b.toolName} needs permission`);
      el.appendChild(head);
      if (b.summary) {
        const tool = document.createElement('div');
        tool.className = 'sub';
        setText(tool, b.toolName);
        el.appendChild(tool);
      }
      if (b.body) {
        const pre = document.createElement('pre');
        pre.className = b.isCommand ? 'askdetail cmd' : 'askdetail';
        setText(pre, b.body);
        el.appendChild(pre);
      }
      el.appendChild(permissionActions(b.requestId, b.state, b.alwaysAllowRule));
      break;
    }
    case 'question': {
      el.className = `blk ask question st-${b.state}`;
      el.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'askhead';
      setText(head, 'Claude has a question');
      el.appendChild(head);
      el.appendChild(questionForm(b.requestId, b.questions, b.state, b.answers));
      break;
    }
    case 'plan': {
      el.className = `blk ask plan st-${b.state}`;
      el.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'askhead';
      setText(head, 'Plan ready for approval');
      el.appendChild(head);
      const body = document.createElement('div');
      body.className = 'body';
      renderMarkdown(body, b.plan);
      el.appendChild(body);
      appendShowMore(el, b.id, b.more);
      el.appendChild(planActions(b.requestId, b.state));
      break;
    }
    case 'note': {
      el.className = `blk note tone-${b.tone}`;
      el.innerHTML = '';
      const body = document.createElement('span');
      setText(body, b.text);
      el.appendChild(body);
      break;
    }
  }

  const ts = 'ts' in b ? timeLabel(b.ts) : '';
  if (ts) el.title = ts;
}

/** An ask this pane cannot answer: say so instead of showing dead buttons. */
function cannotAnswer(row: HTMLElement, what: string): void {
  const note = document.createElement('span');
  note.className = 'asknote';
  setText(note, `Answer this in ${what}: this session is not running in this window.`);
  row.appendChild(note);
}

function settledRow(state: AskState): HTMLElement {
  const row = document.createElement('div');
  row.className = 'askrow';
  const done = document.createElement('span');
  done.className = 'asknote';
  setText(done, answeredLabel(state));
  row.appendChild(done);
  return row;
}

function permissionActions(requestId: string, state: AskState, alwaysAllowRule: string | undefined): HTMLElement {
  if (state !== 'pending') return settledRow(state);
  const row = document.createElement('div');
  row.className = 'askrow';

  const mk = (label: string, decision: 'allow' | 'always' | 'deny', cls: string) => {
    const b = document.createElement('button');
    b.className = `askbtn ${cls}`;
    setText(b, label);
    b.addEventListener('click', () => {
      // Disabling is optimistic; the host's patch decides what the card ends
      // up saying, including "too late".
      for (const other of Array.from(row.querySelectorAll('button'))) other.disabled = true;
      post({ type: 'decide', requestId, decision });
      followAfterAnswer();
    });
    return b;
  };

  row.appendChild(mk('Allow', 'allow', 'primary'));
  if (alwaysAllowRule) {
    const always = mk('Always allow', 'always', '');
    // Say exactly which rule gets written, so "always" is never a blank cheque.
    always.title = `Adds the rule ${alwaysAllowRule}`;
    row.appendChild(always);
  }
  row.appendChild(mk('Deny', 'deny', ''));
  return row;
}

/**
 * `AskUserQuestion` as a form. Only a session running here can be answered —
 * the hook that carries Allow/Deny to another window explicitly cannot settle
 * a question.
 */
function questionForm(
  requestId: string,
  questions: QuestionView[],
  state: AskState,
  answers: Record<string, string> | undefined,
): HTMLElement {
  const wrap = document.createElement('div');

  for (const q of questions) {
    const qd = document.createElement('div');
    qd.className = 'qtext';
    setText(qd, q.question);
    wrap.appendChild(qd);

    if (state !== 'pending') {
      const chosen = document.createElement('div');
      chosen.className = 'sub';
      setText(chosen, answers?.[q.question] ?? q.options.map((o) => o.label).join(' · '));
      wrap.appendChild(chosen);
      continue;
    }

    const opts = document.createElement('div');
    opts.className = 'qopts';
    for (const o of q.options) {
      const label = document.createElement('label');
      label.className = 'qopt';
      const input = document.createElement('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = `q:${requestId}:${q.question}`;
      input.value = o.label;
      const text = document.createElement('span');
      setText(text, o.label);
      label.append(input, text);
      if (o.description) label.title = o.description;
      opts.appendChild(label);
    }
    // Claude's own question tool always offers "Other"; so does this.
    const other = document.createElement('input');
    other.type = 'text';
    other.className = 'qother';
    other.placeholder = 'Other…';
    other.dataset.question = q.question;
    opts.appendChild(other);
    wrap.appendChild(opts);
  }

  if (state !== 'pending') {
    wrap.appendChild(settledRow(state));
    return wrap;
  }

  const row = document.createElement('div');
  row.className = 'askrow';
  if (!caps?.canSend) {
    cannotAnswer(row, 'Claude Code');
    wrap.appendChild(row);
    return wrap;
  }

  const submit = document.createElement('button');
  submit.className = 'askbtn primary';
  setText(submit, 'Answer');
  submit.addEventListener('click', () => {
    const collected: Record<string, string> = {};
    for (const q of questions) {
      const picked = Array.from(
        wrap.querySelectorAll<HTMLInputElement>(`input[name="q:${CSS.escape(requestId)}:${CSS.escape(q.question)}"]`),
      )
        .filter((i) => i.checked)
        .map((i) => i.value);
      const free = wrap.querySelector<HTMLInputElement>(`input.qother[data-question="${CSS.escape(q.question)}"]`);
      const freeText = free?.value.trim();
      if (freeText) picked.push(freeText);
      if (picked.length > 0) collected[q.question] = picked.join(', ');
    }
    if (Object.keys(collected).length === 0) return;
    submit.disabled = true;
    post({ type: 'answer', requestId, answers: collected });
    followAfterAnswer();
  });
  row.appendChild(submit);
  wrap.appendChild(row);
  return wrap;
}

function planActions(requestId: string, state: AskState): HTMLElement {
  if (state !== 'pending') return settledRow(state);
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'askrow';

  if (!caps?.canSend) {
    cannotAnswer(row, 'Claude Code');
    wrap.appendChild(row);
    return wrap;
  }

  const approve = document.createElement('button');
  approve.className = 'askbtn primary';
  setText(approve, 'Approve');
  approve.addEventListener('click', () => {
    approve.disabled = true;
    changes.disabled = true;
    post({ type: 'plan', requestId, decision: 'approve' });
    followAfterAnswer();
  });

  const feedback = document.createElement('textarea');
  feedback.className = 'qfeedback';
  feedback.rows = 2;
  feedback.placeholder = 'What should change?';
  feedback.hidden = true;

  const changes = document.createElement('button');
  changes.className = 'askbtn';
  setText(changes, 'Request changes');
  changes.addEventListener('click', () => {
    if (feedback.hidden) {
      feedback.hidden = false;
      feedback.focus();
      setText(changes, 'Send feedback');
      return;
    }
    approve.disabled = true;
    changes.disabled = true;
    post({ type: 'plan', requestId, decision: 'deny', feedback: feedback.value.trim() || undefined });
    followAfterAnswer();
  });

  row.append(approve, changes);
  wrap.append(row, feedback);
  return wrap;
}

/** Colour a unified patch without a syntax highlighter. */
function renderDiff(pre: HTMLElement, patch: string): void {
  pre.innerHTML = '';
  for (const line of patch.split('\n')) {
    const span = document.createElement('span');
    span.className = line.startsWith('+')
      ? 'dadd'
      : line.startsWith('-')
        ? 'ddel'
        : line.startsWith('@@')
          ? 'dhunk'
          : 'dctx';
    setText(span, `${line}\n`);
    pre.appendChild(span);
  }
}

function childContainer(parent: HTMLElement): HTMLElement {
  let child = parent.querySelector(':scope > .subagent-work') as HTMLElement | null;
  if (!child) { child = document.createElement('div'); child.className = 'subagent-work'; parent.appendChild(child); }
  return child;
}

const searchNodes = new Map<string, HTMLElement>();
const searchBlocks = new Map<string, ConvBlock>();
const searchResults = document.getElementById('searchresults')!;
const findInput = document.getElementById('find') as HTMLInputElement;
let archiveRequest = '';

type WorkGroup = { details: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement; startedAt?: number };
let currentWork: WorkGroup | undefined;

function blockTime(block: ConvBlock): number | undefined {
  if (!('ts' in block) || !block.ts) return undefined;
  const value = Date.parse(block.ts);
  return Number.isFinite(value) ? value : undefined;
}

function durationText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function beginWork(block: ConvBlock): WorkGroup {
  const details = document.createElement('details');
  details.className = 'worklog';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Working…';
  const body = document.createElement('div');
  body.className = 'workbody';
  details.append(summary, body);
  blocksEl.appendChild(details);
  return { details, summary, body, startedAt: blockTime(block) ?? Date.now() };
}

function finishWork(block?: ConvBlock): void {
  if (!currentWork) return;
  const end = block ? blockTime(block) : undefined;
  const elapsed = end && currentWork.startedAt ? end - currentWork.startedAt : undefined;
  currentWork.summary.textContent = elapsed && elapsed > 0 ? `Worked for ${durationText(elapsed)}` : 'Work details';
  currentWork.details.open = false;
  currentWork = undefined;
}
function requestArchive(query = '', before?: string, beforeTime?: string): void {
  archiveRequest = String(Date.now());
  notch.textContent = 'Loading…';
  post({ type: 'archive', requestId: archiveRequest, before, beforeTime, query });
}
notch.addEventListener('click', () => {
  const first = [...blocksEl.children].map((el) => (el as HTMLElement).dataset.id).find((id) => id?.startsWith('t:'));
  const firstNode = blocksEl.firstElementChild as HTMLElement | null;
  const live = firstNode?.dataset.id ? blockState.get(firstNode.dataset.id) : undefined;
  requestArchive('', first, !first && live && 'ts' in live ? live.ts : undefined);
});
document.getElementById('findbar')!.addEventListener('submit', (e) => { e.preventDefault(); if (findInput.value.trim()) requestArchive(findInput.value.trim()); });
document.getElementById('clearfind')!.addEventListener('click', () => { archiveRequest = ''; searchResults.hidden = true; searchResults.replaceChildren(); searchNodes.clear(); searchBlocks.clear(); findInput.value = ''; });

// ---- list maintenance ----

function appendBlocks(blocks: ConvBlock[]): void {
  for (const b of blocks) {
    const existing = nodes.get(b.id);
    if (existing) {
      blockState.set(b.id, b);
      fillNode(existing, b);
      continue;
    }
    const node = buildNode(b);
    nodes.set(b.id, node);
    blockState.set(b.id, b);
    const parent = b.parentToolUseId ? [...blockState.values()].find((x) => x.kind === 'tool' && x.toolUseId === b.parentToolUseId) : undefined;
    const parentNode = parent ? nodes.get(parent.id) : undefined;
    if (parentNode) childContainer(parentNode).appendChild(node);
    else if (b.kind === 'thinking' || b.kind === 'tool') {
      currentWork ??= beginWork(b);
      currentWork.body.appendChild(node);
    } else {
      if (b.kind === 'assistant' || b.kind === 'user') finishWork(b);
      blocksEl.appendChild(node);
    }
  }
  while (stick && blocksEl.children.length > MAX_BLOCK_NODES) {
    const first = blocksEl.firstElementChild as HTMLElement | null;
    if (!first) break;
    blocksEl.removeChild(first);
    for (const item of [first, ...Array.from(first.querySelectorAll<HTMLElement>('[data-id]'))]) {
      if (item.dataset.id) { nodes.delete(item.dataset.id); blockState.delete(item.dataset.id); }
    }
    notch.hidden = false;
  }
  // An arriving ask is the one block the bottom of the view is the wrong place
  // to land on: a plan or a multi-part question is usually taller than the
  // pane, so scrolling to the end of the conversation means scrolling past the
  // question to its buttons, and the thing being asked is off-screen above.
  const ask = blocks.find((b) => isAsk(b) && b.state === 'pending');
  const askNode = ask ? nodes.get(ask.id) : undefined;
  if (stick) {
    if (askNode) showAsk(askNode);
    else scrollToBottom();
  } else {
    newCount += blocks.length;
    jump.textContent = `↓ ${newCount} new`;
    jump.hidden = false;
  }
  updateAskNav();
}

/**
 * Apply a patch to one block. `follow` is what keeps a pane that is stuck to
 * the bottom stuck; an expansion the reader asked for passes false, because
 * being thrown to the end of the conversation is the opposite of what clicking
 * "Show the rest" was for.
 */
function patchBlock(id: string, partial: Partial<ConvBlock>, follow = true): void {
  const node = nodes.get(id);
  const prev = blockState.get(id);
  if (!node || !prev) return;
  const next = { ...prev, ...partial } as ConvBlock;
  blockState.set(id, next);
  fillNode(node, next);
  // A block being read in full that has since grown (a reply still streaming)
  // asks again rather than snapping back to its first 6,000 characters.
  if (expanded.has(id) && 'more' in next && next.more) scheduleRefetch(id);
  if (follow && stick) scrollToBottom();
  updateAskNav();
}

function scheduleRefetch(id: string): void {
  if (refetching.has(id)) return;
  refetching.add(id);
  setTimeout(() => {
    refetching.delete(id);
    if (expanded.has(id) && nodes.has(id)) post({ type: 'requestBlockText', id });
  }, REFETCH_MS);
}

function scrollToBottom(): void {
  scroller.scrollTop = scroller.scrollHeight;
  newCount = 0;
  jump.hidden = true;
}

/** Whether the view is at the end of the conversation, which is what makes it follow new blocks. */
function recomputeStick(): void {
  stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
  if (stick) {
    newCount = 0;
    jump.hidden = true;
  }
}

// ---- the ask you are being kept waiting by ----

/** The three blocks that stop the agent until they are answered. */
type AskBlock = Extract<ConvBlock, { kind: 'permission' | 'question' | 'plan' }>;

function isAsk(b: ConvBlock | undefined): b is AskBlock {
  return b !== undefined && (b.kind === 'permission' || b.kind === 'question' || b.kind === 'plan');
}

/** What to call an ask in one line, in the reader's terms rather than the tool's. */
function askLabel(b: AskBlock): string {
  if (b.kind === 'plan') return 'Plan ready for approval';
  if (b.kind === 'question') return b.questions[0]?.header || b.questions[0]?.question || 'Claude has a question';
  return b.summary ?? `${b.toolName} needs permission`;
}

/**
 * Unanswered asks, in conversation order. Read from the DOM rather than from
 * `blockState`, because a long conversation drops its oldest nodes and an ask
 * that is no longer rendered is one this strip cannot point at.
 */
function pendingAsks(): AskBlock[] {
  const out: AskBlock[] = [];
  for (const el of Array.from(blocksEl.children)) {
    const b = blockState.get((el as HTMLElement).dataset.id ?? '');
    if (isAsk(b) && b.state === 'pending') out.push(b);
  }
  return out;
}

/** Is enough of this card's head on screen to read what is being asked? */
function headVisible(node: HTMLElement): boolean {
  const r = node.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  return r.top >= s.top - 2 && r.top <= s.bottom - ASK_HEAD_PX;
}

/** Put the *top* of an ask card at the top of the view — the question, not its buttons. */
function showAsk(node: HTMLElement): void {
  scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - ASK_TOP_GAP_PX;
  // Parking at an ask means leaving the end of the conversation, so following
  // new blocks has to stop — otherwise the next one drags the view off the
  // question again. Being answered turns it back on.
  recomputeStick();
  flash(node);
  updateAskNav();
}

/** A one-second outline, so the eye finds the card the strip just moved to. */
function flash(node: HTMLElement): void {
  node.classList.remove('flash');
  // Reading offsetWidth restarts the animation; without it a second click on
  // the strip does nothing visible.
  void node.offsetWidth;
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1200);
}

/**
 * The strip above the composer: what Claude is waiting on, whenever the card
 * that says it is off screen. Hidden the moment the card's head is visible —
 * it exists to end a hunt, not to be a second copy of the question.
 */
function updateAskNav(): void {
  const asks = pendingAsks();
  const target = asks.find((b) => {
    const n = nodes.get(b.id);
    return n !== undefined && !headVisible(n);
  });
  if (!target) {
    askNav.hidden = true;
    askNav.removeAttribute('data-id');
    return;
  }
  const node = nodes.get(target.id)!;
  const above = node.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
  const others = asks.length - 1;
  askNav.textContent = `${above ? '↑' : '↓'} ${askLabel(target)}${others > 0 ? ` · ${others} more waiting` : ''}`;
  askNav.title = 'Show what Claude is waiting on';
  askNav.dataset.id = target.id;
  askNav.hidden = false;
}

/**
 * An ask was just answered, so the conversation is about to carry on: follow it
 * again. Without this a pane parked on the question stays there while the work
 * it unblocked scrolls past underneath.
 */
function followAfterAnswer(): void {
  stick = true;
  updateAskNav();
}

// ---- header / composer ----

function setStatus(status: SessionStatus, estimated: boolean): void {
  pill.className = `pill st-${status}`;
  pill.textContent = estimated ? `~ ${STATUS_LABEL[status]}` : STATUS_LABEL[status];
  pill.title = estimated ? 'Estimated from the transcript: install the status hooks for exact status.' : '';
}

function setMeta(session: SessionDTO): void {
  activeProvider = session.provider;
  document.getElementById('findbar')!.hidden = activeProvider !== 'claude';
  (notch as HTMLButtonElement).disabled = activeProvider !== 'claude';
  notch.textContent = activeProvider === 'claude' ? 'Load earlier messages' : 'Earlier messages not shown';
  ttl.textContent = displayTitle(session);
  meta.textContent = [session.projectName, session.gitBranch !== 'HEAD' ? session.gitBranch : undefined, session.name]
    .filter(Boolean)
    .join(' · ');
  // Models, effort (requested → applied, "unknown" where not reported), tokens
  // and cost with its basis. Nothing at all for a session with no records (#28).
  usageEl.hidden = !session.usage;
  usageEl.textContent = session.usage ? usageHeaderText(session.usage, (id) => modelLabel(id) ?? id) : '';
  usageEl.title = session.usage ? usageTitle(session.usage) : '';
}

function setCaps(next: ConversationCapabilities): void {
  caps = next;
  releaseBtn.hidden = !next.canRelease;

  // Taking over is the way a read-only conversation becomes a typeable one, so
  // it sits in the composer bar where the question "why can't I type?" is asked.
  adoptBtn.hidden = !(next.canAdopt || next.canResumeHere);
  adoptBtn.disabled = false;
  if (next.canAdopt) {
    adoptBtn.textContent = 'Take over here';
    adoptBtn.title = 'End the process running this session and continue it in this window';
  } else if (next.canResumeHere) {
    adoptBtn.textContent = 'Resume here';
    adoptBtn.title = 'Start this session running in this window now, without sending anything';
  }

  composerWrite.hidden = !next.canSend;
  modeSel.disabled = !!next.adoptOnSend;
  modelSel.disabled = !!next.adoptOnSend;
  effortSel.disabled = !!next.adoptOnSend;
  composerRead.hidden = next.canSend;
  // Empty rather than hidden: the note keeps its flex space, so Resume here
  // stays where the Send button sits instead of jumping to the left edge.
  // Cleared on the way in, so a reason from a read-only state cannot survive
  // into a typeable one — the row is hidden then, but a stale sentence waiting
  // in the DOM for the next hiccup is not worth the byte it saves.
  //
  // The note says what the *button* next to it is for, and never what Send
  // does. Those were the same sentence once — "Send resumes this session here…"
  // printed beside a button reading "Resume here", which reads as two ways to
  // do one thing and invites the fair question of why the button exists. It
  // exists because sending is not the only reason to want the session live:
  // until it is adopted the mode, model and effort pickers are disabled (see
  // just above), so picking a model before typing needs the button. The hint
  // about Send moved to where Send is typed — the placeholder.
  //
  // With no button — a busy session, where taking over would throw its turn
  // away — there is nothing to explain, so the Send hint is the note again.
  composerNote.textContent = next.canResumeHere
    ? 'Ended. Resume it here, or just type — sending resumes it too.'
    : next.canAdopt && next.adoptOnSend
      ? 'Running elsewhere. Take it over here, or just type — sending takes it over too.'
      : (next.sendHint ?? (next.canSend ? '' : (next.readOnlyReason ?? '')));
  composerRead.hidden = next.canSend && !next.adoptOnSend;
  msgEl.placeholder = next.sendHint ?? (activeProvider === 'codex' ? 'Message Codex…' : 'Message Claude…');
  // The box is sized by `autoGrow`, which until now only ran on input — so
  // between the composer appearing and the first keystroke it had whatever
  // height `rows="1"` gave it, which is not the height this layout wants, and
  // it sat clipped against the bottom of the pane. Measured here, once it is
  // visible: a `scrollHeight` read on a hidden element is 0, which would set
  // the height to zero and make it worse.
  if (!composerWrite.hidden) autoGrow();
}

/** The list currently rendered, so options are rebuilt only when it changes. */
let modelsKey = '';

function setModels(models: ModelChoice[] | undefined): void {
  const list = models ?? [];
  const key = list.map((m) => `${m.value}\u0000${m.label}`).join('\u0001');
  if (key === modelsKey) return;
  modelsKey = key;
  modelSel.textContent = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.resolved) opt.dataset.resolved = m.resolved;
    modelSel.appendChild(opt);
  }
  // Nothing to choose between until the CLI has answered; an empty dropdown
  // would just look broken.
  modelSel.hidden = list.length === 0;
}

/**
 * The effort levels belong to the *selected* model, not to the session: Haiku
 * has none and `xhigh` is not everywhere, so the list is rebuilt whenever the
 * model changes and the dropdown disappears entirely for a model that cannot
 * be asked to think harder. Offering a level the session would ignore is worse
 * than offering none.
 *
 * The blank first row is the CLI's own default, which is a real choice and not
 * the same as any named level — it is what you get back by un-picking.
 */
let effortKey = '';

function setEffortLevels(levels: string[] | undefined): void {
  const list = levels ?? [];
  const key = list.join('\u0001');
  if (key === effortKey) return;
  effortKey = key;
  const previous = effortSel.value;
  effortSel.textContent = '';
  if (list.length > 0) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Effort: default';
    effortSel.appendChild(blank);
  }
  for (const level of list) {
    const opt = document.createElement('option');
    opt.value = level;
    opt.textContent = level;
    effortSel.appendChild(opt);
  }
  effortSel.hidden = list.length === 0;
  // Keep the level across a model change when the new model also has it.
  if (previous && list.includes(previous)) effortSel.value = previous;
}

/** What the session reports it is on, which the CLI may have changed itself. */
function selectEffort(effort: string | undefined): void {
  if (effortSel.hidden) return;
  const wanted = effort ?? '';
  if (Array.from(effortSel.options).some((o) => o.value === wanted)) effortSel.value = wanted;
}

/**
 * The CLI reports the wire id it resolved to (`claude-sonnet-4-5-…`) while the
 * list offers aliases (`sonnet`), so match on `resolved` before falling back to
 * showing the raw id — the dropdown must never name a model the session is not
 * actually on.
 */
function selectModel(model: string | undefined): void {
  if (!model || modelSel.options.length === 0) return;
  const opts = Array.from(modelSel.options);
  const match = opts.find((o) => o.value === model) ?? opts.find((o) => o.dataset.resolved === model);
  if (match) {
    modelSel.value = match.value;
    return;
  }
  const extra = document.createElement('option');
  extra.value = model;
  extra.textContent = model;
  modelSel.appendChild(extra);
  modelSel.value = model;
}

/**
 * Whether a turn is running, which is what the primary button does: Send while
 * Claude is idle, Stop while it is working. One button rather than two because
 * the pane is used at ~300px, and because "the button under the box" is where
 * the hand already is when the thing to do is call the model off.
 *
 * Enter keeps sending even while it says Stop — typing the next instruction
 * mid-turn queues it (the "N queued" chip), exactly as it does in a terminal —
 * so the interrupt never eats a message the user meant to send.
 */
let busy = false;

function setBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  sendBtn.textContent = pendingSend ? 'Cancel queued send' : next ? 'Stop' : 'Send';
  sendBtn.title = next ? 'Interrupt what Claude is doing (Enter still queues a message)' : 'Send this message';
  sendBtn.classList.toggle('stop', next);
}

/**
 * Back to "nothing is running here": the state a pane starts in, and the one it
 * is put back into when it is reused for a conversation with no composer of its
 * own. Only `init` does this — a `session` push arrives every couple of seconds
 * while the store ticks and carries no composer, so resetting on those was what
 * flicked the button from Stop back to Send moments after a message was sent.
 */
function clearComposer(): void {
  setBusy(false);
  queuedEl.hidden = true;
}

let slashCommands: string[] = [];
function setComposer(c: ComposerState): void {
  slashCommands = activeProvider === 'claude' ? [...new Set(['compact', 'clear', 'context', ...c.slashCommands])] : [];
  if (c.permissionMode) modeSel.value = c.permissionMode;
  setModels(c.models);
  selectModel(c.model);
  // After `selectModel`, so the levels come from the row that is now showing.
  setEffortLevels(c.models?.find((m) => m.value === modelSel.value)?.effortLevels);
  selectEffort(c.effort);
  setBusy(c.busy);
  sendBtn.disabled = false; // sends queue behind a running turn, so never blocked
  queuedEl.hidden = c.queued === 0;
  queuedEl.textContent = c.queued === 1 ? '1 queued' : `${c.queued} queued`;
}

function setBanner(next: ConversationCapabilities): void {
  if (!next.estimated || activeProvider !== 'claude') {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  banner.replaceChildren();
  const text = document.createElement('span');
  text.textContent =
    'Status is estimated from this Claude transcript, and permission prompts cannot be answered here. ' +
    'Install the status hooks, then restart this Claude session.';
  const install = document.createElement('button');
  install.type = 'button';
  install.textContent = 'Install status hooks';
  install.addEventListener('click', () => post({ type: 'installHooks' }));
  banner.append(text, install);
}

function autoGrow(): void {
  msgEl.style.height = 'auto';
  msgEl.style.height = `${Math.min(msgEl.scrollHeight, MAX_COMPOSER_PX)}px`;
}

// ---- @ mentions ----

/**
 * The `@token` the caret is sitting in, or nothing.
 *
 * Anchored to a word boundary so an email address or a decorator does not open
 * the picker, and stopped at whitespace so the token ends where the path does.
 * Exported shape: where it starts, and what has been typed so far.
 */
function mentionAt(value: string, caret: number): { start: number; query: string } | undefined {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0) return undefined;
  // Only after whitespace or at the very start: `foo@bar` is not a mention.
  if (at > 0 && !/\s/.test(upto[at - 1])) return undefined;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return undefined;
  return { start: at, query };
}

let mentionFiles: string[] = [];
let mentionIndex = 0;
/** The token the current list belongs to, so a stale answer is ignored. */
let mentionQuery: string | undefined;

function mentionsOpen(): boolean {
  return !mentionsEl.hidden;
}

function closeMentions(): void {
  mentionsEl.hidden = true;
  mentionFiles = [];
  mentionQuery = undefined;
}

function renderMentions(): void {
  mentionsEl.textContent = '';
  if (mentionFiles.length === 0) {
    mentionsEl.hidden = true;
    return;
  }
  mentionFiles.forEach((file, i) => {
    const row = document.createElement('div');
    row.className = i === mentionIndex ? 'mrow on' : 'mrow';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === mentionIndex));

    // Basename bold, directory muted: the name is what is being looked for and
    // the path is how you tell two files of that name apart.
    const slash = file.lastIndexOf('/');
    const dir = document.createElement('span');
    dir.className = 'mdir';
    setText(dir, slash < 0 ? '' : file.slice(0, slash + 1));
    const name = document.createElement('span');
    name.className = 'mname';
    setText(name, slash < 0 ? file : file.slice(slash + 1));

    row.append(name, dir);
    row.addEventListener('mousedown', (e) => {
      // mousedown, not click: the textarea must not lose focus first.
      e.preventDefault();
      acceptMention(i);
    });
    mentionsEl.appendChild(row);
  });
  mentionsEl.hidden = false;
}

function acceptMention(i: number): void {
  const file = mentionFiles[i];
  const here = mentionAt(msgEl.value, msgEl.selectionStart ?? 0);
  if (!file || !here) return closeMentions();
  const before = msgEl.value.slice(0, here.start);
  const after = msgEl.value.slice((msgEl.selectionStart ?? 0));
  // A trailing space: a mention is nearly always followed by more sentence.
  msgEl.value = `${before}@${file} ${after}`;
  const caret = before.length + file.length + 2;
  msgEl.setSelectionRange(caret, caret);
  closeMentions();
  autoGrow();
  msgEl.focus();
}

function updateMentions(): void {
  const here = mentionAt(msgEl.value, msgEl.selectionStart ?? 0);
  if (!here) return closeMentions();
  mentionQuery = here.query;
  post({ type: 'fileSuggest', query: here.query });
}

msgEl.addEventListener('input', updateMentions);
// Moving the caret out of a token closes the picker; typing is handled above.
msgEl.addEventListener('click', () => {
  if (mentionsOpen()) updateMentions();
});

// ---- attachments ----

/** Pasted images waiting to go with the next message, newest last. */
let attachments: ImageAttachment[] = [];

function renderAttachments(): void {
  attachmentsEl.hidden = attachments.length === 0;
  attachmentsEl.textContent = '';
  attachments.forEach((img, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach';

    // `img-src` allows `data:`, so the thumbnail is the image itself rather
    // than a paperclip: what was pasted is worth seeing before it is sent.
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mediaType};base64,${img.data}`;
    thumb.alt = `Attached image ${i + 1}`;
    chip.appendChild(thumb);

    const x = document.createElement('button');
    x.className = 'attachx';
    x.textContent = '✕';
    x.title = 'Remove this image';
    x.setAttribute('aria-label', `Remove attached image ${i + 1}`);
    x.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
      msgEl.focus();
    });
    chip.appendChild(x);

    attachmentsEl.appendChild(chip);
  });
}

/**
 * The paperclip. Images could already be pasted or dropped; neither helps when
 * the thing you want is in a folder rather than on the clipboard.
 *
 * The real `<input type="file">` is hidden and clicked through, because a file
 * input cannot be styled into anything that belongs next to the mic — and the
 * value is cleared afterwards so picking the same file twice in a row still
 * fires a `change`.
 */
attachBtn.addEventListener('click', () => attachPick.click());
attachPick.addEventListener('change', () => {
  for (const file of Array.from(attachPick.files ?? [])) addImageFile(file);
  attachPick.value = '';
  msgEl.focus();
});

/** Read one clipboard/dropped file into the shape the wire wants. */
function addImageFile(file: File): void {
  if (!IMAGE_MEDIA_TYPES.includes(file.type as (typeof IMAGE_MEDIA_TYPES)[number])) {
    note(`Agent Wrangler cannot send ${file.type || 'that file'} — images only (PNG, JPEG, GIF, WebP).`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    // A data URL is `data:<type>;base64,<payload>`; the API wants the payload.
    const data = String(reader.result).split(',')[1] ?? '';
    if (decodedBytes(data) > MAX_IMAGE_BYTES) {
      // Refused here rather than by the API, which would reject it as a failed
      // turn long after the paste, when the image is no longer on the clipboard.
      note(`That image is too large to send (limit ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`);
      return;
    }
    attachments.push({ mediaType: file.type, data });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function note(text: string): void {
  appendBlocks([{ kind: 'note', id: `n${Date.now()}`, tone: 'warn', text }]);
}

msgEl.addEventListener('paste', (e: ClipboardEvent) => {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
  if (files.length === 0) return; // ordinary text paste, leave it alone
  e.preventDefault();
  for (const f of files) addImageFile(f);
});

// ---- drag and drop ----

/**
 * Dropping files on the pane is the composer's other way in: an image becomes
 * an attachment, exactly as a paste does, and anything else — a source file, a
 * folder — is written into the box as an `@` mention, which is what dragging a
 * file into the TUI does.
 *
 * The *path* is what makes the second half possible, and a dropped `File` in a
 * webview does not have one, so the paths come from `text/uri-list` — the
 * Finder and VSCode's own explorer both set it. Only a drop with no path at
 * all (an image dragged straight out of another app) falls back to reading the
 * bytes here, which is why that path still only takes images.
 *
 * The whole pane is the target rather than the textarea: at 300px the box is a
 * couple of lines tall, and aiming at it is not the point of the gesture.
 */
function dropTypes(t: DataTransfer | null): boolean {
  if (!t || composerWrite.hidden) return false; // read-only: nothing to drop into
  return t.types.includes('Files') || t.types.includes('text/uri-list') || t.types.includes('resourceurls');
}

/** Paths named by a drop, best source first. Empty when it carries none. */
function droppedPaths(t: DataTransfer): string[] {
  const uris = fileUrisToPaths(t.getData('text/uri-list'));
  if (uris.length > 0) return uris;
  // VSCode's own drags also carry a JSON array of resource URIs, under a name
  // that has been spelled both ways.
  const raw = t.getData('resourceurls') || t.getData('ResourceURLs');
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((u): u is string => typeof u === 'string')
      .map(fileUriToPath)
      .filter((p): p is string => p !== undefined);
  } catch {
    return [];
  }
}

/**
 * `dragleave` fires on every element the pointer crosses on the way through, so
 * the highlight is counted in and out rather than turned off by the first one.
 */
let dragDepth = 0;

function endDrag(): void {
  dragDepth = 0;
  composerInput.classList.remove('dropping');
}

app.addEventListener('dragenter', (e: DragEvent) => {
  if (!dropTypes(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth++;
  composerInput.classList.add('dropping');
});

app.addEventListener('dragover', (e: DragEvent) => {
  if (!dropTypes(e.dataTransfer)) return;
  e.preventDefault(); // without this the drop never arrives
  e.dataTransfer!.dropEffect = 'copy';
});

app.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) endDrag();
});

app.addEventListener('dragend', endDrag);

app.addEventListener('drop', (e: DragEvent) => {
  const t = e.dataTransfer;
  if (!dropTypes(t)) return;
  e.preventDefault();
  endDrag();

  const paths = droppedPaths(t!);
  if (paths.length > 0) {
    // The host says what each one turns into; it comes back as `dropped`.
    post({ type: 'dropPaths', paths });
    msgEl.focus();
    return;
  }

  // No path came with the drop, so there is nothing to mention and the bytes
  // are all we have — which only helps for an image.
  const files = Array.from(t!.files);
  const images = files.filter((f) => IMAGE_MEDIA_TYPES.includes(f.type as (typeof IMAGE_MEDIA_TYPES)[number]));
  for (const f of images) addImageFile(f);
  const rest = files.length - images.length;
  if (rest > 0) {
    note(
      `${rest === 1 ? 'That file' : `${rest} of those files`} arrived without a path, so only an image could be taken from it.`,
    );
  }
  msgEl.focus();
});

/** Write dropped paths into the box as a run of mentions, at the caret. */
function insertMentions(mentions: string[]): void {
  if (mentions.length === 0) return;
  closeMentions();
  const text = mentions.join(' ');
  const start = msgEl.selectionStart ?? msgEl.value.length;
  const end = msgEl.selectionEnd ?? start;
  const before = msgEl.value.slice(0, start);
  const after = msgEl.value.slice(end);
  // A mention has to stay a word of its own, and a drop usually lands in the
  // middle of a half-typed sentence.
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const tail = after.startsWith(' ') || after === '' ? '' : ' ';
  msgEl.value = `${before}${lead}${text}${tail}${after}`;
  const caret = before.length + lead.length + text.length;
  msgEl.setSelectionRange(caret, caret);
  autoGrow();
  msgEl.focus();
}

let activeSession = '';
let activeProvider = 'claude';
const drafts = new Map<string, { text: string; images: ImageAttachment[] }>();
let pendingSend: { id: string; text: string; session: string } | undefined;
function sendMessage(): void {
  if (pendingSend) { post({ type: 'cancelSend' }); return; }
  const text = msgEl.value.trim();
  // An image on its own is a real message; only both being empty is a no-op.
  if (!text && attachments.length === 0) return;
  const requestId = String(Date.now());
  pendingSend = { id: requestId, text: msgEl.value, session: activeSession };
  post({ type: 'send', requestId, sessionKey: activeSession, text, images: attachments.length > 0 ? attachments : undefined });
  sendBtn.textContent = 'Cancel queued send';
  msgEl.readOnly = true;
  return;
}

// ---- dictation ----

type MicState = 'idle' | 'recording' | 'transcribing';
let micState: MicState = 'idle';
// Set when Send is clicked mid-dictation: the recording stops like a normal
// mic-button stop, but once the transcript lands it goes straight out instead
// of just filling the box.
let sendAfterDictation = false;

const MIC_LABEL: Record<MicState, string> = {
  idle: 'Dictate a message',
  recording: 'Stop recording and put the text in the box (does not send)',
  transcribing: 'Finishing transcription…',
};

/**
 * What the strip above the text shows. The preview lives there and never in
 * the textarea: it is provisional, and putting it in the box would mean either
 * rewriting the user's draft on every revision or leaving stale words behind
 * when a revision shortened. The box only ever receives the final text, once.
 */
const dict = {
  /** Session the recording was started in; the final text goes to its draft. */
  session: '',
  livePreview: true,
  text: '',
  recordedMs: 0,
  coveredMs: 0,
  previewError: undefined as string | undefined,
  /** A result or problem to show once the recording is over. */
  flash: undefined as { tone: 'error' | 'info'; text: string } | undefined,
  flashTimer: undefined as number | undefined,
};

function setMicState(state: MicState, message?: string): void {
  micState = state;
  micBtn.classList.toggle('recording', state === 'recording');
  micBtn.classList.toggle('busy', state === 'transcribing');
  // Only `transcribing` disables it: while recording the button is the way to
  // stop, and disabling it there would trap the microphone open.
  micBtn.disabled = state === 'transcribing';
  micBtn.title = message ?? MIC_LABEL[state];
  micBtn.setAttribute('aria-label', message ?? MIC_LABEL[state]);
  renderDictation();
}

function flashDictation(tone: 'error' | 'info', text: string): void {
  if (dict.flashTimer !== undefined) window.clearTimeout(dict.flashTimer);
  dict.flash = { tone, text };
  // Errors stay long enough to read a sentence about System Settings; a
  // "nothing heard" is a glance.
  dict.flashTimer = window.setTimeout(clearDictationFlash, tone === 'error' ? 12000 : 4000);
  renderDictation();
}

function clearDictationFlash(): void {
  if (dict.flashTimer !== undefined) window.clearTimeout(dict.flashTimer);
  dict.flashTimer = undefined;
  dict.flash = undefined;
  renderDictation();
}

dictClose.addEventListener('click', clearDictationFlash);

function renderDictation(): void {
  dictEl.classList.remove('live', 'busy', 'warn', 'error', 'info');
  if (micState === 'idle') {
    if (!dict.flash) {
      dictEl.hidden = true;
      return;
    }
    dictEl.hidden = false;
    dictEl.classList.add(dict.flash.tone);
    dictLabel.textContent = dict.flash.text;
    dictDetail.hidden = true;
    dictText.hidden = true;
    dictClose.hidden = false;
    return;
  }
  const view = describeDictation({
    state: micState,
    livePreview: dict.livePreview,
    recordedMs: dict.recordedMs,
    coveredMs: dict.coveredMs,
    previewError: dict.previewError,
    elsewhere: dict.session !== '' && dict.session !== activeSession,
  });
  dictEl.hidden = false;
  dictEl.classList.add(view.tone);
  dictLabel.textContent = view.label;
  dictDetail.hidden = !view.detail;
  dictDetail.textContent = view.detail ?? '';
  dictClose.hidden = true;
  dictText.hidden = !dict.livePreview;
  dictText.classList.toggle('empty', dict.text === '');
  dictText.textContent =
    dict.text || (micState === 'recording' ? 'Speak — words appear here as they are recognised.' : '');
  // Newest words are the ones being checked, so keep them in view when a long
  // dictation outgrows the strip's few lines.
  dictText.scrollTop = dictText.scrollHeight;
}

function resetDictationPreview(): void {
  dict.text = '';
  dict.recordedMs = 0;
  dict.coveredMs = 0;
  dict.previewError = undefined;
}

/**
 * Put the final text in the composer of the conversation it was dictated in,
 * at the caret, without removing anything already typed. If the pane has moved
 * to another conversation meanwhile, it goes into that conversation's saved
 * draft instead, so it is waiting there on the way back.
 */
function deliverDictated(text: string): void {
  const target = dict.session;
  if (target && target !== activeSession) {
    const draft = drafts.get(target) ?? { text: '', images: [] };
    drafts.set(target, { ...draft, text: spliceDictation(draft.text, draft.text.length, text).value });
    note('Dictation finished after you switched conversations; the text is in the draft of the one you left.');
    return;
  }
  // The end of a selection, never the selection itself: see `spliceDictation`.
  const caret = msgEl.selectionEnd ?? msgEl.value.length;
  const next = spliceDictation(msgEl.value, caret, text);
  msgEl.value = next.value;
  msgEl.setSelectionRange(next.caret, next.caret);
  autoGrow();
  msgEl.focus();
}

function startDictation(): void {
  clearDictationFlash();
  resetDictationPreview();
  dict.session = activeSession;
  dict.livePreview = true;
  // Optimistic: the host confirms with a `dictation` message, and turns it
  // back if a tool is missing. Waiting for that first would make the button
  // feel dead for as long as it takes to find ffmpeg.
  setMicState('recording');
  post({ type: 'dictate', action: 'start' });
}

/** Stop and transcribe. Only ever fills the box — sending stays a separate act. */
function stopDictation(): void {
  if (micState !== 'recording') return;
  setMicState('transcribing');
  post({ type: 'dictate', action: 'stop' });
}

function onDictationMessage(m: Extract<HostToConversation, { type: 'dictation' }>): void {
  // A quick second click has already moved this pane on to `transcribing`; the
  // host's late "recording" confirmation of the first click must not undo it.
  if (m.state === 'recording' && micState === 'transcribing') return;
  if (m.state === 'recording') dict.livePreview = m.livePreview !== false;
  if (m.state === 'idle') {
    if (m.text) deliverDictated(m.text);
    if (m.message) flashDictation('error', m.message);
    else if (m.notice) flashDictation('info', m.notice);
    else if (m.text === '') flashDictation('info', 'Nothing was heard, so nothing was added.');
    resetDictationPreview();
    dict.session = '';
  }
  setMicState(m.state, m.state === 'idle' ? undefined : m.message);
  // Do this after setMicState so sendMessage sees mic back at idle, not still
  // mid-transcription.
  if (m.state === 'idle' && sendAfterDictation) {
    sendAfterDictation = false;
    sendMessage();
  }
}

function onDictationPreview(m: Extract<HostToConversation, { type: 'dictationPreview' }>): void {
  if (micState !== 'recording') return; // a preview straggling in behind a stop
  dict.text = m.text;
  dict.recordedMs = m.recordedMs;
  dict.coveredMs = m.coveredMs;
  dict.previewError = m.previewError;
  renderDictation();
}

// Escape abandons a recording. Without it the only way out of a mistaken click
// is to stop and then delete whatever the room was transcribed as.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && micState === 'recording') {
    sendAfterDictation = false;
    resetDictationPreview();
    dict.session = '';
    setMicState('idle');
    post({ type: 'dictate', action: 'cancel' });
  }
});

micBtn.addEventListener('click', () => {
  if (micState === 'transcribing') return;
  if (micState === 'recording') stopDictation();
  else startDictation();
});

// ---- events ----

scroller.addEventListener('scroll', () => {
  recomputeStick();
  updateAskNav();
});

window.addEventListener('resize', updateAskNav);

jump.addEventListener('click', () => {
  stick = true;
  scrollToBottom();
  updateAskNav();
});

askNav.addEventListener('click', () => {
  const id = askNav.dataset.id;
  const node = id ? nodes.get(id) : undefined;
  if (node) showAsk(node);
});

pinBtn.addEventListener('click', () => post({ type: 'openInTab' }));
releaseBtn.addEventListener('click', () => post({ type: 'release' }));
adoptBtn.addEventListener('click', () => {
  // The host confirms before doing anything; disabling here only stops a
  // second click landing while that modal is up.
  adoptBtn.disabled = true;
  post({ type: caps?.canAdopt ? 'adopt' : 'resumeHere' });
});
sendBtn.addEventListener('click', () => {
  if (pendingSend) post({ type: 'cancelSend' });
  else if (busy) post({ type: 'interrupt' });
  else if (micState === 'recording') {
    // Stop like the mic button would, but send the transcript once it lands
    // instead of just dropping it in the box.
    sendAfterDictation = true;
    stopDictation();
  } else if (micState === 'transcribing') {
    // Already stopping from a mic-button click; ride that transcript out to a send.
    sendAfterDictation = true;
  } else sendMessage();
});
modeSel.addEventListener('change', () => post({ type: 'setPermissionMode', mode: modeSel.value as PermissionModeName }));
modelSel.addEventListener('change', () => post({ type: 'setModel', model: modelSel.value }));
effortSel.addEventListener('change', () => post({ type: 'setEffort', effort: effortSel.value }));

const slashList = document.getElementById('slashcommands')!;
msgEl.addEventListener('input', () => {
  autoGrow();
  slashList.replaceChildren();
  const value = msgEl.value;
  slashList.hidden = !/^\/[\w-]*$/.test(value);
  if (slashList.hidden) return;
  for (const command of slashCommands.filter((c) => c.startsWith(value.slice(1))).slice(0, 12)) {
    const button = document.createElement('button');
    button.textContent = '/' + command;
    button.addEventListener('click', () => { msgEl.value = '/' + command + ' '; slashList.hidden = true; msgEl.focus(); });
    slashList.appendChild(button);
  }
});
msgEl.addEventListener('keydown', (e) => {
  if (!slashList.hidden && (e.key === 'Tab' || e.key === 'ArrowDown')) {
    e.preventDefault(); (slashList.querySelector('button') as HTMLButtonElement | null)?.focus(); return;
  }
  if (e.key === 'Escape') slashList.hidden = true;
  // The mention picker owns these keys while it is open, so Enter completes a
  // path instead of sending a half-typed message.
  if (mentionsOpen() && !e.isComposing) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      mentionIndex = (mentionIndex + step + mentionFiles.length) % mentionFiles.length;
      renderMentions();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acceptMention(mentionIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentions();
      return;
    }
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  sendMessage();
});

// Links inside rendered markdown open in the browser, never inside the pane.
blocksEl.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href)) post({ type: 'openExternal', url: href });
  else if (href.startsWith('/')) post({ type: 'openFile', path: href });
});

vscodeApi.onMessage((body) => {
  const m = body as HostToConversation;
  switch (m.type) {
    case 'archive': {
      if (m.requestId !== archiveRequest) break;
      notch.textContent = 'Load earlier messages';
      if (m.error) { note(m.error); break; }
      if (m.query) {
        searchResults.replaceChildren();
        searchResults.hidden = false;
        const label = document.createElement('p');
        label.textContent = `${m.blocks.length} matching blocks${m.more ? ' (most recent 100)' : ''}`;
        searchResults.appendChild(label);
        searchNodes.clear(); searchBlocks.clear();
        for (const b of m.blocks) { const node = buildNode(b); searchNodes.set(b.id, node); searchBlocks.set(b.id, b); searchResults.appendChild(node); }
        scroller.scrollTop = 0;
      } else {
        const height = scroller.scrollHeight;
        for (const b of [...m.blocks].reverse()) {
          if (nodes.has(b.id)) continue;
          const node = buildNode(b); nodes.set(b.id, node); blockState.set(b.id, b); blocksEl.prepend(node);
        }
        notch.hidden = !m.more;
        scroller.scrollTop += scroller.scrollHeight - height;
        stick = false;
      }
      break;
    }
    case 'subagent': {
      const parent = nodes.get(m.id);
      if (!parent) break;
      if (m.error) { note(m.error); break; }
      const container = childContainer(parent);
      for (const b of [...m.blocks].reverse()) {
        if (nodes.has(b.id)) continue;
        const node = buildNode(b); nodes.set(b.id, node); blockState.set(b.id, b); container.prepend(node);
      }
      container.querySelector('.earlier-subagent')?.remove();
      if (m.more) {
        const btn = document.createElement('button'); btn.className = 'earlier-subagent'; btn.textContent = 'Earlier subagent work';
        const block = blockState.get(m.id);
        btn.addEventListener('click', () => { if (block?.kind === 'tool') post({ type: 'subagent', id: m.id, toolUseId: block.toolUseId, before: m.blocks[0]?.id }); });
        container.prepend(btn);
      }
      break;
    }
    case 'sendResult':
      if (pendingSend?.id !== m.requestId) break;
      const sentSession = pendingSend.session;
      pendingSend = undefined;
      msgEl.readOnly = false;
      if (sentSession !== activeSession) { if (!m.error) drafts.delete(sentSession); break; }
      sendBtn.textContent = busy ? 'Stop' : 'Send';
      if (m.error) note(m.error);
      else {
        msgEl.value = ''; attachments = []; renderAttachments(); autoGrow();
        if (m.adopted) {
          note('Session taken over here. Release hands it back to a terminal.');
          const undo = document.createElement('button'); undo.className = 'note-action'; undo.textContent = 'Undo takeover';
          undo.addEventListener('click', () => post({ type: 'release' }));
          blocksEl.lastElementChild?.appendChild(undo);
        }
      }
      break;
    case 'init':
      if (activeSession !== m.session.key) {
        if (activeSession) drafts.set(activeSession, { text: msgEl.value, images: [...attachments] });
        if (pendingSend) post({ type: 'cancelSend' });
        activeSession = m.session.key;
        const draft = drafts.get(activeSession);
        msgEl.value = draft?.text ?? ''; attachments = draft?.images ?? []; msgEl.readOnly = false;
        renderAttachments(); autoGrow();
        // Moving to another conversation ends a recording rather than letting
        // it carry on into a composer it was not started in. The text is
        // finished and filed in the draft of the conversation it belongs to.
        stopDictation();
        renderDictation();
      }
      archiveRequest = ''; searchResults.hidden = true; searchResults.replaceChildren(); searchNodes.clear(); searchBlocks.clear();
      nodes.clear();
      blockState.clear();
      expanded.clear();
      blocksEl.innerHTML = '';
      currentWork = undefined;
      notch.hidden = !m.truncated;
      setMeta(m.session);
      setStatus(m.session.status, m.caps.estimated);
      setCaps(m.caps);
      if (m.composer) setComposer(m.composer);
      else clearComposer();
      setBanner(m.caps);
      stick = true;
      appendBlocks(m.blocks);
      // Opening a pane on a session that is already waiting lands on what it is
      // waiting for. `appendBlocks` has done that when there was an ask, so the
      // fallback to the end of the conversation is only for when there was not.
      if (pendingAsks().length === 0) scrollToBottom();
      updateAskNav();
      // So a window reload brings this pane back on the same conversation.
      vscodeApi.setState({ key: m.session.key });
      break;
    case 'append':
      appendBlocks(m.blocks);
      break;
    case 'patch':
      patchBlock(m.id, m.block);
      break;
    case 'session':
      // The same conversation can change key underneath the pane: a runner's
      // session id starts out `pending` and Claude Code issues a fresh one on
      // resume and after a compaction. Only a *switch* re-inits, so a `session`
      // update is always this same conversation and the draft rides along —
      // without this the composer kept sending the old key and the host
      // answered "Conversation changed; your draft was not sent."
      if (activeSession !== m.session.key) {
        const draft = drafts.get(activeSession);
        if (draft) { drafts.delete(activeSession); drafts.set(m.session.key, draft); }
        if (dict.session === activeSession) dict.session = m.session.key;
        if (pendingSend) pendingSend = { ...pendingSend, session: m.session.key };
        activeSession = m.session.key;
        vscodeApi.setState({ key: activeSession });
      }
      setMeta(m.session);
      setStatus(m.session.status, m.caps.estimated);
      setCaps(m.caps);
      setBanner(m.caps);
      break;
    case 'composer':
      setComposer(m.composer);
      break;
    case 'blockText': {
      const prev = searchBlocks.get(m.id) ?? blockState.get(m.id);
      const node = searchNodes.get(m.id) ?? nodes.get(m.id);
      if (!prev || !node) break;
      if (m.text === undefined) {
        // The host no longer holds it (evicted, or a reload since). Say so on
        // the button: silently leaving the short text there would read as the
        // whole thing.
        expanded.delete(m.id);
        const btn = node.querySelector('.showmore') as HTMLButtonElement | null;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'The rest is no longer held — reopen the conversation to read it in full';
        }
        // A copy was waiting on this. Copying the prefix anyway and saying so is
        // better than copying nothing, but it must say so — a partial reply that
        // claims to be whole is the one outcome worth avoiding.
        if (copyPending.delete(m.id)) {
          const copy = node.querySelector('.blockcopy') as HTMLButtonElement | null;
          const prefix = 'text' in prev ? (prev.text ?? '') : '';
          if (copy) writeCopy(copy, prefix, 'Copied only the part still held');
        }
        break;
      }
      const wantsCopy = copyPending.delete(m.id);
      // Expanding a block above the view would push everything below it down,
      // so the block is held still instead: whatever the reader was looking at
      // stays where it was.
      const before = node.getBoundingClientRect().top;
      if (searchNodes.has(m.id)) {
        const next = (prev.kind === 'tool' ? { ...prev, result: { ...prev.result, text: m.text, truncated: false } } : prev.kind === 'plan' ? { ...prev, plan: m.text, more: undefined } : { ...prev, text: m.text, more: undefined }) as ConvBlock;
        searchBlocks.set(m.id, next); fillNode(node, next);
        if (wantsCopy) finishPendingCopy(node, m.text);
        break;
      }
      patchBlock(m.id, (prev.kind === 'tool' ? { result: { ...prev.result, text: m.text, truncated: false } } : prev.kind === 'plan' ? { plan: m.text, more: undefined } : { text: m.text, more: undefined }) as Partial<ConvBlock>, false);
      scroller.scrollTop += node.getBoundingClientRect().top - before;
      // After the patch, not before: `fillNode` rebuilds the block, so the
      // button the click came from is already detached and a flash on it would
      // go nowhere.
      if (wantsCopy) finishPendingCopy(node, m.text);
      break;
    }
    case 'fileSuggestions':
      // Ignore an answer to a keystroke the user has already typed past.
      if (m.query !== mentionQuery) break;
      mentionFiles = m.files;
      mentionIndex = 0;
      renderMentions();
      break;
    case 'dropped':
      insertMentions(m.mentions);
      if (m.images.length > 0) {
        attachments.push(...m.images);
        renderAttachments();
      }
      for (const text of m.notes) note(text);
      break;
    case 'dictation':
      onDictationMessage(m);
      break;
    case 'dictationPreview':
      onDictationPreview(m);
      break;
    case 'error':
      appendBlocks([{ kind: 'note', id: `e${Date.now()}`, tone: 'error', text: m.text }]);
      break;
  }
});

post({ type: 'ready' });
