import './conversation.css';
import type {
  AskState,
  ComposerState,
  ConvBlock,
  ConversationCapabilities,
} from '../../shared/conversation';
import { renderMarkdown as mdToHtml } from '../../shared/markdown';
import type { ConversationToHost, HostToConversation } from '../../shared/messages';
import { STATUS_LABEL, type SessionDTO, type SessionStatus } from '../../shared/model';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};
const vscodeApi = acquireVsCodeApi();
const post = (msg: ConversationToHost) => vscodeApi.postMessage(msg);

/** Rendered blocks kept in the DOM. Older ones are dropped with a notch. */
const MAX_BLOCK_NODES = 400;
/** Treat the view as "at the bottom" within this many pixels. */
const STICK_PX = 56;

const app = document.getElementById('app')!;
app.innerHTML = `
<div id="hdr">
  <span id="pill" class="pill"></span>
  <span id="ttl"></span>
  <span id="meta"></span>
  <span id="spacer"></span>
  <button id="pin" class="hdrbtn" title="Open this conversation in its own tab">Pin</button>
</div>
<div id="banner" hidden></div>
<div id="scroll"><div id="notch" hidden>earlier messages not shown</div><div id="blocks"></div></div>
<button id="jump" hidden></button>
<div id="composer">
  <span id="composerNote"></span>
  <button id="goTo" class="hdrbtn" hidden></button>
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
const composerNote = document.getElementById('composerNote')!;
const goToBtn = document.getElementById('goTo') as HTMLButtonElement;
const pinBtn = document.getElementById('pin') as HTMLButtonElement;

/** Block id → its node, so a patch updates in place instead of re-rendering. */
const nodes = new Map<string, HTMLElement>();
/** Latest state of each block, since a patch is partial. */
const blockState = new Map<string, ConvBlock>();

let stick = true;
let newCount = 0;

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

function toolStateLabel(b: Extract<ConvBlock, { kind: 'tool' }>): string {
  if (b.state === 'running') return 'running';
  return b.state === 'error' ? 'failed' : '';
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
      el.className = 'blk assistant';
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
      setText(s, 'Thinking');
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
      const state = toolStateLabel(b);
      if (state) {
        const st = document.createElement('span');
        st.className = 'tstate';
        setText(st, state);
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
          const file = document.createElement('div');
          file.className = 'sub';
          setText(file, b.result.diff.file);
          const pre = document.createElement('pre');
          pre.className = 'tdiff';
          renderDiff(pre, b.result.diff.patch);
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
      el.appendChild(askActions(b.requestId, b.state, b.alwaysAllowRule));
      break;
    }
    case 'question': {
      el.className = `blk ask question st-${b.state}`;
      el.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'askhead';
      setText(head, 'Claude asked a question');
      el.appendChild(head);
      for (const q of b.questions) {
        const qd = document.createElement('div');
        qd.className = 'body';
        setText(qd, q.question);
        el.appendChild(qd);
        const opts = document.createElement('div');
        opts.className = 'sub';
        setText(opts, q.options.map((o) => o.label).join(' · '));
        el.appendChild(opts);
      }
      const note = document.createElement('div');
      note.className = 'asknote';
      setText(
        note,
        b.state === 'pending'
          ? 'Answer this one in Claude Code: a question cannot be settled from outside.'
          : answeredLabel(b.state),
      );
      el.appendChild(note);
      break;
    }
    case 'plan': {
      el.className = `blk ask plan st-${b.state}`;
      el.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'askhead';
      setText(head, 'Plan awaiting approval');
      el.appendChild(head);
      const body = document.createElement('div');
      body.className = 'body';
      renderMarkdown(body, b.plan);
      el.appendChild(body);
      const note = document.createElement('div');
      note.className = 'asknote';
      setText(
        note,
        b.state === 'pending'
          ? 'Approve this one in Claude Code: plan approval cannot be settled from outside.'
          : answeredLabel(b.state),
      );
      el.appendChild(note);
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

function answeredLabel(state: AskState): string {
  switch (state) {
    case 'allowed':
      return 'Allowed.';
    case 'denied':
      return 'Denied.';
    case 'expired':
      return 'Answered in Claude Code.';
    default:
      return '';
  }
}

function askActions(requestId: string, state: AskState, alwaysAllowRule: string | undefined): HTMLElement {
  const row = document.createElement('div');
  row.className = 'askrow';
  if (state !== 'pending') {
    const done = document.createElement('span');
    done.className = 'asknote';
    setText(done, answeredLabel(state));
    row.appendChild(done);
    return row;
  }
  const mk = (label: string, decision: 'allow' | 'always' | 'deny', cls: string) => {
    const b = document.createElement('button');
    b.className = `askbtn ${cls}`;
    setText(b, label);
    b.addEventListener('click', () => {
      // Optimistic only in the sense of disabling: the host's patch decides
      // what the card ends up saying, including "too late".
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
  pill.title = estimated
    ? 'Estimated from the transcript: install the status hooks for exact status.'
    : '';
}

function setMeta(session: SessionDTO): void {
  ttl.textContent = session.title;
  meta.textContent = [session.projectName, session.gitBranch !== 'HEAD' ? session.gitBranch : undefined, session.name]
    .filter(Boolean)
    .join(' · ');
}

function setCaps(caps: ConversationCapabilities, composer: ComposerState | undefined): void {
  if (caps.goTo) {
    goToBtn.hidden = false;
    goToBtn.textContent = caps.goTo.label;
  } else {
    goToBtn.hidden = true;
  }
  if (caps.canSend && composer) {
    composerNote.textContent = '';
  } else {
    composerNote.textContent = caps.readOnlyReason ?? 'Read-only.';
  }
}

function setBanner(caps: ConversationCapabilities): void {
  if (!caps.estimated) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent =
    'Status here is estimated from the transcript, and a permission prompt cannot be answered. ' +
    'Install the Agent Wrangler status hooks, then restart this session.';
}

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
pinBtn.addEventListener('click', () => post({ type: 'pin' }));

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
      setCaps(m.caps, m.composer);
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
      setCaps(m.caps, undefined);
      setBanner(m.caps);
      break;
    case 'composer':
      break; // phase 2
    case 'toolResult':
      break; // phase 2
    case 'error': {
      appendBlocks([{ kind: 'note', id: `e${Date.now()}`, tone: 'error', text: m.text }]);
      break;
    }
  }
});

post({ type: 'ready' });
