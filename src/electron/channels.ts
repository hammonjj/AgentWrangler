/**
 * The IPC channel names, in one file because the preload and the main process
 * are two bundles and a typo between them is a silent dead channel rather than
 * a compile error.
 */

/** Renderer → main. One enveloped `{pane, body}` message from a pane. */
export const TO_HOST = 'aw:toHost';
/** Main → renderer. The same envelope, the other way. */
export const TO_WEBVIEW = 'aw:toWebview';
/** Renderer → main, synchronous, once at load: the saved webview state. */
export const STATE_GET = 'aw:state:get';
/** Renderer → main. Replace the saved webview state. */
export const STATE_SET = 'aw:state:set';
/** Main → renderer. One line of transient feedback for the shell's toast. */
export const TOAST = 'aw:toast';

/** The custom scheme the window's documents and bundles are served from. */
export const SCHEME = 'aw';
/** Origin of everything the window loads, and therefore its CSP source. */
export const ORIGIN = `${SCHEME}://bundle`;
