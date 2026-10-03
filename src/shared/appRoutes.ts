/**
 * The browser app shell's routes (#133, plan §5): which screen a URL means,
 * which panes a viewport shows for it, and how the shell keeps the URL, the
 * table's view and the conversation in step.
 *
 * Routes live in the hash (`#/missions`, `#/c/<key>`). The server serves the
 * page only at `/`, so a path router would need it to answer every route with
 * the same document; a hash never reaches the server, survives a reload and
 * gives the back button something to go back to.
 *
 * Everything here is pure: the DOM half is `src/webview/workbench/shell.ts`,
 * which feeds `routerStep` what happened and carries out the effects it returns.
 * No Node or DOM imports (`src/shared`).
 */

export type AppRoute =
  | { kind: 'agents' }
  | { kind: 'missions' }
  | { kind: 'analytics' }
  /** No key: whatever the conversation pane is showing (an analytics detail has none). */
  | { kind: 'conversation'; key?: string }
  /** Preferences, mounted by `webview/preferences/pane.ts` (#135). */
  | { kind: 'preferences' }
  /** Pairing a device (#137): a page the pairing UI mounts into. */
  | { kind: 'pair' };

export type RouteKind = AppRoute['kind'];

/** The routes the table pane draws: its session views, Missions and Analytics. */
export type TableRoute = Extract<AppRoute, { kind: 'agents' | 'missions' | 'analytics' }>;

/**
 * The table's views as the shell names them. `sessions` is Status or Project,
 * whichever the table last used: the URL does not care how rows are grouped.
 */
export type TableRouteView = 'sessions' | 'missions' | 'analytics';

/** The dashboard's own view names (`TableView` in `dashboard/main.ts`). */
export type DashboardTableView = 'status' | 'project' | 'missions' | 'analytics';

export function parseRoute(hash: string): AppRoute {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const [head = '', ...rest] = path.split('/');
  switch (head) {
    case '':
    case 'agents':
      return { kind: 'agents' };
    case 'missions':
      return { kind: 'missions' };
    case 'analytics':
      return { kind: 'analytics' };
    case 'preferences':
      return rest[0] === 'pair' ? { kind: 'pair' } : { kind: 'preferences' };
    case 'pair':
      return { kind: 'pair' };
    case 'c': {
      const raw = rest.join('/');
      if (!raw) return { kind: 'conversation' };
      try {
        return { kind: 'conversation', key: decodeURIComponent(raw) };
      } catch {
        return { kind: 'conversation' }; // a malformed escape: not a key we could have written
      }
    }
    default:
      return { kind: 'agents' };
  }
}

export function formatRoute(route: AppRoute): string {
  switch (route.kind) {
    case 'agents':
      return '#/';
    case 'conversation':
      return route.key ? `#/c/${encodeURIComponent(route.key)}` : '#/c';
    case 'pair':
      return '#/preferences/pair';
    default:
      return `#/${route.kind}`;
  }
}

export function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return formatRoute(a) === formatRoute(b);
}

/** What the route's heading says, and what the tab's title starts with. */
export function routeTitle(route: AppRoute): string {
  switch (route.kind) {
    case 'agents':
      return 'Agents';
    case 'missions':
      return 'Missions';
    case 'analytics':
      return 'Analytics';
    case 'conversation':
      return 'Conversation';
    case 'preferences':
      return 'Preferences';
    case 'pair':
      return 'Pair a device';
  }
}

export function isTableRoute(route: AppRoute): route is TableRoute {
  return route.kind === 'agents' || route.kind === 'missions' || route.kind === 'analytics';
}

export function tableViewOf(route: TableRoute): TableRouteView {
  return route.kind === 'agents' ? 'sessions' : route.kind;
}

export function routeOfTableView(view: TableRouteView | DashboardTableView): TableRoute {
  if (view === 'missions' || view === 'analytics') return { kind: view };
  return { kind: 'agents' };
}

export function shellTableView(view: DashboardTableView): TableRouteView {
  return view === 'missions' || view === 'analytics' ? view : 'sessions';
}

// ---- layout ----

/**
 * At or above this viewport width the shell shows today's split; below it, one
 * pane at a time. The viewport, not a pane: the shell owns the window, the
 * panes still size off themselves. Two panes at their 260 px floor plus room
 * to drag is about this.
 */
export const SPLIT_MIN_VIEWPORT_PX = 800;

export type ShellLayout = 'split' | 'single';

export function layoutFor(viewportWidth: number): ShellLayout {
  return viewportWidth >= SPLIT_MIN_VIEWPORT_PX ? 'split' : 'single';
}

/** What is on screen: both panes, one of them, or a page of the shell's own. */
export type ShellSurface = 'split' | 'table' | 'conversation' | 'page';

export function surfaceFor(route: AppRoute, layout: ShellLayout): ShellSurface {
  if (route.kind === 'preferences' || route.kind === 'pair') return 'page';
  if (layout === 'split') return 'split';
  return route.kind === 'conversation' ? 'conversation' : 'table';
}

/**
 * Where the shell's Back button goes from a route that hides the table:
 * the table view last used, or Preferences from a page under it.
 */
export function backRoute(route: AppRoute, tableView: TableRouteView | undefined): AppRoute | undefined {
  switch (route.kind) {
    case 'conversation':
    case 'preferences':
      return routeOfTableView(tableView ?? 'sessions');
    case 'pair':
      return { kind: 'preferences' };
    default:
      return undefined;
  }
}

// ---- the router ----

