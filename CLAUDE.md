# Agent Wrangler — working rules for coding agents

macOS background service (the **core daemon**) that monitors every Claude Code and Codex
session on this machine and runs their conversations, plus a web workbench that a browser
opens: the agent table and the conversation side by side, on this Mac or a paired phone.
Read `README.md` for behaviour, and the active plan in `docs/plans/` before touching anything it
covers.

**There is no VSCode extension** (removed 2026-09-22) **and no Electron** (retired in #142). The
browser workbench is the only front end. Nothing may import `vscode` or `electron` (a test
checks), and `HostServices` has one implementation, `src/node/nodeHost.ts`.

## Commands

- `npm run build` · `npm run typecheck` · `npm test` (vitest; pure functions only, plus
  `test/live.integration.test.ts`, which reads the real `~/.claude` and self-skips without it)
  · `npm run test:integration`.
- `node dist/launcher/main.js [--dry-run]` — from a checkout, what opening the app does: start
  this checkout's daemon (spawned, no LaunchAgent) and open a browser on a sign-in link.
  `--dry-run` starts, installs and opens nothing. It runs against the real data dir unless
  `HOME` (and `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) point at a temp dir.
- `npm run app:package` — build and assemble `release/Agent Wrangler.app`
  (`scripts/package-app.ts`: Info.plist, a compiled C launcher, the pinned Node, `dist/`
  unpacked under `Contents/Resources/app`), signed and verified.
- `npm run app:install` — package, put it in `/Applications`, and move the core daemon onto it
  (`aw daemon start` from the new bundle, when the daemon was running).
  **Run it yourself after every code change**, and say so; it replaces the copy James uses.
  It signs with the self-signed *Agent Wrangler Local Signing* certificate and fails without
  it; `npm run app:signing-setup` creates it (once per machine, needs James's password).
- `aw daemon start|stop|stop --all|status` — the core daemon (#130): a LaunchAgent
  (`com.hammonjj.agentwrangler.core`) on the bundle's Node. Opening the app runs
  `src/launcher` (ensure the daemon, mint a loopback link, `open` it, exit).
  From a checkout it spawns the checkout's `dist/daemon/main.js` against the real data dir, so
  in tests point `HOME` (and `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) at a temp dir. Never install the
  LaunchAgent from a test, and never run the packaged launcher without `--dry-run` against a
  temp `HOME`: a packaged `ensure` talks to the real launchd label.

## Branches and worktrees

Several agents work on this repo at once, so a branch is not enough: two agents on one
checkout are two agents on one branch, and their changes arrive in `git status` already
mixed together. A branch that is being worked on gets **its own worktree**, which is its own
directory, so each agent has a tree of its own.

- **The primary tree stays on `main`.** `~/Documents/GitHub/AgentWrangler` is checked out on
  `main` and is not switched to anything else. Do not *work* there — it is the tree every
  other agent's `git status` is looking at, and editing it is how two agents' changes end up
  in one commit.
- **Every feature gets its own worktree. No exceptions, however small it looks.**
  ```bash
  git worktree add ../AgentWrangler-<topic> -b feat/<topic>
  ln -s ../AgentWrangler/node_modules ../AgentWrangler-<topic>/node_modules
  ```
  When it is done: commit, merge to `main`, push, and remove the worktree. Branch strategy
  beyond that is not worth ceremony on a personal project — the worktree is there to keep
  agents off each other, not to model a release process.
  The symlink is why `npm install` is not needed in the new tree; re-run it only if
  `package.json` gains a dependency.
- **Never `git checkout` or `git switch` in a tree you did not create.** Another agent is
  probably in it, and switching the branch under them is exactly what mixes the work together.
  `git worktree list` says who is where.
- **Never commit files that are not yours.** In a shared tree `git status` shows other agents'
  work in progress. Commit by path (`git commit <paths>`), never `git commit -a`, and never
  `git add -A` without reading what it picked up.
  **`M` next to a file you edited does not mean the diff is yours.** `git commit <path>` takes
  the whole working-tree file, so someone else's half-finished edits in it ride along under
  your message — and vanish from their `git status`, so they will not notice. Run
  `git diff <paths>` and read it before committing, every time. This has happened: see
  `docs/plans/remote-questions-and-plans.md` §1.
- **Only one agent runs `npm run app:install` at a time.** It installs the build of whichever
  tree it ran in and restarts the core daemon on it, so the last one wins; say which tree you
  installed from.
- Merge with `git merge --no-ff` from `main`, then `git worktree remove ../AgentWrangler-<topic>`
  and delete the branch.

## The project board

Work is tracked as issues in `hammonjj/AgentWrangler` on the **Agent Wrangler** GitHub Project
(https://github.com/users/hammonjj/projects/4). James watches its **Board** view to see where
each item is, so the card has to move when the work does. If your task has an issue, you own
its card:

| When | Set Status to |
|---|---|
| You start work on it (worktree created) | **In Progress** |
| You cannot proceed — waiting on James, another issue, or an unknown | **Blocked**, and comment on the issue saying why and what unblocks it |
| You pick it back up | **In Progress** |
| Merged to `main` and pushed | close the issue (`gh issue close <n> -c "<one-line summary + commit>"`); a project workflow moves it to **Done** |

Don't touch Inbox/Ready (that's backlog grooming — the `product-manager` agent and James), and
don't move cards for issues you aren't working on. Keep comments short and public-repo safe.
Name the issue in your branch and commit (`feat/<topic>`, "… (#<n>)").

Setting Status is two commands — find the card, then set it:

```bash
gh api graphql -f query='query{repository(owner:"hammonjj",name:"AgentWrangler"){issue(number:<n>){projectItems(first:5){nodes{id project{number}}}}}}' --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number==4) | .id'
gh project item-edit --project-id PVT_kwHOAEABR84Bkgxz --field-id PVTSSF_lAHOAEABR84BkgxzzhjRHMQ --id <item-id> --single-select-option-id <option>
```

Status options: In Progress `d486ef89` · Blocked `4303ea8c` · Done `0bacc5d9`
(Inbox `a802d6ef` · Ready `1d190bd3`). If the IDs stop working, re-read them with
`gh project field-list 4 --owner hammonjj --format json`. If `gh` says the token lacks the
`project` scope, tell James to run `gh auth refresh -s project`; don't skip the update silently.

## Hard rules

- **Restarting the core is allowed, when it cannot end a conversation.** There is no app to
  quit: the core is the daemon, and the browser is only a view of it (closing tabs stops
  nothing). Every Claude conversation runs in a session host that survives a daemon restart and
  reattaches (#122); Codex threads survive on the background Codex server (the default).
  Restart the core with `aw daemon start` from the new install (`app:install` does it for you):
  it reloads the LaunchAgent, the old daemon stops as `aw daemon stop` does, and the new one
  reattaches the hosts. Say that you did and which tree the installed build came from. A
  browser tab left open reloads itself onto the new build. Don't restart if:
  - `aw status` reports any session that ends with the daemon (a Codex thread with the
    background server off). You may be one of them: `AGENTWRANGLER_HOSTED=1` in your
    environment means you are in a host;
  - another agent is mid-`app:install`;
  - a host shows as unreachable. It would stay unreachable after the restart too.

  Never run `aw daemon stop --all`: it ends hosted conversations too (it refuses in an agent's
  shell anyway). If in doubt, say "a restart is needed" and leave it to James.
  A daemon on the old build is the usual cause of "my fix didn't work": `aw daemon status`
  shows its build.
- **The repo is public** (`hammonjj/AgentWrangler`). No real project paths, session titles,
  prompts, transcript content or hook payloads in code, tests, fixtures, docs or commits.
  Fixtures use `/Users/test/proj`-style paths. Never paste `live.integration.test.ts` output anywhere.
- `src/webview/**` imports only from `src/shared/**` and `src/webview/common/**`.
  `src/shared/**` has no Node or DOM imports (it is bundled into both the main process and the
  webviews); `src/webview/common/**` is browser-only and is where things a webview has exactly
  one of live — see `paneApi.ts`.
- Webview CSP forbids inline styles and inline scripts; use classes and the nonce'd bundle.
- **The table and the conversation share one webview** (the workbench page the daemon serves
  to a browser), split by a divider the user drags, one pane at a time on a phone (#134). Three things a webview has exactly one of — the API handle, the
  message channel and `setState` — are shared through `src/webview/common/paneApi.ts`. Go
  through it; the web shim (`src/webview/webshim`) supplies the one bridge.
- **Neither pane may assume it has the page.** The table is usually about half a
  full-screen tab, but the divider moves, so a pane can be 300px inside a 2000px tab.
  Size off the pane, never the viewport: the table folds its columns below 720px from a
  `ResizeObserver` and exposes that as `#app.narrow`, which is why its narrow styles are a
  class and not a `@media` query. Scope element selectors to a pane root (`#app`, `#convApp`,
  `#prefsApp`) or they leak — the conversation renders markdown tables.
- Never read `~/.claude/sessions/*.key` files: they are secrets.
- New source and test files are TypeScript.

## Layout

`src/claude/*` Claude Code provider (registry, transcript tail/index, hook events + log +
installer, status) · `src/codex/*` Codex provider and runner · `src/core/*` provider-agnostic
store, config, services · `src/remote/*` remote control, with `discord/` below the transport
boundary · `src/app/createApp.ts` the application (`src/app/webWorkbench.ts` is the browser
workbench the daemon serves) · `src/daemon/*` the core daemon · `src/launcher/*` what opening
the app runs (`launcher.c` is the bundle's executable, which execs Node on `main.ts`) ·
`src/node/*` plain-Node host services and the LaunchAgent · `src/core/appBundle.ts` the `.app`
layout · `src/host/*` the seam the app is written against · `src/ui/*` webview hosts and click
routing · `src/webview/*` browser bundles (one dir per bundle, entry `main.ts` + a `.css`;
`workbench` is what ships and imports the `dashboard`, `conversation` and `preferences` panes,
`webshim` is the bridge loaded before it, `common/` is shared browser-only code) ·
`src/shared/*` model and wire protocol · `scripts/package-app.ts` the bundle
(`scripts/packaging/` its pure half) · `test/*` vitest.

## Verification

Typecheck and tests green, then `npm run app:install` (it restarts the core daemon on the new
build when the rule above allows; otherwise tell James a restart is needed), and say what to
open or click in the browser to see the change. Status-hook facts that are not documented by
Anthropic are recorded in the README ("How status is detected") and in `docs/plans/`.
