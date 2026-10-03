import { describe, expect, it } from 'vitest';
import {
  SPLIT_MIN_VIEWPORT_PX,
  backRoute,
  formatRoute,
  initialRouterState,
  layoutFor,
  parseRoute,
  routerStep,
  surfaceFor,
  type AppRoute,
  type RouterInput,
  type RouterState,
} from '../src/shared/appRoutes';

/** Feed inputs in order; the state after, and every effect on the way. */
function run(inputs: RouterInput[], from: RouterState = initialRouterState()) {
  let state = from;
  const effects = inputs.flatMap((input) => {
    const step = routerStep(state, input);
    state = step.state;
    return step.effects;
  });
  return { state, effects };
}

describe('routes in the URL', () => {
  it.each<[string, AppRoute]>([
    ['', { kind: 'agents' }],
    ['#', { kind: 'agents' }],
    ['#/', { kind: 'agents' }],
    ['#/agents', { kind: 'agents' }],
    ['#/missions', { kind: 'missions' }],
    ['#/analytics/', { kind: 'analytics' }],
    ['#/preferences', { kind: 'preferences' }],
    ['#/preferences/pair', { kind: 'pair' }],
    ['#/c', { kind: 'conversation' }],
    ['#/c/claude%3Aabc-123', { kind: 'conversation', key: 'claude:abc-123' }],
    ['#/nowhere', { kind: 'agents' }],
    ['#/c/%E0%A4%A', { kind: 'conversation' }],
  ])('%s parses', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it('round-trips every route, including keys with characters a path would split on', () => {
    const routes: AppRoute[] = [
      { kind: 'agents' },
      { kind: 'missions' },
      { kind: 'analytics' },
      { kind: 'preferences' },
      { kind: 'pair' },
      { kind: 'conversation' },
      { kind: 'conversation', key: 'codex:thread/with spaces?&#' },
    ];
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
});

describe('layout', () => {
  it('splits at the breakpoint and shows one pane below it', () => {
    expect(layoutFor(SPLIT_MIN_VIEWPORT_PX)).toBe('split');
    expect(layoutFor(SPLIT_MIN_VIEWPORT_PX - 1)).toBe('single');
  });

  it('chooses the surface from the route and the layout', () => {
    expect(surfaceFor({ kind: 'conversation', key: 'k' }, 'split')).toBe('split');
    expect(surfaceFor({ kind: 'missions' }, 'split')).toBe('split');
    expect(surfaceFor({ kind: 'conversation', key: 'k' }, 'single')).toBe('conversation');
    expect(surfaceFor({ kind: 'analytics' }, 'single')).toBe('table');
    expect(surfaceFor({ kind: 'preferences' }, 'split')).toBe('page');
    expect(surfaceFor({ kind: 'pair' }, 'single')).toBe('page');
  });

  it('goes back from a lone conversation to the table view last used', () => {
    expect(backRoute({ kind: 'conversation', key: 'k' }, 'missions')).toEqual({ kind: 'missions' });
    expect(backRoute({ kind: 'conversation' }, undefined)).toEqual({ kind: 'agents' });
    expect(backRoute({ kind: 'pair' }, 'sessions')).toEqual({ kind: 'preferences' });
    expect(backRoute({ kind: 'agents' }, 'sessions')).toBeUndefined();
  });
});

describe('the router', () => {
  it('a deep link to a conversation asks for it when the pane remembered another', () => {
    const { state, effects } = run([{ type: 'start', route: { kind: 'conversation', key: 'B' }, savedKey: 'A' }]);
    expect(effects).toEqual([{ type: 'showConversation', key: 'B' }]);
    expect(state.requestedKey).toBe('B');
  });

  it('a deep link to the conversation the pane already shows asks for nothing', () => {
    const { effects } = run([{ type: 'start', route: { kind: 'conversation', key: 'A' }, savedKey: 'A' }]);
    expect(effects).toEqual([]);
  });

  it('a deep link to Missions switches the table', () => {
    const { effects } = run([{ type: 'start', route: { kind: 'missions' } }]);
    expect(effects).toEqual([{ type: 'tableView', view: 'missions' }]);
  });

  it('opening a row (the host navigates) pushes the conversation route and focuses its heading', () => {
    const { state, effects } = run([
      { type: 'start', route: { kind: 'agents' } },
      { type: 'tableViewShown', view: 'sessions', user: false, settled: true },
      { type: 'navigate', target: 'conversation', key: 'K' },
    ]);
    expect(effects.filter((e) => e.type !== 'tableView')).toEqual([
      { type: 'history', mode: 'push', route: { kind: 'conversation', key: 'K' } },
      { type: 'focusHeading' },
    ]);
    // The host already pointed the pane: the shell does not ask again.
    expect(effects.some((e) => e.type === 'showConversation')).toBe(false);
    expect(state.route).toEqual({ kind: 'conversation', key: 'K' });
  });

  it('back to an earlier conversation asks the pane for it, and its arrival settles the request', () => {
    const start = run([
      { type: 'start', route: { kind: 'agents' } },
      { type: 'navigate', target: 'conversation', key: 'A' },
      { type: 'conversationShown', key: 'A' },
      { type: 'navigate', target: 'conversation', key: 'B' },
      { type: 'conversationShown', key: 'B' },
    ]).state;
    const back = run([{ type: 'hash', route: { kind: 'conversation', key: 'A' } }], start);
    expect(back.effects).toEqual([{ type: 'showConversation', key: 'A' }, { type: 'focusHeading' }]);
    // The back button already wrote the URL: no history effect.
    const arrived = run([{ type: 'conversationShown', key: 'A' }], back.state);
    expect(arrived.state.requestedKey).toBeUndefined();
    expect(arrived.effects).toEqual([]);
  });

  it('while a requested conversation is on its way, another arriving does not rewrite the URL', () => {
    const s = run([
      { type: 'start', route: { kind: 'conversation', key: 'B' }, savedKey: 'A' },
      { type: 'conversationShown', key: 'A' },
    ]);
    expect(s.state.route).toEqual({ kind: 'conversation', key: 'B' });
    expect(s.effects.filter((e) => e.type === 'history')).toEqual([]);
  });

  it('a conversation that changes key in place takes the URL with it, without a history entry', () => {
    const s = run([
      { type: 'start', route: { kind: 'agents' } },
      { type: 'navigate', target: 'conversation', key: 'pending-1' },
      { type: 'conversationShown', key: 'pending-1' },
    ]).state;
    const rekey = run([{ type: 'conversationShown', key: 'real-1', previous: 'pending-1' }], s);
    expect(rekey.effects).toEqual([{ type: 'history', mode: 'replace', route: { kind: 'conversation', key: 'real-1' } }]);
  });

  it('a conversation with no key in the URL (an analytics detail) is named once one shows', () => {
    const s = run([{ type: 'start', route: { kind: 'agents' } }, { type: 'navigate', target: 'conversation' }]).state;
    expect(s.route).toEqual({ kind: 'conversation' });
    const shown = run([{ type: 'conversationShown', key: 'K' }], s);
    expect(shown.effects).toEqual([{ type: 'history', mode: 'replace', route: { kind: 'conversation', key: 'K' } }]);
  });

  it('a conversation shown while another route is up leaves the route alone', () => {
    const s = run([{ type: 'start', route: { kind: 'missions' } }, { type: 'conversationShown', key: 'K' }]);
    expect(s.state.route).toEqual({ kind: 'missions' });
    expect(s.state.shownKey).toBe('K');
  });

  it('clicking a table tab is a navigation: pushed, and focus stays on the tab', () => {
    const s = run([
      { type: 'start', route: { kind: 'agents' } },
      { type: 'tableViewShown', view: 'sessions', user: false, settled: true },
      { type: 'tableViewShown', view: 'analytics', user: true, settled: true },
    ]);
    expect(s.effects.filter((e) => e.type !== 'tableView')).toEqual([{ type: 'history', mode: 'push', route: { kind: 'analytics' } }]);
  });

  it('a table that falls back on its own (no orchestration) replaces the URL once it knows', () => {
    const early = run([
      { type: 'start', route: { kind: 'missions' } },
      { type: 'tableViewShown', view: 'sessions', user: false, settled: false },
    ]);
    expect(early.state.route).toEqual({ kind: 'missions' }); // not yet: Missions may still come
    const late = run([{ type: 'tableViewShown', view: 'sessions', user: false, settled: true }], early.state);
    expect(late.effects).toEqual([{ type: 'history', mode: 'replace', route: { kind: 'agents' } }]);
  });

  it('a link to a route the table is already on asks the table for nothing', () => {
    const s = run([
      { type: 'start', route: { kind: 'agents' } },
      { type: 'tableViewShown', view: 'missions', user: true, settled: true },
    ]).state;
    const again = run([{ type: 'hash', route: { kind: 'conversation', key: 'K' } }, { type: 'hash', route: { kind: 'missions' } }], s);
    expect(again.effects.filter((e) => e.type === 'tableView')).toEqual([]);
  });

  it('the shell going somewhere itself pushes (or replaces) and focuses', () => {
    const go = run([{ type: 'go', route: { kind: 'pair' } }]);
    expect(go.effects).toEqual([{ type: 'history', mode: 'push', route: { kind: 'pair' } }, { type: 'focusHeading' }]);
    const replace = run([{ type: 'go', route: { kind: 'preferences' }, replace: true }]);
    expect(replace.effects[0]).toEqual({ type: 'history', mode: 'replace', route: { kind: 'preferences' } });
  });

  it('going nowhere new does nothing', () => {
    expect(run([{ type: 'go', route: { kind: 'agents' } }]).effects.filter((e) => e.type !== 'tableView')).toEqual([]);
  });

  it('the host bringing the app forward leaves a page for the table, and otherwise stays put', () => {
    const fromPage = run([{ type: 'start', route: { kind: 'preferences' } }, { type: 'navigate', target: 'workbench' }]);
    expect(fromPage.state.route).toEqual({ kind: 'agents' });
    const fromTable = run([{ type: 'start', route: { kind: 'missions' } }, { type: 'navigate', target: 'workbench' }]);
    expect(fromTable.state.route).toEqual({ kind: 'missions' });
  });
});
