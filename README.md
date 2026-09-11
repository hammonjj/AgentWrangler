# Agent Wrangler

Local VSCode extension that monitors every AI agent session on this machine — who is **waiting on you**, who is busy, who looks stuck, and who is done — in one live dashboard.

v1 supports **Claude Code** (all sessions across all VSCode windows and terminals). The data layer is provider-based so Codex can be added later.

Status comes from Claude Code's own hooks when they're installed, so *Blocked on you* means a permission prompt is genuinely on screen — not a guess from a quiet transcript.

## Run it

```bash
npm install
```

Then open this folder in VSCode and press **F5** (Run Agent Wrangler). A new Extension Development Host window opens with:

- **Agent Wrangler dashboard**, opened for you at startup as an editor tab in the main editor area: all sessions grouped *Blocked on you → Waiting → Possibly stuck → Done → Busy → Ended*. Set `agentWrangler.dashboardLocation` to `panel` to dock it in the bottom panel next to Terminal instead, or turn `agentWrangler.openOnStartup` off to open it yourself.
- **Status bar bell**: `$(bell-dot) N waiting` when agents are blocked on you; click to open the dashboard.

## Install it for real (dogfooding)

F5 only loads the extension into a dev-host window, so the cross-window relay can't see your normal windows. To run it in every window:

```bash
npm run install-local    # build → package .vsix → code --install-extension --force
```

Nothing reloads on its own: every window keeps the old build until **Cmd+Shift+P → Developer: Reload Window** or a VSCode restart. A reload also ends the Claude Code sessions running in that window, so it is left to you. `npm run install-local:reload` is the opt-in variant that additionally touches `.dev-reload`, which the extension watches in the window that has this repo open and reloads that one window. Repeat the same command after every change — `--force` reinstalls over the same version, so no version bump is needed.

The VSCode CLI is assumed to live in `/Applications/Visual Studio Code.app`; override with `VSCODE_CLI=/path/to/code npm run install-local`. To go back to F5-only iteration: `code --uninstall-extension local.agent-wrangler`.

## Behavior

