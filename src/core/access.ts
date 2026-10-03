/**
 * Who is acting, through what, and whether they may (#123).
 *
 * Agent Wrangler has one user. This module does not change that: there is no
 * login, no account and no role. What it adds is the *boundary* accounts would
 * need, so that adding them later is a change of policy and storage rather
 * than a hunt for every place an action can start (`docs/plans/
 * browser-workbench.md` §9):
 *
 * - every request carries a `RequestContext` naming its `Principal` and the
 *   channel it came through (`via`);
 * - every dispatcher calls `authorize` once per request, before anything in
 *   `SessionActions` or orchestration runs. The dispatchers are the pane hosts
 *   (`DashboardHost`, `ConversationHost`), the control socket's backend, the
 *   remote-control service and the app's end of the remote daemon;
 * - every mutating action that passes, and every refusal, leaves an audit line
 *   with the principal and `via`. Ids only, never content.
 *
 * The single-user policy allows the owner and denies everything else. The
 * point is the call site, not the policy.
 *
 * **Device and connection ids are attribution, never identity.** A context
 * carries them so the audit can say which tab or which paired phone acted, and
 * so later work (#126) can send a prompt back to the connection that caused
 * it. `authorize` does not read them. A device is *bound to* a principal at
 * pairing; it does not become one.
 *
 * Ownership, for whoever adds accounts (plan §9). Everything below is shared by
 * the machine today, and the left column stays shared:
 *
 * | Host-wide (stays shared) | Potentially user-owned later |
 * |---|---|
 * | Agent runtimes, session hosts, hooks, Codex, local model endpoints, orchestration and routing policy, remote-control config, secrets, the web listener and devices list, nicknames (labels on shared sessions) | Column prefs, favourite and hidden projects, notification preferences, view state (already per browser), drafts. Arguably sessions and missions themselves (an `owner` field defaulting to `local-owner`). |
 *
 * Adding accounts would then mean a principal store and login, keying the
 * right-hand column by principal (migrating today's values to `local-owner`),
 * an `owner` on sessions and missions, and a real policy in `authorize`. None
 * of that is built.
 *
 * Kept here rather than in `src/shared/`: no webview needs these types. A
 * browser never asserts who it is; the daemon decides that from its credential.
 */

/** Branded so a session id, device id or Discord user id cannot be passed where a principal is meant. */
export type PrincipalId = string & { readonly __principal: true };

export interface Principal {
  readonly id: PrincipalId;
  /** Only one kind today. A second kind is where roles would start. */
  readonly kind: 'owner';
}

/** The one principal there is: whoever owns this Mac's Agent Wrangler. */
export const LOCAL_OWNER: Principal = Object.freeze({ id: 'local-owner' as PrincipalId, kind: 'owner' as const });

/**
 * The channel a request arrived through.
 *
 * - `browser`: a workbench client: the window today, a browser tab later. The
 *   window's own menu and tray count as this too, until Electron is retired.
 * - `cli`: the `aw` command over the control socket.
 * - `discord`: a press on a remote-control card, from an allow-listed user.
 * - `daemon`: the app acting on its own (auto-pause), with nobody's click behind it.
 */
export type Via = 'browser' | 'cli' | 'discord' | 'daemon';

export interface RequestContext {
  readonly principal: Principal;
  readonly via: Via;
  /** Browser: which paired device. Attribution only, never identity. */
  readonly deviceId?: string;
  /** Browser: which tab. Attribution only, never identity. */
  readonly connectionId?: string;
}

/** A context for the owner, through `via`. Device and connection ids ride along for the audit only. */
export function ownerContext(via: Via, ids: { deviceId?: string; connectionId?: string } = {}): RequestContext {
  return Object.freeze({
    principal: LOCAL_OWNER,
    via,
    ...(ids.deviceId !== undefined ? { deviceId: ids.deviceId } : {}),
    ...(ids.connectionId !== undefined ? { connectionId: ids.connectionId } : {}),
  });
}

/**
 * What an action does, which decides whether it is audited.
 *
 * - `read`: looks, changes nothing (a snapshot, a transcript page, a list).
 * - `ui`: changes only what the requester sees, or uses this Mac's own UI on
 *   its behalf (opening a pane, a URL or a file, copying an id, dictation).
 * - `mutate`: changes sessions, missions, settings or files. Audited.
 */
export type ActionKind = 'read' | 'ui' | 'mutate';

/**
 * Every action a dispatcher can authorise, and its kind. Coarse on purpose: a
 * policy would grant these, and a list of one per button would be a list
 * nobody could write a policy against.
 */
