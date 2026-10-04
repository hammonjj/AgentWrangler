/**
 * The app shell (#133, plan §5): what turns the workbench into an app that
 * works without a native window around it.
 *
 * - **Shell channel**, in every host: prompts become in-page modals
 *   (`modalHost.ts`), toasts go to the toast host.
 * - **Routes**, in the browser only: Agents, Conversation (`#/c/<key>`),
 *   Missions, Analytics, Preferences and Pair a device, in the URL's hash, with
 *   a bar of links and a heading. The back button works; a route change moves
 *   focus to its heading.
 * - **Layout**, in the browser only: at or above `SPLIT_MIN_VIEWPORT_PX` the
 *   split as it is; below it one pane at a time, with a Back button between
 *   the conversation and the table. The shell may measure the viewport because
 *   it owns the window; the panes still size off themselves (`#app.narrow`).
 *
 * The routing decisions are `src/shared/appRoutes.ts`, pure and tested; this
 * file feeds it events and carries out its effects. The panes are told and
 * heard through `common/shellBus.ts` and never know the shell is there.
 */

import {
  SPLIT_MIN_VIEWPORT_PX,
  backRoute,
  formatRoute,
  initialRouterState,
  layoutFor,
  parseRoute,
  routeTitle,
  routerStep,
  shellTableView,
  surfaceFor,
  type AppRoute,
  type RouterEffect,
  type RouterInput,
  type RouterState,
  type ShellSurface,
} from '../../shared/appRoutes';
import { paneApi, shellApi } from '../common/paneApi';
import {
  onConversationShown,
  onOpenRoute,
  onTableViewShown,
  pageMounter,
  requestTableView,
  type PageKind,
} from '../common/shellBus';
import { trackViewport } from '../common/phone';
import { createModalHost } from './modalHost';
import { showToast } from './toastHost';

const SURFACES: ShellSurface[] = ['split', 'table', 'conversation', 'page'];

/** `history.state` as the shell writes it: how many of its own entries are behind this one. */
interface HistoryMark {
  awDepth: number;
}

function depthOf(state: unknown): number | undefined {
  const d = (state as Partial<HistoryMark> | null)?.awDepth;
  return typeof d === 'number' && d >= 0 ? d : undefined;
}

/** Whether this tab is on the Mac itself: the only place pairing can be started (#137). */
export function isLoopbackBrowser(hostname: string = location.hostname): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Pair a device (#137): the server renders `/pair/new` itself, under its own
 * tight CSP, so this page leads to it in this tab and does not embed it. A
 * device on the LAN cannot start pairing at all.
 */
function mountPairPage(root: HTMLElement): void {
  const note = document.createElement('p');
  note.className = 'aw-page-note';
  root.appendChild(note);
  if (!isLoopbackBrowser()) {
    note.textContent = 'A device is paired from a browser on the Mac running Agent Wrangler. Open Agent Wrangler there, then Preferences, then Pair a device.';
    return;
  }
  note.textContent = 'Start pairing to get a five-minute code and QR code that signs another device in, such as a phone on your home network.';
  const p = document.createElement('p');
  const go = document.createElement('a');
  go.className = 'aw-page-button';
  go.href = '/pair/new';
  go.textContent = 'Start pairing a device';
  p.appendChild(go);
  root.appendChild(p);
}

/**
 * What the native window's menu carried (#146). Refresh and Install Status
 * Hooks are messages the table already handles; Remove Status Hooks and Restart
 * Codex Server go to the host as shell `appAction`s, where the host authorises
 * and confirms them.
 */
function actionsMenu(dashboard: ReturnType<typeof paneApi>): HTMLElement {
  const menu = document.createElement('details');
  menu.className = 'aw-actions';
  const summary = document.createElement('summary');
  summary.textContent = 'Actions';
  const list = document.createElement('div');
  list.className = 'aw-actions-list';
  list.setAttribute('role', 'menu');
  const item = (label: string, title: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'aw-actions-item';
    b.textContent = label;
    b.title = title;
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => {
      menu.open = false;
      run();
    });
    list.appendChild(b);
  };
  item('Refresh', 'Re-read every session now', () => dashboard.post({ type: 'refresh' }));
  item('Install status hooks', 'Let Claude Code report exact status', () => dashboard.post({ type: 'installHooks' }));
  item('Remove status hooks', "Take Agent Wrangler's hooks out of Claude Code's settings", () => shellApi.post({ type: 'appAction', action: 'removeHooks' }));
  item('Restart Codex server', 'Restart the background Codex server, to pick up a Codex update', () => shellApi.post({ type: 'appAction', action: 'restartCodex' }));
  menu.append(summary, list);
  // A menu closes on a click elsewhere and on Escape, like the native one did.
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    summary.focus();
  });
  return menu;
}

