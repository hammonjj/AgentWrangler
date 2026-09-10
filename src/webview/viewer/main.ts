import './viewer.css';
import type { HostToViewer, ViewerToHost } from '../../shared/messages';
import { STATUS_LABEL, type SessionDTO, type SessionStatus, type ViewerBlock } from '../../shared/model';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();
const post = (msg: ViewerToHost) => vscodeApi.postMessage(msg);

const MAX_BLOCK_NODES = 220;
const STICK_PX = 48;

const app = document.getElementById('app')!;
app.innerHTML = `
<div id="hdr">
  <span id="pill" class="pill"></span>
  <span id="ttl"></span>
  <span id="meta"></span>
</div>
<div id="banner" hidden>Session ended — <button id="resumeBtn">Resume in terminal</button></div>
<div id="scroll"><div id="notch" hidden>earlier messages omitted</div><div id="blocks"></div></div>
<button id="jump" hidden></button>
`;

const pill = document.getElementById('pill')!;
const ttl = document.getElementById('ttl')!;
const meta = document.getElementById('meta')!;
const banner = document.getElementById('banner')!;
const scroller = document.getElementById('scroll')!;
const notch = document.getElementById('notch')!;
const blocksEl = document.getElementById('blocks')!;
const jump = document.getElementById('jump')!;

let stick = true;
let newCount = 0;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Markdown-lite: escape first, then fences, inline code, bold, line breaks. */
function mdToHtml(raw: string): string {
  const parts = raw.split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[^\n]*\n/, '');
      out += `<pre><code>${esc(body)}</code></pre>`;
    } else {
      let t = esc(parts[i]);
      t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\n/g, '<br>');
      out += t;
    }
  }
  return out;
}

function setStatus(status: SessionStatus): void {
  pill.className = `pill st-${status}`;
  pill.textContent = STATUS_LABEL[status];
  banner.hidden = status !== 'ended';
}

function blockNode(b: ViewerBlock): HTMLElement {
  const el = document.createElement('div');
  if (b.kind === 'tool') {
    el.className = 'blk tool';
    el.innerHTML = `<span class="tname">${esc(b.name)}</span>${b.inputPreview ? `<span class="tin">${esc(b.inputPreview)}</span>` : ''}`;
  } else {
    el.className = `blk ${b.kind}`;
    if (b.kind === 'assistant' && b.msgId) el.dataset.msgId = b.msgId;
    el.innerHTML = mdToHtml(b.text);
  }
  return el;
}

function appendBlocks(blocks: ViewerBlock[]): void {
  for (const b of blocks) {
    const last = blocksEl.lastElementChild as HTMLElement | null;
    if (
      b.kind === 'assistant' &&
      b.msgId &&
      last &&
      last.classList.contains('assistant') &&
      last.dataset.msgId === b.msgId
    ) {
      last.innerHTML += '<br>' + mdToHtml(b.text);
      continue;
    }
    blocksEl.appendChild(blockNode(b));
  }
  while (blocksEl.children.length > MAX_BLOCK_NODES) {
    blocksEl.removeChild(blocksEl.firstElementChild!);
    notch.hidden = false;
  }
  if (stick) {
    scroller.scrollTop = scroller.scrollHeight;
  } else {
    newCount += blocks.length;
    jump.textContent = `↓ ${newCount} new`;
    jump.hidden = false;
  }
}

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
  newCount = 0;
  jump.hidden = true;
  scroller.scrollTop = scroller.scrollHeight;
});

document.getElementById('resumeBtn')!.addEventListener('click', () => post({ type: 'resumeClicked' }));

function setMeta(session: SessionDTO): void {
  ttl.textContent = session.title;
  const bits = [session.projectName, session.gitBranch !== 'HEAD' ? session.gitBranch : undefined, session.name]
    .filter(Boolean)
    .join(' · ');
  meta.textContent = bits;
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as HostToViewer;
  switch (m.type) {
    case 'init':
      blocksEl.innerHTML = '';
      notch.hidden = !m.truncated;
      setMeta(m.session);
      setStatus(m.session.status);
      stick = true;
      appendBlocks(m.blocks);
      break;
    case 'append':
      appendBlocks(m.blocks);
      break;
    case 'status':
      setStatus(m.status);
      break;
    case 'title':
      ttl.textContent = m.title;
      break;
  }
});

post({ type: 'ready' });
