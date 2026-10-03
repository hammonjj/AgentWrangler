/**
 * The request guards that keep a loopback server from being driven by any
 * page the user happens to have open.
 *
 * The file began as spike #120's hand-rolled RFC 6455 codec; the frames are
 * now the `ws` package's (#128), and only the guards are left.
 */

/**
 * Loopback only, by name. A `Host` that is anything else is a DNS-rebinding
 * page that resolved its own name to 127.0.0.1; the browser would otherwise
 * treat it as same-origin with us.
 */
export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
