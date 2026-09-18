import './conversation.css';
import { createWebviewBridge } from '../../shared/webviewBridge';
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
import { renderMarkdown as mdToHtml } from '../../shared/markdown';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import { displayTitle, STATUS_LABEL, type SessionDTO, type SessionStatus } from '../../shared/model';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};
const vscodeApi = createWebviewBridge<unknown>(acquireVsCodeApi);
const post = (msg: ConversationToHost) => vscodeApi.postMessage(msg);

/** Rendered blocks kept in the DOM. Older ones are dropped with a notch. */
const MAX_BLOCK_NODES = 400;
/** Treat the view as "at the bottom" within this many pixels. */
const STICK_PX = 56;
/** Composer grows with the message up to this, then scrolls. */
const MAX_COMPOSER_PX = 180;

/**
 * The modes worth offering. `bypassPermissions` is deliberately absent: it
 * needs an extra opt-in flag and turns every guard off at once, which is not
 * something a dropdown should do by accident.
 */
const MODES: { value: PermissionModeName; label: string }[] = [
  { value: 'default', label: 'Ask permission' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'plan', label: 'Plan mode' },
];

const app = document.getElementById('app')!;
app.innerHTML = `
<div id="hdr">
  <span id="pill" class="pill"></span>
  <span id="ttl"></span>
  <span id="meta"></span>
  <span id="spacer"></span>
  <button id="release" class="hdrbtn" hidden title="Stop running this session here and resume it in a terminal">Release</button>
  <button id="pin" class="hdrbtn" title="Open this conversation in a tab of its own, which row clicks never swap away">Own tab</button>
</div>
<div id="banner" hidden></div>
<div id="scroll"><div id="notch" hidden>earlier messages not shown</div><div id="blocks"></div></div>
<button id="jump" hidden></button>
<div id="composer">
  <div id="composerRead">
    <span id="composerNote"></span>
    <button id="adopt" class="askbtn primary" hidden></button>
    <button id="goTo" class="hdrbtn" hidden></button>
  </div>
  <div id="composerWrite" hidden>
    <div id="composerBar">
      <select id="mode" title="Permission mode"></select>
      <select id="model" title="Model" hidden></select>
      <span id="queued" hidden></span>
      <span class="grow"></span>
    </div>
    <div id="mentions" class="mentions" role="listbox" hidden></div>
    <div id="attachments" hidden></div>
    <div id="composerInput">
      <textarea id="msg" rows="1" placeholder="Message Claude…  (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="mic" class="micbtn" title="Dictate a message" aria-label="Dictate a message"></button>
      <button id="send" class="askbtn primary" title="Send this message">Send</button>
    </div>
  </div>
</div>
`;

const pill = document.getElementById('pill')!;
const ttl = document.getElementById('ttl')!;
const meta = document.getElementById('meta')!;
const banner = document.getElementById('banner')!;
const scroller = document.getElementById('scroll')!;
const notch = document.getElementById('notch')!;
const blocksEl = document.getElementById('blocks')!;
const jump = document.getElementById('jump')!;
const composerRead = document.getElementById('composerRead')!;
const composerWrite = document.getElementById('composerWrite')!;
const composerNote = document.getElementById('composerNote')!;
const goToBtn = document.getElementById('goTo') as HTMLButtonElement;
const adoptBtn = document.getElementById('adopt') as HTMLButtonElement;
const pinBtn = document.getElementById('pin') as HTMLButtonElement;
const releaseBtn = document.getElementById('release') as HTMLButtonElement;
const modeSel = document.getElementById('mode') as HTMLSelectElement;
const modelSel = document.getElementById('model') as HTMLSelectElement;
const queuedEl = document.getElementById('queued')!;
const msgEl = document.getElementById('msg') as HTMLTextAreaElement;
const micBtn = document.getElementById('mic') as HTMLButtonElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const attachmentsEl = document.getElementById('attachments')!;
const mentionsEl = document.getElementById('mentions')!;
const composerInput = document.getElementById('composerInput')!;

