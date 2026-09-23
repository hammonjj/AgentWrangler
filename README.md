# Agent Wrangler

Local macOS app that monitors every AI agent session on this machine — who is **waiting on you**, who is busy, who looks stuck, and who is done — in one live dashboard.

Agent Wrangler supports **Claude Code and Codex** sessions across local VSCode windows, terminals, and desktop clients. The dashboard can filter by provider, and conversations started from Agent Wrangler can run through either Claude's Agent SDK or Codex App Server.

Status comes from Claude Code's own hooks when they're installed, so *Blocked on you* means a permission prompt is genuinely on screen — not a guess from a quiet transcript.

## Run it

```bash
npm install
npm run electron          # build, then open the window
npm run electron:nobuild  # open it against the current dist/
```

To install it properly:

```bash
npm run app:install       # build, package, and put it in /Applications
```

Nothing restarts on its own. A running copy keeps the old build until you quit and reopen it —
and quitting ends the conversations Agent Wrangler is running, so it is left to you.

`env -u ELECTRON_RUN_AS_NODE` is applied by the scripts: VSCode sets that variable in its
terminals and it makes the Electron binary behave as plain Node, so without it the app launches
with every Electron API `undefined`. It reaches `open -a` too, so launching the installed app
*from a VSCode terminal* fails the same way; from Finder or the Dock it is fine.

Codex discovery reads bounded tails from `~/.codex/sessions`; it does not modify Codex's state
database. A Codex row carries its originating client when the rollout reports one. External
Codex conversations are live, read-only transcript views. Set the dashboard provider filter to
**Codex** before pressing **+ New** to start a fully interactive Codex thread through App Server,
including streaming replies, interruption, and approval decisions.

> **There was a VSCode extension.** It was removed on 2026-09-22 — the app had caught up on
> everything that mattered, and keeping a second front end alive meant every feature needing two
> stories. `git log` has it if you need it back.

## Behavior

- **One tab, two panes, a divider you move.** The agent table and the conversation live in a single editor tab rather than two, because they are never used apart — as two tabs they could be closed independently, shoved around by a file opening into either editor group, and re-arranged by hand afterwards. Drag the divider to give either side more room, double-click it to go back to the default, or focus it and use the arrow keys (Shift for a bigger step). The position is remembered.
  - **Neither pane assumes it has the window.** The table folds its Project/Worktree/Branch/Model/PR columns below 720px, and that threshold is now measured on the *pane* rather than the window — drag the divider left and the columns fold without the window changing size at all. *Open in its own tab* still gives a conversation a tab of its own, which is the escape hatch for watching one agent while browsing others.
