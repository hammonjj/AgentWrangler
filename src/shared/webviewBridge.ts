/**
 * Host-neutral bridge: `globalThis.agentWranglerHost`, which the browser shim
 * (`src/webview/webshim`) defines before any bundle runs, or else the
 * `acquireVsCodeApi()` a VSCode webview is given.
 */
export interface WebviewBridge<State> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

export function createWebviewBridge<State>(
  acquireVsCode: () => WebviewBridge<State>,
): WebviewBridge<State> {
  const shim = (globalThis as any).agentWranglerHost as WebviewBridge<State> | undefined;
  return shim ?? acquireVsCode();
}
