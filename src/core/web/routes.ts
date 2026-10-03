/**
 * Extra HTTP endpoints the web server hosts (#141), each in its own file and
 * registered from `WebServerOptions.routes`. The server does what is common
 * to all of them before a route sees the request: the `Host` check, the
 * `Origin` check (every non-GET), and the device cookie. A route adds its own
 * (a custom header, the access gate, size caps) and answers.
 */
import type * as http from 'node:http';
import type { AccessGate, RequestContext } from '../access';
import type { DeviceScope } from './devices';

export interface WebRouteContext {
  /** The signed-in device's request context (owner, `via: 'browser'`, its `deviceId`). */
  context: RequestContext;
  scope: DeviceScope;
  gate: AccessGate;
}

export interface WebRoute {
  method: 'POST';
  /** Exact pathname. */
  path: string;
  handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: WebRouteContext): void | Promise<void>;
}
