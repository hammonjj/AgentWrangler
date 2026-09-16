# Agent Wrangler — working rules for coding agents

VSCode extension that monitors every Claude Code session on this machine and hosts their
conversations, in one tab: the agent table and the conversation side by side. Read `README.md` for behaviour, and the active plan
in `docs/plans/` before touching anything it covers.

## Commands

- `npm run build` · `npm run typecheck` · `npm test` (vitest; pure functions only, plus
  `test/live.integration.test.ts`, which reads the real `~/.claude` and self-skips without it).
- `npm run install-local` — build, package the `.vsix`, install it over the current version.
  **Run it yourself after every code change.** It does not reload anything.

## Branches and worktrees

Several agents work on this repo at once, so a branch is not enough: two agents on one
checkout are two agents on one branch, and their changes arrive in `git status` already
mixed together. A branch that is being worked on gets **its own worktree**, which is its own
directory, so each agent has a tree of its own.

- **The primary tree stays on `main`.** `~/Documents/GitHub/AgentWrangler` is checked out on
  `main` and is not switched to anything else. Small self-contained changes land there.
- **Anything bigger than one sitting gets a branch and a worktree:**
  ```bash
  git worktree add ../AgentWrangler-<topic> -b feat/<topic>
  ln -s ../AgentWrangler/node_modules ../AgentWrangler-<topic>/node_modules
  ```
  Then open that folder in VSCode and work there. The symlink is why `npm install` is not
  needed in the new tree; re-run it only if `package.json` gains a dependency.
- **Never `git checkout` or `git switch` in a tree you did not create.** Another agent is
  probably in it, and switching the branch under them is exactly what mixes the work together.
  `git worktree list` says who is where.
- **Never commit files that are not yours.** In a shared tree `git status` shows other agents'
  work in progress. Commit by path (`git commit <paths>`), never `git commit -a`, and never
  `git add -A` without reading what it picked up.
- **Only one agent runs `npm run install-local` at a time.** It installs the build of whichever
  tree it ran in, so the last one wins; say which tree you installed from.
- Merge with `git merge --no-ff` from `main`, then `git worktree remove ../AgentWrangler-<topic>`
  and delete the branch.

## Hard rules

- **Never reload a VSCode window automatically**, and never run `npm run install-local:reload`
  unless James asks. *Developer: Reload Window* ends every Claude Code session in that window.
  Say "a reload is needed" and leave it to him. An unreloaded window running the old build
  is the usual cause of "my fix didn't work".
- **The repo is public** (`hammonjj/AgentWrangler`). No real project paths, session titles,
  prompts, transcript content or hook payloads in code, tests, fixtures, docs or commits.
  Fixtures use `/Users/test/proj`-style paths. Never paste `live.integration.test.ts` output anywhere.
- `src/webview/**` imports only from `src/shared/**` and `src/webview/common/**`.
  `src/shared/**` has no `vscode`, Node or DOM imports (it is bundled into both the
  extension host and the webviews); `src/webview/common/**` is browser-only and is where
  things a webview has exactly one of live — see `paneApi.ts`.
- Webview CSP forbids inline styles and inline scripts; use classes and the nonce'd bundle.
- **The table and the conversation share one webview** (the workbench tab), split by a
  divider the user drags. Three things a webview has exactly one of — the API handle, the
  message channel and `setState` — are shared through `src/webview/common/paneApi.ts`. Go
  through it; calling `acquireVsCodeApi()` a second time throws and kills a pane.
- **Neither pane may assume it has the window.** The table is usually about half a
  full-screen window, but the divider moves, so a pane can be 300px inside a 2000px tab.
  Size off the pane, never the viewport: the table folds its columns below 720px from a
  `ResizeObserver` and exposes that as `#app.narrow`, which is why its narrow styles are a
  class and not a `@media` query. Scope element selectors to a pane root (`#app`,
  `#convApp`) or they leak — the conversation renders markdown tables.
- Never read `~/.claude/sessions/*.key` files: they are secrets.
- New source and test files are TypeScript.

## Layout

`src/claude/*` Claude Code provider (registry, transcript tail/index, hook events + log +
installer, status) · `src/core/*` provider-agnostic store, config, services · `src/ui/*`
webview hosts, click routing, relay, terminal · `src/webview/*` browser bundles (one dir per
bundle, entry `main.ts` + a `.css`; `workbench` is what ships and imports the `dashboard`
and `conversation` panes, `common/` is shared browser-only code) · `src/shared/*` model and wire protocol · `test/*` vitest.

## Verification

Typecheck and tests green, then `npm run install-local`, then tell James which window needs a
reload and what to click to see the change. Status-hook facts that are not documented by
Anthropic are recorded in the README ("How status is detected") and in `docs/plans/`.
