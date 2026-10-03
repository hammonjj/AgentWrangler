/**
 * The clients connected to the app, and the dialogs and surface that reach the
 * right one (#126, `docs/plans/browser-workbench.md` §7.3).
 *
 * A client is one document the user is looking at: a browser tab. Each registers a `ClientChannel`: how to ask it something, how
 * to show it a line of feedback, and how to point its conversation pane
 * somewhere. The registry then offers one `HostDialogs` and one
 * `WorkbenchSurface` to the rest of the app, as before, but scoped: a call made
 * while handling a client's request (`currentRequest()`, see
 * `requestScope.ts`) goes to that client and no other.
 *
 * With no originating client, because the app is acting by itself
 * (notifications, startup checks, orchestration, `aw`, Discord) or because
 * the client that asked has gone:
 *
 * - a toast goes to every client;
 * - a prompt is not shown anywhere. Its text goes to every client as a toast
 *   and it resolves as cancelled at once, which is each prompt's
 *   non-interactive default. Nothing ever waits on a modal nobody can see;
 * - navigation goes to the fallback client if there is one and it is open,
 *   else nowhere. The daemon has none.
 *
 * A prompt whose client disconnects while it is open resolves as cancelled.
 */
import type { RequestContext } from './access';
import type { Disposable } from './events';
import { currentRequest } from './requestScope';
import type { SessionHandle } from './session/sessionHandle';
import type { HostDialogs, HostServices, HostShell, InputOptions, PickItem, WorkbenchSurface } from '../host/hostServices';
import type { AnalyticsDetail } from '../shared/orchestration/analyticsView';
import type { ShellPrompt, ShellPromptValue } from '../shared/shellProtocol';
import { NoticeDeduper } from '../shared/webCapabilities';

/** The same tag inside this is one ask. */
const NOTICE_DEDUPE_MS = 5_000;

/** Where a client's conversation pane should go. */
export type NavigateTarget =
  | { kind: 'open'; preserveFocus?: boolean }
  | { kind: 'session'; key: string; preserveFocus?: boolean }
  | { kind: 'handle'; handle: SessionHandle; preserveFocus?: boolean }
  | { kind: 'tab'; key: string }
  | { kind: 'detail'; detail: AnalyticsDetail };

/**
 * A prompt as the app asks it: the wire shape, plus what cannot cross a wire.
 * `validateInput` is checked live by a client that can (the palette) and on
 * each answer by one that cannot.
 */
export type ClientPrompt = ShellPrompt & { validateInput?: (value: string) => string | undefined };

/** What a browser tab is sent for a notice (#141). Tapping it goes to `sessionKey`. */
export interface ClientNotice {
  title: string;
  body: string;
  sessionKey?: string;
  /** One per ask: the same ask arriving twice collapses into one notification. */
  tag: string;
}

/**
 * Where a client is, which decides what the host-local actions (open a file,
 * show it in Finder, run a command in a terminal) mean for it (#140):
 *
 * | kind | Is | Host-local actions |
 * |---|---|---|
 * | `window` | a native client on the Mac (tests; the Electron window until #142) | done on the Mac |
 * | `loopback` | a browser on this machine | shown in the browser; "Open on this Mac" offered |
 * | `lan` | a browser elsewhere | shown in the browser; nothing is ever done on the host |
 */
export type ClientKind = 'window' | 'loopback' | 'lan';

/** A file the app wants a client to look at. */
export interface ClientFile {
  path: string;
  /** What the app asked for: the file opened, or revealed in the file manager. */
  intent: 'open' | 'reveal';
}

/** A command the app wants a client's user to run in a terminal. */
export interface ClientCommand {
  command: string;
  cwd: string;
  name: string;
}

