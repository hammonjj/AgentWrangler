/** Host-neutral bridge used by both VS Code webviews and a future Electron preload. */
export interface WebviewBridge<State> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

export function createWebviewBridge<State>(
  acquireVsCode: () => WebviewBridge<State>,
): WebviewBridge<State> {
  const electron = (globalThis as any).agentWranglerHost as WebviewBridge<State> | undefined;
  return electron ?? acquireVsCode();
}
