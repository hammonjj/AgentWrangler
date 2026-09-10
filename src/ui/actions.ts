/** Session actions shared by the dashboard webview, viewer panels, and palette commands. */
export interface SessionActions {
  /** Row click: live → viewer, ended → resume in terminal. */
  smartOpen(key: string): void;
  openViewer(key: string): void;
  resume(key: string): void;
  copyId(key: string): void;
  reveal(key: string): void;
  refreshAll(): void;
  openExternal(url: string): void;
  /** Dashboard banner → the `agentWrangler.installHooks` command (modal confirm included). */
  installHooks(): void;
}