- **Plan usage cards sit above the table** — the same numbers as Claude Code's `/usage`: the 5-hour session, the 7-day week, any model-scoped week (e.g. *Weekly Fable*), and extra-usage credits once any have been spent. Each card has the percent, a bar (blue, yellow from 70%, orange from 90%), and a *Resets in* countdown that ticks locally. They are read every five minutes (`agentWrangler.usagePollIntervalSeconds`) from `GET /api/oauth/usage` with the login token Claude Code stored at sign-in (macOS Keychain item *Claude Code-credentials*, else `~/.claude/.credentials.json`); the token is only ever read — Claude Code owns refreshing it. If a read fails the last good numbers simply stay up and the next poll tries again (backing off); the failure is logged, not shown on the cards. The *Refresh* palette command forces a read now. Every window shares one read per interval through a cache file in the extension's globalStorage (the endpoint returns HTTP 429 when several windows ask at once; a 429 backs the next read off by at least five minutes, or `Retry-After`). Turn the cards off with `agentWrangler.showUsage`.
- The dashboard is a column-aligned table with collapsible sections (*Blocked on you / Waiting / Possibly stuck / Done / Busy / Ended / Archived*); collapse state is remembered.
- **Columns are yours.** Drag any divider in the header to resize the column to its right; the Agent column absorbs the difference, so the rest of the table stays put. The button at the right end of the header (or a right-click anywhere on it) opens a picker for switching columns on and off, with *Reset widths*. Both the widths and the hidden set are saved in the extension's global state, so they survive a reload and a restart and are the same in the editor tab and the docked panel. Anything switched off keeps showing on the row's second line, so hiding a column costs the space it took, not the fact it carried.
- **A Model column** shows which model wrote the latest reply — *Opus 5*, *Fable 5.1*, *Haiku 4.5* — read from the transcript's last assistant message. The cell's tooltip has the full wire id. A model released after this build still appears, just unshortened.
- **Waiting vs Done.** Both mean the agent finished its turn and is idle. *Waiting* means its last message asked you something — a question, a choice, "let me know". *Done* means it reported and stopped. The split is read off the reply text (a question mark closing the last paragraph, or a decision phrase), so it is a heuristic that errs towards *Waiting*: unknown or failed turns are always *Waiting*. Done sessions get a green dot, do not light the status-bar bell, and do toast when `notifyOnWaiting` is on.
- **Blocked rows say what for.** Under the title a *Blocked on you* row shows the permission's subject — the Bash command and its description, the file an Edit touches, the question an `AskUserQuestion` asks — and, while Claude Code's dialog is still open, **Allow** and **Deny** buttons that answer it from the dashboard. The row is taller for it on purpose. Claude Code's own dialog keeps working; whichever is answered first wins. (Hooks required; see below for how the buttons reach Claude Code.)
- **Conversations nobody has typed into yet are hidden.** A new Claude panel or a `/clear` registers a live process with no transcript; it appears the moment the first prompt lands, not as a *Waiting* row with nothing in it.
- **Narrow docking works.** Below ~720px (a sidebar or a split bottom panel) the Project, Branch, Model and PR columns are not rendered at all and fold into the row's second line, so the session title, status chips, ETA and age stay visible instead of being pushed off-screen. The picker shows those columns as *too narrow* rather than pretending they are on screen; widening the dock brings them back exactly as you left them.
- **An ETA column** on every busy row (hooks required). It counts down against your own turn history: until the median while the turn is still typical, then until the 90th percentile once it has outlived half its peers (yellow past p75, orange past p90, where it shows `>Xm` instead of a countdown). Italic means the baseline is still the seeded one, before 20 of your turns have been recorded. A dash means the turn's start was not observed; the cell's tooltip says why.
- **A banner at the top says when status is only estimated** — hooks not installed, disabled, or stale — with an *Install hooks* button. Once installed, it lists the live sessions that predate the install and still need a restart.
- **Clicking a row goes to wherever the session actually lives.** Ownership is decided from the process tree, not the folder: every live session's pid is in Claude's registry, and walking its parents says whether it sits under this window's extension host (a Claude Code panel), under one of this window's terminal shells, under another window of this VSCode, or outside VSCode altogether. The row tooltip says what a click will do.
  - **Panel session in this window** → reveals it in the official Claude Code panel (`claude-vscode.editor.open <sessionId>`) — fully interactive immediately.
  - **Terminal session in this window** → shows the integrated terminal running it. A terminal session cannot be moved into the panel: it is one process, and resuming its id in a panel would start a second copy and fork the conversation, so the extension never does that.
  - **Live session in another window of this VSCode** → cross-window relay: a note (session id, cwd, pid) is written to a shared mailbox (extension globalStorage) watched by every Agent Wrangler instance, and the owning window is focused via VSCode's own CLI; the instance that owns the process claims the note and reveals the panel or terminal there. (Requires the extension to be running in the target window — during F5-only iteration that means only dev-host windows participate; other windows still get focused.)
  - **Live session nothing here can reveal** (an iTerm session, a pid that has just died) → read-only viewer.
  - **Ended session** → in this window's workspace: resumed into the Claude Code panel; elsewhere: a terminal at the project folder running `claude --resume <id>`.
  - Without a readable process table (no `ps`) the old folder-based rule applies: in this workspace → panel, other window's panel session → relay, else viewer.
- The eye button opens the read-only viewer for any session with a transcript.
- Row buttons: view transcript (ended sessions) and **archive** — archived sessions move to the always-last Archived section (collapsed by default), stop counting toward the status-bar bell, and never toast. The same button unarchives.
- Command palette: `Agent Wrangler: …` commands (dashboard, refresh, viewer, resume, copy id, reveal transcript, install/remove status hooks).

## How status is detected

Two sources, in priority order. Hooks are ground truth; the transcript is a fallback.

### 1. Hooks (exact, opt-in)

Run **`Agent Wrangler: Install Status Hooks…`** (or click *Install hooks* in the dashboard banner). It merges a block into `~/.claude/settings.json` in which every hook appends its stdin payload to `~/.claude/agentwrangler/$PPID.jsonl`; the extension tails those logs. The one exception is `PermissionRequest`, which runs `~/.claude/agentwrangler/permission-hook.sh` (written by the installer) — see *Allow / Deny* below.

| Signal | Meaning |
|---|---|
| `PermissionRequest` · `Elicitation` · `Notification`/`agent_needs_input` · `PreToolUse` for `AskUserQuestion` / `ExitPlanMode` | **Blocked on you** (row names the tool, and what for) |
| `Stop` with a reply that asks something · `StopFailure` | **Waiting** |
| `Stop` with a reply that just reports | **Done** |
| `UserPromptSubmit` · `PreToolUse` · `PostToolUse`/`PostToolBatch` | **Busy** (row shows the in-flight tool and its elapsed time) |
| no events at all past `stuckThresholdSeconds` (default 10 min), nothing in flight | **Possibly stuck** |
| `SessionEnd`, or pid gone | **Ended** |
| `SessionStart` with no transcript yet | *hidden* (an empty conversation) |

