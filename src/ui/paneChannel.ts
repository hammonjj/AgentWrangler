/**
 * One webview, two panes, two protocols.
 *
 * `DashboardHost` and `ConversationHost` were each written against a webview of
 * their own, and their message unions overlap — `ready` and `openExternal` mean
 * different things in each — so sharing a channel by shape is not possible.
 * Every message is therefore addressed: `{ pane, body }`, wrapped on the way
 * out and filtered on the way in.
 *
 * A host takes one of these instead of a `vscode.Webview` and is otherwise
 * unchanged. It also no longer sets `webview.html` or `webview.options`: with
 * two hosts on one webview, whichever constructed second would have replaced
 * the document the first was already talking to. The shell owns the document,
 * which is the same split the shells already had for lifetime.
 *
 * The envelope is used for a pane alone in its own panel too, so there is one
 * wire format rather than one that depends on where a pane is mounted.
 */

import type * as vscode from 'vscode';
import type { PaneName } from '../shared/messages';

export interface PaneChannel {
  postMessage(msg: unknown): Thenable<boolean>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDidReceiveMessage(listener: (msg: any) => void): vscode.Disposable;
}

export function paneChannel(webview: vscode.Webview, pane: PaneName): PaneChannel {
  return {
    postMessage: (body) => webview.postMessage({ pane, body }),
    onDidReceiveMessage: (listener) =>
      webview.onDidReceiveMessage((m: { pane?: PaneName; body?: unknown }) => {
        // The other pane's traffic arrives here too; so does anything VSCode
        // itself sends. Neither is ours.
        if (!m || typeof m !== 'object' || m.pane !== pane) return;
        listener(m.body);
      }),
  };
}