export interface ClientChannel {
  /** The `RequestContext.connectionId` its requests carry. */
  readonly connectionId: string;
  /**
   * A browser tab that shows OS notifications itself (#141): true only while
   * its permission is granted. Absent or false: not a place a notice can go
   * (a tab that has not asked or was refused).
   */
  readonly canNotify?: boolean;
  /** Send a notice to a tab with `canNotify`. The tab decides whether to show it (hidden or unfocused). */
  notify?(notice: ClientNotice): void;
  readonly kind: ClientKind;
  /** A link, opened where this client is: its own browser, or the default browser on the Mac. */
  openUrl(url: string): void;
  /** A file: the viewer in a browser; the default app or the file manager on the Mac for the window. */
  showFile(file: ClientFile): void;
  /** A command: shown and copyable in a browser; run in Terminal on the Mac for the window. */
  showCommand(command: ClientCommand): void;
  /** On screen now: the window is open, the tab is connected. */
  readonly isOpen: boolean;
  /** Ask; resolves with the answer, or undefined for cancelled. See `ShellPromptValue`. */
  prompt(request: ClientPrompt): Promise<ShellPromptValue>;
  toast(text: string, timeoutMs?: number): void;
  navigate(target: NavigateTarget): void;
}

export interface ClientRegistryOptions {
  log(message: string): void;
  /**
   * The client that navigation with no originating client goes to, if it is
   * open. The daemon passes none.
   */
  navigationFallback?: string;
}

interface Entry {
  channel: ClientChannel;
  /** Resolves when the client unregisters; every prompt open on it races this. */
  gone: Promise<void>;
  leave(): void;
}

export class ClientRegistry {
  private readonly clients = new Map<string, Entry>();
  /** Scoped to the originating client. Hand this to the app as `host.dialogs`. */
  readonly dialogs: HostDialogs;
  /** Scoped to the originating client. Hand this to the app as its surface. */
  readonly surface: WorkbenchSurface;
  /**
   * Scoped to the originating client (#140). Hand this to the app as
   * `host.shell`: a link, file or command goes to the client that asked and
   * is shown where that client is. With none, the fallback client if open,
   * else nothing: the host never opens anything unasked.
   */
  readonly shell: HostShell;

  constructor(private readonly opts: ClientRegistryOptions) {
    this.dialogs = this.createDialogs();
    this.surface = this.createSurface();
    this.shell = this.createShell();
  }

  /** Connect a client. Disposing it disconnects it, and cancels whatever it was being asked. */
  register(channel: ClientChannel): Disposable {
    if (this.clients.has(channel.connectionId)) throw new Error(`client ${channel.connectionId} is already registered`);
    let leave!: () => void;
    const gone = new Promise<void>((resolve) => (leave = resolve));
    const entry: Entry = { channel, gone, leave };
    this.clients.set(channel.connectionId, entry);
    return {
      dispose: () => {
        if (this.clients.get(channel.connectionId) !== entry) return;
        this.clients.delete(channel.connectionId);
        entry.leave();
      },
    };
  }

  get size(): number {
    return this.clients.size;
  }

  get(connectionId: string): ClientChannel | undefined {
    return this.clients.get(connectionId)?.channel;
  }

  /** The client the request being handled came from, while it is still connected. */
  originating(ctx: RequestContext | undefined = currentRequest()): ClientChannel | undefined {
    return this.entryFor(ctx)?.channel;
  }

  /** A line to every client: how the app tells everyone something nobody in particular asked for. */
  broadcast(text: string, timeoutMs?: number): void {
    for (const { channel } of this.clients.values()) {
      try {
        channel.toast(text, timeoutMs);
      } catch (err) {
        this.opts.log(`clients: toast to ${channel.connectionId} failed: ${String(err)}`);
      }
    }
  }

  /**
   * Send a notice to every browser tab that can show one; how many were sent.
   * Each tab decides for itself whether the user is already looking at it.
   */
  notify(notice: ClientNotice): number {
    let sent = 0;
    for (const { channel } of this.clients.values()) {
      if (!channel.canNotify || !channel.notify) continue;
      try {
        channel.notify(notice);
        sent++;
      } catch (err) {
        this.opts.log(`clients: notice to ${channel.connectionId} failed: ${String(err)}`);
      }
    }
    return sent;
  }

  /**
   * `host.notify`, routed (#141, decision D3). A notice goes to every browser
   * tab that can show it; the host's own (`native`: `osascript` in the
   * daemon) fires only when no such tab is
   * connected. A visible tab suppresses its own copy, and the host's stays
   * quiet too: somebody is looking. Discord is separate and unchanged.
   *
   * The same `tag` inside `NOTICE_DEDUPE_MS` is one ask, delivered once.
   */
  notifier(native: HostServices['notify'], now: () => number = Date.now): NonNullable<HostServices['notify']> {
    const dedupe = new NoticeDeduper(NOTICE_DEDUPE_MS);
    return (notice) => {
      if (notice.tag !== undefined && !dedupe.first(notice.tag, now())) return;
      const sent =
        notice.tag !== undefined
          ? this.notify({
              title: notice.title,
              body: notice.body,
              tag: notice.tag,
              ...(notice.sessionKey !== undefined ? { sessionKey: notice.sessionKey } : {}),
            })
          : 0;
      if (sent === 0) native?.(notice);
    };
  }

