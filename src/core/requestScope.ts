/**
 * Which request the code running now is handling (#126).
 *
 * `HostDialogs` and `WorkbenchSurface` are called from about seventy places in
 * `createApp`, `SessionActions`, orchestration and the pane hosts. With
 * several clients, a confirmation or a navigation caused by client A's click
 * must reach client A, and threading a context parameter through every one of
 * those calls would touch nearly every action for no other gain. Instead each
 * dispatcher runs the request it is handling inside `runInRequest(ctx, …)`,
 * and the scoped dialogs and surface (`src/core/clients.ts`) read the context
 * back with `currentRequest()`. `AsyncLocalStorage` carries it through every
 * `await`, timer and callback the request starts.
 *
 * That last part is also its hazard: anything *long-lived* created while a
 * request is being handled — a socket to a session host, a child process, an
 * interval — would carry that request's context for its whole life, and work
 * it later triggers on its own would be routed to whoever happened to start
 * it. So:
 *
 * - connections and processes that outlive the request are created inside
 *   `outsideRequest(…)` (the session-host client and supervisor, the Codex
 *   app-server link, the remote daemon link);
 * - listeners that are the app acting by itself (the "needs you"
 *   notifications, mission notices) run their bodies in `outsideRequest`,
 *   because an emitter calls its listeners in the context of whoever fired it;
 * - entry points that are not a pane message but are still somebody's click
 *   (the Electron menu, tray, notifications, Preferences, a menu quit) say
 *   whose with an explicit `runInRequest`.
 *
 * A request with no context, or whose client has gone, is treated as the app
 * acting by itself; see `ClientRegistry` for what that means for a prompt.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './access';

const scope = new AsyncLocalStorage<RequestContext>();

/** Run `fn` as part of the request `ctx`; everything it starts inherits it. */
export function runInRequest<T>(ctx: RequestContext, fn: () => T): T {
  return scope.run(ctx, fn);
}

/** The request being handled, or undefined when the app is acting by itself. */
export function currentRequest(): RequestContext | undefined {
  return scope.getStore();
}

/**
 * Run `fn` as the app's own work, whatever request is being handled. For
 * creating things that outlive the request, and for listeners that are not
 * part of whichever request fired them.
 */
export function outsideRequest<T>(fn: () => T): T {
  return scope.exit(fn);
}

/**
 * The same object with every method run inside `ctx`. For a dispatcher whose
 * requests arrive as method calls (the control socket's backend).
 */
export function scopedMethods<T extends object>(ctx: RequestContext, target: T): T {
  const out = {} as Record<string, unknown>;
  for (const [name, value] of Object.entries(target)) {
    out[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => runInRequest(ctx, () => (value as (...a: unknown[]) => unknown).apply(target, args))
        : value;
  }
  return out as T;
}