export const ACTIONS = {
  'view.read': 'read',
  'session.open': 'ui',
  'host.open': 'ui',
  'dictation.use': 'ui',
  'session.start': 'mutate',
  'session.send': 'mutate',
  'session.interrupt': 'mutate',
  /** Answer a permission prompt, a question or a plan. */
  'session.decide': 'mutate',
  /** Permission mode, model, effort of a running session. */
  'session.configure': 'mutate',
  'session.adopt': 'mutate',
  'session.release': 'mutate',
  'session.resume': 'mutate',
  'session.close': 'mutate',
  'session.pause': 'mutate',
  'session.rename': 'mutate',
  'session.archive': 'mutate',
  'sessions.pauseAll': 'mutate',
  'hooks.install': 'mutate',
  /** Host-wide settings (runner defaults, Discord on/off). */
  'settings.write': 'mutate',
  /** Potentially user-owned preferences: columns, favourite and hidden projects. */
  'prefs.write': 'mutate',
  'task.propose': 'mutate',
  'task.delegate': 'mutate',
  'task.act': 'mutate',
  'mission.create': 'mutate',
  'mission.act': 'mutate',
  'routing.decide': 'mutate',
  /** Mint a single-use browser login link (`aw web open`, #127). */
  'web.link': 'mutate',
  /** Exchange a login link, or a device cookie at `/login`, for a signed-in browser (#127). */
  'web.login': 'mutate',
  /** A browser became a new device: a credential was issued and stored (#127). */
  'web.device.add': 'mutate',
  /** A remote browser put a file on the host (#139). Audited with the size, never the name. */
  'file.upload': 'mutate',
  /** A remote browser took a file off the host (#139). Audited by an id of the file, never its path. */
  'file.download': 'mutate',
  /** A remote browser listed host directories to choose a folder (#139). */
  'dirs.list': 'read',
} as const satisfies Record<string, ActionKind>;

export type ActionName = keyof typeof ACTIONS;

export function actionKind(action: ActionName): ActionKind {
  return ACTIONS[action];
}

/** What an action is about, by id. Never a path or any content: it is written to the audit log. */
export interface ResourceRef {
  readonly kind: 'session' | 'mission' | 'setting' | 'proposal' | 'device' | 'file';
  readonly id: string;
  /** A file's size in bytes (#139). A number says nothing about what is in it. */
  readonly size?: number;
}

export type AccessDecision = 'allow' | 'deny';

export type Authorizer = (ctx: RequestContext, action: ActionName, resource?: ResourceRef) => AccessDecision;

/**
 * The single-user policy: the owner may do anything, nobody else anything.
 *
 * Reads the principal and nothing else, which is what keeps a device or
 * connection id from ever standing in for an identity.
 */
export const authorize: Authorizer = (ctx) =>
  ctx.principal.kind === 'owner' && ctx.principal.id === LOCAL_OWNER.id ? 'allow' : 'deny';

/** One audit line for an access decision. Ids only. */
export interface AccessAuditRecord {
  /** `login-failed`: a login that named nobody (a bad, used or expired link). It has no principal. */
  event: 'authorized' | 'refused-unauthorised' | 'login-failed';
  /** Absent only on `login-failed`: nobody was identified. */
  principal?: PrincipalId;
  via: Via;
  action: ActionName;
  resource?: ResourceRef;
  deviceId?: string;
  connectionId?: string;
  /** `login-failed` only: why, in a word. */
  outcome?: string;
}

/** Where access lines go. `FileAuditLog` is one; tests use an array. */
export interface AccessAudit {
  write(record: AccessAuditRecord): void;
}

/**
 * `authorize` plus the audit, as dispatchers use it: one call per request,
 * `true` to go ahead.
 *
 * Mutating actions are audited whether they pass or not; reads and UI actions
 * only when refused, because a line per row click would bury the lines that
 * matter.
 */
export interface AccessGate {
  admit(ctx: RequestContext, action: ActionName, resource?: ResourceRef): boolean;
  /**
   * A credential that identified nobody (#127): a login link that is unknown,
   * used or expired. There is no principal to authorise, so it is only
   * audited, always. `outcome` is a word ("invalid", "expired"), never the
   * credential.
   */
  loginFailed(via: Via, outcome: string): void;
}

export function createAccessGate(opts: { authorize?: Authorizer; audit?: AccessAudit; log?: (message: string) => void } = {}): AccessGate {
  const decide = opts.authorize ?? authorize;
  return {
    admit(ctx, action, resource) {
      const decision = decide(ctx, action, resource);
      if (decision === 'allow' && actionKind(action) !== 'mutate') return true;
      opts.audit?.write({
        event: decision === 'allow' ? 'authorized' : 'refused-unauthorised',
        principal: ctx.principal.id,
        via: ctx.via,
        action,
        ...(resource
          ? { resource: { kind: resource.kind, id: resource.id, ...(resource.size !== undefined ? { size: resource.size } : {}) } }
          : {}),
        ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
        ...(ctx.connectionId !== undefined ? { connectionId: ctx.connectionId } : {}),
      });
      if (decision === 'deny') opts.log?.(`access: refused ${action} via ${ctx.via} for ${ctx.principal.id}`);
      return decision === 'allow';
    },
    loginFailed(via, outcome) {
      opts.audit?.write({ event: 'login-failed', via, action: 'web.login', outcome });
    },
  };
}

/**
 * A dispatcher's standing access: the context its requests are made in and the
 * gate they pass. Supplied by whoever creates the dispatcher, so a per-connection
 * context can replace the window's one without the dispatcher changing.
 */
export interface BoundAccess {
  readonly context: RequestContext;
  readonly gate: AccessGate;
}

/** What one request asks to do, as a dispatcher classifies it before acting. */
export interface AccessRequest {
  action: ActionName;
  resource?: ResourceRef;
}

/** A session, as a resource. Absent key, absent resource. */
export function sessionRef(key: string | undefined): ResourceRef | undefined {
  return key ? { kind: 'session', id: key } : undefined;
}
