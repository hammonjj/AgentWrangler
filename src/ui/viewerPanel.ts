import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { linesToBlocks } from '../claude/transcriptRender';
import { MAX_CHUNK_BYTES, readRange, splitCompleteLines } from '../claude/transcriptTail';
import type { Disposable } from '../core/events';
import type { AgentProvider } from '../core/provider';
import type { SessionStore } from '../core/sessionStore';
import type { HostToViewer, ViewerToHost } from '../shared/messages';
import type { AgentSession, SessionStatus, ViewerBlock } from '../shared/model';
import type { SessionActions } from './actions';
import { buildWebviewHtml } from './html';

const INIT_TAIL_BYTES = 512 * 1024;
const MAX_INIT_BLOCKS = 200;
const FOLLOW_POLL_MS = 2000;

/** One live read-only transcript panel per session; reveal-if-open. */
export class ViewerPanelManager implements vscode.Disposable {
  private panels = new Map<string, ViewerPanel>();

  constructor(
    private extensionUri: vscode.Uri,
    private store: SessionStore,
    private provider: AgentProvider,
    private actions: SessionActions,
  ) {}

  open(session: AgentSession): void {
    const existing = this.panels.get(session.key);
    if (existing) {
      existing.reveal();
      return;
    }
    if (!session.transcriptPath) {
      void vscode.window.showInformationMessage('Agent Wrangler: no transcript yet for this session.');
      return;
    }
    const panel = new ViewerPanel(this.extensionUri, session, this.store, this.provider, this.actions);
    this.panels.set(session.key, panel);
    panel.onDispose(() => this.panels.delete(session.key));
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
    this.panels.clear();
  }
}

class ViewerPanel {
  private panel: vscode.WebviewPanel;
  private byteOffset = 0;
  private subs: Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private ready = false;
  private pumping = false;
  private lastStatus: SessionStatus;
  private disposedCb?: () => void;

  constructor(
    extensionUri: vscode.Uri,
    private session: AgentSession,
    private store: SessionStore,
    provider: AgentProvider,
    private actions: SessionActions,
  ) {
    this.lastStatus = session.status;
    this.panel = vscode.window.createWebviewPanel('agentWrangler.viewer', session.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    this.panel.webview.html = buildWebviewHtml({
      webview: this.panel.webview,
      extensionUri,
      bundleName: 'viewer',
      title: session.title,
    });

    this.subs.push(this.panel.webview.onDidReceiveMessage((m: ViewerToHost) => void this.onMessage(m)));
    if (provider.onTranscriptAppended) {
      this.subs.push(
        provider.onTranscriptAppended((e) => {
          if (e.sessionId === this.session.sessionId.toLowerCase()) void this.pump();
        }),
      );
    }
    this.subs.push(this.store.onDidUpdate(() => this.onStoreUpdate()));
    this.panel.onDidDispose(() => this.disposeInner());
    this.armTimer();
  }

  reveal(): void {
    this.panel.reveal();
  }

  onDispose(cb: () => void): void {
    this.disposedCb = cb;
  }

  dispose(): void {
    this.panel.dispose(); // triggers onDidDispose → disposeInner
  }

  private post(msg: HostToViewer): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: ViewerToHost): Promise<void> {
    if (m.type === 'ready') await this.sendInit();
    else if (m.type === 'resumeClicked') this.actions.resume(this.session.key);
    else if (m.type === 'openExternal') this.actions.openExternal(m.url);
  }

  private async sendInit(): Promise<void> {
    const filePath = this.session.transcriptPath;
    if (!filePath) return;
    let size = 0;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      // gone — show empty; status updates will mark it ended
    }
    const readStart = Math.max(0, size - INIT_TAIL_BYTES);
    let blocks: ViewerBlock[] = [];
    let endOffset = 0;
    const buf = await readRange(filePath, readStart, size);
    if (buf !== undefined) {
      const split = splitCompleteLines(buf, readStart > 0);
      blocks = linesToBlocks(split.lines);
      endOffset = split.endOffset;
    }
    this.byteOffset = readStart + endOffset;
    const truncated = readStart > 0 || blocks.length > MAX_INIT_BLOCKS;
    this.ready = true;
    this.post({ type: 'init', session: this.session, blocks: blocks.slice(-MAX_INIT_BLOCKS), truncated });
  }

  /** Read appended bytes past our offset and stream new blocks to the webview. */
  private async pump(): Promise<void> {
    if (!this.ready || this.pumping) return;
    this.pumping = true;
    try {
      const filePath = this.session.transcriptPath;
      if (!filePath) return;
      let size: number;
      try {
        size = (await fs.stat(filePath)).size;
      } catch {
        return;
      }
      if (size < this.byteOffset) {
        await this.sendInit(); // truncated/rewritten — start over
        return;
      }
      while (size > this.byteOffset) {
        const end = Math.min(size, this.byteOffset + MAX_CHUNK_BYTES);
        const buf = await readRange(filePath, this.byteOffset, end);
        if (buf === undefined) return;
        const split = splitCompleteLines(buf, false);
        if (split.endOffset === 0) break; // only a partial line so far
        this.byteOffset += split.endOffset;
        const blocks = linesToBlocks(split.lines);
        if (blocks.length > 0) this.post({ type: 'append', blocks });
        if (end === size) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private onStoreUpdate(): void {
    const s = this.store.get(this.session.key);
    if (!s) {
      // aged out of the store (ended + outside the window)
      if (this.lastStatus !== 'ended') {
        this.lastStatus = 'ended';
        this.post({ type: 'status', status: 'ended' });
        this.armTimer();
      }
      return;
    }
    const titleChanged = s.title !== this.session.title;
    const statusChanged = s.status !== this.lastStatus;
    this.session = s;
    if (titleChanged) {
      this.panel.title = s.title;
      this.post({ type: 'title', title: s.title });
    }
    if (statusChanged) {
      this.lastStatus = s.status;
      this.post({ type: 'status', status: s.status });
      this.armTimer();
      void this.pump(); // catch the tail that produced the transition
    }
  }

  private armTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.lastStatus === 'busy' || this.lastStatus === 'stuck') {
      this.timer = setInterval(() => void this.pump(), FOLLOW_POLL_MS);
    }
  }

  private disposeInner(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.disposedCb?.();
  }
}