export interface RouterState {
  route: AppRoute;
  /** The conversation the pane last said it is showing. */
  shownKey?: string;
  /** A conversation the shell asked for and has not seen arrive yet. */
  requestedKey?: string;
  /** The table's view as it last said; undefined before it has said. */
  tableView?: TableRouteView;
}

export type RouterEffect =
  /** Write the URL. Never fires `hashchange`: `pushState`/`replaceState`. */
  | { type: 'history'; mode: 'push' | 'replace'; route: AppRoute }
  /** Point the conversation pane at this session, as a row click does. */
  | { type: 'showConversation'; key: string }
  /** Switch the table to this view. */
  | { type: 'tableView'; view: TableRouteView }
  /** Move focus to the route's heading. */
  | { type: 'focusHeading' };

export type RouterInput =
  /** The page loaded on this URL; the conversation pane remembered `savedKey`. */
  | { type: 'start'; route: AppRoute; savedKey?: string }
  /** The URL changed under the shell: back, forward, a link, a typed hash. */
  | { type: 'hash'; route: AppRoute }
  /** The shell itself goes somewhere: its Back button, `openRoute`. */
  | { type: 'go'; route: AppRoute; replace?: boolean }
  /** The host pointed this client's conversation somewhere (`navigate` on the shell channel). */
  | { type: 'navigate'; target: 'conversation' | 'workbench'; key?: string }
  /** The conversation pane is showing `key` now; `previous` when the same conversation changed key. */
  | { type: 'conversationShown'; key: string; previous?: string }
  /**
   * The table is on `view`. `user`: because someone clicked its tab. `settled`:
   * the table has had a snapshot, so it knows whether Missions exists at all.
   */
  | { type: 'tableViewShown'; view: TableRouteView; user: boolean; settled: boolean };

export interface RouterStep {
  state: RouterState;
  effects: RouterEffect[];
}

export function initialRouterState(): RouterState {
  return { route: { kind: 'agents' } };
}

/**
 * Go to `route`: say which pane needs pointing where, and write the URL if
 * `history` says to. `focus` moves focus to the new route's heading when the
 * route actually changed.
 */
function apply(state: RouterState, route: AppRoute, history: 'push' | 'replace' | 'none', focus: boolean): RouterStep {
  const effects: RouterEffect[] = [];
  const next: RouterState = { ...state, route };
  if (isTableRoute(route)) {
    const view = tableViewOf(route);
    if (state.tableView !== view) effects.push({ type: 'tableView', view });
  }
  if (route.kind === 'conversation' && route.key && route.key !== state.shownKey && route.key !== state.requestedKey) {
    effects.push({ type: 'showConversation', key: route.key });
    next.requestedKey = route.key;
  }
  const changed = !sameRoute(state.route, route);
  if (history !== 'none' && changed) effects.push({ type: 'history', mode: history, route });
  if (focus && changed) effects.push({ type: 'focusHeading' });
  return { state: next, effects };
}

export function routerStep(state: RouterState, input: RouterInput): RouterStep {
  switch (input.type) {
    case 'start':
      // The URL is already right, and focus stays where the browser put it.
      return apply({ ...state, shownKey: input.savedKey }, input.route, 'none', false);
    case 'hash':
      return apply(state, input.route, 'none', true);
    case 'go':
      return apply(state, input.route, input.replace ? 'replace' : 'push', true);
    case 'navigate': {
      if (input.target === 'workbench') {
        // The app was asked to come forward; a page hides the panes it means.
        if (state.route.kind === 'preferences' || state.route.kind === 'pair') {
          return apply(state, routeOfTableView(state.tableView ?? 'sessions'), 'push', true);
        }
        return { state, effects: [] };
      }
      // The host has already pointed the pane: nothing to ask for, only the URL to follow.
      const route: AppRoute = input.key ? { kind: 'conversation', key: input.key } : { kind: 'conversation' };
      const cleared: RouterState = { ...state, requestedKey: undefined, shownKey: input.key ?? state.shownKey };
      return apply(cleared, route, 'push', true);
    }
    case 'conversationShown': {
      const next: RouterState = { ...state, shownKey: input.key };
      if (state.requestedKey === input.key) next.requestedKey = undefined;
      const route = state.route;
      if (route.kind !== 'conversation') return { state: next, effects: [] };
      // The same conversation under a new id (a runner's `pending` id, a resume):
      // the URL follows it, in place.
      const rekeyed = input.previous !== undefined && route.key === input.previous;
      // Something else was shown while the shell waits for the one it asked for:
      // the URL keeps naming that one.
      const waiting = next.requestedKey !== undefined && !rekeyed;
      if (route.key === input.key || waiting) return { state: next, effects: [] };
      const to: AppRoute = { kind: 'conversation', key: input.key };
      return { state: { ...next, route: to }, effects: [{ type: 'history', mode: 'replace', route: to }] };
    }
    case 'tableViewShown': {
      const next: RouterState = { ...state, tableView: input.view };
      const route = routeOfTableView(input.view);
      if (input.user) {
        if (sameRoute(state.route, route)) return { state: next, effects: [] };
        // Clicking a tab is navigating: back undoes it. Focus stays on the tab.
        return { state: { ...next, route }, effects: [{ type: 'history', mode: 'push', route }] };
      }
      // The table fell back on its own (Missions with orchestration off): the
      // URL says what is on screen, without a history entry nobody asked for.
      if (isTableRoute(state.route) && input.settled && !sameRoute(state.route, route)) {
        return { state: { ...next, route }, effects: [{ type: 'history', mode: 'replace', route }] };
      }
      return { state: next, effects: [] };
    }
  }
}