export function startAppShell(opts: { browser: boolean }): void {
  const wb = document.getElementById('wb') as HTMLElement;
  let router: ((input: RouterInput) => void) | undefined;

  const modals = createModalHost({
    send: (body) => shellApi.post(body),
    toast: showToast,
    background: () => [...document.body.children].filter((n): n is HTMLElement => n instanceof HTMLElement && n.id !== 'awToasts'),
    fallbackFocus: () => document.getElementById('awRouteTitle') ?? document.getElementById('wbSplit'),
  });

  shellApi.onMessage((m) => {
    switch (m.type) {
      case 'prompt':
      case 'promptCancel':
        modals.receive(m);
        return;
      case 'toast':
        showToast(m.text, m.timeoutMs);
        return;
      case 'navigate':
        router?.({ type: 'navigate', target: m.target, ...(m.key ? { key: m.key } : {}) });
        return;
      default:
        return; // the connection's own (`hello`, `ack`), handled by the shim
    }
  });
  // The host cancelled whatever it was asking when the socket dropped.
  shellApi.onReconnect(() => modals.reset());

  if (!opts.browser) return;
  trackViewport(); // the on-screen keyboard must not cover the composer (#134)
  router = startRouter(wb);
}

function startRouter(wb: HTMLElement): (input: RouterInput) => void {
  document.body.classList.add('aw-app');
  const dashboard = paneApi('dashboard');
  const conversationState = paneApi<{ key?: string }>('conversation');

  // ---- the bar: back, heading, links ----
  const bar = document.createElement('header');
  bar.id = 'awBar';
  bar.className = 'aw-bar';

  const back = document.createElement('button');
  back.id = 'awBack';
  back.type = 'button';
  back.className = 'aw-bar-back';
  back.hidden = true;

  const heading = document.createElement('h1');
  heading.id = 'awRouteTitle';
  heading.className = 'aw-bar-title';
  heading.tabIndex = -1;

  const nav = document.createElement('nav');
  nav.className = 'aw-nav';
  nav.setAttribute('aria-label', 'Sections');
  const link = (route: AppRoute, label: string) => {
    const a = document.createElement('a');
    a.href = formatRoute(route);
    a.textContent = label;
    a.dataset.route = route.kind;
    nav.appendChild(a);
    return a;
  };
  const links = {
    agents: link({ kind: 'agents' }, 'Agents'),
    conversation: link({ kind: 'conversation' }, 'Conversation'),
    missions: link({ kind: 'missions' }, 'Missions'),
    analytics: link({ kind: 'analytics' }, 'Analytics'),
    preferences: link({ kind: 'preferences' }, 'Preferences'),
  };
  bar.append(back, heading, nav, actionsMenu(dashboard));
  // First in the document, above the table's launcher: the first tab stop and
  // the first thing a screen reader meets.
  document.body.prepend(bar);
  wb.setAttribute('role', 'main');

  // ---- pages of the shell's own ----
  const page = document.createElement('section');
  page.id = 'awPage';
  page.className = 'aw-page';
  page.hidden = true;
  page.setAttribute('aria-labelledby', 'awPageTitle');
  const pageTitle = document.createElement('h2');
  pageTitle.id = 'awPageTitle';
  pageTitle.tabIndex = -1;
  const pageBody = document.createElement('div');
  pageBody.id = 'awPageBody';
  page.append(pageTitle, pageBody);
  wb.after(page);

  // The conversation's title is its heading: what focus lands on when a
  // conversation is opened. The pane fills in its text; the shell gives it the role.
  const convTitle = document.getElementById('ttl');
  convTitle?.setAttribute('role', 'heading');
  convTitle?.setAttribute('aria-level', '2');
  if (convTitle) convTitle.tabIndex = -1;

  // ---- state ----
  let state: RouterState = initialRouterState();
  let depth = depthOf(history.state) ?? 0;
  let hasMissions = true;
  let settled = false;
  const wide = window.matchMedia(`(min-width: ${SPLIT_MIN_VIEWPORT_PX}px)`);
  const layout = () => layoutFor(wide.matches ? SPLIT_MIN_VIEWPORT_PX : 0);

  function feed(input: RouterInput): void {
    const step = routerStep(state, input);
    state = step.state;
    let focus = false;
    for (const effect of step.effects) {
      if (effect.type === 'focusHeading') focus = true;
      else perform(effect);
    }
    paint();
    if (focus) focusHeading();
  }

  function perform(effect: Exclude<RouterEffect, { type: 'focusHeading' }>): void {
    switch (effect.type) {
      case 'history': {
        const url = formatRoute(effect.route);
        if (effect.mode === 'push') history.pushState({ awDepth: ++depth } satisfies HistoryMark, '', url);
        else history.replaceState({ awDepth: depth } satisfies HistoryMark, '', url);
        return;
      }
      case 'showConversation':
        // Exactly what clicking its row does: the host points this tab's conversation there.
        dashboard.post({ type: 'rowClick', key: effect.key });
        return;
      case 'tableView':
        requestTableView(effect.view);
        return;
    }
  }

  function paint(): void {
    const route = state.route;
    const surface = surfaceFor(route, layout());
    for (const s of SURFACES) document.body.classList.toggle(`aw-surface-${s}`, s === surface);
    page.hidden = surface !== 'page';

    const title = routeTitle(route);
    heading.textContent = title;
    document.title = `${title} · Agent Wrangler`;

    // Back only where the table is out of sight: a lone conversation, or a page.
    const target = surface === 'conversation' || surface === 'page' ? backRoute(route, state.tableView) : undefined;
    back.hidden = !target;
    if (target) {
      back.textContent = `‹ ${routeTitle(target)}`;
      back.setAttribute('aria-label', `Back to ${routeTitle(target)}`);
    }

    links.conversation.href = formatRoute(state.shownKey ? { kind: 'conversation', key: state.shownKey } : { kind: 'conversation' });
    links.missions.hidden = links.analytics.hidden = settled && !hasMissions;
    const current = route.kind === 'pair' ? 'preferences' : route.kind;
    for (const [kind, a] of Object.entries(links)) {
      if (kind === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }

    if (route.kind === 'preferences' || route.kind === 'pair') showPage(route.kind);
    else pageShown = undefined; // drawn afresh next time it is opened
  }

  let pageShown: PageKind | undefined;
  function showPage(kind: PageKind): void {
    if (pageShown === kind) return;
    pageShown = kind;
    pageTitle.textContent = routeTitle({ kind });
    pageBody.replaceChildren();
    const mount = pageMounter(kind);
    if (mount) {
      mount(pageBody);
      return;
    }
    // Placeholders until their stories land: Preferences (#135).
    const note = document.createElement('p');
    note.className = 'aw-page-note';
    if (kind === 'preferences') {
      note.textContent = 'Preferences are not available in the browser yet. Open them from Agent Wrangler on the Mac.';
      pageBody.appendChild(note);
      // Only a browser on the Mac can start pairing (#137): a link a LAN device could not use is noise.
      if (isLoopbackBrowser()) {
        const p = document.createElement('p');
        const pair = document.createElement('a');
        pair.href = formatRoute({ kind: 'pair' });
        pair.textContent = 'Pair a device';
        p.appendChild(pair);
        pageBody.appendChild(p);
      }
    } else {
      mountPairPage(pageBody);
    }
  }

  function focusHeading(): void {
    const route = state.route;
    let target: HTMLElement | null = heading;
    if (route.kind === 'preferences' || route.kind === 'pair') target = pageTitle;
    else if (route.kind === 'conversation' && convTitle?.textContent) target = convTitle;
    target.focus();
  }

  back.addEventListener('click', () => {
    const target = backRoute(state.route, state.tableView);
    if (!target) return;
    // The previous entry is one of ours: going back is what Back means.
    if (depth > 0) history.back();
    else feed({ type: 'go', route: target, replace: true });
  });

  // ---- what moves the route ----
  window.addEventListener('hashchange', () => {
    // A link or a typed hash makes an entry with no mark: it is one deeper.
    const marked = depthOf(history.state);
    if (marked === undefined) {
      depth++;
      history.replaceState({ awDepth: depth } satisfies HistoryMark, '');
    } else {
      depth = marked;
    }
    feed({ type: 'hash', route: parseRoute(location.hash) });
  });
  wide.addEventListener('change', () => paint());

  if (depthOf(history.state) === undefined) history.replaceState({ awDepth: depth } satisfies HistoryMark, '');
  feed({ type: 'start', route: parseRoute(location.hash), savedKey: conversationState.getState()?.key });

  // After the start, so what the panes already announced (replayed on
  // subscribing) is read against the URL's route, not the default one.
  onTableViewShown((a) => {
    settled = a.settled;
    hasMissions = a.hasMissions;
    feed({ type: 'tableViewShown', view: shellTableView(a.view), user: a.user, settled: a.settled });
  });
  onConversationShown((a) => feed({ type: 'conversationShown', key: a.key, ...(a.previous ? { previous: a.previous } : {}) }));
  onOpenRoute((route) => feed({ type: 'go', route }));
  return feed;
}
