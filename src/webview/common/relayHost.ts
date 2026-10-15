/**
 * Whether this page runs inside the remote-control loader (#175, #176): its sockets go over the
 * relay, and its origin is the loader's site, not the Mac. The HTTP routes the Mac serves to a
 * loopback or LAN browser (file view, folder listing, uploads, dictation) are not reachable from
 * here, so the features that use them say so instead of failing.
 *
 * Read from the loader's socket factory, which it defines before any workbench code runs.
 */
export function isRelayHost(): boolean {
  return typeof (globalThis as { agentWranglerSocket?: unknown }).agentWranglerSocket === 'function';
}

/** The sentence a relay-unavailable feature shows. */
export function notOverRelay(what: string): string {
  return `${what} is not available over remote control yet. Use a browser on the Mac or your home network for that.`;
}
