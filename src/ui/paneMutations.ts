/**
 * Whether a pane message changes something, by the classification the pane
 * hosts authorise with (#123). The browser connection remembers those by
 * `commandId`, so a resend after a drop is not acted on twice (#128). A
 * message the classifiers do not know is a mutation there, and here.
 */
import { actionKind } from '../core/access';
import type { ConversationToHost, DashboardToHost } from '../shared/messages';
import { conversationRequest } from './conversation/conversationHost';
import type { PreferencesToHost } from '../shared/preferences';
import { dashboardRequest } from './dashboardHost';
import { preferencesRequest } from './preferencesHost';

export function isMutatingPaneMessage(pane: string, body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  if (pane === 'dashboard') return actionKind(dashboardRequest(body as DashboardToHost).action) === 'mutate';
  if (pane === 'conversation') return actionKind(conversationRequest(body as ConversationToHost, undefined).action) === 'mutate';
  if (pane === 'preferences') return actionKind(preferencesRequest(body as PreferencesToHost).action) === 'mutate';
  return false;
}
