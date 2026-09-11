/** Session actions shared by the dashboard webview, viewer panels, and palette commands. */
export interface SessionActions {
  /** Row click: go to wherever the session lives (see `OpenTarget`). */
  smartOpen(key: string): void;
  openViewer(key: string): void;
  resume(key: string): void;
  copyId(key: string): void;
  reveal(key: string): void;
  refreshAll(): void;
  openExternal(url: string): void;
  /** Dashboard banner → the `agentWrangler.installHooks` command (modal confirm included). */
  installHooks(): void;
  /** Answer the permission prompt a blocked session is sitting on, from the dashboard. */
  decidePermission(key: string, behavior: 'allow' | 'deny'): void;
}
