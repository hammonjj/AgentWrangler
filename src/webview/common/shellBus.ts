/**
 * What the panes and the browser app shell (#133) tell each other, in the one
 * document they share.
 *
 * The panes do not know there is a shell, and must keep working without one
 * (a VSCode-style host has none): they only *announce* what they show and
 * *accept* requests to show something else. The shell (`workbench/shell.ts`)
 * listens to the announcements to keep the URL right, and makes the requests
 * when the URL changes.
 *
 * Announcements are remembered, so a listener that subscribes late (the shell
 * evaluates after both panes) still hears the latest one.
 *
 * Browser-only; no messages cross the wire here.
 */

import type { AppRoute, DashboardTableView, TableRouteView } from '../../shared/appRoutes';

type Listener<T> = (value: T) => void;

/** A value with a last-known state: late subscribers get it at once. */
function topic<T>() {
  const listeners = new Set<Listener<T>>();
  let last: { value: T } | undefined;
  return {
    emit(value: T): void {
      last = { value };
      for (const l of [...listeners]) l(value);
    },
    on(listener: Listener<T>, replay = true): () => void {
      listeners.add(listener);
      if (replay && last) listener(last.value);
      return () => listeners.delete(listener);
    },
  };
}

// ---- the table's view ----

export interface TableViewAnnouncement {
  view: DashboardTableView;
  /** A tab was clicked (or a mission chip): a navigation, not a repaint. */
  user: boolean;
  /** The table has had a snapshot, so it knows whether Missions exists. */
  settled: boolean;
  /** Missions and Analytics exist: orchestration is on. */
  hasMissions: boolean;
}

const tableViewShown = topic<TableViewAnnouncement>();
const tableViewWanted = topic<TableRouteView>();

/** The dashboard: this is the view on screen now. Cheap to repeat; listeners de-duplicate. */
export const announceTableView = (a: TableViewAnnouncement): void => tableViewShown.emit(a);
export const onTableViewShown = (l: Listener<TableViewAnnouncement>): (() => void) => tableViewShown.on(l);

/** The shell: switch the table to this view. Not replayed: a request is a moment. */
export const requestTableView = (view: TableRouteView): void => tableViewWanted.emit(view);
export const onTableViewRequest = (l: Listener<TableRouteView>): (() => void) => tableViewWanted.on(l, false);

// ---- the conversation ----

export interface ConversationAnnouncement {
  key: string;
  /** The same conversation's key before this one, when it changed key in place. */
  previous?: string;
}

const conversationShown = topic<ConversationAnnouncement>();

/** The conversation pane: it is showing this session now. */
export const announceConversation = (a: ConversationAnnouncement): void => conversationShown.emit(a);
export const onConversationShown = (l: Listener<ConversationAnnouncement>): (() => void) => conversationShown.on(l);

// ---- routes, for code outside the shell ----

const routeWanted = topic<AppRoute>();

/**
 * Go to a route of the browser shell, as if a link to it were followed. Does
 * nothing where there is no shell. For the pairing UI
 * (#137): `openRoute({ kind: 'pair' })`.
 */
export const openRoute = (route: AppRoute): void => routeWanted.emit(route);
export const onOpenRoute = (l: Listener<AppRoute>): (() => void) => routeWanted.on(l, false);

/**
 * Pages of the shell's own (Preferences, Pair a device) draw a placeholder
 * until something mounts real content: `registerPage('pair', (root) => …)` is
 * called with the page's content element each time the page is shown.
 */
export type PageKind = Extract<AppRoute['kind'], 'preferences' | 'pair'>;
const pages = new Map<PageKind, (root: HTMLElement) => void>();

export function registerPage(kind: PageKind, mount: (root: HTMLElement) => void): void {
  pages.set(kind, mount);
}

export function pageMounter(kind: PageKind): ((root: HTMLElement) => void) | undefined {
  return pages.get(kind);
}