**Allow / Deny from the dashboard.** Claude Code runs `PermissionRequest` hooks and shows its permission dialog *at the same time*, then takes whichever answers first (verified in the 2.1.267 binary: the hook generator and the dialog promise are started together and raced). The installed script logs the payload like every other hook, leaves a marker in `~/.claude/agentwrangler/requests/`, and then polls for `decisions/<id>.json` for up to ~28 minutes (its hook `timeout` is 30 minutes). Clicking **Allow** or **Deny** writes that file with Claude Code's own decision shape (`hookSpecificOutput.decision.behavior`); the script prints it and exits, and Claude Code applies it. If you answer in Claude Code instead, the next event (`PreToolUse` or `PermissionDenied`) removes the marker and the script exits within half a second. The buttons only render while the marker exists, so they never offer a decision that can no longer land. Tools that require interaction by design (`AskUserQuestion`, `ExitPlanMode`) cannot be answered this way and show no buttons.

*Possibly stuck* is deliberately slow to trigger. Hooks fire on tool calls and prompts, not while the model is generating, so a long think or a large `Write` is silent for minutes (measured in one ordinary turn: 121s, 388s, 79s, 104s). The ETA column is what says "running long"; *stuck* means nothing at all for ten minutes.

Notes on the install, all verified against the shipped Claude Code:

- **Your existing hooks are preserved.** The installer merges and backs `settings.json` up first; uninstall removes exactly its own entries. Unparseable settings abort rather than being overwritten.
- **Only new sessions report.** Claude Code snapshots hook config when a session starts, so editing settings does nothing to sessions already running.
- **Overhead is a shell append**, no interpreter startup. The log is sharded by the Claude pid because `cat >>` is only atomic while a payload fits in one write: measured here, 30 concurrent appends stay intact at 20 KB each but corrupt 6 of 30 lines at 64 KB and most at 128 KB. A `tool_input` holding a large `Write` reaches that easily; sharded, the same test is clean at 1 MB.
- Hooks can be silently suppressed by `disableAllHooks`, safe mode, an org policy allowing only managed hooks, or unaccepted workspace trust. The extension warns rather than leaving you to wonder.

### 2. Transcript inference (fallback, always on)

Sessions with no hook data — anything started before installing them — are derived from the registry plus the transcript tail, exactly as before, and rendered with a **hollow status dot** meaning *estimated*.

| Signal | Meaning |
|---|---|
| `~/.claude/sessions/<pid>.json` + pid alive | session is live (registry gives cwd + friendly name) |
| registry entry, no transcript file | *hidden* (nothing typed yet) |
| last transcript line: assistant `stop_reason: end_turn`, reply asks something | **Waiting** |
| last transcript line: assistant `stop_reason: end_turn`, reply just reports | **Done** |
| last transcript line: assistant `tool_use` / user / queue-op | **Busy** |
| busy but transcript silent > `stuckThresholdSeconds` (default 10 min) | **Possibly stuck** |
| pid gone | **Ended** |

Inference cannot distinguish a permission prompt from a long tool call from a wedged session — all three look like a silent transcript. That limitation is the reason hooks exist; without them, *Possibly stuck* is a guess.

Transcripts and hook logs are both read incrementally (bounded tail reads with a per-file byte offset) — large files are never loaded whole.

## Settings

`agentWrangler.dashboardLocation` (`editor` — or `panel` for the bottom panel) · `openOnStartup` (true) · `claudeBinaryPath` · `stuckThresholdSeconds` (600 — generation is silent for minutes; see above) · `endedWindowHours` (48) · `maxEndedSessions` (50) · `notifyOnWaiting` (false — toast when an agent flips to waiting, blocked or done) · `pollIntervalSeconds` (5)

## Development

```bash
npm run watch      # esbuild watch (also started automatically by F5)
npm run typecheck  # tsc --noEmit
npm test           # vitest: tail parser, status table, live ~/.claude smoke test
```

Source layout: `src/claude/*` (registry reader, incremental tail parser, status derivation, hook event reducer + log tailer + settings installer, provider), `src/core/*` (provider-agnostic store), `src/ui/*` (dashboard host + its two shells — editor tab and panel view, viewer panels, status bar, terminal resume), `src/webview/*` (browser bundles). Webview code may only import from `src/shared/*`.
