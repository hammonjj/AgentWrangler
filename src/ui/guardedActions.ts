/**
 * `SessionActions` behind the access gate, for callers that call actions
 * directly instead of dispatching messages: the window's menu and tray, and the
 * app's end of the remote daemon (#123).
 *
 * The pane hosts do not use this. They authorise each *message* (which may do
 * more than call an action: write a setting, run a mission), so wrapping their
 * actions as well would authorise and audit everything twice.
 */
import { sessionRef, type ActionName, type BoundAccess } from '../core/access';
import type { SessionActions } from './actions';

/** Each action's name for `authorize`. A mapped type, so a new action cannot compile without one. */
export const SESSION_ACTION_NAMES: { readonly [K in keyof SessionActions]: ActionName } = {
  smartOpen: 'session.open',
  openInTab: 'session.open',
  rename: 'session.rename',
  adopt: 'session.adopt',
  adoptAndSend: 'session.send',
  release: 'session.release',
  closeSession: 'session.close',
  pauseSession: 'session.pause',
  pauseAll: 'sessions.pauseAll',
  resume: 'session.resume',
  copyId: 'host.open',
  reveal: 'host.open',
  refreshAll: 'view.read',
  openExternal: 'host.open',
  openFile: 'host.open',
  installHooks: 'hooks.install',
  decidePermission: 'session.decide',
  answerQuestion: 'session.decide',
  decidePlan: 'session.decide',
};

/** A refused action that has a caller waiting on its outcome. */
export class AccessDeniedError extends Error {
  constructor(action: ActionName) {
    super(`Not permitted: ${action}`);
    this.name = 'AccessDeniedError';
  }
}

/**
 * The same actions, each authorised in `access` before it runs. A refused
 * action does nothing: a fire-and-forget one returns, `closeSession` resolves
 * `false` (nothing was closed), and the rest reject with `AccessDeniedError`,
 * because their callers report an outcome and "applied" would be a lie.
 */
export function guardSessionActions(actions: SessionActions, access: BoundAccess): SessionActions {
  const ok = (action: ActionName, key?: string) => access.gate.admit(access.context, action, sessionRef(key));
  const n = SESSION_ACTION_NAMES;
  const denied = (action: ActionName) => Promise.reject(new AccessDeniedError(action));
  return {
    smartOpen: (key) => void (ok(n.smartOpen, key) && actions.smartOpen(key)),
    openInTab: (key) => void (ok(n.openInTab, key) && actions.openInTab(key)),
    rename: (key) => void (ok(n.rename, key) && actions.rename(key)),
    adopt: (key) => void (ok(n.adopt, key) && actions.adopt(key)),
    adoptAndSend: (key, text, images, signal) =>
      ok(n.adoptAndSend, key) ? actions.adoptAndSend(key, text, images, signal) : denied(n.adoptAndSend),
    release: (key) => void (ok(n.release, key) && actions.release(key)),
    closeSession: (key, opts) => (ok(n.closeSession, key) ? actions.closeSession(key, opts) : Promise.resolve(false)),
    pauseSession: (key, pause) => void (ok(n.pauseSession, key) && actions.pauseSession(key, pause)),
    pauseAll: (pause) => void (ok(n.pauseAll) && actions.pauseAll(pause)),
    resume: (key) => void (ok(n.resume, key) && actions.resume(key)),
    copyId: (key) => void (ok(n.copyId, key) && actions.copyId(key)),
    reveal: (key) => void (ok(n.reveal, key) && actions.reveal(key)),
    refreshAll: () => void (ok(n.refreshAll) && actions.refreshAll()),
    openExternal: (url) => void (ok(n.openExternal) && actions.openExternal(url)),
    openFile: (file) => void (ok(n.openFile) && actions.openFile(file)),
    installHooks: () => void (ok(n.installHooks) && actions.installHooks()),
    decidePermission: (key, behavior, opts) =>
      ok(n.decidePermission, key) ? actions.decidePermission(key, behavior, opts) : denied(n.decidePermission),
    answerQuestion: (key, requestId, answers) =>
      ok(n.answerQuestion, key) ? actions.answerQuestion(key, requestId, answers) : denied(n.answerQuestion),
    decidePlan: (key, requestId, approve, feedback) =>
      ok(n.decidePlan, key) ? actions.decidePlan(key, requestId, approve, feedback) : denied(n.decidePlan),
  };
}
