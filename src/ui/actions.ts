/** Session actions shared by the dashboard webview, conversation panes, and palette commands. */
export interface SessionActions {
  /** Row click: show this session in the conversation pane (see `OpenTarget`). */
  smartOpen(key: string): void;
  /**
   * The pane's way out: reveal the Claude Code panel, terminal or VSCode window
   * that actually runs this session. This is the behaviour a row click used to
   * have, kept as a deliberate action rather than an accident of clicking.
   */
  goTo(key: string): void;
  /** Open a conversation panel of this session's own, which is never swapped away. */
  pin(key: string): void;
  /**
   * Hand a session this window is running back to a terminal: end our process,
   * then resume the same id there. The conversation lives in the transcript, so
   * nothing is lost in the handover.
   */
  release(key: string): void;
  resume(key: string): void;
  copyId(key: string): void;
  reveal(key: string): void;
  refreshAll(): void;
  openExternal(url: string): void;
  /** Open a file the conversation mentions (a tool's target) in the editor. */
  openFile(path: string): void;
  /** Dashboard banner → the `agentWrangler.installHooks` command (modal confirm included). */
  installHooks(): void;
  /**
   * Answer the permission prompt a blocked session is sitting on, from the
   * dashboard. `always` allows and adds the rule, as Claude Code's own
   * "don't ask again" does.
   */
  decidePermission(key: string, behavior: 'allow' | 'deny' | 'always'): void;
}
