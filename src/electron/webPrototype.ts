/**
 * The workbench, in an ordinary browser on this Mac: the WebSocket side.
 *
 * The HTTP side — page, assets, login link, device cookie and the request
 * guards — is `core/web/server.ts` (#127). It hands each authenticated,
 * upgraded socket here with its device's `RequestContext`, and this gives it
 * its own `DashboardHost`/`ConversationHost` pair over a WebSocket
 * `EnvelopeTransport`, all over the one app. The bridge on the page is
 * `src/webview/webshim`. Plan: `docs/plans/browser-workbench.md`.
 *
 * Each browser is a client of its own (#126): confirmations, pickers, toasts
 * and navigation its own clicks cause come back to it over the `shell`
 * channel (`src/core/web/shellChannel.ts`), answered for now with the
 * browser's `confirm()`/`prompt()`. What it does not do yet, and the plan says
 * who does: in-page modals (#133), TLS, LAN.
 */
import type { Duplex } from 'node:stream';
import type { AgentWranglerApp } from '../app/createApp';
import { Emitter, type Disposable } from '../core/events';
import { ownerContext, type RequestContext } from '../core/access';
import type { ClientRegistry } from '../core/clients';
import { createShellChannel } from '../core/web/shellChannel';
import type { HostServices } from '../host/hostServices';
import { SHELL_PANE } from '../shared/shellProtocol';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import type { EnvelopeTransport } from '../ui/paneChannel';
import { encodeClose, encodePong, encodeText, WsDecoder } from '../core/web/wsFrames';
import { createWorkbenchHosts } from './workbenchWindow';

/** A browser that stops reading is dropped rather than buffered without end. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/**
 * Per process, not per `createBrowserClients`: the server is rebuilt when the
 * port changes, and a new connection must never reuse an id the registry
 * still holds for one that is closing.
 */
let connectionSeq = 0;

export interface BrowserClientsOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  /** Each browser registers as a client, so what it causes comes back to it (#126). */
  clients: ClientRegistry;
  log: (line: string) => void;
}

export interface BrowserClients extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(socket: Duplex, device: RequestContext): void;
}

export function createBrowserClients(opts: BrowserClientsOptions): BrowserClients {
  const { app, host, ui, clients, log } = opts;
  /** Each open socket, and how to close it. */
  const connections = new Map<Duplex, () => void>();

  function attach(socket: Duplex, device: RequestContext): void {
    const incoming = new Emitter<unknown>();
    const decoder = new WsDecoder();
    let open = true;

    const transport: EnvelopeTransport = {
      postMessage: async (msg) => {
        if (!open) return false;
        if (socket.writableLength > MAX_BUFFERED_BYTES) {
          log('web prototype: dropping a browser that stopped reading');
          close(1008);
          return false;
        }
        socket.write(encodeText(JSON.stringify(msg)));
        return true;
      },
      onDidReceiveMessage: (listener) => incoming.event(listener),
    };

    // The device cookie is the owner's, so the owner it is; the device and
    // connection ids are for the audit and for sending this browser's prompts,
    // toasts and navigation back to it (#126), never identity (#123).
    const connectionId = `web-${++connectionSeq}`;
    let panes: ReturnType<typeof createWorkbenchHosts> | undefined = createWorkbenchHosts(
      app,
      host,
      ui,
      transport,
      ownerContext('browser', { deviceId: device.deviceId, connectionId }),
    );
    const shell = createShellChannel({
      connectionId,
      post: (envelope) => void transport.postMessage(envelope),
      conversation: () => panes?.conversation,
    });
    const shellIn = incoming.event((raw) => {
      const m = raw as { pane?: unknown; body?: unknown } | undefined;
      if (m && typeof m === 'object' && m.pane === SHELL_PANE) shell.receive(m.body);
    });
    const registration = clients.register(shell.channel);

    const close = (code?: number) => {
      if (!open) return;
      open = false;
      if (code !== undefined && !socket.destroyed) socket.end(encodeClose(code));
      else socket.destroy();
      // Before the panes: whatever this browser was being asked resolves as cancelled.
      registration.dispose();
      shell.dispose();
      shellIn.dispose();
      panes?.dashboard.dispose();
      panes?.conversation.dispose();
      panes = undefined;
      connections.delete(socket);
      log(`web prototype: browser disconnected (${connections.size} open)`);
    };
    connections.set(socket, () => close());
    log(`web prototype: browser connected (${connections.size} open)`);

    socket.on('data', (chunk: Buffer) => {
      for (const ev of decoder.push(chunk)) {
        if (ev.kind === 'text') {
          try {
            incoming.fire(JSON.parse(ev.text));
          } catch {
            close(1007);
            return;
          }
        } else if (ev.kind === 'ping') {
          socket.write(encodePong(ev.payload));
        } else if (ev.kind === 'close') {
          close(1000);
          return;
        } else {
          close(ev.code);
          return;
        }
      }
    });
    socket.on('close', () => close());
    socket.on('error', () => close());
  }

  return {
    attach,
    dispose: () => {
      // Closed here, not on the sockets' later 'close' events, so every client
      // is unregistered (and its prompts cancelled) before this returns.
      for (const close of [...connections.values()]) close();
    },
  };
}