  private entryFor(ctx: RequestContext | undefined): Entry | undefined {
    const id = ctx?.connectionId;
    return id === undefined ? undefined : this.clients.get(id);
  }

  /**
   * Ask the originating client, or nobody. `notice` is what everyone is told
   * instead when there is nobody to ask.
   */
  private async ask(request: ClientPrompt, notice: string | undefined): Promise<ShellPromptValue> {
    const entry = this.entryFor(currentRequest());
    if (!entry) {
      this.opts.log(`clients: no client to ask (${request.kind}); taking the default`);
      if (notice) this.broadcast(notice);
      return undefined;
    }
    let answer: Promise<ShellPromptValue>;
    try {
      answer = Promise.resolve(entry.channel.prompt(request));
    } catch (err) {
      this.opts.log(`clients: prompt on ${entry.channel.connectionId} failed: ${String(err)}`);
      return undefined;
    }
    return Promise.race([
      answer.catch((err: unknown) => {
        this.opts.log(`clients: prompt on ${entry.channel.connectionId} failed: ${String(err)}`);
        return undefined;
      }),
      entry.gone.then(() => undefined),
    ]);
  }

  private createDialogs(): HostDialogs {
    const label = (value: ShellPromptValue, items: string[]) =>
      typeof value === 'string' && items.includes(value) ? value : undefined;
    return {
      info: async (message, ...items) => label(await this.ask({ kind: 'message', level: 'info', message, items }, message), items),
      warn: async (message, options, ...items) =>
        label(
          await this.ask(
            {
              kind: 'message',
              level: 'warn',
              message,
              items,
              ...(options.detail !== undefined ? { detail: options.detail } : {}),
              ...(options.modal ? { modal: true } : {}),
              ...(options.defaultToCancel ? { defaultToCancel: true } : {}),
            },
            message,
          ),
          items,
        ),
      error: (message) => {
        void this.ask({ kind: 'message', level: 'error', message, items: [] }, message);
      },
      flash: (message, timeoutMs) => {
        const client = this.originating();
        if (client) client.toast(message, timeoutMs);
        else this.broadcast(message, timeoutMs);
      },
      input: async (options) => {
        const value = await this.ask(
          {
            kind: 'input',
            ...pickDefined(options, ['title', 'prompt', 'value', 'placeHolder', 'password']),
            ...(options.validateInput ? { validateInput: options.validateInput } : {}),
          },
          `${options.title ?? options.prompt ?? 'A question'}: no window to answer it in, so it was cancelled.`,
        );
        return typeof value === 'string' ? value : undefined;
      },
      pick: async <T extends PickItem>(items: T[], options?: Parameters<HostDialogs['pick']>[1]) => {
        const value = await this.ask(
          {
            kind: 'pick',
            items: items.map((i) => pickDefined(i, ['label', 'description', 'detail'])),
            ...pickDefined(options ?? {}, ['placeHolder', 'matchOnDescription', 'matchOnDetail']),
          },
          `${options?.placeHolder ?? 'A choice'}: no window to choose in, so nothing was chosen.`,
        );
        return typeof value === 'number' && Number.isInteger(value) ? items[value] : undefined;
      },
      pickFolder: async (options) => {
        const value = await this.ask(
          { kind: 'pickFolder', ...(options?.openLabel !== undefined ? { openLabel: options.openLabel } : {}) },
          'Choosing a folder needs a window, so it was cancelled.',
        );
        return typeof value === 'string' && value ? value : undefined;
      },
    };
  }

