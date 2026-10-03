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
 * What it does not do yet, and the plan says who does: confirmations, pickers
 * and toasts still appear on the Mac (`HostDialogs` is app-wide); navigation
 * the app starts — a new conversation, a notification — goes to the window,
 * not the browser (`WorkbenchSurface` is app-wide); no TLS, no LAN.
 */
import type { Duplex } from 'node:stream';
import type { AgentWranglerApp } from '../app/createApp';
import { Emitter, type Disposable } from '../core/events';
import { ownerContext, type RequestContext } from '../core/access';
import type { HostServices } from '../host/hostServices';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import type { SessionActions } from '../ui/actions';
import type { EnvelopeTransport } from '../ui/paneChannel';
import { encodeClose, encodePong, encodeText, WsDecoder } from '../core/web/wsFrames';
import { createWorkbenchHosts } from './workbenchWindow';

/** A browser that stops reading is dropped rather than buffered without end. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

export interface BrowserClientsOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  log: (line: string) => void;
}

export interface BrowserClients extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(socket: Duplex, device: RequestContext): void;
}

export function createBrowserClients(opts: BrowserClientsOptions): BrowserClients {
  const { app, host, ui, log } = opts;
  const connections = new Set<Duplex>();

  let connectionSeq = 0;
  function attach(socket: Duplex, device: RequestContext): void {
    connections.add(socket);
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

    // A row click shows the conversation in *this* browser. Everything else is
    // the app's own actions; the prototype of the prototype's limits is above.
    let panes: ReturnType<typeof createWorkbenchHosts> | undefined;
    const actions: SessionActions = Object.assign(Object.create(app.actions) as SessionActions, {
      smartOpen: (key: string) => {
        if (app.store.get(key)) panes?.conversation.show(key);
      },
    });
    // The device cookie is the owner's, so the owner it is; the device and
    // connection ids are for the audit, never identity (#123).
    const connectionId = `web-${++connectionSeq}`;
    panes = createWorkbenchHosts(app, host, ui, transport, ownerContext('browser', { deviceId: device.deviceId, connectionId }), actions);
    log(`web prototype: browser connected (${connections.size} open)`);

    const close = (code?: number) => {
      if (!open) return;
      open = false;
      if (code !== undefined && !socket.destroyed) socket.end(encodeClose(code));
      else socket.destroy();
      panes?.dashboard.dispose();
      panes?.conversation.dispose();
      panes = undefined;
      connections.delete(socket);
      log(`web prototype: browser disconnected (${connections.size} open)`);
    };

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
      for (const s of connections) s.destroy();
    },
  };
}