/** Block id → its node, so a patch updates in place instead of re-rendering. */
const nodes = new Map<string, HTMLElement>();
/** Latest state of each block, since a patch is partial. */
const blockState = new Map<string, ConvBlock>();

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
      break;
    }
    case 'thinking': {
      el.className = 'blk thinking';
      el.innerHTML = '';
      const d = document.createElement('details');
      const s = document.createElement('summary');
      setText(s, b.streaming ? 'Thinking…' : 'Thinking');
      const body = document.createElement('div');
      body.className = 'body';
      renderMarkdown(body, b.text);
      d.append(s, body);
      el.appendChild(d);
      break;
    }
    case 'tool': {
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
        if (b.result.diff) {
          const { file: filePath, patch } = b.result.diff;
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
        }
      }
      el.appendChild(d);
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
    blocksEl.appendChild(node);
  }
  while (blocksEl.children.length > MAX_BLOCK_NODES) {
    const first = blocksEl.firstElementChild as HTMLElement | null;
    if (!first) break;
    blocksEl.removeChild(first);
    if (first.dataset.id) {
      nodes.delete(first.dataset.id);
      blockState.delete(first.dataset.id);
    }
    notch.hidden = false;
  }
  if (stick) scrollToBottom();
  else {
    newCount += blocks.length;
    jump.textContent = `↓ ${newCount} new`;
    jump.hidden = false;
  }
}

function patchBlock(id: string, partial: Partial<ConvBlock>): void {
  const node = nodes.get(id);
  const prev = blockState.get(id);
  if (!node || !prev) return;
  const next = { ...prev, ...partial } as ConvBlock;
  blockState.set(id, next);
  fillNode(node, next);
  if (stick) scrollToBottom();
}

function scrollToBottom(): void {
  scroller.scrollTop = scroller.scrollHeight;
  newCount = 0;
  jump.hidden = true;
}

// ---- header / composer ----

function setStatus(status: SessionStatus, estimated: boolean): void {
  pill.className = `pill st-${status}`;
  pill.textContent = estimated ? `~ ${STATUS_LABEL[status]}` : STATUS_LABEL[status];
  pill.title = estimated ? 'Estimated from the transcript: install the status hooks for exact status.' : '';
}

function setMeta(session: SessionDTO): void {
  ttl.textContent = displayTitle(session);
  meta.textContent = [session.projectName, session.gitBranch !== 'HEAD' ? session.gitBranch : undefined, session.name]
    .filter(Boolean)
    .join(' · ');
}

function setCaps(next: ConversationCapabilities): void {
  caps = next;
  goToBtn.hidden = !next.goTo;
  if (next.goTo) goToBtn.textContent = next.goTo.label;
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
    adoptBtn.title = 'Continue this ended session in this window';
  }

  composerWrite.hidden = !next.canSend;
  composerRead.hidden = next.canSend;
  // Empty rather than hidden: the note keeps its flex space, so Resume here
  // stays where the Send button sits instead of jumping to the left edge.
  // Cleared on the way in, so a reason from a read-only state cannot survive
  // into a typeable one — the row is hidden then, but a stale sentence waiting
  // in the DOM for the next hiccup is not worth the byte it saves.
  composerNote.textContent = next.canSend ? '' : (next.readOnlyReason ?? '');
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
  sendBtn.textContent = next ? 'Stop' : 'Send';
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

function setComposer(c: ComposerState): void {
  if (c.permissionMode) modeSel.value = c.permissionMode;
  setModels(c.models);
  selectModel(c.model);
  setBusy(c.busy);
  sendBtn.disabled = false; // sends queue behind a running turn, so never blocked
  queuedEl.hidden = c.queued === 0;
  queuedEl.textContent = c.queued === 1 ? '1 queued' : `${c.queued} queued`;
}

