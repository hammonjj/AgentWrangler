# Agent Wrangler — working rules for coding agents

macOS desktop app (Electron) that monitors every Claude Code and Codex session on this machine
and hosts their conversations in one window: the agent table and the conversation side by side.
Read `README.md` for behaviour, and the active plan in `docs/plans/` before touching anything it
covers.

**There is no VSCode extension.** It was removed on 2026-09-22; the app is the only front end.
Nothing may import `vscode`, and `HostServices` has one implementation.

## Commands

- `npm run build` · `npm run typecheck` · `npm test` (vitest; pure functions only, plus
  `test/live.integration.test.ts`, which reads the real `~/.claude` and self-skips without it).
- `npm run electron` — build, then open the window. `npm run electron:nobuild` skips the build.
- `npm run app:install` — build, package, and put it in `/Applications`.
  **Run it yourself after every code change**, and say so; it replaces the copy James uses.
  It signs with the self-signed *Agent Wrangler Local Signing* certificate and fails without
  it; `npm run app:signing-setup` creates it (once per machine, needs James's password).

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
  tree it ran in, so the last one wins; say which tree you installed from.
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

- **Restarting the app is allowed, when it cannot end a conversation.** With session hosts on
  (`"experimental.sessionHosts": true` in `~/Library/Application Support/Agent Wrangler/settings.json`,
  or the default once #15's flip lands), Claude conversations run in hosts that survive a quit
  and reattach on relaunch. Codex threads already survive a quit. Restart with
  `osascript -e 'quit app "Agent Wrangler"'`, wait for the process to exit, then
  `open -a "Agent Wrangler"`, and say that you did. Don't restart if:
  - the setting is off. In-process conversations end with the app, and you may be one of them;
  - another agent is mid-`app:install`;
  - a host shows as unreachable. It would stay unreachable after the restart too.

  If in doubt, say "a restart is needed" and leave it to James.
  A running copy on the old build is the usual cause of "my fix didn't work".
- **The repo is public** (`hammonjj/AgentWrangler`). No real project paths, session titles,
  prompts, transcript content or hook payloads in code, tests, fixtures, docs or commits.
  Fixtures use `/Users/test/proj`-style paths. Never paste `live.integration.test.ts` output anywhere.
- `src/webview/**` imports only from `src/shared/**` and `src/webview/common/**`.
  `src/shared/**` has no Node or DOM imports (it is bundled into both the main process and the
  webviews); `src/webview/common/**` is browser-only and is where things a webview has exactly
  one of live — see `paneApi.ts`.
- Webview CSP forbids inline styles and inline scripts; use classes and the nonce'd bundle.
- **The table and the conversation share one webview** (the workbench window), split by a
  divider the user drags. Three things a webview has exactly one of — the API handle, the
  message channel and `setState` — are shared through `src/webview/common/paneApi.ts`. Go
  through it; calling `acquireVsCodeApi()` a second time throws and kills a pane.
- **Neither pane may assume it has the window.** The table is usually about half a
  full-screen window, but the divider moves, so a pane can be 300px inside a 2000px tab.
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
boundary · `src/app/createApp.ts` the application, minus the window · `src/electron/*` the main
process, windows and menu · `src/host/*` the seam the app is written against · `src/ui/*`
webview hosts and click routing · `src/webview/*` browser bundles (one dir per bundle, entry
`main.ts` + a `.css`; `workbench` is what ships and imports the `dashboard` and `conversation`
panes, `common/` is shared browser-only code) · `src/shared/*` model and wire protocol ·
`test/*` vitest.

## Verification

Typecheck and tests green, then `npm run app:install`, then restart the app if the rule above
allows it (otherwise tell James it needs restarting), and say what to click to see the change. Status-hook facts that are not documented by
Anthropic are recorded in the README ("How status is detected") and in `docs/plans/`.
