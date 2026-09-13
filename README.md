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
- **Columns are yours.** Every divider in the header is drawn, not hidden: drag one to resize the column to its right, and **only** that column changes — the elastic Agent column absorbs the difference and every other column keeps the width it had. A column can grow until Agent reaches its 110px floor, and no further, so a drag can never push the table wider than the dock. The button at the right end of the header (or a right-click anywhere on it) opens a picker for switching columns on and off, with *Reset widths*. Both the widths and the hidden set are saved in the extension's global state, so they survive a reload and a restart and are the same in the editor tab and the docked panel. Anything switched off keeps showing on the row's second line, so hiding a column costs the space it took, not the fact it carried.
- **A Model column** shows which model wrote the latest reply — *Opus 5*, *Fable 5.1*, *Haiku 4.5* — read from the transcript's last assistant message. The cell's tooltip has the full wire id. A model released after this build still appears, just unshortened.
- **A Worktree column** names the linked git worktree a session is working in, and is blank in a main checkout — which is the point, since several agents on one repo means several trees and *main* alone stops telling you who is where. Detected without running git: a linked worktree's `.git` is a *file* holding `gitdir: …/.git/worktrees/<name>`, where a main checkout's is a directory. A session sitting in a subdirectory still resolves, the answer is cached per directory, and *Refresh* re-checks (so a `git worktree add` shows up on the next refresh).
- **Waiting vs Done.** Both mean the agent finished its turn and is idle. *Waiting* means its last message asked you something — a question, a choice, "let me know". *Done* means it reported and stopped. The split is read off the reply text (a question mark closing the last paragraph, or a decision phrase), so it is a heuristic that errs towards *Waiting*: unknown or failed turns are always *Waiting*. Done sessions get a green dot, do not light the status-bar bell, and do toast when `notifyOnWaiting` is on.
- **Blocked rows open a permission card.** A *Blocked on you* row gets extra rows of its own under it, spanning the table: a header line with Claude's own one-line description of what it wants to do, and — sliding open underneath — the command *as it will run*, wrapped over as many lines as it takes rather than ellipsised, with **Allow**, **Always allow** and **Deny**. The card opens by itself while a decision can still land and collapses to its header once it cannot; clicking the header toggles it either way. Claude Code's own dialog keeps working; whichever is answered first wins. (Hooks required; see below for how the buttons reach Claude Code.)
- **Conversations nobody has typed into yet are hidden.** A new Claude panel or a `/clear` registers a live process with no transcript; it appears the moment the first prompt lands, not as a *Waiting* row with nothing in it.
- **Narrow docking works.** Below ~720px (a sidebar or a split bottom panel) the Project, Worktree, Branch, Model and PR columns are not rendered at all and fold into the row's second line, so the session title, status chips, ETA and age stay visible instead of being pushed off-screen. The picker shows those columns as *too narrow* rather than pretending they are on screen; widening the dock brings them back exactly as you left them.
- **An ETA column** on every busy row (hooks required). It counts down against your own turn history: until the median while the turn is still typical, then until the 90th percentile once it has outlived half its peers (yellow past p75, orange past p90, where it shows `>Xm` instead of a countdown). Italic means the baseline is still the seeded one, before 20 of your turns have been recorded. A dash means the turn's start was not observed; the cell's tooltip says why.
- **A banner at the top says when status is only estimated** — hooks not installed, disabled, or stale — with an *Install hooks* button. Once installed, it lists the live sessions that predate the install and still need a restart.
- **Clicking a row opens the conversation here.** Every session — in this window, in another VSCode window, in a terminal, on this machine at all — opens in the **conversation pane** beside the dashboard, and the click never moves focus or jumps you between windows. The pane reads the session's transcript live, so it works for conversations this extension has nothing to do with.
  - **What it renders**: prompts and replies as markdown, thinking collapsed, one card per tool call that expands to its input and output, edits as a diff. Code blocks have a copy button; links open in the browser.
  - **Permission prompts can be answered from it.** A *Blocked on you* session grows a card naming the tool and what it wants, with **Allow** and **Deny**. This is the same hook race the dashboard buttons use, so answering in Claude Code instead simply flips the card to *answered there*. (`AskUserQuestion` and plan approval are shown but cannot be answered from outside, by Claude Code's design.)
  - **Sessions owned elsewhere are read-only.** There is no supported way to type into a Claude Code session running in another window or a terminal, so the composer says which one owns it and the button beside it goes there: the Claude Code panel, the integrated terminal, or the VSCode window that owns the process (via the cross-window relay). Ownership is decided from the process tree, not the folder — every live session's pid is in Claude's registry, and walking its parents says where it sits.
  - **Pin** (the eye button on a row, or the pane's own Pin) gives a session a tab of its own that row clicks never swap away. One reusable pane plus pins means browsing five agents costs one tab.
  - **Ended sessions** open in the pane too, with *Resume in terminal* as the way to continue them.
  - Set `agentWrangler.rowClickOpens` to `wherever-it-runs` to get the old behaviour back, where a click went straight to the panel, terminal or window that runs the session.
- **Conversations you start here are fully interactive.** A bar across the top of the dashboard holds a **project dropdown** and a **+ New** button: pick a folder, press the button, and a Claude Code session starts there, inside the extension, in the pane. It is an ordinary session in every respect that matters — it registers in `~/.claude/sessions`, runs your hooks, writes the normal transcript, and can be resumed anywhere afterwards — but this pane is its only interface, so it has no terminal to steal your attention. Unlike the Claude Code panel, which is bound to its window's workspace, one window can run sessions in **any** project on the machine.
  - **The dropdown lists every folder you have used Claude Code in**, newest first. That list is Claude Code's own — the `projects` map in `~/.claude.json`, which it appends to itself the first time you work somewhere — plus this window's workspace folders and anything currently running, so a new project appears without being told about it. Folders that have been deleted are left out, since nothing can start in them. **Browse…** at the bottom reaches anywhere else. The dropdown shows the folder's name and its full path as a tooltip, because two checkouts of one repo share a basename.
  - **Each row has an X that removes it**, for the folders you tried once and will not open again. The entry stays in `~/.claude.json` — that file is Claude Code's, not ours, and rewriting someone else's config to tidy a dropdown is not a trade worth making — so the removal is recorded on our side and applied to every later scan. Removals are shared by every dashboard, and survive reloads. The menu stays open while you remove, so clearing three stale folders is three clicks.
  - **Anywhere you navigate to is added back.** Browsing to a folder, or starting a conversation in one, puts it in the list and undoes a previous removal — so an X is never a decision you have to be sure about. Nothing else un-removes a folder: a session that shows up in one from a terminal elsewhere leaves your list alone.
  - The choice is remembered per dashboard, not globally: two windows are usually two different jobs, and a shared setting would have each one moving where the other starts its next conversation.
  - *Agent Wrangler: New Conversation…* and the **+** in the view's title bar do the same thing through a quick pick, in the same order, for when your hands are on the keyboard.
  - **Type, interrupt, queue.** Enter sends, Shift+Enter is a newline, and a message sent mid-turn queues behind it with a *queued* chip. *Stop* interrupts the turn in flight. Replies stream in a word at a time.
  - **Permission, question and plan cards are answered here.** A permission ask offers **Allow**, **Deny**, and **Always allow** when the prompt itself suggested a rule (the button's tooltip names the rule it writes). `AskUserQuestion` renders as a form with the options and an *Other* box; a plan renders with **Approve** and **Request changes**, and the feedback goes back to the model. These three are exactly what the hook path cannot do for a session running elsewhere.
  - **Dictate instead of typing.** The microphone beside the composer records; click it again and what you said lands at the cursor. Escape throws the recording away. Transcription is **local** — `ffmpeg` records 16 kHz mono, `whisper.cpp` transcribes it, and no audio leaves the machine. Roughly half a second for a sentence once warm; the very first run takes ~15s while Metal compiles its shaders, once ever.
    - It needs `brew install ffmpeg whisper-cpp` and a model. Agent Wrangler checks for all three when you click, names whichever is missing, and offers to install it or download the default model (`ggml-base.en`, 141 MB, into `~/.cache/agent-wrangler/whisper/`). Point `agentWrangler.dictation.modelPath` at a bigger model for better accuracy, or another language.
    - The recording runs in the extension host, not the webview — a webview is an iframe with its own permission story, and a child process of the window is just VSCode asking for the microphone, which macOS already understands. Expect one permission prompt the first time. It is also how Claude Code's own dictation works.
    - The tools are found on `PATH` **and** in the Homebrew prefixes, because a GUI VSCode is started by `launchd` and inherits a bare `PATH` in which no Homebrew binary exists. `agentWrangler.dictation.ffmpegPath` / `.whisperPath` override the search, and `.inputDevice` picks a microphone other than the system default.
  - **Paste a screenshot straight in.** Paste or drop an image into the composer and it becomes a thumbnail with an X to take it back; it goes with your message as an image block. An image on its own is a fine message. Images too large for the API (5 MB) or in a format it will not take are refused at the paste, not hours later as a failed turn.
  - **Type `@` to mention a file.** The list is every file in the session's folder that `git ls-files` knows about — tracked *and* new-but-not-ignored, so this morning's file is there and `node_modules` is not — ranked by a fuzzy match on the filename. Arrows move, Enter or Tab completes, Escape dismisses. Outside a git repository it falls back to walking the folder.
  - **Open an edit in the real diff editor.** Any tool card carrying a patch has a button for it: side by side, syntax highlighted, navigable. Both sides are rebuilt from the patch rather than read off disk, because a transcript can be weeks old and the file changed many times since — so the tab says *changed region*, which is what it shows.
  - **The permission mode is a dropdown**: ask every time, auto-accept edits, or plan mode. It changes the live session, the same as `shift+tab` in the terminal. Defaults come from `agentWrangler.runner.defaultPermissionMode` and `runner.model`.
  - **Take over here** pulls an existing session into this window, wherever it was running — another VSCode window, a terminal, an iTerm tab. It ends that process and resumes the same session id here, which works because a Claude Code conversation *is* its transcript: resume appends to the same file under the same id, so nothing is lost. Offered only while the session is idle (*Waiting* or *Done*) — a turn in flight would be thrown away — and re-checked after you confirm, in case it started working while the dialog was up. If the old process refuses to die, the takeover is abandoned rather than risking two processes writing one transcript. An **ended** session skips all that and simply says *Resume here*.
  - **Release** is the opposite: this window stops running the session and a terminal resumes the same id. Same reasoning, same guarantee, and a turn in flight is cut off, which the confirm says.
  - **A reload brings your conversation back.** These sessions are child processes of the window, so *Developer: Reload Window* ends them — but only the processes. On startup the window resumes the one the pane was last showing, and opens it without taking focus. Bounded on purpose: the most recent session only, recorded in *this* window's state rather than shared between windows, only within the last few hours, and never one that something else has picked up in the meantime. Turn it off with `agentWrangler.runner.autoResumeLastOnStartup`.
  - Rows the dashboard knows this window is running are marked **here**, since those are the ones you can type into.
  - It runs the `claude` bundled inside your installed Claude Code extension, which is what the Claude Code panel itself runs, rather than whatever `claude` is on `PATH` (often several versions older). `agentWrangler.claudeBinaryPath` overrides that.
- Row buttons: **pin** and **archive** — archived sessions move to the always-last Archived section (collapsed by default), stop counting toward the status-bar bell, and never toast. The same button unarchives.
- Command palette: `Agent Wrangler: …` commands (dashboard, refresh, new conversation, open conversation, pin conversation, go to where a session runs, resume, copy id, reveal transcript, install/remove status hooks).

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

**Always allow** is Claude Code's own *don't ask again*, not a second implementation of it. The `PermissionRequest` payload carries `permission_suggestions` — the exact permission updates the dialog's "don't ask again" would apply, e.g. `{type: "addRules", behavior: "allow", destination: "localSettings", rules: [{toolName: "Bash", ruleContent: "npm test:*"}]}`. The button hands that list straight back as `decision.updatedPermissions` on the allow, and Claude Code applies it to the session and saves it where the suggestion says (verified in the 2.1.268 binary: an allow decision's `updatedPermissions` is validated against the same schema as the SDK's, applied via `setSessionToolPermissionContext` and persisted). Only *allow* rules and directory grants are passed through — a `deny` or `ask` suggestion is dropped rather than applied by a button with that label. The button's tooltip names the rule and where it will be saved, the status bar confirms it afterwards, and it does not appear when the payload offered no suggestion.

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

`agentWrangler.rowClickOpens` (`conversation` — or `wherever-it-runs` for the pre-pane behaviour) · `conversation.openBeside` (true) · `runner.defaultPermissionMode` (`default`) · `runner.model` (empty — Claude Code's own default) · `runner.autoResumeLastOnStartup` (true) · `agentWrangler.dashboardLocation` (`editor` — or `panel` for the bottom panel) · `openOnStartup` (true) · `claudeBinaryPath` · `stuckThresholdSeconds` (600 — generation is silent for minutes; see above) · `endedWindowHours` (48) · `maxEndedSessions` (50) · `notifyOnWaiting` (false — toast when an agent flips to waiting, blocked or done) · `pollIntervalSeconds` (5)

## Development

```bash
npm run watch      # esbuild watch (also started automatically by F5)
npm run typecheck  # tsc --noEmit
npm test           # vitest: tail parser, status table, live ~/.claude smoke test
```

Source layout: `src/claude/*` (registry reader, incremental tail parser, transcript→block reducer, status derivation, hook event reducer + log tailer + settings installer, binary resolution, provider, and `runner/` — the Agent SDK session driver and its pure message reducer), `src/core/*` (provider-agnostic store), `src/ui/*` (dashboard host + its two shells — editor tab and panel view — conversation pane host, its two sources and shells, click routing, cross-window relay, status bar, terminal resume), `src/webview/*` (browser bundles: dashboard, conversation). Webview code may only import from `src/shared/*`.

The Agent SDK is bundled into `dist/extension.js`. It is ESM and calls `createRequire(import.meta.url)` at load, which is empty in a CJS bundle, so `esbuild.mjs` defines that expression as this file's own URL — without it the extension throws before it activates.
