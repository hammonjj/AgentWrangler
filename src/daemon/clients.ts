/**
 * The core daemon's clients (#131): the browsers, and the app's window when
 * it is one of them.
 *
 * - A `ClientRegistry` (#126) becomes the host's broker for dialogs
 *   (`host.useBroker`) and the app's surface (`app.attachSurface`), so a
 *   prompt or a navigation goes to the client whose request caused it, and
 *   one with no originating client is told to everyone and taken as
 *   cancelled. There is no fallback client: the daemon has no window of its
 *   own (the app's window is a browser like any other).
 * - Opening things, the clipboard and notifications stay with the default
 *   broker: they act on this Mac, which is where a loopback client is.
 * - The web workbench (`src/app/webWorkbench.ts`), the same service the
 *   Electron app runs while it owns the core: loopback, LAN, settings sync.
 *   `loginLink` is what `web.link` (`aw web open`, the window) returns.
 */
import type { AgentWranglerApp } from '../app/createApp';
import { startWebWorkbench, type WebWorkbench } from '../app/webWorkbench';
import { workbenchUi } from '../app/workbenchHosts';
import { ClientRegistry } from '../core/clients';
import type { ControlWebLinkResult } from '../core/control/protocol';
import type { Disposable } from '../core/events';
import { createDefaultClientBroker } from '../node/clientBroker';
import { createMacShell } from '../node/macShell';
import type { NodeHost } from '../node/nodeHost';

export interface DaemonClientsOptions {
  app: AgentWranglerApp;
  host: NodeHost;
  log: (message: string) => void;
  /** `dist/webview`, readable by plain Node. Absent: no web workbench (tests of the core alone). */
  webviewDir?: string;
}

export interface DaemonClients extends Disposable {
  readonly registry: ClientRegistry;
  readonly web: WebWorkbench | undefined;
  loginLink(): ControlWebLinkResult | undefined;
  /** After a wake: the LAN addresses may have changed. */
  refresh(): void;
}

export function startDaemonClients(opts: DaemonClientsOptions): DaemonClients {
  const { app, host, log } = opts;
  const registry = new ClientRegistry({ log });
  const local = createDefaultClientBroker({ log });
  // Dialogs and the shell go to the client that asked (#126, #140). The Mac's
  // own shell is only for a loopback browser's "Open on this Mac".
  const macShell = createMacShell(log);
  host.useBroker({ ...local, dialogs: registry.dialogs, shell: registry.shell });
  app.attachSurface(registry.surface);
  const web = opts.webviewDir
    ? startWebWorkbench({ app, host, ui: workbenchUi(host), clients: registry, log, hostShell: macShell, webviewDir: opts.webviewDir })
    : undefined;
  if (!web) log('web: no workbench assets given; the browser workbench is off');
  return {
    registry,
    web,
    loginLink: () => web?.loginLink(),
    refresh: () => web?.refresh(),
    dispose: () => {
      web?.dispose();
      host.useBroker(undefined);
    },
  };
}
