/**
 * The workbench, in an ordinary browser on this Mac: the WebSocket side.
 *
 * The HTTP side — page, assets, login link, device cookie and the request
 * guards — is `core/web/server.ts` (#127). The connection itself — handshake,
 * acks and exactly-once, backpressure, snapshot coalescing — is
 * `core/web/browserConnections.ts` (#128). This is what ties them to this
 * process's app: each browser gets its own `DashboardHost`/`ConversationHost`
 * pair (`createWorkbenchHosts`), all over the one app. The bridge on the page
 * is `src/webview/webshim`. Plan: `docs/plans/browser-workbench.md`.
 *
 * What it does not do yet, and the plan says who does: in-page modals (#133),
 * TLS, LAN.
 */
import type { WebSocket } from 'ws';
import type { AgentWranglerApp } from '../app/createApp';
import type { Disposable } from '../core/events';
import type { RequestContext } from '../core/access';
import type { ClientRegistry } from '../core/clients';
import { createBrowserConnections } from '../core/web/browserConnections';
import type { HostServices, HostShell } from '../host/hostServices';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import { isMutatingPaneMessage } from '../ui/paneMutations';
import { createWorkbenchHosts } from './workbenchWindow';

export interface BrowserClientsOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  /** Each browser registers as a client, so what it causes comes back to it (#126). */
  clients: ClientRegistry;
  log: (line: string) => void;
  /** The build the served page is (`WebServer.build`). */
  build: () => string;
  /** Whether a folder a browser chose may be used as a host path (`WebFiles.folderAllowed`, #139). */
  folderAllowed: (dir: string) => Promise<boolean>;
  /** The Mac's own shell: what a loopback browser's "Open on this Mac" does (#140). */
  hostShell?: HostShell;
}

export interface BrowserClients extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(socket: WebSocket, device: RequestContext): void;
}

export function createBrowserClients(opts: BrowserClientsOptions): BrowserClients {
  const { app, host, ui, clients, log } = opts;
  return createBrowserConnections({
    clients,
    log,
    build: opts.build,
    folderAllowed: opts.folderAllowed,
    ...(opts.hostShell ? { hostShell: opts.hostShell } : {}),
    isMutating: isMutatingPaneMessage,
    createPanes: (transport, context) => createWorkbenchHosts(app, host, ui, transport, context),
  });
}