- **Plan usage cards sit pinned above the table (they stay put while the list scrolls)** — the same numbers as Claude Code's `/usage`: the 5-hour session, the 7-day week, any model-scoped week (e.g. *Weekly Fable*), and extra-usage credits once any have been spent. Each card has the percent, a bar (blue, yellow from 70%, orange from 90%), and a *Resets in* countdown that ticks locally. They are read every minute (`agentWrangler.usagePollIntervalSeconds`), and **every 20 seconds once any limit passes 90%** — or ten points below your auto-pause threshold, whichever is lower — because near the end of a window the question stops being "am I close" and becomes "how many minutes do I have", and a reading five minutes old is how a burst of agents crosses 98% and lands on 100%. The read costs no tokens (it is an account-metadata endpoint, not an inference call) and every window shares one read per interval, so the only budget it spends is the endpoint's own rate limit. The source is `GET /api/oauth/usage` with the login token Claude Code stored at sign-in (macOS Keychain item *Claude Code-credentials*, else `~/.claude/.credentials.json`); the token is only ever read — Claude Code owns refreshing it. If a read fails the last good numbers simply stay up and the next poll tries again (backing off); the failure is logged, not shown on the cards. The *Refresh* menu item forces a read now. Every window shares one read per interval through a cache file in the app's cache directory (the endpoint returns HTTP 429 when several windows ask at once; a 429 backs the next read off by at least five minutes, or `Retry-After`). Turn the cards off with `agentWrangler.showUsage`.
- The dashboard is a column-aligned table with collapsible sections (*Pinned / Blocked on you / Waiting / Possibly stuck / Done / Busy / Paused / Ended / Archived*); collapse state is remembered.
- **Columns are yours.** Every divider in the header is drawn, not hidden: drag one to resize the column to its right, and **only** that column changes — the elastic Agent column absorbs the difference and every other column keeps the width it had. A column can grow until Agent reaches its 110px floor, and no further, so a drag can never push the table wider than the dock. The button at the right end of the header (or a right-click anywhere on it) opens a picker for switching columns on and off, with *Reset widths*. Both the widths and the hidden set are saved in the app's state file, so they survive a restart. Anything switched off keeps showing on the row's second line, so hiding a column costs the space it took, not the fact it carried.
- **The Age column is the age of the conversation**, counting from its first prompt and across every resume since — not the time since it last said something. That was the old meaning and it answered a question the table already answers twice: a busy row carries its tool's elapsed time and an ETA, and an idle row's silence is the point of it being idle. "How long has this been going" is the thing nothing else says. The number comes from the transcript file's creation time, which is exact for the purpose — Claude Code writes no transcript until the first prompt, and `--resume` appends to the same file rather than starting a new one (checked here against 229 transcripts: every one agreed with its first line's timestamp to within a second). The cell's tooltip adds the last-activity time, so nothing was lost, and says so plainly on the rare session that has no transcript to read a birth time from.
- **A Model column** shows which model wrote the latest reply — *Opus 5*, *Fable 5.1*, *Haiku 4.5* — read from the transcript's last assistant message. The cell's tooltip has the full wire id. A model released after this build still appears, just unshortened.
- **A Worktree column** names the linked git worktree a session is working in, and is blank in a main checkout — which is the point, since several agents on one repo means several trees and *main* alone stops telling you who is where. Detected without running git: a linked worktree's `.git` is a *file* holding `gitdir: …/.git/worktrees/<name>`, where a main checkout's is a directory. A session sitting in a subdirectory still resolves, the answer is cached per directory, and *Refresh* re-checks (so a `git worktree add` shows up on the next refresh).
- **Waiting vs Done.** Both mean the agent finished its turn and is idle. *Waiting* means its last message asked you something — a question, a choice, "let me know". *Done* means it reported and stopped. The split is read off the reply text (a question mark closing the last paragraph, or a decision phrase), so it is a heuristic that errs towards *Waiting*: unknown or failed turns are always *Waiting*. Done sessions get a green dot, do not light the status-bar bell, and do toast when `notifyOnWaiting` is on.
- **Blocked rows open a permission card.** A *Blocked on you* row gets extra rows of its own under it, spanning the table: a header line with Claude's own one-line description of what it wants to do, and — sliding open underneath — the command *as it will run*, wrapped over as many lines as it takes rather than ellipsised, with **Allow**, **Always allow** and **Deny**. The card opens by itself while a decision can still land and collapses to its header once it cannot; clicking the header toggles it either way. Claude Code's own dialog keeps working; whichever is answered first wins. (Hooks required; see below for how the buttons reach Claude Code.)
- **Conversations nobody has typed into yet are hidden.** A new Claude panel or a `/clear` registers a live process with no transcript; it appears the moment the first prompt lands, not as a *Waiting* row with nothing in it.
- **Narrow docking works.** Below ~720px (a sidebar or a split bottom panel) the Project, Worktree, Branch, Model and PR columns are not rendered at all and fold into the row's second line, so the session title, status chips, ETA and age stay visible instead of being pushed off-screen. The picker shows those columns as *too narrow* rather than pretending they are on screen; widening the dock brings them back exactly as you left them.
- **An ETA column** on every busy row (hooks required). It counts down against your own turn history: until the median while the turn is still typical, then until the 90th percentile once it has outlived half its peers (yellow past p75, orange past p90, where it shows `>Xm` instead of a countdown). Italic means the baseline is still the seeded one, before 20 of your turns have been recorded. A dash means the turn's start was not observed; the cell's tooltip says why.
- **A banner at the top says when status is only estimated** — hooks not installed, disabled, or stale — with an *Install hooks* button. Once installed, it lists the live sessions that predate the install and still need a restart.
- **Clicking a row opens the conversation here.** Every session — started here, in a VSCode window, in a terminal, on this machine at all — opens in the **conversation pane** beside the dashboard, and the click never moves focus or jumps you between windows. The pane reads the session's transcript live, so it works for conversations Agent Wrangler has nothing to do with.
  - **What it renders**: prompts and replies as markdown, thinking collapsed, one card per tool call that expands to its input and output, edits as a diff. Code blocks have a copy button; links open in the browser.
  - **Permission prompts can be answered from it.** A *Blocked on you* session grows a card naming the tool and what it wants, with **Allow** and **Deny**. This is the same hook race the dashboard buttons use, so answering in Claude Code instead simply flips the card to *answered there*. (`AskUserQuestion` and plan approval are shown but cannot be answered from outside, by Claude Code's design.)
  - **Send takes over here.** For an idle external session, sending ends its previous process and resumes it here. For hook-backed busy sessions, the message waits until idle. Estimated status requires confirmation. Cancel leaves the draft intact; Release hands the session back to a terminal.
  - **Open in its own tab** (a row's right-click menu, or the pane's own *Own tab* button) gives a session a tab that row clicks never swap away. One reusable pane plus a couple of these means browsing five agents costs one tab. It was called *Pin* until pinning a dashboard row needed the word; the two are unrelated, and one menu cannot have two items called Pin.
  - **Ended sessions** open in the pane too, with *Resume here* or sending a message as the way to continue them.
- **Conversations you start here are fully interactive.** A bar across the top of the dashboard holds a **project dropdown** and a **+ New** button: pick a folder, press the button, and a Claude Code session starts there, inside the app, in the pane. It is an ordinary session in every respect that matters — it registers in `~/.claude/sessions`, runs your hooks, writes the normal transcript, and can be resumed anywhere afterwards — but this pane is its only interface, so it has no terminal to steal your attention. Unlike the Claude Code panel, which is bound to its window's workspace, one window can run sessions in **any** project on the machine. The dropdown's first row, and its default, is **Global**: a conversation that belongs to no project, for the questions that are not about code you have checked out. It runs in `~/.agent-wrangler/Global`, a scratch folder of its own rather than your home directory, so an agent asked something general has a harmless place to stand and its transcript is not filed under a project it never touched.
  - **The dropdown lists every folder you have used Claude Code in**, newest first. That list is Claude Code's own — the `projects` map in `~/.claude.json`, which it appends to itself the first time you work somewhere — plus this window's workspace folders and anything currently running, so a new project appears without being told about it. Folders that have been deleted are left out, since nothing can start in them. **Browse…** at the bottom reaches anywhere else. The dropdown shows the folder's name and its full path as a tooltip, because two checkouts of one repo share a basename.
  - **Each row has an X that removes it**, for the folders you tried once and will not open again. The entry stays in `~/.claude.json` — that file is Claude Code's, not ours, and rewriting someone else's config to tidy a dropdown is not a trade worth making — so the removal is recorded on our side and applied to every later scan. Removals are shared by every dashboard, and survive reloads. The menu stays open while you remove, so clearing three stale folders is three clicks.
  - **Anywhere you navigate to is added back.** Browsing to a folder, or starting a conversation in one, puts it in the list and undoes a previous removal — so an X is never a decision you have to be sure about. Nothing else un-removes a folder: a session that shows up in one from a terminal elsewhere leaves your list alone.
  - The choice is remembered per dashboard, not globally: two windows are usually two different jobs, and a shared setting would have each one moving where the other starts its next conversation.
  - *Agent Wrangler: New Conversation…* and the **+** in the view's title bar do the same thing through a quick pick, in the same order, for when your hands are on the keyboard.
  - **Type, interrupt, queue.** Enter sends, Shift+Enter is a newline, and a message sent mid-turn queues behind it with a *queued* chip. While Claude is working the **Send** button becomes **Stop**, which interrupts the turn in flight, and goes back to Send when the turn ends — one button, so the thing to press is always the button under the box. Enter still sends while it says Stop, so a message typed mid-turn queues rather than being eaten by the interrupt. Replies stream in a word at a time.
  - **The composer is one box.** The attachment chips, the text and a toolbar strip along the bottom — paperclip and microphone on the left, **Send** on the right — all live inside a single framed surface that takes the focus ring as a whole. It used to be a flex *row*: a textarea with two 28px icon buttons and a text button balanced on its bottom edge, which ate half the width at the 300px the pane is often used at and left Send stranded far from the text at full width. The frame moved off the textarea and onto the box around it, which is what makes the four parts read as one control.
  - **Right-click anything typeable for Cut/Copy/Paste.** An Electron app has no context menu unless it builds one, and without it a text field looks broken to a mouse: ⌘C worked, right-click did nothing at all. Editable fields now get undo/redo, cut/copy/paste, *Paste and Match Style* and Select All — greyed out per the field's own `editFlags` — with spelling corrections above them when there is a red underline; a selection anywhere else gets Copy. Installed on every renderer the app creates, so the palette and the Settings window have it too.
  - **The model dropdown** beside the permission-mode one lists exactly the models your account can use — the list is the CLI's own answer, not a hardcoded one — and switches the model for the next turn.
  - **Permission, question and plan cards are answered here.** A permission ask offers **Allow**, **Deny**, and **Always allow** when the prompt itself suggested a rule (the button's tooltip names the rule it writes). `AskUserQuestion` renders as a form with the options and an *Other* box; a plan renders with **Approve** and **Request changes**, and the feedback goes back to the model. These three are exactly what the hook path cannot do for a session running elsewhere.
  - **An ask is never something you have to go looking for.** When one arrives — and when the pane opens on a session that is already waiting — the view lands on the **top** of its card, at the question itself, rather than at the end of the conversation, which on a card taller than the pane (a long plan, a multi-part question) means landing past it on its buttons. If the card is off screen for any other reason, a strip above the composer says what Claude is waiting on (*↑ Plan ready for approval*) and clicking it brings that card's head back to the top of the view, with a one-second outline so the eye finds it. The strip disappears as soon as the card is visible: it is a pointer, not a second copy of the question. Answering starts the conversation following along again.
  - **Long blocks keep the rest one click away.** Text is capped at 6,000 characters on the way to the pane so that opening a conversation does not ship a megabyte nobody will read; anything cut gets a **Show the rest (N more characters)** button rather than a silent ellipsis, and the host hands over what it held back. It matters most on a plan — approving half a plan is approving something you have not read. A reply still streaming keeps its expansion as it grows, and if the held text has since been dropped (a 2 MB-per-conversation budget, oldest first) the button says so instead of quietly showing the short version.
  - **Dictate instead of typing.** The microphone beside the composer records; click it again and what you said lands at the cursor. Escape throws the recording away. Transcription is **local** — `ffmpeg` records 16 kHz mono, `whisper.cpp` transcribes it, and no audio leaves the machine. Roughly half a second for a sentence once warm; the very first run takes ~15s while Metal compiles its shaders, once ever.
    - It needs `brew install ffmpeg whisper-cpp` and a model. Agent Wrangler checks for all three when you click, names whichever is missing, and offers to install it or download the default model (`ggml-base.en`, 141 MB, into `~/.cache/agent-wrangler/whisper/`). Point `agentWrangler.dictation.modelPath` at a bigger model for better accuracy, or another language.
    - The recording runs in the main process, not the webview — a webview is an iframe with its own permission story, and a child process of the app is just the app asking for the microphone, which macOS already understands. Expect one permission prompt the first time. It is also how Claude Code's own dictation works.
    - The tools are found on `PATH` **and** in the Homebrew prefixes, because a GUI VSCode is started by `launchd` and inherits a bare `PATH` in which no Homebrew binary exists. `agentWrangler.dictation.ffmpegPath` / `.whisperPath` override the search, and `.inputDevice` picks a microphone other than the system default.
  - **Paste a screenshot straight in.** Paste an image into the composer and it becomes a thumbnail with an X to take it back; it goes with your message as an image block. An image on its own is a fine message. Images too large for the API (5 MB) or in a format it will not take are refused at the paste, not hours later as a failed turn.
  - **Drop files on the pane to attach them.** Anywhere on the pane, from the Finder or from VSCode's own explorer: an image is attached as an image, and anything else — a source file, a folder — is written into the box as an `@` mention, relative to the session's folder when it lives inside it. That is what dragging a file into the TUI does, and it is the cheaper half: Claude reads the ones it actually needs instead of a dropped folder arriving whole in the prompt. An image past the 5 MB ceiling goes in as a path rather than being refused, since Claude's own Read can open it. Paths come from the drag's `text/uri-list`; a file dropped without one (an image dragged straight out of another app) still attaches by its bytes.
  - **Type `@` to mention a file.** The list is every file in the session's folder that `git ls-files` knows about — tracked *and* new-but-not-ignored, so this morning's file is there and `node_modules` is not — ranked by a fuzzy match on the filename. Arrows move, Enter or Tab completes, Escape dismisses. Outside a git repository it falls back to walking the folder.
  - **Open an edit in the real diff editor.** Any tool card carrying a patch has a button for it: side by side, syntax highlighted, navigable. Both sides are rebuilt from the patch rather than read off disk, because a transcript can be weeks old and the file changed many times since — so the tab says *changed region*, which is what it shows.
  - **The permission mode is a dropdown**: ask every time, auto-accept edits, or plan mode. It changes the live session, the same as `shift+tab` in the terminal. Defaults come from `agentWrangler.runner.defaultPermissionMode` and `runner.model`.
  - **The model is a dropdown beside it**, and switching applies to the next reply, the same as `/model` in the terminal. The list is the CLI's own answer to "which models may this account use", asked once per session rather than hardcoded, so it never offers a model you cannot reach and never goes stale as models are added. It appears once the session has started; if an older CLI cannot answer, the dropdown stays hidden rather than guessing. The session reports back the *resolved* id (`claude-sonnet-4-5-…`) while the list offers aliases (`sonnet`), so the dropdown matches the two up — and shows the raw id rather than the wrong name if it ever cannot.
  - **Take over here** pulls an existing session into this window, wherever it was running — another VSCode window, a terminal, an iTerm tab. It ends that process and resumes the same session id here, which works because a Claude Code conversation *is* its transcript: resume appends to the same file under the same id, so nothing is lost. Offered only while the session is idle (*Waiting* or *Done*) — a turn in flight would be thrown away — and re-checked after you confirm, in case it started working while the dialog was up. If the old process refuses to die, the takeover is abandoned rather than risking two processes writing one transcript. An **ended** session skips all that and simply says *Resume here*.
    - **The button and the composer no longer say the same thing.** The note beside *Resume here* used to read "Send resumes this session here and ends its previous process" — two ways to do one thing, printed side by side, which makes the button look redundant. It is not: until the session is adopted the permission-mode, model and effort dropdowns are disabled, so choosing a model before writing anything needs the button. The note now says what the *button* is for (*Ended. Resume it here, or just type — sending resumes it too.*) and the hint about Send moved to where Send is typed, the placeholder.
  - **Release** is the opposite: this window stops running the session and a terminal resumes the same id. Same reasoning, same guarantee, and a turn in flight is cut off, which the confirm says.
  - **A reload brings your conversation back.** These sessions are child processes of the window, so *Developer: Reload Window* ends them — but only the processes. On startup the window resumes the one the pane was last showing, and opens it without taking focus. Bounded on purpose: the most recent session only, recorded in *this* window's state rather than shared between windows, only within the last few hours, and never one that something else has picked up in the meantime. Turn it off with `agentWrangler.runner.autoResumeLastOnStartup`.
  - **And it brings back what was *said*, not just the session.** A resumed session streams nothing of its past — the SDK picks the conversation up and carries on — so a pane showing one used to come back empty while the model still held every word of it, and the only way to see where you had got to was to ask the agent to repeat itself. The pane now reads the session's transcript for the half that happened before the resume and puts it above the live half, so a reload, a *Take over* and a *Resume here* all land you at the bottom of the conversation you were already having. The two halves can never overlap or double up: the transcript is read once, before the resumed process is started, so it holds strictly the past. The same 512 KB / 300-block window the read-only pane uses applies, with the same notch at the top when there is more above it.
  - Rows this window runs carry no badge of their own. They used to be marked **here**, which marked the rule instead of the exception — with nearly everything running in one window it appeared on nearly every row — so it went. A row's tooltip still says where clicking it will open the session.
  - It runs the `claude` bundled inside your installed Claude Code VSCode extension, which is a far newer build than whatever `claude` is on `PATH`. `agentWrangler.claudeBinaryPath` overrides that.
- **Pause the agents when the tokens run low.** The bar above the table has a controls group pushed to its right, opposite the launcher, and the first thing in it is one button that freezes **every** running agent on the machine — not just this window's. Pressing it sends `SIGSTOP` to each session's process: a stopped `claude` makes no further API requests, so it spends nothing, and `SIGCONT` puts it back exactly where it was. Anything paused turns the button into **▶ N**, so a half-frozen fleet is one click from running again.
  - **Per session, from the row's right-click menu** — *Pause agent* / *Resume agent*. Neither asks for confirmation, unlike *Close session*: pausing is undone by the same menu item, and a dialog in front of the button you reach for while watching the last of your tokens disappear is friction in the wrong place.
  - **Paused rows move to their own *Paused* section**, above *Ended*, with a purple dot and a `paused` chip — a frozen agent is a live process you are coming back to, not one of the two sections that hold what you are finished with. The section exists because a frozen session's status stops being about the session: status is read from transcript activity, and a stopped process makes none, so a paused row left in Busy would read as work in progress and then relabel itself *Possibly stuck* — which is why the row's tooltip says it is paused rather than naming a status that is no longer moving. They stop counting toward the status-bar bell for the same reason: a frozen *Blocked* session is asking a question that nothing can answer until it is resumed.
  - **What it costs.** Nothing at all for an idle agent. A turn *in flight* is the exception: its HTTPS request is held open by a process that has stopped reading it, so a long pause can have the far end drop the connection and that turn fails on resume. Everything already written to the transcript is kept, so the cost is one turn, never the conversation. This is also why pausing is not `SIGKILL`: a stopped process finishes its partial writes when it resumes, so the transcript is never truncated.
  - **It works for sessions Agent Wrangler has nothing to do with** — another VSCode window, an iTerm tab, anywhere on the machine — because a signal is the one channel into a running Claude Code TUI that exists.
  - **Nothing is written down: which agents are paused is read from the OS.** `ps` reports a stopped process as state `T`, so every dashboard asks the same question of the same authority and gets the same answer. That is what makes a pause in one window visible in another, survive a reload, need no cleanup when a paused agent is killed from its own terminal, and correct itself if a signal is ever refused — and it means an agent you stopped by hand with `kill -STOP` shows up as paused too, with a button to start it again. The first cut of this kept a persisted set of "sessions this window paused" instead; a second window could neither see those records nor preserve them, so pausing anything there erased them, and a stopped process whose record has been erased is frozen with nothing left to thaw it.
  - **Closing or taking over a paused session continues it first**, since a stopped process cannot act on the SIGTERM that *Close session* sends — it would sit out the whole grace period and then be SIGKILLed, which is the one way to strand a half-written transcript line.
  - **Auto-pause** (`agentWrangler.autoPause.enabled`, off by default) does it for you at `autoPause.percent` — **98%** by default, across *any* limit window, not just the one currently constraining requests: a weekly limit at 99% ends the day as firmly as the five-hour one. 98 rather than 100 leaves room for the reading to be a poll old and for a turn that started at 99% to finish. It fires **once per approach**: after firing it re-arms only when usage falls back under the threshold, so an agent you deliberately resumed at 98% is not frozen again at the next poll. A failed usage read never triggers it — no reading is not evidence of exhaustion, and freezing every agent on the machine is too blunt a thing to do on a guess — and it stays armed until it has actually stopped something, so a window reloaded while over the threshold does not spend its one shot before the first session scan has found anything to pause. Turning it on also keeps the usage reads going when `showUsage` is off: hiding the cards is a preference about a narrow dock, and it must not quietly switch off a spending guard.
- **Organize conversations into your own sections.** The table has a status view for *Blocked on you*, *In progress*, *Paused*, *Done* and the other live states, plus a sections view for your own organization. Every conversation starts in the always-present **General** section. Right-click a row and choose *Add to…* to move it to an existing section, or create a new named section and add it in one step.
- **Give a conversation your own name.** *Give it a name…* on the row menu opens a box showing the current title as a placeholder, so you type a name rather than edit one; once a name is set the item reads *Rename…*, the box is prefilled with it, and emptying the box puts the original title back. It is deliberately not prefilled the first time — filling it with the derived title would let you freeze today's guess at a name as a literal one, which would then stick when the real title improved. The name shows everywhere the session does — the dashboard row, the conversation pane's header and tab, the status-bar tooltip, the toasts, the command palette's picker, and the terminal tab a resume opens — because it is applied in the session store, which is the one thing all of those read from. The row's tooltip still carries the title it came with.
  - **It is a nickname, not a rename, and that is deliberate.** A Claude Code session's title is not a field anyone owns: it is derived from the `ai-title` line the model writes into the transcript, then the registry's generated handle, then the slug of the first prompt, then the first prompt itself. Changing it for real would mean writing into `~/.claude/sessions/<pid>.json` or appending to the transcript — both Claude Code's files, and the second one *is* the conversation. This repo already declined to rewrite `~/.claude.json` to tidy a dropdown; corrupting a conversation to relabel it is a far worse trade. Keeping the name on our side also means it works on ended sessions and on sessions Agent Wrangler has never run, and that clearing it is a real undo rather than a second rename back to a remembered string.
- **Right-click a row for its actions.** *Add to…*, *Give it a name…*, *Open in its own tab*, *Go to where it runs*, *Pause agent*, *Copy session id*, *Archive* — and, separated and in red at the bottom, *Close session…*. Archived sessions move to the always-last Archived section in the status view (collapsed by default), stop counting toward the status-bar bell, and never toast; the same item unarchives.
  - **Close session** ends the process running a session and stops there — it hands it to nobody, unlike *Take over* and *Release*. That is safe for the same reason those are: a Claude Code conversation *is* its transcript, so closing one parks it rather than destroying it. The row moves to *Ended* and the conversation resumes from where it stopped. Unlike *Take over* it is offered **while a turn is in flight**, because the session most worth closing is the one that has wedged; the confirm says so plainly when that is the case. A session this window runs is stopped gracefully; anything else gets SIGTERM, then SIGKILL if it has not gone in five seconds, and an error rather than a silent failure if it refuses both. Ended sessions and live ones with no known pid do not get the item at all — there would be nothing to signal.
  - **Every provider, not just Claude.** It used to be Claude-only, which left *Archive* — a hide, not a stop — as the only thing you could do to a Codex row you were finished with. The two real conditions are the ones above and they answer for any provider: a Codex thread this window runs has no pid of its own (one app-server serves every thread) and is closed by releasing it, and a Codex conversation running somewhere else has neither a pid nor a handle and correctly does not offer the item.
- The menu carries the same actions (refresh, new conversation, open conversation, open a conversation in its own tab, rename a conversation, go to where a session runs, resume, copy id, reveal transcript, pause all agents, resume all paused agents, pause or resume one agent, install/remove status hooks, connect or disconnect Discord).

## Remote control (experimental)

Answer a permission prompt from your phone. Off by default, and under
**Preferences → Experimental** because it is the only thing here that reaches
outside the machine.

Agent Wrangler stays in charge throughout. Discord shows the same choices the
dashboard row shows, and pressing one runs the same action — the agent never
learns Discord exists, and nothing can be approved remotely that the local UI is
not already offering.

**Setting it up.** At [discord.com/developers](https://discord.com/developers/applications):

1. **New Application** → **Bot** → **Reset Token**, and copy it.
2. **Leave the Interactions Endpoint URL empty.** This is the one that matters.
   Filling it in tells Discord to deliver button presses to that URL over HTTPS
   instead of down the connection the bot opens itself — which is exactly what
   would require a public address, and the feature is built to avoid.
3. **OAuth2 → URL Generator** → scope `bot`, permissions *View Channel*,
   *Send Messages*, *Embed Links*. Open the URL and add it to your server.
4. If the channel is private — a good idea — add the bot to **that channel**
   explicitly. Being in the server is not enough, and the failure looks like the
   bot simply ignoring you.
5. **Connect Discord…** from the app menu, and paste the token. It is checked
   against Discord before it is saved, so a typo fails there rather than later
   as a connection error. It goes to the **system keychain**, never to
   `settings.json`.
6. In **Preferences → Experimental**, fill in the server ID, the channel ID and
   the Discord user IDs allowed to answer. Turn Developer Mode on in Discord
   (User Settings → Advanced) to copy IDs. An empty allowlist means **nobody**,
   and nothing is published at all.

**What you get.** When an agent hits a permission prompt, one message appears
naming the agent, repository, branch, worktree and tool, with the command in a
code block and Claude's own reason. It carries **Allow once**, **Deny**, and
**Always allow ‹rule›** when — and only when — Agent Wrangler itself is offering
that (the prompt has to have suggested a rule). Press one and the agent
continues; the message is edited to say who answered and when, and the buttons
are removed.

Answer at the machine instead and the message closes itself, saying it was
answered in Agent Wrangler. It does not claim which way: there is no
`PermissionGranted` hook, so after the fact that genuinely cannot be known, and
a guess would be worse than the blank.

**It also says when an agent finishes** (`remote.notifyOnDone`, on once Discord
is connected). A buttonless message naming the agent, repository and branch —
never a word of what it said, which is the news being on the machine where it is
safe. It rides the same working→finished edge the local toasts do, so it fires
once per finish rather than repeatedly while a session sits there done, and an
archived session stays quiet. Codex sessions are included: nothing is being
offered, so nothing has to be answerable.

**Auto-pause tells you too.** When the usage guard stops every agent, a second
kind of message appears: no buttons, just the threshold it crossed, how many
agents were paused and on which machine. It is the one thing worth knowing from
away from the desk that nobody is waiting on you for — everything has stopped and
will stay stopped until you resume it in the app. It is sent once, when it
happens; if Discord is disconnected at that moment it is dropped rather than
delivered late, since by the time a reconnect lands it is no longer news. A pause
*you* pressed sends nothing: you are sitting in front of the machine that did it.

**The toolbar's Discord button is all of it, not some of it.** Lit, everything
above goes to the channel; unlit, nothing does — permission cards included, and
any card still open in the channel is closed as cancelled when you press it. It
used to exempt permission prompts, on the reasoning that muting one could strand
an agent you are away from; in practice a button reading *off* while the channel
keeps filling up reads as broken, and the prompt is not lost either way — it is
still waiting in Agent Wrangler, and switching the button back on republishes
whatever is still being asked. It is the same thing as `remote.notificationsEnabled`
in Preferences, and appears in the toolbar only once Discord is configured.

**What it does not do yet.** Questions (`AskUserQuestion`) and plan approvals are
not mirrored — they never reach the `PermissionRequest` hook, so they are only
answerable in the app. There is no Slack transport, no chat, and no way to start
or stop an agent remotely.

**Security.** The token is in the keychain, encrypted by the OS, in its own file
at mode 0600 — never in settings, never logged, and stripped from error
messages. Presses are accepted only from the configured server and channel, only
from a listed user ID (never a username: those can be changed and reused), and
only for a prompt Agent Wrangler still has open — a press on a card whose prompt
has since been answered cannot land on whatever replaced it. Commands are
redacted before they are sent: assignments to secret-looking names, vendor
tokens, bearer headers, PEM blocks and `--password`-style flags are masked, and
your home directory is folded to `~`. Every publish, press, refusal and
resolution is appended to `~/.cache/agent-wrangler/remote/audit.log`, which
records IDs and tool names but not command text — the channel already has that.

**Exactly one gateway socket, always.** Discord will happily let one bot hold
several connections at once, and they are not redundancy: every socket receives
every interaction, all of them race to acknowledge the press, and the losers get
`404 Unknown interaction` — which the card renders as *"The application didn't
respond in time."* They also breed. Each socket that dies asks for a replacement,
so a gateway that can be holding two is a gateway that will be holding two
hundred by morning, blowing Discord's identify limit and going silent.
`DiscordGateway` therefore keeps its per-connection state (the socket, its
heartbeat timer, whether the last beat was acknowledged) on a `Connection`
record, not on the instance, and every callback checks it is still the current
one before acting. A superseded connection is inert: its close event asks for
nothing, its heartbeat sends nothing. There is one reconnect chain, single-flight
and epoch-stamped, so closes arriving during a backoff cannot start chains of
their own. The test fake fires a close event when closed locally, exactly as a
real `WebSocket` does — a fake that stayed quiet is what let this through the
first time.

**One known race.** If you answer at the machine and in Discord within the same
half-second, whichever decision file lands last wins. This is the same race
Claude Code's own dialog already has with Agent Wrangler's buttons, and it is
documented rather than arbitrated.

## How status is detected

Two sources, in priority order. Hooks are ground truth; the transcript is a fallback.

### 1. Hooks (exact, opt-in)

Choose **Install Status Hooks…** from the menu (or click *Install hooks* in the dashboard banner). It merges a block into `~/.claude/settings.json` in which every hook appends its stdin payload to `~/.claude/agentwrangler/$PPID.jsonl`; Agent Wrangler tails those logs. The one exception is `PermissionRequest`, which runs `~/.claude/agentwrangler/permission-hook.sh` (written by the installer) — see *Allow / Deny* below.

| Signal | Meaning |
|---|---|
| `PermissionRequest` · `Elicitation` · `Notification`/`agent_needs_input` · `PreToolUse` for `AskUserQuestion` / `ExitPlanMode` | **Blocked on you** (row names the tool, and what for) |
| `Stop` with a reply that asks something · `StopFailure` | **Waiting** |
| `Stop` with a reply that just reports | **Done** |
| `UserPromptSubmit` · `PreToolUse` · `PostToolUse`/`PostToolBatch` | **Busy** (row shows the in-flight tool and its elapsed time) |
| no events at all past `stuckThresholdSeconds` (default 10 min), nothing in flight | **Possibly stuck** |
| `SessionEnd`, or pid gone | **Ended** |
| `SessionStart` with no transcript yet | *hidden* (an empty conversation) |

**Allow / Deny from the dashboard.** Claude Code runs `PermissionRequest` hooks and shows its permission dialog *at the same time*, then takes whichever answers first (verified in the 2.1.267 binary: the hook generator and the dialog promise are started together and raced). The installed script logs the payload like every other hook, leaves a marker in `~/.claude/agentwrangler/requests/`, and then polls for `decisions/<id>.json` for up to ~28 minutes (its hook `timeout` is 30 minutes). Clicking **Allow** or **Deny** writes that file with Claude Code's own decision shape (`hookSpecificOutput.decision.behavior`); the script prints it and exits, and Claude Code applies it. If you answer in Claude Code instead, the decision is picked up from the pid file (below), which also removes the marker, and the script exits within half a second. The buttons only render while the marker exists, so they never offer a decision that can no longer land. Tools that require interaction by design (`AskUserQuestion`, `ExitPlanMode`) cannot be answered this way and show no buttons.

**Answering in the Claude Code window** is the one thing hooks cannot report, so it is read off the pid file instead. There is no `PermissionGranted` hook — Claude Code 2.1.270 registers `PermissionDenied` but has no counterpart for the other answer — and the event order is `PreToolUse` → `PermissionRequest` → *you answer* → `PostToolUse`. `PostToolUse` fires when the tool has **finished**, so on hooks alone, allowing a ten-minute test run would leave the row in *Blocked on you* for the whole ten minutes, which is exactly backwards. `~/.claude/sessions/<pid>.json` closes the gap: Claude Code rewrites a `status` field there on every state change — `running` → `busy`, `requires_action` → `waiting` (with `waitingFor` = `permission prompt` or `input needed`), `idle` → `idle` — stamped with `statusUpdatedAt`. Measured here, the flip back to `busy` is written within ~0.1 s of the click, and stays `waiting` for as long as a prompt is genuinely open. The registry watcher already sees that write, so the row clears in well under a second however long the allowed command then runs. The status is only ever used to *end* a block, never to start one, and only when its stamp is later than the moment the block was recorded — a `busy` written before the prompt existed cannot cancel it. Sessions from an older Claude Code that writes no `status` simply keep the old behaviour.

**Always allow** is Claude Code's own *don't ask again*, not a second implementation of it. The `PermissionRequest` payload carries `permission_suggestions` — the exact permission updates the dialog's "don't ask again" would apply, e.g. `{type: "addRules", behavior: "allow", destination: "localSettings", rules: [{toolName: "Bash", ruleContent: "npm test:*"}]}`. The button hands that list straight back as `decision.updatedPermissions` on the allow, and Claude Code applies it to the session and saves it where the suggestion says (verified in the 2.1.268 binary: an allow decision's `updatedPermissions` is validated against the same schema as the SDK's, applied via `setSessionToolPermissionContext` and persisted). Only *allow* rules and directory grants are passed through — a `deny` or `ask` suggestion is dropped rather than applied by a button with that label. The button's tooltip names the rule and where it will be saved, the status bar confirms it afterwards, and it does not appear when the payload offered no suggestion.

*Possibly stuck* is deliberately slow to trigger. Hooks fire on tool calls and prompts, not while the model is generating, so a long think or a large `Write` is silent for minutes (measured in one ordinary turn: 121s, 388s, 79s, 104s). The ETA column is what says "running long"; *stuck* means nothing at all for ten minutes.

A **paused** session is silent by construction — its process is stopped, so it writes no transcript and fires no hooks — and both tables above would eventually call it *Possibly stuck*. Pausing is tracked separately from status for exactly that reason: the row moves to the *Paused* section, keeps the status it was stopped at, and is left out of the bell and the toasts until it is resumed.

Notes on the install, all verified against the shipped Claude Code:

- **Your existing hooks are preserved.** The installer merges and backs `settings.json` up first; uninstall removes exactly its own entries. Unparseable settings abort rather than being overwritten.
- **Only new sessions report.** Claude Code snapshots hook config when a session starts, so editing settings does nothing to sessions already running.
- **Overhead is a shell append**, no interpreter startup. The log is sharded by the Claude pid because `cat >>` is only atomic while a payload fits in one write: measured here, 30 concurrent appends stay intact at 20 KB each but corrupt 6 of 30 lines at 64 KB and most at 128 KB. A `tool_input` holding a large `Write` reaches that easily; sharded, the same test is clean at 1 MB.
- Hooks can be silently suppressed by `disableAllHooks`, safe mode, an org policy allowing only managed hooks, or unaccepted workspace trust. Agent Wrangler warns rather than leaving you to wonder.

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

`runner.defaultPermissionMode` (`acceptEdits` — or `default` to be asked every time, `plan` to plan first) · `runner.model` (empty — Claude Code's own default) · `runner.autoResumeLastOnStartup` (true) · `openOnStartup` (true) · `claudeBinaryPath` · `stuckThresholdSeconds` (600 — generation is silent for minutes; see above) · `endedWindowHours` (48) · `maxEndedSessions` (50) · `notifyOnWaiting` (false — toast when an agent flips to waiting, blocked or done) · `pollIntervalSeconds` (5) · `showUsage` (true) · `usagePollIntervalSeconds` (60, and 20 by itself near a limit) · `autoPause.enabled` (false) · `autoPause.percent` (98)

## Development

```bash
npm run watch      # esbuild watch
npm run typecheck  # tsc --noEmit
npm test           # vitest: tail parser, status table, live ~/.claude smoke test
```

Source layout: `src/claude/*` (registry reader, incremental tail parser, transcript→block reducer, status derivation, hook event reducer + log tailer + settings installer, binary resolution, provider, and `runner/` — the Agent SDK session driver and its pure message reducer), `src/core/*` (provider-agnostic store), `src/ui/*` (dashboard host + its two shells — editor tab and panel view — conversation pane host, its two sources and shells, click routing, cross-window relay, status bar, terminal resume), `src/webview/*` (browser bundles: dashboard, conversation). Webview code may only import from `src/shared/*`.

The Agent SDK is bundled into `dist/electron/main.js`. It is ESM and calls `createRequire(import.meta.url)` at load, which is empty in a CJS bundle, so `esbuild.mjs` defines that expression as this file's own URL — without it the extension throws before it activates.

## Conversation continuity

- Recently interrupted sessions carry a **was here** chip. Only the most recent session auto-resumes; open another and send or choose Resume here.
- **Load earlier messages** pages backward through the transcript; **Find in conversation** searches the archive and shows up to the latest 100 matching blocks. Clear restores the live view.
- Tool output can be expanded in full. Agent/Task cards offer **Load subagent work** after the parent transcript links the sidecar; live subagent messages nest under their parent.
- Type `/` for commands; Tab focuses the first completion. `/compact`, `/clear`, and `/context` were checked in streaming mode. Commands advertised by the CLI are also offered. `/clear` changes the session identity, just as in Claude Code.
- Cost is the cumulative **estimate for this runner invocation**, not lifetime billing. Context is the latest summary supplied by the CLI, refreshed after each turn when supported.
- `agentWrangler.runner.confirmTakeoverOnSend` restores confirmation for all send-triggered takeovers. Estimated status always requires confirmation.
- The dashboard and conversation share one workbench tab; row clicks stay here. Deliberate terminal release remains available.

Source-checkout handoff: `docs/plans/electron-prep-handoff.md` lists acceptance checks and remaining limitations.
