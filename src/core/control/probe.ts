/**
 * Whether something is listening on a Unix socket: the one probe every
 * single-instance check uses (the remote daemon, the core daemon, and the app
 * deciding whether it may run its core, #130). A connect that succeeds is an
 * answer; a refused connect, a missing file or a second's silence is not.
 */
import * as net from 'node:net';

export type SocketProbe = (socketPath: string) => Promise<boolean>;

export const socketAnswers: SocketProbe = (socketPath) =>
  new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
