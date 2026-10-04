/**
 * "+ New" (table pane) asks the conversation pane to put the cursor in its
 * composer once the new conversation opens. The panes share a page but not
 * modules' state, so the request lives here. It expires, so a conversation
 * opened later for another reason does not steal focus.
 */

const WINDOW_MS = 15_000;

let requestedAt = 0;

export function requestComposerFocus(): void {
  requestedAt = Date.now();
}

/** True once per request, and only while it is fresh. */
export function takeComposerFocus(): boolean {
  const fresh = requestedAt > 0 && Date.now() - requestedAt < WINDOW_MS;
  requestedAt = 0;
  return fresh;
}
