import type { ImageAttachment } from '../shared/conversation';

/**
 * What answering a permission prompt did.
 *
 * `stale` and `gone` are deliberately separate: `stale` means the session has
 * since moved on to a *different* prompt and this answer was for the previous
 * one, `gone` means the prompt this answer was for is simply over (answered in
 * Claude Code's own dialog, or the hook script gave up waiting). The first is
 * worth telling the user about differently from the second, and only the first
 * indicates a button that was on screen longer than it should have been.
 */
export type PermissionDecisionOutcome = 'applied' | 'stale' | 'gone' | 'unsupported';

/** Session actions shared by the dashboard webview, conversation panes, and palette commands. */
export interface SessionActions {
  /** Row click: show this session in the conversation pane (see `OpenTarget`). */
  smartOpen(key: string): void;
  /**
   * Open a conversation panel of this session's own, which is never swapped
   * away. Called `pin` until pinning a dashboard *row* needed that name.
   */
  openInTab(key: string): void;
  /** Ask the user what to call this conversation; blank clears back to its own title. */
  rename(key: string): void;
  /**
   * Pull a session into this window: end whatever process runs it, then resume
   * the same id here. Only offered for an idle or ended session — a turn in
   * flight would be thrown away. An ended one has nothing to end first.
   */
  adopt(key: string): void;
  adoptAndSend(key: string, text: string, images: ImageAttachment[] | undefined, signal: AbortSignal): Promise<void>;
  /**
   * The opposite: hand a session this window is running back to a terminal.
   * The conversation lives in the transcript, so nothing is lost either way.
   */
  release(key: string): void;
  /**
   * End the process running a session, leaving the session itself intact: the
   * row moves to Ended and `claude --resume` picks the conversation up where it
   * stopped, because the conversation *is* the transcript.
   *
   * Unlike `adopt` this is offered while a turn is in flight — a wedged agent
   * is the main reason to reach for it — so the implementation confirms first
   * and says plainly when a turn is about to be thrown away.
   */
  closeSession(key: string): void;
  /**
   * Freeze one session's process, or thaw it. Unlike `closeSession` this keeps
   * the process — it simply stops running — so it is offered without a confirm:
   * the cost of getting it wrong is one click to undo.
   */
  pauseSession(key: string, pause: boolean): void;
  /**
   * The same across every running agent on the machine, for when the plan is
   * nearly spent. `pause: false` thaws everything currently frozen.
   */
  pauseAll(pause: boolean): void;
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
   * Answer the permission prompt a blocked session is sitting on. `always`
   * allows and adds the rule, as Claude Code's own "don't ask again" does.
   *
   * This is the one way a permission is answered from outside Claude Code —
   * the dashboard row, the conversation pane's card, and anything else that
   * grows a button for it all come through here, so the guard below is applied
   * once rather than per surface.
   *
   * `expectedRequestId` is the prompt the caller rendered its button from
   * (`AgentSession.permissionRequestId`). Pass it whenever you have it: a
   * button can outlive the prompt it was drawn for, and without it the answer
   * would land on whatever prompt the session has open *now*.
   */
  decidePermission(
    key: string,
    behavior: 'allow' | 'deny' | 'always',
    opts?: { expectedRequestId?: string },
  ): Promise<PermissionDecisionOutcome>;
}