function setBanner(next: ConversationCapabilities): void {
  if (!next.estimated) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent =
    'Status here is estimated from the transcript, and a permission prompt cannot be answered. ' +
    'Install the Agent Wrangler status hooks, then restart this session.';
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

function sendMessage(): void {
  const text = msgEl.value.trim();
  // An image on its own is a real message; only both being empty is a no-op.
  if (!text && attachments.length === 0) return;
  post({ type: 'send', text, images: attachments.length > 0 ? attachments : undefined });
  // The host will say so too, a moment later; doing it here means the button
  // answers the click that sent the message rather than the round trip.
  setBusy(true);
  msgEl.value = '';
  attachments = [];
  renderAttachments();
  autoGrow();
  stick = true;
  scrollToBottom();
}

// ---- dictation ----

type MicState = 'idle' | 'recording' | 'transcribing';
let micState: MicState = 'idle';

const MIC_LABEL: Record<MicState, string> = {
  idle: 'Dictate a message',
  recording: 'Stop recording and insert the text',
  transcribing: 'Transcribing…',
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
}

/**
 * Drop dictated text in at the cursor rather than replacing what is there: the
 * usual reason to dictate is to finish a sentence that was started by hand.
 */
function insertDictated(text: string): void {
  if (!text) return;
  const start = msgEl.selectionStart ?? msgEl.value.length;
  const end = msgEl.selectionEnd ?? start;
  const before = msgEl.value.slice(0, start);
  const after = msgEl.value.slice(end);
  // A space only where one is actually missing, so dictating twice does not
  // build up a gap and dictating into an empty box does not start with one.
  const pad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  msgEl.value = `${before}${pad}${text}${after}`;
  const caret = before.length + pad.length + text.length;
  msgEl.setSelectionRange(caret, caret);
  autoGrow();
  msgEl.focus();
}

// Escape abandons a recording. Without it the only way out of a mistaken click
// is to stop and then delete whatever the room was transcribed as.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && micState === 'recording') {
    setMicState('idle');
    post({ type: 'dictate', action: 'cancel' });
  }
});

micBtn.addEventListener('click', () => {
  if (micState === 'transcribing') return;
  if (micState === 'recording') {
    setMicState('transcribing');
    post({ type: 'dictate', action: 'stop' });
  } else {
    // Optimistic: the host confirms with a `dictation` message, and turns it
    // back if a tool is missing. Waiting for that first would make the button
    // feel dead for as long as it takes to find ffmpeg.
    setMicState('recording');
    post({ type: 'dictate', action: 'start' });
  }
});

// ---- events ----

scroller.addEventListener('scroll', () => {
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
  if (nearBottom) {
    stick = true;
    newCount = 0;
    jump.hidden = true;
  } else {
    stick = false;
  }
});

jump.addEventListener('click', () => {
  stick = true;
  scrollToBottom();
});

goToBtn.addEventListener('click', () => post({ type: 'goTo' }));
pinBtn.addEventListener('click', () => post({ type: 'openInTab' }));
releaseBtn.addEventListener('click', () => post({ type: 'release' }));
adoptBtn.addEventListener('click', () => {
  // The host confirms before doing anything; disabling here only stops a
  // second click landing while that modal is up.
  adoptBtn.disabled = true;
  post({ type: caps?.canAdopt ? 'adopt' : 'resumeHere' });
});
sendBtn.addEventListener('click', () => {
  if (busy) post({ type: 'interrupt' });
  else sendMessage();
});
modeSel.addEventListener('change', () => post({ type: 'setPermissionMode', mode: modeSel.value as PermissionModeName }));
modelSel.addEventListener('change', () => post({ type: 'setModel', model: modelSel.value }));

msgEl.addEventListener('input', autoGrow);
msgEl.addEventListener('keydown', (e) => {
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

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as HostToConversation;
  switch (m.type) {
    case 'init':
      nodes.clear();
      blockState.clear();
      blocksEl.innerHTML = '';
      notch.hidden = !m.truncated;
      setMeta(m.session);
      setStatus(m.session.status, m.caps.estimated);
      setCaps(m.caps);
      if (m.composer) setComposer(m.composer);
      else clearComposer();
      setBanner(m.caps);
      stick = true;
      appendBlocks(m.blocks);
      scrollToBottom();
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
      setMeta(m.session);
      setStatus(m.session.status, m.caps.estimated);
      setCaps(m.caps);
      setBanner(m.caps);
      break;
    case 'composer':
      setComposer(m.composer);
      break;
    case 'toolResult': {
      const node = nodes.get(m.id);
      const pre = node?.querySelector('.tresult');
      if (pre) setText(pre as HTMLElement, m.text);
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
      setMicState(m.state, m.message);
      if (m.text) insertDictated(m.text);
      break;
    case 'error':
      appendBlocks([{ kind: 'note', id: `e${Date.now()}`, tone: 'error', text: m.text }]);
      break;
  }
});

post({ type: 'ready' });