  private createShell(): HostShell {
    const registry = this;
    /** The originating client, or the fallback while it is open. */
    const target = (what: string): ClientChannel | undefined => {
      const client = registry.originating();
      if (client) return client;
      const fallback = registry.opts.navigationFallback !== undefined ? registry.get(registry.opts.navigationFallback) : undefined;
      if (fallback?.isOpen) return fallback;
      registry.opts.log(`clients: ${what}: no client to show it to`);
      return undefined;
    };
    return {
      openExternal: (url) => target(`open ${url}`)?.openUrl(url),
      openFile: (path) => target(`open ${path}`)?.showFile({ path, intent: 'open' }),
      revealInFileManager: (path) => target(`reveal ${path}`)?.showFile({ path, intent: 'reveal' }),
      runInTerminal: (command, options) => target(`run ${command}`)?.showCommand({ command, cwd: options.cwd, name: options.name }),
    };
  }

  private createSurface(): WorkbenchSurface {
    const registry = this;
    /** The originating client, or the fallback while it is open. */
    const target = (): ClientChannel | undefined => {
      const client = registry.originating();
      if (client) return client;
      const fallback = registry.opts.navigationFallback !== undefined ? registry.get(registry.opts.navigationFallback) : undefined;
      return fallback?.isOpen ? fallback : undefined;
    };
    const go = (to: NavigateTarget) => target()?.navigate(to);
    return {
      /** The originating client's; with none, whether any client is on screen. */
      get isOpen() {
        const client = registry.originating();
        if (client) return client.isOpen;
        for (const { channel } of registry.clients.values()) if (channel.isOpen) return true;
        return false;
      },
      open: (options) => go({ kind: 'open', ...options }),
      show: (key, options) => go({ kind: 'session', key, ...options }),
      showSession: (handle, options) => go({ kind: 'handle', handle, ...options }),
      openInTab: (key) => go({ kind: 'tab', key }),
      showDetail: (detail) => go({ kind: 'detail', detail }),
    };
  }
}

/**
 * A channel over an ordinary `HostDialogs` and a navigator: a native client's
 * (the Electron window had one until #142), and a test's.
 */
export function channelFromDialogs(opts: {
  connectionId: string;
  dialogs: HostDialogs;
  isOpen: () => boolean;
  navigate: (target: NavigateTarget) => void;
  /** The machine's own shell, which this client (the window) acts on. Without it, nothing is opened. */
  shell?: HostShell;
  kind?: ClientKind;
}): ClientChannel {
  const { dialogs, shell } = opts;
  return {
    connectionId: opts.connectionId,
    kind: opts.kind ?? 'window',
    openUrl: (url) => shell?.openExternal(url),
    showFile: (file) => (file.intent === 'reveal' ? shell?.revealInFileManager(file.path) : shell?.openFile(file.path)),
    showCommand: (c) => {
      if (shell?.runInTerminal) shell.runInTerminal(c.command, { cwd: c.cwd, name: c.name });
      else dialogs.error('Agent Wrangler: this host has no terminal to hand the session to.');
    },
    get isOpen() {
      return opts.isOpen();
    },
    prompt: async (request) => {
      switch (request.kind) {
        case 'message':
          if (request.level === 'error') {
            dialogs.error(request.message);
            return undefined;
          }
          if (request.level === 'info' && request.detail === undefined && !request.modal && !request.defaultToCancel) {
            return dialogs.info(request.message, ...request.items);
          }
          return dialogs.warn(
            request.message,
            pickDefined(request, ['detail', 'modal', 'defaultToCancel']),
            ...request.items,
          );
        case 'input': {
          const options: InputOptions = pickDefined(request, ['title', 'prompt', 'value', 'placeHolder', 'password']);
          if (request.validateInput) options.validateInput = request.validateInput;
          return dialogs.input(options);
        }
        case 'pick': {
          const picked = await dialogs.pick(
            request.items.map((item, index) => ({ ...item, index })),
            pickDefined(request, ['placeHolder', 'matchOnDescription', 'matchOnDetail']),
          );
          return picked?.index;
        }
        case 'pickFolder':
          return dialogs.pickFolder(request.openLabel !== undefined ? { openLabel: request.openLabel } : undefined);
      }
    },
    toast: (text, timeoutMs) => dialogs.flash(text, timeoutMs),
    navigate: opts.navigate,
  };
}

/** The named fields of `from` that are set: what crosses a wire, with no `undefined`s or functions. */
function pickDefined<T extends object, K extends keyof T>(from: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}
