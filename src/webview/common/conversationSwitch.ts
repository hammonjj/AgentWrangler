/**
 * A row click or "+ New" (table pane) tells the conversation pane, on the same
 * page, what it is about to show. The host answers with the conversation only
 * after a round trip to the Mac, which over the remote-control relay takes
 * seconds; until then the pane went on showing the previous conversation under
 * no sign that a click had landed. With this it clears at once and says what it
 * is opening. The panes share a page but not modules' state, so the hand-off
 * lives here, as `composerFocus` does.
 */

export interface ConversationSwitch {
  /** The row's key; absent for a conversation that does not exist yet ("+ New"). */
  key?: string;
  title: string;
}

let listener: ((to: ConversationSwitch) => void) | undefined;

export function announceSwitch(to: ConversationSwitch): void {
  listener?.(to);
}

/** The conversation pane's; there is one per page. */
export function onSwitch(l: (to: ConversationSwitch) => void): void {
  listener = l;
}
