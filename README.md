# Agent Wrangler

Agent Wrangler watches every AI agent session on a Mac — who is **waiting on you**, who is
busy, who looks stuck, and who is done — and runs conversations of its own. You see and drive
all of it from one live workbench in a browser: on that Mac, or on a phone or another computer
on your home network once you have paired it.

It sees **Claude Code and Codex** sessions however they were started: in a terminal, an
editor, a desktop client, another agent's subprocess, or Agent Wrangler itself. The table can
filter by provider, and conversations started from Agent Wrangler run through Claude's Agent
SDK or Codex App Server.

Status comes from Claude Code's own hooks when they're installed, so a row that says it is waiting on a permission prompt means the prompt is genuinely on screen — not a guess from a quiet transcript.

## How it fits together

| Part | What it is | Where it runs |
|---|---|---|
| **Execution host** | The Mac that runs the agents and everything they touch: repositories, worktrees, builds, tests, and any app an agent drives (Unity, an automation browser) | One Mac |
| **Core daemon** | The background service that owns all of Agent Wrangler's state: sessions, the conversations it runs, missions, Discord, `aw` and the web server. A LaunchAgent, `com.hammonjj.agentwrangler.core` | The execution host |
| **Session hosts** | One small process per Claude conversation, so restarting or updating the daemon never ends one. Codex threads run in a background Codex server the same way | The execution host |
| **Browser clients** | Any browser showing the workbench. A client renders and sends commands; it never runs agent work | The Mac itself, or a paired phone, tablet or computer on your home network |

What follows from that:

- **Work happens on the execution host.** A file you attach from a phone is uploaded to the
  Mac. A folder you pick is a folder on the Mac, and every path the workbench shows is a path on
  the Mac. An app an agent drives stays on the Mac's screen: the browser shows what the agent
  reports, screenshots included, never a live view of a Mac window. Use macOS Screen Sharing
  for that.
- **Loopback by default.** The workbench listens on `127.0.0.1:7391`, and even there a browser
  has to sign in (`aw web open`).
- **Your home network is opt-in.** *Allow devices on my home network* adds an HTTPS listener on
  the Mac's private addresses, with a certificate from a local CA you trust once per device, and
  each device is paired one by one. See [LAN access](#lan-access).
- **Never the internet.** No public URL, no port forwarding, no relay, no cloud account. Away
  from home, Discord is the channel (see [Remote control](#remote-control-experimental)), and it
  only ever makes outbound connections.
- **One approval path.** Allowing a tool, answering a question and approving a plan go through
  the same server-side actions whether the press came from a browser on the Mac, a phone,
  Discord or `aw`. The first answer wins; a client that answers late is told it was already
  answered. Nothing can be approved remotely that the table is not already offering.
- **One user.** Every client acts as the Mac account's owner, the single `local-owner`
  principal. Each request still says who is acting and how (`browser`, `cli`, `discord`, or the
  daemon acting by itself), passes one `authorize()` check, and is written to the access log by
  id. There are no accounts. Adding them later would mean a principal store and sign-in,
  per-user preferences (columns, favourite projects, notification choices, drafts), an owner on
  sessions and missions, and a real `authorize()` policy, while agent runtimes, hooks, secrets
  and the listener stay shared by the host (`docs/plans/browser-workbench.md` §9).
- **Closing every tab stops nothing.** The daemon does not track browsers: agents keep running,
  and the next tab you open picks up the current state.

**What the browser does not do.** Agent Wrangler used to be a desktop window (Electron),
retired in #142. A few things went with it:

| Gone | What there is instead |
|---|---|
| A window of its own, a Dock icon, a menu-bar item with the attention count | A browser tab. Decision D4 gives the count to the tab's title, but that is not built yet: the title names the page only |
| Clickable Mac notifications while no tab is open | A plain Mac notification from the daemon (clicking it does nothing), plus Discord when it is on. See [Notifications and dictation](#notifications-and-dictation-in-a-browser-141) |
| A live preview of the words while dictating | The browser records; the Mac transcribes when you stop |
| *Resume in Terminal* and *Release* into a new Terminal window | The `claude --resume` command, shown to copy and run yourself |
| *Open in its own tab* | Open the conversation in a second browser tab |
| A side-by-side diff editor for an edit | The tool card shows the whole patch |
| The menu's *Refresh*, *Restart Codex Server* and *Remove Status Hooks* | No control yet. Usage is read every minute anyway; Codex's server is restarted at daemon start when nothing is running; hooks can be removed by hand from `~/.claude/settings.json` |

## Getting started

This sets up a new Mac, then a phone. Everything runs on the Mac; the phone needs only a
browser.

**The Mac needs:** Git and the Xcode Command Line Tools (`xcode-select --install`; the
launcher is compiled with `clang`), Node and npm to build (the app then runs on its own pinned
Node 22), and Claude Code or Codex, installed and signed in. Dictation also needs
`brew install ffmpeg whisper-cpp`.

1. **Get the code.**

   ```bash
   git clone https://github.com/hammonjj/AgentWrangler.git
   cd AgentWrangler
   npm install
   ```

2. **Create the signing certificate**, once per Mac: `npm run app:signing-setup`. macOS asks
   for your login password to trust it. See [Signing](#installing-updating-and-restarting)
   for why.
3. **Build and install the app:** `npm run app:install`. It puts *Agent Wrangler* in
   `/Applications`. The first build may ask whether `codesign` may use the key: choose
   **Always Allow**.
4. **Put `aw` on your PATH:** `npm run cli:install`.
5. **Open Agent Wrangler** from `/Applications`, Spotlight or Finder, or run `aw web open`.
   Either starts the core daemon, then opens your default browser at
   `http://127.0.0.1:7391/`, signed in. `aw daemon status` should now say
   `Core daemon: running`, with its build.
6. **Install the status hooks.** The table shows a banner saying status is only estimated;
   press **Install hooks**. Claude Code sessions started from then on report exact status;
   restart the ones already running when convenient. See
   [How status is detected](#how-status-is-detected).
7. **Preferences** (the *Preferences* link in the page's bar, `#/preferences`):
   - *Open at login* starts the daemon when you log in, with no browser, so Discord and running
     agents are covered after a reboot.
   - To be told when an agent needs you while the tab is in the background, turn on *Notify
     when an agent needs you* (off by default), then press **Enable notifications** in the
     page's banner and allow them. With no tab open, the Mac notifies by itself (*Notify while
     no tab is open*, on by default).
8. **Add a phone** (optional; same home network as the Mac):
   1. In Preferences → Browser, turn on *Allow devices on my home network*. Allow incoming
      connections if the macOS firewall asks.
   2. Trust the Mac's local CA on the phone, once: see
      [Trusting the CA on an iPhone or iPad](#lan-access).
   3. Pair it: run `aw web pair` on the Mac and scan the QR code with the phone. See
      [Pairing a device](#pairing-a-device).
   4. On the phone, bookmark the page. Browser notifications do not reach an iPhone yet; see
      [Notifications and dictation](#notifications-and-dictation-in-a-browser-141).
9. **Discord** (optional, for answering from away from home): see
   [Remote control](#remote-control-experimental).

If something does not come up, see [Troubleshooting](#troubleshooting).

## Installing, updating and restarting

Agent Wrangler is a background service, the **core daemon**, plus a web workbench that a
browser opens. Opening the app (Finder, Spotlight) makes sure the core daemon is running on
this build, asks it for a one-time sign-in link, opens that in your default browser, and exits:
there is no Dock icon to linger. `aw web open` does the same from a terminal.

From a checkout, without installing:

```bash
npm run build
node dist/launcher/main.js            # start this checkout's daemon (no LaunchAgent) and open a browser
node dist/launcher/main.js --dry-run  # say what it would do; start, install and open nothing
```

**What the app bundle is.** `npm run app:package` (`scripts/package-app.ts`) assembles
`release/Agent Wrangler.app` with no Electron and no electron-builder:

| Path in the bundle | What it is |
|---|---|
| `Contents/Info.plist` | Bundle id `com.hammonjj.agentwrangler`, kept from the Electron builds so privacy grants stay valid; `LSUIElement` (no Dock icon) |
| `Contents/MacOS/Agent Wrangler` | The launcher: a small compiled C program (`src/launcher/launcher.c`) that execs the bundled Node on `dist/launcher/main.js` |
| `Contents/Resources/node/bin/node` | The pinned official Node (`scripts/fetch-node.mjs`, #129) |
| `Contents/Resources/app/dist/…` | The daemon, session host, `aw` and launcher programs, the web page, the qualification fixtures; plain files, no asar |

It is signed with the identity below and checked with `codesign --verify --deep --strict`.
Hardened runtime stays off, as before.

**Signing, once per Mac.** Packaged builds are signed with a self-signed certificate,
*Agent Wrangler Local Signing*, from your login keychain. Create it before the first
`app:install`:

```bash
npm run app:signing-setup # create the certificate and trust it for code signing
```

macOS asks for your login password once, to trust the certificate. The first build may ask
whether `codesign` may use the key; choose **Always Allow**. The script does nothing if the
certificate is already there. Without the certificate, `app:package` fails; it will not fall
back to an unsigned build.

The reason is that macOS pins privacy grants (Screen Recording, Accessibility, microphone) to
the app's signature. With an ad-hoc signature each rebuild counts as a new app, so the grants
stopped working while System Settings still showed them on. With a fixed certificate they
survive rebuilds. `codesign -dv "/Applications/Agent Wrangler.app"` should show
`Authority=Agent Wrangler Local Signing`, not `Signature=adhoc`. If you are moving off an
ad-hoc build, grants made before the switch are stale. Clear them once with
`tccutil reset ScreenCapture com.hammonjj.agentwrangler` (and `Accessibility`), then grant
again. This setup only covers one machine. Distributing the app needs an Apple Developer ID
certificate and notarization (#57).

**Installing and updating.** `npm run app:install` (`scripts/install-app.sh`):

1. quits a running Electron-era copy of the app (from before #142) the ordinary way. As a
   window client it ends nothing; running its own core it ends only Codex threads it ran in its
   own process. Run inside an agent Agent Wrangler runs, it leaves such a copy alone and tells
   you to quit it;
2. replaces `/Applications/Agent Wrangler.app`;
3. runs `aw daemon start` from the new bundle when the daemon (or an old app) was running. That
   rewrites the LaunchAgent for the new build; the old daemon stops as `aw daemon stop` does,
   and the new one reattaches every session host. A daemon you stopped stays stopped;
4. refreshes an installed `aw` that is a copy of `bin/aw`.

**Migrating from an Electron build.** Secrets moved from Electron `safeStorage` to the
Keychain in #124, and only an Electron build could do that move. A copy older than #124 must
first run a build that includes #124 but predates #142 (any `main` between the two merges),
open it once, then install this one. `experimental.coreDaemon` is retired
and removed from `settings.json` at startup: the daemon always runs the core. The old remote
daemon's LaunchAgent (`com.hammonjj.agentwrangler.remote`) is removed the first time the core
daemon starts.

**Restarting** means restarting the core daemon: `aw daemon start` from a newer install, or
`aw daemon stop` then opening the app. Neither ends a Claude conversation or a Codex thread on
the background server, and a tab left open reconnects and reloads itself onto the new build.
**Open at login** (off by default) is the
LaunchAgent's `RunAtLoad`: the daemon starts at login and no browser opens. launchd restarts a
daemon that crashes, never one that was stopped. While an agent the daemon runs is working or
asking permission it holds `caffeinate -i`, which also defers idle sleep.

**Stopping and coming back.** A conversation runs in one of three places, and that decides
what survives what:

| Conversation runs in | `aw daemon stop`, an update, a daemon crash | `aw daemon stop --all` | Logout, reboot |
|---|---|---|---|
| A **session host** (every Claude conversation) | Keeps running; reattaches when the daemon starts | Ended | Ended |
| The **Codex background server** (on by default) | Keeps running | Keeps running | Ended |
| The **daemon process** (Codex, with the background server off) | Ended | Ended | Ended |

No Claude conversation runs in the daemon's process, and there is no setting that makes one: a
restart never ends one (#122).

*Ended* is never lost: each conversation is its transcript. An ended conversation is stopped
gracefully (up to ten seconds to finish its turn), shows an **interrupted** chip on the next
start, and right-click → **Resume here** carries it on with the model, mode and effort it was
started with. The newest one resumes by itself (the *Resume the last conversation on startup*
setting). Nothing about stopping asks first: there is no window to ask in.

**Session hosts: Claude conversations keep running when the daemon stops.** Each Claude
conversation runs in its own small background process (a *session host*), so stopping,
reinstalling or a crash of the core daemon does not end it: the turn in flight carries on, a
permission prompt waits, and the daemon reconnects to it when it starts again. This is the
only way Claude conversations run; the *Keep conversations running when Agent Wrangler quits*
setting that used to switch it is gone, and an old value of it is removed from `settings.json`
at startup. Codex has its own background server (below).

- A host's files live in `~/Library/Application Support/Agent Wrangler/`: `run/` (a manifest,
  a token and a socket per host, readable by you only), `logs/host-*.log`, and `runtimes/`, a
  clone of the app that hosts run from so a reinstall never pulls the program out from under
  them. Hosts run on the Node the app bundles (`Contents/Resources/node`, an official pinned
  release), shown in `ps` as `Agent Wrangler Host`. A token opens its host's socket, so both are readable by your user only.
- **Security limits, plainly.** Hosts keep other users on the Mac out, and make accidental or
  prompt-injected use hard. They do **not** stop a process running as you: it can read a
  token and drive that host's conversation (send to it, answer its questions, change its
  permission mode), just as it could already edit the hook script or `settings.json`. That
  includes an agent with a free shell. See `docs/plans/session-lifecycle-architecture.md` §12.
- **A hosted conversation's permission prompts are answered only through its host**: from the
  pane, the row's Allow/Deny, or Discord. The host sets `AGENTWRANGLER_HOSTED=1` for `claude`,
  and the permission hook then logs the prompt (so the row shows it waiting) without waiting
  for a decision file, so writing one cannot approve anything. Conversations outside a host (ones
  started in a terminal) keep the file path. The app updates the hook script by itself; `settings.json` is not touched.
- **After a reinstall**, a conversation keeps running on the build it started with until its next
  message while idle: then it moves to a fresh host of the new build (same session, same model,
  mode and effort) before the message is sent. A busy one, one waiting on a question or
  permission, or one with background tasks is never moved; it moves on a later idle message.
- **If a host crashes**, the `claude` it ran may keep going on its own for a while. Agent
  Wrangler finds it (by its `~/.claude/sessions/<pid>.json`, checked against the process's start
  time) and ends it, waiting for it to exit, before anything resumes that session, so there is
  never a second process on one conversation. The row shows **interrupted** and Resume brings it
  back; a crashed one is never resumed automatically.
- **Idle conversations are parked** after *End idle sessions with no Agent Wrangler connected
  after* (default 24 hours, 0 = never) while the core daemon is stopped: ended gracefully, resumable as
  usual. Never one that is working, waiting on a question or permission, or running background
  tasks, and time the machine spends asleep does not count.
- While a conversation is working, the Mac is kept from *idle* sleep (a lid close still sleeps).
  On wake, the core daemon rechecks its hosts and reconnects Discord at once.
- A logout or reboot ends hosts too (macOS ends every process of yours). Each host ends its
  conversation gracefully, and it comes back as **interrupted**, resumable as above.

**Codex conversations survive a daemon restart.** Agent Wrangler runs every Codex thread in
one background `codex app-server` of its own, detached from the core daemon, so a stop, a crash
or a reinstall leaves it running: a turn in progress finishes, and an approval or question it is
waiting on is still there, on the same card, when the daemon comes back. The server runs from a
copy of the Codex binary kept under the app's data directory (`runtimes/`), because VS Code
deletes old extension versions; its manifest, socket and log are in `run/`. It is not Codex's
machine-wide `app-server daemon`, which the `codex` command line would attach to.

- **Updating Codex restarts that server**, which ends a running turn and drops its pending
  approvals and questions (you send again). Agent Wrangler does it by itself only when the
  daemon starts, and only when nothing is running. The browser has no control to do it on
  demand yet (the window's *Restart Codex Server…* went with it); `aw daemon stop` then
  `aw daemon start` at a quiet moment does it.
- A thread can have only one writer. One Agent Wrangler's server holds is refused by the VS Code
  extension until about a minute after it goes idle with nobody attached, and the reverse:
  a thread VS Code holds shows in Agent Wrangler as *open in another app*, read-only, until you
  take it over again.
- *Keep Codex conversations running across restarts* (on by default) turns this off; Codex then
  runs as a child of the core daemon and ends with it.

Codex discovery reads bounded tails from `~/.codex/sessions`; it does not modify Codex's state
database. A Codex row carries its originating client when the rollout reports one. External
Codex conversations are live, read-only transcript views. Set the table's provider filter to
**Codex** before pressing **+ New** to start a fully interactive Codex thread through App Server,
including streaming replies, interruption, and approval decisions.

## Behavior

- **One page, two panes, a divider you move.** The agent table and the conversation share one page, because they are never used apart. Drag the divider to give either side more room, double-click it to go back to the default, or focus it and use the arrow keys (Shift for a bigger step). The position is remembered per browser.
  - **The page's bar** links the routes: *Agents* (the table), *Missions*, *Analytics* and *Preferences*, each its own URL (`#/missions`, `#/preferences`; a conversation is `#/c/<key>`), so the browser's Back button and bookmarks work.
  - **On a phone** (or any narrow window) the page shows one pane at a time: the table, then the conversation with a *‹ Back* button. Touch targets are 44px, and the composer stays above the on-screen keyboard.
  - **Neither pane assumes it has the page.** The table folds its Project/Worktree/Branch/Model/PR columns below 720px, measured on the *pane* rather than the window — drag the divider left and the columns fold without the window changing size at all. To watch one agent while browsing others, open its conversation in a second browser tab: every tab has a conversation pane of its own.
- **Plan usage cards sit pinned above the table (they stay put while the list scrolls)** — the same numbers as Claude Code's `/usage`: the 5-hour session, the 7-day week, any model-scoped week (e.g. *Weekly Fable*), and extra-usage credits once any have been spent. Each card has the percent, a bar (blue, yellow from 70%, orange from 90%), and a *Resets in* countdown that ticks locally. They are read every minute (`usagePollIntervalSeconds`), and **every 20 seconds once any limit passes 90%** — or ten points below your auto-pause threshold, whichever is lower — because near the end of a window the question stops being "am I close" and becomes "how many minutes do I have", and a reading five minutes old is how a burst of agents crosses 98% and lands on 100%. The read costs no tokens (it is an account-metadata endpoint, not an inference call) and every window shares one read per interval, so the only budget it spends is the endpoint's own rate limit. The source is `GET /api/oauth/usage` with the login token Claude Code stored at sign-in (macOS Keychain item *Claude Code-credentials*, else `~/.claude/.credentials.json`); the token is only ever read — Claude Code owns refreshing it. If a read fails the last good numbers simply stay up and the next poll tries again (backing off); the failure is logged, not shown on the cards. A read that leaves a window out (some list only the model-scoped week) does not take its card away: the Session and Weekly cards keep their last figure until that window resets, since within a window the percent only climbs, and the card's tooltip says when that figure was read. The daemon makes one read per interval, whatever number of tabs are open, through a cache file in the app's cache directory (a 429 from the endpoint backs the next read off by at least five minutes, or `Retry-After`). Turn the cards off with `showUsage`.
- The agent table is column-aligned, with collapsible sections (*Pinned / Waiting / Possibly stuck / Done / Busy / Paused / Ended / Archived*); collapse state is remembered.
  - ***Waiting* is both ways an agent can be waiting on you**: stopped at a permission prompt it cannot get past, and finished with a turn that ended on a question. They used to be *Blocked on you* and *Waiting*, two headings for one instruction — go and look at that one — which cost a section of table height to draw a line the reader does not act on. Nothing was merged away underneath: a permission prompt is still its own status everywhere it is acted on, and the row says which it is without a heading having to. It **sorts to the top of the section**, because it is the only row in the table where the agent is frozen until you press something; it carries the orange dot rather than the yellow one; and it opens a card with buttons, where a question does not.
- **Columns are yours.** Every divider in the header is drawn, not hidden: drag one to resize the column to its right, and **only** that column changes — the elastic Agent column absorbs the difference and every other column keeps the width it had. A column can grow until Agent reaches its 110px floor, and no further, so a drag can never push the table wider than its pane. The button at the right end of the header (or a right-click anywhere on it) opens a picker for switching columns on and off, with *Reset widths*. Both the widths and the hidden set are saved in the app's state file on the Mac, so they survive a restart and every browser shares them. Anything switched off keeps showing on the row's second line, so hiding a column costs the space it took, not the fact it carried.
- **The Age column is the age of the conversation**, counting from its first prompt and across every resume since — not the time since it last said something. That was the old meaning and it answered a question the table already answers twice: a busy row carries its tool's elapsed time and an ETA, and an idle row's silence is the point of it being idle. "How long has this been going" is the thing nothing else says. The number comes from the transcript file's creation time, which is exact for the purpose — Claude Code writes no transcript until the first prompt, and `--resume` appends to the same file rather than starting a new one (checked here against 229 transcripts: every one agreed with its first line's timestamp to within a second). The cell's tooltip adds the last-activity time, so nothing was lost, and says so plainly on the rare session that has no transcript to read a birth time from.
- **A Model column** shows which model wrote the latest reply — *Opus 5*, *Fable 5.1*, *Haiku 4.5* — read from the transcript's last assistant message. The cell's tooltip has the full wire id. A model released after this build still appears, just unshortened.
- **A Worktree column** names the linked git worktree a session is working in, and is blank in a main checkout — which is the point, since several agents on one repo means several trees and *main* alone stops telling you who is where. Detected without running git: a linked worktree's `.git` is a *file* holding `gitdir: …/.git/worktrees/<name>`, where a main checkout's is a directory. A session sitting in a subdirectory still resolves, and the answer is cached per directory until the daemon restarts.
- **The Project is the repository, not the folder.** A session in a linked worktree (`MyApp-feature`) or a subfolder (`MyApp/packages/web`) shows and groups as `MyApp`, the main checkout's name; the Worktree column says which tree. Outside git it is the folder's own name. A repository at your home folder itself (a dotfiles repo) is ignored, so it does not swallow every folder under home.
- **Subagents are not rows.** Codex's internal and subagent threads are always left out of the table. Claude Code's subagents never were rows: they live inside their parent's conversation.
- **A *shared checkout* chip** marks every live session that has another live session in the same checkout — the same main checkout, or the same linked worktree. Two agents there share one index and one working tree, so a commit by one can pick up the other's half-finished edits. Separate worktrees of one repo are not flagged. The tooltip names the other sessions. Claude sessions count until they end. Codex threads never end, so they count only while Agent Wrangler runs them or they are mid-turn. The launcher's folder button turns amber with a ⚠ when the picked folder's checkout is already occupied. Both are warnings only: nothing is blocked.
- **Waiting vs Done.** Both mean the agent finished its turn and is idle. *Waiting* means its last message asked you something — a question, a choice, "let me know". *Done* means it reported and stopped. The split is read off the reply text (a question mark closing the last paragraph, or a decision phrase), so it is a heuristic that errs towards *Waiting*: unknown or failed turns are always *Waiting*. Done sessions get a green dot, do not count as needing you, and do notify when `notifyOnWaiting` is on.
- **A row stopped at a permission prompt opens a card.** It gets extra rows of its own under it, spanning the table: a header line with Claude's own one-line description of what it wants to do, and — sliding open underneath — the command *as it will run*, wrapped over as many lines as it takes rather than ellipsised, with **Allow**, **Always allow** and **Deny**. The card opens by itself while a decision can still land and collapses to its header once it cannot; clicking the header toggles it either way. Claude Code's own dialog keeps working; whichever is answered first wins. (Hooks required; see below for how the buttons reach Claude Code.)
- **Conversations nobody has typed into yet are hidden.** A new Claude panel or a `/clear` registers a live process with no transcript; it appears the moment the first prompt lands, not as a *Waiting* row with nothing in it.
- **Narrow panes work.** Below ~720px (the divider dragged left, or a phone) the Project, Worktree, Branch, Model and PR columns are not rendered at all and fold into the row's second line, so the session title, status chips, ETA and age stay visible instead of being pushed off-screen. The picker shows those columns as *too narrow* rather than pretending they are on screen; widening the pane brings them back exactly as you left them.
- **An ETA column** on every busy row (hooks required). It counts down against your own turn history: until the median while the turn is still typical, then until the 90th percentile once it has outlived half its peers (yellow past p75, orange past p90, where it shows `>Xm` instead of a countdown). Italic means the baseline is still the seeded one, before 20 of your turns have been recorded. A dash means the turn's start was not observed; the cell's tooltip says why.
- **A banner at the top says when status is only estimated** — hooks not installed, disabled, or stale — with an *Install hooks* button. Once installed, it lists the live sessions that predate the install and still need a restart.
- **Clicking a row opens the conversation here.** Every session — started here, in an editor, in a terminal, anywhere on the Mac — opens in the **conversation pane** beside the table, in the tab you clicked in, and the click never moves you to another window. The pane reads the session's transcript live, so it works for conversations Agent Wrangler has nothing to do with.
  - **What it renders**: prompts and replies as markdown, thinking collapsed, one card per tool call that expands to its input and output, edits as a diff. Code blocks have a copy button; links open in the browser.
  - **Permission prompts can be answered from it.** A session stopped at one grows a card naming the tool and what it wants, with **Allow** and **Deny**. This is the same hook race the table's buttons use, so answering in Claude Code instead simply flips the card to *answered there*. (`AskUserQuestion` and plan approval cannot go through the hook at all, by Claude Code's design — they are answerable only for conversations Agent Wrangler is running, where the daemon holds the callback itself.)
  - **Send takes over here.** For an idle external session, sending ends its previous process and resumes it here. For hook-backed busy sessions, the message waits until idle. Estimated status requires confirmation. Cancel leaves the draft intact; Release hands the session back to a terminal.
  - **Ended sessions** open in the pane too, with *Resume here* or sending a message as the way to continue them.
- **Conversations you start here are fully interactive.** A bar across the top of the table holds a **project dropdown** and a **+ New** button: pick a folder, press the button, and a Claude Code session starts there, run by Agent Wrangler, in the pane. It is an ordinary session in every respect that matters — it registers in `~/.claude/sessions`, runs your hooks, writes the normal transcript, and can be resumed anywhere afterwards — but this pane is its only interface, so it has no terminal to steal your attention. Unlike the Claude Code panel in an editor, which is bound to its window's workspace, Agent Wrangler can run sessions in **any** project on the Mac. The dropdown's first row, and its default, is **Global**: a conversation that belongs to no project, for the questions that are not about code you have checked out. It runs in `~/.agent-wrangler/Global`, a scratch folder of its own rather than your home directory, so an agent asked something general has a harmless place to stand and its transcript is not filed under a project it never touched.
  - **The dropdown lists every folder you have used Claude Code in**, newest first. That list is Claude Code's own — the `projects` map in `~/.claude.json`, which it appends to itself the first time you work somewhere — plus anything currently running, so a new project appears without being told about it. Folders that have been deleted are left out, since nothing can start in them. **Browse…** at the bottom opens a folder browser of the **Mac's** folders (your known projects first, then anything under your home folder), whichever device you are on. The dropdown shows the folder's name and its full path as a tooltip, because two checkouts of one repo share a basename.
  - **Each row has an X that removes it**, for the folders you tried once and will not open again. The entry stays in `~/.claude.json` — that file is Claude Code's, not ours, and rewriting someone else's config to tidy a dropdown is not a trade worth making — so the removal is recorded on our side and applied to every later scan. Removals are shared by every dashboard, and survive reloads. The menu stays open while you remove, so clearing three stale folders is three clicks.
  - **A star beside the X makes a folder a favourite.** Favourites sit at the top of the list, under Global, sorted by name rather than by recency, so the few folders you use all the time are always in the same place; everything else keeps its newest-first order below them. Like removals, favourites are kept on our side (not in `~/.claude.json`), shared by every dashboard and survive relaunches. Starring leaves the menu open and the selection unchanged. A starred folder that has been deleted is left out like any other, and removing a favourite with the X also un-stars it, so browsing back to it brings it back as an ordinary row.
  - **Anywhere you navigate to is added back.** Browsing to a folder, or starting a conversation in one, puts it in the list and undoes a previous removal — so an X is never a decision you have to be sure about. Nothing else un-removes a folder: a session that shows up in one from a terminal elsewhere leaves your list alone.
  - The choice is remembered per browser, not on the Mac: your laptop and your phone can each keep their own.
  - **Type, interrupt, queue.** Enter sends, Shift+Enter is a newline, and a message sent mid-turn queues behind it with a *queued* chip. While Claude is working the **Send** button becomes **Stop**, which interrupts the turn in flight, and goes back to Send when the turn ends — one button, so the thing to press is always the button under the box. Enter still sends while it says Stop, so a message typed mid-turn queues rather than being eaten by the interrupt. Replies stream in a word at a time.
  - **The composer is one box.** The attachment chips, the text and a toolbar strip along the bottom — paperclip and microphone on the left, **Send** on the right — all live inside a single framed surface that takes the focus ring as a whole. It used to be a flex *row*: a textarea with two 28px icon buttons and a text button balanced on its bottom edge, which ate half the width at the 300px the pane is often used at and left Send stranded far from the text at full width. The frame moved off the textarea and onto the box around it, which is what makes the four parts read as one control.
  - **The model dropdown** beside the permission-mode one lists exactly the models your account can use — the list is the CLI's own answer, not a hardcoded one — and switches the model for the next turn.
  - **Permission, question and plan cards are answered here.** A permission ask offers **Allow**, **Deny**, and **Always allow** when the prompt itself suggested a rule (the button's tooltip names the rule it writes). `AskUserQuestion` renders as a form with the options and an *Other* box; a plan renders with **Approve** and **Request changes**, and the feedback goes back to the model. These three are exactly what the hook path cannot do for a session running elsewhere.
  - **An ask is never something you have to go looking for.** When one arrives — and when the pane opens on a session that is already waiting — the view lands on the **top** of its card, at the question itself, rather than at the end of the conversation, which on a card taller than the pane (a long plan, a multi-part question) means landing past it on its buttons. If the card is off screen for any other reason, a strip above the composer says what Claude is waiting on (*↑ Plan ready for approval*) and clicking it brings that card's head back to the top of the view, with a one-second outline so the eye finds it. The strip disappears as soon as the card is visible: it is a pointer, not a second copy of the question. Answering starts the conversation following along again.
  - **Long blocks keep the rest one click away.** Text is capped at 6,000 characters on the way to the pane so that opening a conversation does not ship a megabyte nobody will read; anything cut gets a **Show the rest (N more characters)** button rather than a silent ellipsis, and the host hands over what it held back. It matters most on a plan — approving half a plan is approving something you have not read. A reply still streaming keeps its expansion as it grows, and if the held text has since been dropped (a 2 MB-per-conversation budget, oldest first) the button says so instead of quietly showing the short version.
  - **Dictate instead of typing.** The microphone beside the composer records with the microphone of the device you are on — the phone's, on a phone; click it again and what you said lands at the cursor — in the box, ready to edit, **never sent**. Escape throws the recording away. Transcription is **local to the Mac**: the recording is uploaded to the daemon, `whisper.cpp` transcribes it there, and no audio leaves your own devices. Roughly half a second for a sentence once warm; the very first run takes ~15s while Metal compiles its shaders, once ever. Details, limits and what a browser needs are in [Notifications and dictation in a browser](#notifications-and-dictation-in-a-browser-141).
    - The text goes in the box at the caret, after whatever was already typed. A selection is not replaced, so a stray select-all cannot cost you a draft. Switching conversations mid-recording stops it; the text is filed in the draft of the conversation it was dictated in. A refused microphone, a failed transcription, or a recording in which nothing was heard is reported beside the composer.
    - It needs `brew install ffmpeg whisper-cpp` on the Mac and a model. Agent Wrangler checks for all three when you click, names whichever is missing, and offers to install it or download the default model (`ggml-base.en`, 141 MB, into `~/.cache/agent-wrangler/whisper/`). Point `dictation.modelPath` at a bigger model for better accuracy, or another language. The tools are found on `PATH` **and** in the Homebrew prefixes, because the daemon is started by `launchd` and inherits a bare `PATH`; `dictation.ffmpegPath` / `dictation.whisperPath` override the search.
    - There is no live preview of the words while you speak: the window had one because it recorded with the Mac's own microphone, and that went with it (#142). The `dictation.livePreview` and `dictation.inputDevice` settings belonged to that recording; they were removed (#147) and are cleaned from `settings.json` at startup.
  - **Paste a screenshot straight in.** Paste an image into the composer and it becomes a thumbnail with an X to take it back; it goes with your message as an image block. An image on its own is a fine message. Images too large for the API (5 MB) or in a format it will not take are refused at the paste, not hours later as a failed turn.
  - **Attach files with the paperclip, or drop them on the pane.** An image is attached as an image. Anything else is **uploaded to the Mac** (up to 50 MB a file) into a staging folder for that conversation under the app's support folder, and written into the box as an `@` mention of the uploaded copy's path on the Mac. Uploads older than a week are deleted. A drop from the Mac's own Finder carries the file's path (`text/uri-list`), and a path inside a folder Agent Wrangler serves (a session's folder, a worktree) is mentioned where it is, relative to the session's folder, which is what dragging a file into the TUI does. A path a browser sends is never trusted as a Mac path on its own say-so: anything else is refused with a note to attach it with the paperclip instead.
  - **Type `@` to mention a file.** The list is every file in the session's folder that `git ls-files` knows about — tracked *and* new-but-not-ignored, so this morning's file is there and `node_modules` is not — ranked by a fuzzy match on the filename. Arrows move, Enter or Tab completes, Escape dismisses. Outside a git repository it falls back to walking the folder.
  - **Edits show as a diff in their tool card**, the whole patch. There is no separate side-by-side diff view in the browser yet; the card's button says so.
  - **Files a conversation names** (a path in a tool card, a mission's changed file) open in an in-browser viewer served by the daemon, with *Download* and *Copy path*. Only files under the session folders, worktrees and transcript folders can be fetched. A browser on the Mac itself also gets *Open on this Mac* and *Show in Finder on this Mac*; a paired device never acts on the Mac's desktop.
  - **The permission mode is a dropdown**: ask every time, auto-accept edits, or plan mode. It changes the live session, the same as `shift+tab` in the terminal. Defaults come from `runner.defaultPermissionMode` and `runner.model`.
  - **The model is a dropdown beside it**, and switching applies to the next reply, the same as `/model` in the terminal. The list is the CLI's own answer to "which models may this account use", asked once per session rather than hardcoded, so it never offers a model you cannot reach and never goes stale as models are added. It appears once the session has started; if an older CLI cannot answer, the dropdown stays hidden rather than guessing. The session reports back the *resolved* id (`claude-sonnet-4-5-…`) while the list offers aliases (`sonnet`), so the dropdown matches the two up — and shows the raw id rather than the wrong name if it ever cannot.
  - **Take over here** pulls an existing session into Agent Wrangler, wherever it was running — an editor's Claude Code panel, a terminal, an iTerm tab. It ends that process and resumes the same session id here, which works because a Claude Code conversation *is* its transcript: resume appends to the same file under the same id, so nothing is lost. Offered only while the session is idle (*Waiting* or *Done*) — a turn in flight would be thrown away — and re-checked after you confirm, in case it started working while the dialog was up. If the old process refuses to die, the takeover is abandoned rather than risking two processes writing one transcript. An **ended** session skips all that and simply says *Resume here*.
    - **The button and the composer no longer say the same thing.** The note beside *Resume here* used to read "Send resumes this session here and ends its previous process" — two ways to do one thing, printed side by side, which makes the button look redundant. It is not: until the session is adopted the permission-mode, model and effort dropdowns are disabled, so choosing a model before writing anything needs the button. The note now says what the *button* is for (*Ended. Resume it here, or just type — sending resumes it too.*) and the hint about Send moved to where Send is typed, the placeholder.
  - **Release** is the opposite: Agent Wrangler stops running the session so that a terminal can resume the same id. The browser shows the `claude --resume <id>` command and the folder to run it in, and copies it; you run it in a terminal on the Mac. Same reasoning, same guarantee, and a turn in flight is cut off, which the confirm says.
  - **A restart brings your conversation back.** A daemon restart does not end a conversation (it is in a session host), but a logout, a reboot or a crashed host does. On the next start the daemon resumes the most recently interrupted one by itself. Bounded on purpose: the most recent session only, only within the last few hours, never one that crashed, and never one that something else has picked up in the meantime. Turn it off with `runner.autoResumeLastOnStartup`.
  - **And it brings back what was *said*, not just the session.** A resumed session streams nothing of its past — the SDK picks the conversation up and carries on — so a pane showing one used to come back empty while the model still held every word of it, and the only way to see where you had got to was to ask the agent to repeat itself. The pane now reads the session's transcript for the half that happened before the resume and puts it above the live half, so a restart, a *Take over* and a *Resume here* all land you at the bottom of the conversation you were already having. The two halves can never overlap or double up: the transcript is read once, before the resumed process is started, so it holds strictly the past. The same 512 KB / 300-block window the read-only pane uses applies, with the same notch at the top when there is more above it.
  - Rows Agent Wrangler runs carry no badge of their own. They used to be marked **here**, which marked the rule instead of the exception — it appeared on nearly every row — so it went. A row's tooltip still says where clicking it will open the session.
  - It runs the `claude` bundled inside your installed Claude Code VSCode extension when there is one, which is usually a far newer build than whatever `claude` is on `PATH`. `claudeBinaryPath` overrides that.
- **Pause the agents when the tokens run low.** The bar above the table has a controls group pushed to its right, opposite the launcher, and the first thing in it is one button that freezes **every** running agent on the Mac — not just the ones Agent Wrangler runs. Pressing it sends `SIGSTOP` to each session's process: a stopped `claude` makes no further API requests, so it spends nothing, and `SIGCONT` puts it back exactly where it was. Anything paused turns the button into **▶ N**, so a half-frozen fleet is one click from running again. Pausing asks first: the button sits beside the Discord toggle, and a stray click used to freeze everything. The confirmation names how many agents it will stop, and Cancel is the default, so Return, Escape and Cancel all leave them running. Resuming never asks, and auto-pause (below) never waits on a dialog.
  - **Per session, from the row's right-click menu** — *Pause agent* / *Resume agent*. Neither asks for confirmation, unlike *Close session*: pausing is undone by the same menu item, and a dialog in front of the button you reach for while watching the last of your tokens disappear is friction in the wrong place.
  - **Paused rows move to their own *Paused* section**, above *Ended*, with a purple dot and a `paused` chip — a frozen agent is a live process you are coming back to, not one of the two sections that hold what you are finished with. The section exists because a frozen session's status stops being about the session: status is read from transcript activity, and a stopped process makes none, so a paused row left in Busy would read as work in progress and then relabel itself *Possibly stuck* — which is why the row's tooltip says it is paused rather than naming a status that is no longer moving. They stop counting as needing you for the same reason: a frozen session stopped at a permission prompt is asking something that nothing can answer until it is resumed.
  - **What it costs.** Nothing at all for an idle agent. A turn *in flight* is the exception: its HTTPS request is held open by a process that has stopped reading it, so a long pause can have the far end drop the connection and that turn fails on resume. Everything already written to the transcript is kept, so the cost is one turn, never the conversation. This is also why pausing is not `SIGKILL`: a stopped process finishes its partial writes when it resumes, so the transcript is never truncated.
  - **It works for sessions Agent Wrangler has nothing to do with** — an editor's panel, an iTerm tab, anywhere on the Mac — because a signal is the one channel into a running Claude Code TUI that exists.
  - **Nothing is written down: which agents are paused is read from the OS.** `ps` reports a stopped process as state `T`, so the answer comes from one authority. That is what makes a pause survive a daemon restart, need no cleanup when a paused agent is killed from its own terminal, and correct itself if a signal is ever refused — and it means an agent you stopped by hand with `kill -STOP` shows up as paused too, with a button to start it again.
  - **Closing or taking over a paused session continues it first**, since a stopped process cannot act on the SIGTERM that *Close session* sends — it would sit out the whole grace period and then be SIGKILLed, which is the one way to strand a half-written transcript line.
  - **Auto-pause** (`autoPause.enabled`, off by default) does it for you at `autoPause.percent` — **98%** by default, across *any* limit window, not just the one currently constraining requests: a weekly limit at 99% ends the day as firmly as the five-hour one. 98 rather than 100 leaves room for the reading to be a poll old and for a turn that started at 99% to finish. It fires **once per approach**: after firing it re-arms only when usage falls back under the threshold, so an agent you deliberately resumed at 98% is not frozen again at the next poll. A failed usage read never triggers it — no reading is not evidence of exhaustion, and freezing every agent on the machine is too blunt a thing to do on a guess — and it stays armed until it has actually stopped something, so a daemon started while over the threshold does not spend its one shot before the first session scan has found anything to pause. Turning it on also keeps the usage reads going when `showUsage` is off: hiding the cards is a preference about a narrow pane, and it must not quietly switch off a spending guard. It runs in the daemon, so it works with no browser open.
- **Organize conversations into your own sections.** The table has a status view for *Waiting*, *Busy*, *Paused*, *Done* and the other live states, plus a sections view for your own organization. Every conversation starts in the always-present **Uncategorized** section — named for what it is, since a conversation sitting in a section somebody chose and one nobody has filed yet are the difference the view exists to show. Right-click a row and choose *Add to…* to move it to an existing section, or create a new named section and add it in one step.
- **Give a conversation your own name.** *Give it a name…* on the row menu opens a box showing the current title as a placeholder, so you type a name rather than edit one; once a name is set the item reads *Rename…*, the box is prefilled with it, and emptying the box puts the original title back. It is deliberately not prefilled the first time — filling it with the derived title would let you freeze today's guess at a name as a literal one, which would then stick when the real title improved. The name shows everywhere the session does — the table row, the conversation pane's header, the notifications — because it is applied in the session store, which is the one thing all of those read from. The row's tooltip still carries the title it came with.
  - **It is a nickname, not a rename, and that is deliberate.** A Claude Code session's title is not a field anyone owns: it is derived from the `ai-title` line the model writes into the transcript, then the registry's generated handle, then the slug of the first prompt, then the first prompt itself. Changing it for real would mean writing into `~/.claude/sessions/<pid>.json` or appending to the transcript — both Claude Code's files, and the second one *is* the conversation. This repo already declined to rewrite `~/.claude.json` to tidy a dropdown; corrupting a conversation to relabel it is a far worse trade. Keeping the name on our side also means it works on ended sessions and on sessions Agent Wrangler has never run, and that clearing it is a real undo rather than a second rename back to a remembered string.
- **Right-click a row for its actions** (on a phone, touch and hold). *Add to…*, *Give it a name…*, *Resume here* for an interrupted one, *Pause agent*, *Copy session id*, *Archive* — and, separated and in red at the bottom, *Close session…*. *Open in its own tab* is still listed, but a browser opens the conversation in the pane and says a conversation of its own is not available yet: open a second browser tab instead. Archived sessions move to the always-last Archived section in the status view (collapsed by default), stop counting as needing you, and never notify; the same item unarchives.
  - **Close session** ends the process running a session and stops there — it hands it to nobody, unlike *Take over* and *Release*. That is safe for the same reason those are: a Claude Code conversation *is* its transcript, so closing one parks it rather than destroying it. The row moves to *Ended* and the conversation resumes from where it stopped. Unlike *Take over* it is offered **while a turn is in flight**, because the session most worth closing is the one that has wedged; the confirm says so plainly when that is the case. A session Agent Wrangler runs is stopped gracefully; anything else gets SIGTERM, then SIGKILL if it has not gone in five seconds, and an error rather than a silent failure if it refuses both. Ended sessions and live ones with no known pid do not get the item at all — there would be nothing to signal.
  - **Every provider, not just Claude.** It used to be Claude-only, which left *Archive* — a hide, not a stop — as the only thing you could do to a Codex row you were finished with. The two real conditions are the ones above and they answer for any provider: a Codex thread Agent Wrangler runs has no pid of its own (one app-server serves every thread) and is closed by releasing it, and a Codex conversation running somewhere else has neither a pid nor a handle and correctly does not offer the item.
- **The × on a hovered row means "I'm done with this agent".** It appears in the last column when the pointer is over the row, and it does what *Close session…* does: the process running it ends, the transcript is kept, and the row drops to *Ended*, which ages out of the table on its own. It asks first **only** when a turn is in flight — the case the confirm exists for — so retiring an idle agent costs one click. On a row with nothing left to stop (already ended, or a live session with no known pid) the same button archives instead, since that is what "off my table" can mean there; on an archived row it unarchives.
  - **On the Project tab it also takes the row away.** That tab groups by *where* a session ran, which stays true after it is closed, so there is no Ended section for the row to fall into and it would sit in its project for ever. There the × archives as well as closing — and the Project tab renders no archived rows, so the row goes. Only after the close actually happened: decline the confirm on a working agent and nothing is hidden. The session is still in the Status tab under *Archived*, and a project whose rows have all gone takes its heading with it.
- **There is no app menu.** What it held lives where it is used: new conversation and pause all in the bar above the table, per-session actions in the row menu, installing hooks in the table's banner, connecting or disconnecting Discord in Preferences. The few with no browser control yet are listed under [What the browser does not do](#how-it-fits-together).

## Usage records (telemetry)

Every conversation Agent Wrangler runs, Claude or Codex, gets one line per finished turn in
`orchestration/telemetry/YYYY-MM.jsonl` under the app's support folder. Each line records:

- the models used, and tokens per model (input, output, cache read and write, thinking);
- the estimated cost and what it is based on;
- the effort requested and the effort applied;
- the permission mode;
- durations;
- tool calls, counted by name;
- how many permission asks there were, and how long the turn waited on you.

**Metadata only.** Nothing you or the agent wrote is recorded: no prompts, no replies, no tool
inputs, no file contents. Nothing leaves the machine. The *Record per-turn usage* setting
(`telemetry.enabled`, on by default) switches it off. Delete the folder to remove what was
recorded.

**Where it shows.** The table's *Usage* column shows each session's tokens and estimated
cost, with the cost's basis:

- `est`: the agent's own estimate;
- `priced`: from `telemetry.prices`;
- `cost not reported`: no cost is known;
- a trailing `+`: some turns had no cost, so the total is a lower bound.

In a narrow table the figures move to the row's second line. The conversation header shows
the models used, the effort (requested → applied, "unknown" where the agent did not say),
tokens and cost. Hover either one for the full breakdown. A session with no records shows
nothing, not zeroes.

- **How the numbers are worked out.** Claude reports usage as running totals for the process
  that runs the conversation, so a turn's figure is the difference from the previous turn.
  - **Totals restart.** A resume or a move to a new session host starts a new set of totals.
    `/clear` resets them.
  - **Zeroes are no data.** A crashed session's last report can be all zeroes. That turn
    records no usage, and nothing is subtracted.
  - **A turn is recorded once.** A reattach replays the last turn; that turn is not recorded
    twice.
  - **Turns while the core daemon was stopped** are covered by the next recorded turn, which is
    marked `coversGap`.
- **Where each agent falls short** (a missing figure is left out, never written as 0):

  | | Claude Code | Codex |
  |---|---|---|
  | Tokens | per model, including subagents and compaction | per thread (`thread/tokenUsage/updated`); input includes the cached part |
  | Thinking tokens | where the CLI records them | reasoning tokens |
  | Cost | Claude Code's own estimate (`costBasis: harness-estimate`). On a subscription this is what the tokens would have cost through the API, not a bill | none reported. Optional per-model prices in the `telemetry.prices` setting give `costBasis: price-table`; otherwise the cost is left out |
  | Applied effort | from the status hooks (`effort.level`), once hooks are installed | not reported |
  | Time to first token | reported | not reported |

  Codex's per-thread usage estimate (`account/usage/read`) is not used yet: it is unverified.

## Tasks (experimental)

With *Run tasks in worktrees of their own* on (`orchestration.enabled`, off by default, read at
start), the launcher has a **Tasks** button beside **+ New**. *Run a new task…* asks for an
objective and acceptance criteria, then runs one agent on the launcher's model and effort in a
new worktree and branch of the chosen folder's repository:

- **Where.** `../<repo>.aw/<task-slug>/t1` on branch `aw/<task-slug>/t1`, set up from the
  repository policy (below). The checkout you work in is never touched. A fresh retry gets
  `t1-a2`, and the earlier tree is kept for comparison.
- **How it may work.** A Claude task runs in `auto` mode, or your default mode if that is
  stricter, never `bypassPermissions`. It may run the policy's verification commands and `git`
  inside its worktree without asking. It is always denied `git push`, `git worktree`,
  `git checkout`/`switch`/`rebase`, `npm run app:install`, and edits to the primary checkout.
  A Codex task runs sandboxed to its worktree (`workspace-write`, `on-request`) and does not
  commit.
- **How it ends.** When the agent's turn is over, it is idle, nothing is pending and nothing
  runs in the background. Agent Wrangler then commits anything left uncommitted on the task's
  branch, **verifies the result** (below) and shows a notification. Click it (or *Tasks → the
  task → Open the diff*) to read the diff. A result waits for you: *Accept the result*,
  *Retry fresh* or *Cancel*. Accepting keeps the branch for you to merge. An attempt that
  fails is handled by rule first (below), and waits for you once the rules have nothing left.
- **When an attempt fails.** It is classified from what the harness, the session and the
  checks reported — no model is asked — and a fixed ladder decides the next step:
  - checks failed in a new way → the failure (summary, failing tests, log path) goes back to
    the same session as its next message;
  - the same failure again → raise effort, then the tier, then another harness at the same
    tier, skipping any step a pin, a cap or a limit forbids; three identical failures in a row
    go to you;
  - an API error or a crashed agent → the same route again after a short wait (twice at most,
    not counted as a try at the work);
  - a rate limit → wait for capacity, then the same route. **Never a bigger model;**
  - changed nothing → one more try, told explicitly; ran past 45 minutes of active time →
    stopped, one fresh try; context overflowed → a same-tier model with a larger window, else
    "split the task";
  - asked a question, refused tools repeatedly, or hit a cap → you.

  Hard limits make a runaway loop impossible: 3 tries at the work, 2 infra retries, 3 rate-limit
  waits, 1 effort and 1 tier step, 8 attempts of any kind, and every cap you set (attempts,
  spend, tier, effort). `frontier` is reached only if the mission allows it. A route you picked
  by hand is the task's pins, so escalation keeps to it — it retries and carries on in the same
  session, then hands over — and never changes tier or harness on its own; a planned mission's
  default route is not pinned, so its effort can be raised once. Escalation never changes the
  permission mode or tools. Every step, including a skipped one ("Would raise tier to expert;
  the mission is capped at standard"), is recorded: the strip's **Escalation** button lists the
  ladder as it was walked, and a chip counts the steps (yellow once one changed the route). To
  turn automatic retries off, cap attempts at 1.
- **Verification.** A task is finished because checks passed on its result, not because the
  agent stopped talking. Agent Wrangler runs, in the task's own worktree:
  - `diff-sanity` — the attempt changed something, and the diff has no conflict markers and
    nothing that looks like a credential in it. Deleted or newly skipped tests, and changes
    outside the task's expected area, are warnings rather than failures.
  - **your repository's own commands**, from its policy (below) — and only those. Agent
    Wrangler has no built-in idea of how to test your code, and a model can never supply a
    command.

  The commands run as child processes with the same stripped environment a hosted agent gets,
  each with the timeout its policy gives it, and their output goes to
  `orchestration/logs/<attempt>/` for *Open log*. Four things it is careful about:
  - a check that **fails and then passes on a re-run** of the unchanged tree is marked *flaky*,
    not a failure;
  - a check that **also fails at the commit the task started from** is reported as "the base is
    red" and is not blamed on the agent. That answer is worked out in a throwaway checkout of
    the base commit, set up the same way, and remembered for the rest of the session;
  - a check that **times out or cannot start** is an error — our problem, not the agent's — and
    never counts against it;
  - a repository with **no commands** gives a result marked *unverified*. That is deliberately
    not a pass: `diff-sanity` alone only proves that files changed, so the result is one only
    you can accept.

  The verdict shows as a badge on the session's row and in the task strip, with a line per
  stage and a button to open the failing log.
- **Review.** Some acceptance criteria are not something a command can check ("the error names
  the file"). For those, once the commands have passed, a **read-only reviewer** (Sonnet) is
  given the objective, the criteria and the diff, may read files in the task's worktree and
  nothing else — plan mode, `Read`/`Grep`/`Glob` only, reads outside the worktree refused — and
  answers *met*, *unmet* or *unclear* for each criterion, plus any concerns. The strip lists
  every criterion with its verdict and the reviewer's reason, and the review's cost.
  - It is **advisory** by default: an *unmet* criterion is a warning on the result, not a
    failure. A repository's policy can make it **required** for chosen kinds of task
    (`review.requiredFor`); then *unmet* fails the task and *unclear* makes it inconclusive —
    never a pass.
  - By default it runs only when the task was assessed at **moderate risk or above, or weakly
    verifiable or below** — the tasks its commands say least about (`review.when`: `auto`,
    `always` or `never`). A task that has not been assessed is reviewed.
  - Its verdict is evidence, not verification: a repository with no commands still gives
    *unverified*, however many criteria the reviewer called met. It posts nothing anywhere.
  - A review is a model session with the repository in view, and costs like one. Each is
    recorded on the attempt's usage line as counts, model, tokens and cost (never the
    reviewer's words), so whether it catches what tests miss can be judged later.
- **Where you see it.** A task's session is an ordinary row, with two extra chips: which task it
  is for, and what it ran on (`Opus 5 · high`). An expensive route — the `expert` tier, or `max`
  effort — is filled rather than outlined, so it is visible without opening anything. Click the
  row and the conversation opens under a **task strip**: the objective, the route, attempt
  *n/N*, the branch and its diff stat, and buttons for whatever the task can do now (*Open
  diff*, *Accept*, *Resume*, *Retry*, *Cancel*). After a retry the strip lists every attempt;
  clicking one opens that attempt's own conversation in the same pane. Nothing here opens a
  window, and the chips fold onto the row's second line in a narrow pane.
- **What the work is like.** Beside the running attempt, Agent Wrangler describes the task:
  its kind, how complex, how broad, how risky, how ambiguous, how well a machine could check it,
  and how much there is to read. Each value says how sure it is and where it came from — a path
  rule from the repository policy, the cheap model that reads the objective (never the code), or
  you. Risk a policy path rule raised is never talked down by the model, and nothing can be
  called verifiable that the repository has no command for. The strip shows a summary chip and an
  *Assessment* button that opens the lot. It does not hold a manual task up, and if the model
  answers nothing usable the description is the rules' alone, marked low confidence.
- **Which route it should run on.** From that description a router works out what the work
  *needs* — a capability tier (`basic`/`standard`/`expert`), an effort level, hard needs such as
  context size, and gates (`plan-first` for an open-ended task, `human-review` for a critical
  one) — and a resolver picks a model from Preferences → Orchestration that meets it, is
  enabled and assigned a tier, and whose usage window has room. Tier and effort come from
  different things: risk and breadth raise the tier, weak checks and ambiguity raise the
  effort. How it routes is set by `orchestration.routing` in `settings.json`:
  - `{"mode": "manual"}` (the default): the task runs on the launcher's model and effort, as
    before, and the router's choice is recorded beside it for comparison.
  - `{"mode": "assisted"}`: *Run a new task…* assesses first and shows the proposed route.
    One click runs it; *Change effort…* or *Change model…* runs yours instead, and the change
    is recorded. Dismissing it leaves the proposal in the Tasks menu.
  - `{"mode": "auto"}`: *Run a new task…* assesses, routes and starts the task with no click,
    within your caps; the route chip is marked **A** and *Why this route?* gives the same
    reasons as any other decision. Work the router cannot route within the caps waits as a
    proposal instead. `auto` is gated on the record (Preferences → Orchestration → Automatic
    routing shows each check with its numbers): the routing corpus green with no egregious
    misroute, at least 30 tasks routed in manual (shadow) or assisted mode, at least 70% of
    at least 10 assisted proposals run without a tier change, and no kind of task where the
    router wanted a cheaper route than ran and the route that ran still needed escalation.
    Choosing *Automatic* before that shows the numbers and asks you to *Enable anyway*; the
    override and the numbers you saw are saved in `orchestration.routing.autoOverride`, and
    leaving `auto` drops it. `auto` in `settings.json` with the gate unmet and no override runs
    as `assisted`, and says why. Below the gate, *Shadow comparison* lists what the router
    predicted, what ran and how it went — "router wanted cheaper, the route that ran was
    dearer" and the reverse, with outcomes — by task kind and by the dimension changed.
  - `"maxTier"` and `"maxEffort"` cap every new task. A cap is never exceeded: work that needs
    more than the cap waits for you, saying both why it needs more and what the cap is.
- **Pins and caps, at four scopes.** You can *pin* a harness, model or effort, *cap* the tier,
  effort, attempts, concurrent agents, estimated spend, usage-window share or location
  (local-only / hosted-only), *prefer* a harness or local models, and *exclude* harnesses,
  sources or local models — globally (Preferences → Orchestration → Routing defaults, stored in
  `orchestration.routing`), per repository (the `routing` section of its policy file), per
  mission and per task (the task strip's **Policy…** button, or the Tasks menu). The more
  specific scope wins, but a cap can only be tightened: a task cannot loosen its mission's cap.
  A pin that breaks a cap is refused the moment you set it, naming both ("This task pins
  Opus (expert); the mission is capped at standard"). A pinned model or effort is never changed
  by escalation. A mission freezes the global and repository settings when it starts; a change
  to its own policy or its task's applies from the next attempt — a running one is not
  restarted — and is shown in the strip ("Policy changed (task): pinned effort low → high ·
  applies from attempt 2"). *Pins & caps* in the strip lists each value in force and where it
  came from.

  **Why this route** in the task strip (and the route chip's tooltip) shows the rules that
  fired and on what, the requirement, the fallbacks, and every model that was not picked and
  why — read back from what was recorded when the attempt started, not worked out again.
- **Missions: a plan of tasks, reviewed before anything runs.** *+ New mission* in the table's
  Missions view (or *New mission…* in the Tasks menu) asks for the objective, then whether to
  write the tasks yourself or have them planned. The **planner** reads the repository — only
  reads: plan mode, `Read`/`Grep`/`Glob`, nothing outside the checkout — and proposes a plan,
  **one task unless a split pays for itself** (parts that can be checked on their own, or that
  touch disjoint files). Its answer is data: titles, criteria, scope globs, dependencies and the
  names of verification commands your repository policy already has; it cannot choose a model,
  a tool, a permission or a command. A plan with a cycle, too many tasks, a task with no
  criteria, an unknown check or a path outside the repository gets one repair round, then the
  mission says *planning failed* and why (*Plan again…* or *Write it myself*). A plan that is
  valid but splits where it should not — two tasks on the same files, a chain over one
  subsystem, a trivial or docs-only task — is kept with a warning for you to merge in review.
  Either way you review, edit and approve it; tasks then run one at a time on one mission
  branch. **Replan…** on a started mission asks the planner for the rest: done tasks stay
  exactly as they are, unfinished work is set aside on a branch of its own, and the new plan
  goes through review again.
- **Parallel missions (#46), off by default.** With *Run a mission's independent tasks at the same
  time* on in Preferences (`"orchestration.parallelTasks": true` in `settings.json`), a plan approved from then on runs its independent tasks **at the same time**,
  within the scheduler's limits (two per repository by default), each in a worktree of its own
  (`<repo>.aw/<mission>/t1`, `…/t2`) cut from the mission branch's head, so a task that depends
  on another starts with that work already in its tree. A mission approved without the setting
  keeps running one task at a time in the one mission worktree. When a task's own checks pass,
  Agent Wrangler merges its branch into the mission branch (`aw/<mission>/mission`) in the
  mission's integration worktree, **one merge at a time** (`--no-ff`), and runs the mission
  check there after every merge (the policy's `verification.missionDefault`, or every command it
  names). This is what catches two changes that pass alone and break together:
  - **A conflict** is aborted. By default (`"integration": { "onConflict": "resolve" }` in the
    repository policy) the mission branch is merged into the task's branch in the task's own
    worktree and a *conflict-resolution attempt* resolves it there, then is checked and merged
    like any attempt; at most `conflictAttempts` (default 1) per task. `"needs-human"` hands the
    task to you with the conflicting files instead: resolve it on the task's branch and
    *Accept*, or *Retry*.
  - **A failed mission check** reverts that merge with a revert commit (the mission branch's
    history is never rewritten) and sends the task back with the failure as evidence, to the
    usual escalation ladder. Its branch takes the mission branch and its own work back on top,
    so the next attempt sees the combination that failed, and the next merge carries all of it.
  - **A quit or crash mid-merge** is safe: the pre-merge head is saved in the mission before
    `git merge` runs, and on relaunch the merge is aborted and made again (or, if it was
    committed, verified).
  - **Finishing.** *Merge locally* on a planned mission is **gated**: the merge into the base
    is made first in the integration worktree, the policy's `finish.gate` (or the mission check)
    runs on that merged result, and only if it passes is the base fast-forwarded to exactly that
    commit in your checkout; a failure leaves the base where it was. Nothing is installed; the
    note says a rebuild or reinstall is needed. *Open pull request* pushes the mission branch and
    runs your `gh`; *Keep* and *Discard* leave the base and the remote alone. Nothing reaches the
    base or the remote without your click. From the click until its outcome is recorded the
    button reads *Merging…* (or *Opening PR…*) and the other finishes are off; a repeated click
    joins the one under way, so a mission is merged at most once. The finish is recorded before
    git runs, so a crash or fault mid-finish is settled on relaunch by reading git (or `gh`)
    back — merged, or not — never by running it again; if git cannot answer, the buttons stay off
    and *Check again* asks it again (`docs/plans/pending-actions.md`). Each merge, conflict, revert and mission check writes
    an `integration` usage record (counts and stage names, never file names).
- **Restarts.** A task's conversation is an ordinary row in the table. It survives a daemon
  restart or a reinstall, since every Claude conversation runs in a session host. When the
  daemon starts again the task is picked up where it is. If its session was
  lost (its host was killed, say), the task offers *Resume the attempt*, which continues the
  same session id, and *Retry fresh*. It never resumes by itself, unless the mission sets
  `autoRecover` (one resume, never after a host crash). A retry that was waiting (a backoff, a
  rate limit) when the daemon stopped runs when it is due after it starts again.
- **Records.** Missions are `orchestration/missions/<id>.json` under the app's support folder.
  Each attempt adds one `attempt` line to the usage records, with its route, timings, usage
  summed from its turns, git numbers and flags, and a `routing` line records what the router
  recommended, what ran, and which dimensions differed. Like the turn lines, they hold metadata
  only.

## Local models (orchestration)

Preferences → Orchestration → *Local endpoints* registers OpenAI-compatible servers (Ollama,
llama.cpp's `llama-server`, vLLM, LM Studio, `mlx_lm.server`). The registry is
`orchestration.localEndpoints` in `settings.json`. Nothing is installed or started for you.

- **Loopback or not.** An endpoint on `localhost`, `127.x` or `::1` is on when added. Anything
  else, a LAN box or a hosted API, is treated as external. It is **off** until you turn it on,
  it is not contacted while off, and everywhere it appears it says *data leaves this machine*.
- **Your own machine on your network.** An endpoint on a private address (`10.x`,
  `172.16–31.x`, `192.168.x`, Tailscale's `100.64/10`, IPv6 `fc00::/7`) or a home name
  (`box`, `box.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`) can be marked *My own
  machine on this network: treat as local* on its card, or `"location": "local"` in its entry.
  It is then local everywhere: on by default, no warning, `local` for routing, `local-only`
  caps and *prefer local*. On any other host the field is ignored. See
  [Serving from another machine](#serving-from-another-machine-on-your-network).
- **Keys** go in the macOS login Keychain, never in settings (see
  [Where secrets are kept](#where-secrets-are-kept)). Storing refuses when the Keychain cannot
  be reached. A Codex thread on the endpoint gets the key per request, and the key
  is never written to the session registry. For a native `/v1/messages` Claude Code session, the
  core resolves the key reference and passes the key to its session host over the authenticated
  socket after boot. Only that session's SDK environment gets the endpoint URL, key (or dummy),
  and catalog context window. Resume and host migration repeat the hand-off. Neither the launch
  policy nor the registry or host manifest contains the key.
- **Probe.** AW reads what the runtime says: the model list, context window, vision, slots
  (llama.cpp), constrained decoding, and whether the server serves `/v1/responses` (Codex) and
  `/v1/messages` natively. It probes those with an empty POST, which generates nothing. Each fact
  says where it came from (`probed`, `declared`, `measured`), and anything nobody said stays
  unknown. Health is read every 30 s. One miss is *degraded*, two in a row is *down*.
- **Tier map.** Every probed model shows up **unassigned** and is never routed to until you give
  it a tier. *Qualify Codex* runs §19.6's stage-1 direct probe: 10 tool calls, 10 tool-result round
  trips and 20 JSON replies, all synthetic. That sets tool calling and structured output to
  `measured` for Codex. Claude Code uses the native Messages task fixtures below.
- **Qualify tasks** runs stage 2 (plan §19.9). There are four small scratch repos, plain Node
  with no dependencies, each with seeded bugs, a check (`node test/check.js`), protected tests and
  a list of the paths the agent may change. Each runs 3 times through the selected native harness,
  under the same permissions and prompt framing as a routed attempt, in a temp dir that is removed
  afterwards. A run passes when the check exits 0, nothing under `test/` changed, and every
  changed path is inside the allowed ones. A run that asks for approval fails, since nobody is
  there to answer it. The result shows the pass rate, turns, wall time and tokens, all
  `measured`. Results are kept separately for each native harness, survive a restart, and each run writes a
  `local-call` record. A harness whose native route is absent is marked *not runnable* for that
  harness. It takes minutes. Neither stage ever
  sets a tier.
- **Status beside the tier picker.** Each local model's row in the tier map says what it can
  be picked for now, and what it still needs for each kind of work:
  - Completions need it enabled, at the weakest tier (`basic`), on an endpoint that is on and
    not down.
  - Planning needs `standard` or above and a context window a repository excerpt fits in.
  - Agentic work needs a native `/v1/responses` (Codex) or `/v1/messages` (Claude Code) route,
    qualification for that harness, and a tier.

  A model that stage 1 found completion-only is shown as *Completion only* with the measured
  count, for example `tool calls 0/10`. Both stages' results appear under the picker.
- **Harness-pin warning.** Preferences reminds you that a harness pin or exclusion needs a
  qualified model on the harness it permits.
- **What it does once tiered.** Agentic tasks run through their qualified native harness:
  Codex on Responses or Claude Code on Messages, under the same attempt permissions. A model at the weakest tier (`basic`) answers
  structured completions (assessment) directly over `chat/completions`, ahead of Haiku, and falls
  back to Haiku if it fails. The **planner** uses a healthy local model at `standard` or above
  whenever its known context window can hold the repository excerpt and policy allows local
  work. It has no tools, so Agent Wrangler reads the repository for it and puts an excerpt in
  the prompt, sized to the model's context window: the file tree from `git ls-files`, the
  manifests and READMEs, and the files the objective names or mentions. The plan gets the same
  checks and repair round as a hosted one. If the local model fails for any reason but Cancel,
  the hosted planner plans instead, and review says so. The reviewer, which reads files, always
  uses the hosted model. Server slots count as concurrency.
- **Losing the server.** An attempt whose endpoint goes down, or whose turn fails while the
  endpoint does not answer, ends as `infra` / `local-server-lost`. If the router picked the
  route, or the mission has `autoRecover`, it fails over to another model **in the same tier**.
  A route you picked by hand waits for you.
- **Numbers.** Each local attempt's `attempt` record carries a `local` block: runtime, device,
  context window, queue delay, output tokens/s over active time, and *API-equivalent avoided*.
  That last one is **an estimate**: what the hosted model the router would otherwise have picked
  would have cost at its `telemetry.prices` entry. Direct calls write `local-call` records. The
  endpoint card shows runs, `$0 API cost`, verified first time, succeeded, escalated, tok/s, TTFT
  and runtime per model. A cost a harness invents for a local model is not recorded.

### Serving an MLX model

`scripts/local-models/serve-mlx.sh` serves an MLX (4-bit) model directory with `mlx_lm.server`,
bound to `127.0.0.1` only, and prints how to register it. It installs nothing and never writes
`settings.json`.

```bash
# Once: mlx-lm in a venv of your choosing (the script prints these if it cannot find the server)
python3 -m venv ~/venvs/mlx
~/venvs/mlx/bin/pip install mlx-lm

# Every time: serve the model directory on a port (default 18080)
MLX_VENV=~/venvs/mlx scripts/local-models/serve-mlx.sh ~/models/<model-dir> 18080 --name "<name>"

# Just print the endpoint entry and the steps, without starting the server
MLX_VENV=~/venvs/mlx scripts/local-models/serve-mlx.sh ~/models/<model-dir> 18080 --print-only
```

`<model-dir>` holds `config.json` and `*.safetensors` (an `mlx-community/*-4bit` download).
Extra `mlx_lm.server` flags go after `--`. `--host`, `--port` and `--model` there are refused.
`--write-entry <file>` also writes the entry to a file, but never to `settings.json`.

To register the server, use **Preferences → Orchestration → Local endpoints**: enter URL
`http://127.0.0.1:18080` and a name, then *Add endpoint*. Once the server says it is listening,
press *Probe*. Then give the model a tier in the **Tier map**: `basic` for assessments, or
`standard` or above so missions that prefer local models can plan with it. The status line
under the picker says whether that took. *Qualify* is optional. *Qualify tasks* reports *not
runnable* here, because `mlx_lm.server` has no `/v1/responses`. Or, with the core daemon stopped (`aw daemon stop`), add the entry the script prints to `orchestration.localEndpoints`:

```json
{
  "id": "<the name in lower case, [a-z0-9-]>",
  "name": "<name>",
  "url": "http://127.0.0.1:18080",
  "runtime": "mlx",
  "models": { "<model id: the model dir as the server was given it>": { "contextWindow": 32768 } }
}
```

`contextWindow` is declared from the weights' `config.json` (`max_position_embeddings`),
because `mlx_lm.server` does not report one.

What an MLX model can and cannot do in Agent Wrangler:

- **Completion-only.** `mlx_lm.server` serves `chat/completions` but not `/v1/responses` or
  `/v1/messages` (both 404), so no harness can run on it and it never gets agentic coding
  tasks. It answers assessments at `basic`, and plans missions that prefer local models
  (above) at `standard` or higher. Agent Wrangler does not ship a protocol translator to get
  around this (plan §19.6 point 2).
- **Not through llama.cpp.** `llama-server` loads GGUF files only and cannot load MLX weights.
  An agentic local model needs a GGUF model on `llama-server`, which serves `/v1/responses`
  natively. That path is verified against Codex in plan §19.7, and
  `scripts/local-models/codex-live-check.ts` re-runs the check.

### Serving from another machine on your network

Inference can run on a separate box, such as a PC with an NVIDIA GPU, while Agent Wrangler, the
agents, worktrees and checks stay on this Mac. Only the HTTP calls to the endpoint URL leave the Mac.

- **The server.** Run `llama-server` with a GGUF model on that box. It serves `chat/completions`,
  `/v1/responses` (Codex) and `/v1/messages` (Claude Code) natively, and `/props` reports the
  context it actually runs with. Useful flags:
  - `--host 0.0.0.0` to accept connections from the Mac;
  - `--parallel 1`, because `-c` is split across slots and Agent Wrangler reads a slot's `n_ctx`;
  - `-c 32768` at least, because Claude Code's first turn alone is about 16k tokens;
  - `--jinja` for tool calls;
  - `--api-key-file <file>`. Claude Code sends the key as `x-api-key`, which `llama-server` accepts.
- **Ollama works too, but beware the context window.** Its probe reports the model's trained
  context, not the `num_ctx` it runs with, and a probed window beats a declared one.
- **Lock the box down.** Its firewall should admit the port only from the Mac's address, and
  both machines should have a fixed address (a DHCP reservation).
- **Register it** once per server, with the core daemon stopped, in `orchestration.localEndpoints`. Or
  add it in Preferences, tick *My own machine on this network*, and turn it on:

  ```json
  {
    "id": "gpu-box",
    "name": "GPU box · Qwen3.5-9B",
    "url": "http://192.168.1.50:8080",
    "location": "local",
    "runtime": "llama.cpp",
    "maxConcurrency": 1,
    "device": "RTX GPU, 8 GB"
  }
  ```

- **Then:** use *Set key…* for the key, *Probe*, *Qualify* and *Qualify tasks* per harness,
  and give the model a tier.

## Repository policies (orchestration)

Orchestration (off by default, `orchestration.enabled`) reads what it must not guess about a
repository from `repos/<repo-id>.json` under the app's support folder: where worktrees go and how
they are set up, the verification commands, risky paths, exclusive resources and how a mission
finishes. Nothing is written into the repository. `repo-id` is the primary checkout's folder name
plus a hash of its git common directory, so every worktree of a repository shares one policy.

- Commands are argv arrays (`["npm", "test"]`), never shell strings. A model can name a command
  (`command:unit`) but never add one.
- A file is laid over the defaults field by field. With no file: no verification commands (results
  are `unverified`), an advisory review for risky or weakly verified tasks, no risk paths,
  worktrees in `../<repo>.aw`, finish by merging locally.
- `"review": { "when": "auto" | "always" | "never", "requiredFor": ["migration", …] }` controls
  the reviewer (above). A kind listed in `requiredFor` is always reviewed, and the review is
  required for it, whatever `when` says.
- A file with any error is ignored whole, with each error's path in the log, never half-applied.
- Each attempt records the policy version it ran under (`default`, or `v1-<hash>` of the
  effective policy).

The schema is `src/shared/orchestration/repoPolicy.ts`; this repository's policy is
`docs/repo-policies/agentwrangler.json`. Until the Preferences page for it exists, edit the JSON file by hand.

## From a terminal: `aw`

`npm run cli:install` puts an `aw` command on your `PATH` (a copy of `bin/aw`, so it keeps working if the checkout goes). It runs the CLI bundled inside the installed app, using the app's own runtime, so it needs no Node and always matches the installed build.

| Command | What it does |
|---|---|
| `aw status` | What the core daemon is doing: sessions by status, and how many it runs that survive a daemon restart. |
| `aw sessions [--all]` | The rows of the table (`--all` adds archived ones). |
| `aw session <id>` | One session in detail, including what it is waiting on. |
| `aw attach <id>` | Follow a session the app runs, read-only, until it ends or Ctrl-C. |
| `aw send <id> <text…>` | Send a message to a session the app runs (`-` reads the text from stdin). |
| `aw stop <id> [--force]` | End the process running a session, as the row menu's *Close session* does. A session mid-turn is left alone unless `--force`. |
| `aw projects` | The project folders the launcher offers. |
| `aw delegate <objective…> [--criteria "a; b"] [--folder <dir>] [--claude\|--codex]` | Hand work over. A read-only planner decides whether it is one task or several, and the app waits for you to approve the proposal or the plan (see below). `-` reads the objective from stdin. |
| `aw task <objective…>` (same options) | Shortcut: always one task, no planner. The app assesses and routes it, then waits for you to start it. |
| `aw tasks` | Tasks that are not finished, with their state and branch. |
| `aw web open` | Open the workbench in your default browser, signed in (see [Open in a browser](#open-in-a-browser)). |
| `aw web url` | Print the single-use sign-in link instead of opening it. |
| `aw web pair` | Pair a phone or tablet on your home network: prints a QR code and a code (see [Pairing a device](#pairing-a-device)). |
| `aw web devices [revoke <id>]` | The browsers that can sign in; `revoke` signs one out for good and disconnects its open tabs. |
| `aw daemon start\|stop\|status` | Start, stop or check the core daemon (see [The core daemon](#the-core-daemon)). |

`<id>` is a session id, a unique prefix of one (four characters or more), or a key such as `claude:<id>`. `--json` prints the raw result.

**Delegating work from a conversation (#82).** Ask the agent you are talking to to "delegate
this" (or "hand this off", "run this as a task"), and it runs `aw delegate` with the objective
and criteria. You don't choose between a task and a mission: Agent Wrangler gives the outcome
to the read-only planner (the one *Plan it for me* uses, biased to one task), and the
planner decides.

- **One task.** It becomes a task proposal, assessed and routed as in `assisted` mode whatever
  `orchestration.routing.mode` says, and answered **in the conversation that delegated it**
  (#81): a *Delegated* card at the end of that conversation, styled like a question or a plan,
  with the recommended model and effort pre-selected, **Run**, and **Cancel**. Changing the
  model or effort before Run is recorded as a disagreement with the router; Run on what was
  offered is an acceptance. Your criteria come first on the task, then any the planner added.
- **Several tasks.** It becomes a planned mission in plan review, and the card shows the plan:
  each task (expand it for its objective and criteria) and what it comes after, the risks,
  warnings and anything that stops it starting, **Approve and start**, **Edit in Missions**,
  **Plan again…** and **Cancel**. Approved from the card, tasks without a pin run on the
  launcher's model and effort, exactly as *Approve and start* in the Missions view.
- **While it plans** the card says so and offers **Cancel**. If it **cannot be planned**, the
  card says why and offers **Run as one task** (the objective and your criteria as given) or
  **Plan again…**.

Nothing runs until you press a button on the card: nothing takes focus and nothing is accepted
by keyboard alone, so an Enter meant for the composer can never start work. The notification's
click brings the conversation up. The delegating conversation is only where the card is shown:
the work runs in sessions and worktrees of its own, cut from the repository's primary checkout,
not from the conversation's worktree. Delegation cards and the proposal/plan they turn into
say *Delegated*; once the work runs it is an ordinary task or mission (task strip, Missions
view). `aw delegate` waits up to 100 s for the planner and prints its decision; after that it
prints that the card will show it.

`aw task` is the explicit shortcut when you already know it is one task: the same proposal
and card (headed *Task proposal*), without the planner. A proposal with no known conversation
(either command from your own terminal) is reached from the notification, the launcher's
**Tasks** menu, or the Missions view instead. The Missions view's *New mission* stays as the
advanced way to write or plan a mission yourself. Both need `"orchestration.enabled": true`.
**Conversation suggestions (#84).** Before sending an ordinary message to Claude or Codex,
the conversation pane applies the same deterministic rules, using the repository's verification
policy. Bounded implementation work with independent checks and background value gets a short
**Delegate this work?** card. Expand **Review the handoff** to see the full objective, criteria,
and repository. **Delegate** enters the existing planner; nothing runs until the resulting
proposal or plan is approved. **Keep working here** or **Dismiss suggestion** sends the original
message to the conversation. Cancelling the send, switching conversations, or closing the pane
abandons the offer without sending it; the composer keeps the draft when the pane stays open.

Discussion, explanation, review, small interactive edits, unclear/context-dependent requests,
requests with images, non-git folders, and orchestration sessions do not get suggestions.
The conservative rules can miss work worth delegating: explicit “delegate this”, “run this as
a task”, `aw delegate`, and `aw task` keep their existing paths. Both providers receive shared
guidance to honor those shortcuts and avoid repeating the app's suggestion. The handoff carries
no harness preference from the conversation; explicit CLI `--claude` or `--codex` still pins one.
Local telemetry records accepted, declined, or ignored offers (including cancelled sends),
provider, rule/policy version, and wait duration, never prompt content or repository paths.
It respects `telemetry.enabled`. An older optional Claude Code skill is in
`docs/skills/agentwrangler-task/SKILL.md`.

- **It is a client of the core daemon, never a supervisor.** It talks only to the daemon's control socket (`run/core.sock` in the app's support folder, 0600, with a token that is new every time the daemon starts). It never connects to session hosts, and every command goes the same way as the equivalent click. Open tabs show a short notice when `aw` sends or stops something.
- **With the daemon stopped**, `aw status` and `aw sessions` still work, read-only: they list the session hosts that are still running (they reattach when the daemon starts) and what the daemon last recorded. Everything else says Agent Wrangler is not running.
- **`delegate` and `task` are allowed there**, because they only ever create a proposal or a plan. Nothing runs until you accept it in the app, so an agent calling them can't start work you haven't seen.
- **`send` and `stop` refuse in a shell an agent is running** (Claude Code, Codex, or a session the app hosts), so an agent that has been prompt-injected is not one obvious command away from driving every other session. This is a speed bump, not a wall. Any process running as you can read the token, or clear its environment, and Agent Wrangler cannot stop a deliberately malicious one (see the security model in `docs/plans/session-lifecycle-architecture.md` §12). `aw web url` refuses there too, for the same reason: the link it prints is the whole workbench. So do `aw web pair` (its code lets a device in as you) and `aw web devices revoke`.

## Open in a browser

The workbench is a web page the core daemon serves. On the Mac, open the app, or run:

```bash
aw web open
```

and your default browser opens `http://127.0.0.1:7391/`, signed in. That browser stays signed
in for 30 days from the last time you opened the page. `aw web url` prints the link instead, for
another browser on the Mac. Phones and other computers need [LAN access](#lan-access) and
[pairing](#pairing-a-device).

- **This Mac only.** It listens on `127.0.0.1`, not on your network. A page that tries to
  reach it under another name is refused (421), and so is any other site's script (403).
- **A sign-in link works once, for two minutes.** It turns into a cookie your browser keeps
  (`HttpOnly`, `SameSite=Strict`); Agent Wrangler stores only a hash of it, in
  `web-devices.json` in its support folder. Without that cookie the browser gets nothing but
  "not signed in" (401).
- **Settings:** *Open in a browser* (`web.enabled`, on) and its *Port* (`web.port`, 7391), in
  Preferences under Browser. Off closes the listener and every open tab, which leaves only
  `aw` and Discord: turn it back on by stopping the daemon, setting `"web.enabled": true` in
  `settings.json` in the support folder, and starting it again.
- Confirmations and pickers appear in the tab whose click asked (#126); one nobody's click
  caused is shown to every tab as a notice and answered "cancel".
- Sign-ins, failed sign-ins and new browsers are recorded in the access log
  (`~/.cache/agent-wrangler/access.log`), by id only.

### LAN access

Off by default. *Allow devices on my home network* (`web.lan.enabled`, under Browser in
Preferences, needs *Open in a browser* on) also serves the workbench over **HTTPS** on this
Mac's home-network addresses, on *HTTPS port* (`web.lan.port`, 7392), so a phone or another
computer on the same network can open `https://<your-mac>.local:7392/`. Preferences shows the
addresses it is listening on under the switch. With it off, nothing listens beyond `127.0.0.1`.

It assumes:

- **A home network you trust.** Anyone on it can reach the sign-in page, though nothing
  behind it without a device credential.
- **The macOS firewall allows the port.** If the firewall is on, allow Agent Wrangler to
  accept incoming connections when macOS asks (System Settings → Network → Firewall).
- **No port forwarding.** Never forward 7392 from your router; this is not for the internet.
- **Devices are paired one by one.** A LAN device needs its own credential, which only pairing
  issues. The credential from `aw web open` does not work on the LAN listener, and a LAN one
  does not work on `127.0.0.1`. See [Pairing a device](#pairing-a-device).

How it is served:

- **One listener per private IPv4 address** (10/8, 172.16/12, 192.168/16), not `0.0.0.0`, so
  it never answers on a VPN tunnel or a public address. The addresses are re-read every 30
  seconds and on wake; a new address gets a listener and a new certificate.
- **TLS from a local certificate authority.** On first use Agent Wrangler makes
  *Agent Wrangler Local CA (your-mac)*, valid ten years, and a server certificate it
  signs for `<your-mac>.local`, `localhost` and the current addresses (397 days, re-issued
  when an address changes or 30 days before expiry). Keys are kept 0600 in `web-tls/` in the
  support folder; the CA's key never leaves it.
- **Or your own certificate:** set *Your own certificate* (`web.lan.certFile`) and *Your own
  private key* (`web.lan.keyFile`) to PEM files and they are used instead. Both must be set.
- `Host` must be `<your-mac>.local` or one of the addresses, with the port (421 otherwise);
  `Origin` must be `https://` that host (403 otherwise); the cookie is `Secure` and
  `__Host-` prefixed.

**Trusting the CA on an iPhone or iPad** (once per device):

1. On the Mac, in a browser signed in with `aw web open`, open
   `http://127.0.0.1:7391/ca.mobileconfig`. It downloads `agent-wrangler-ca.mobileconfig`
   (`/ca.pem` is the same certificate as PEM, for other systems). These two addresses work
   only on the Mac, signed in.
2. AirDrop the file to the iPhone (or mail it to yourself). iOS says *Profile Downloaded*.
3. On the iPhone: **Settings → General → VPN & Device Management**, tap the
   *Agent Wrangler Local CA* profile, then **Install** (it shows as *Not Verified*; that is
   expected for a CA made on your Mac).
4. Then **Settings → General → About → Certificate Trust Settings** and turn on full trust for
   *Agent Wrangler Local CA*. Without this step Safari still refuses the certificate.

On another Mac, double-click the `.mobileconfig` (or the `.pem`), install it in System
Settings → Privacy & Security → Profiles, and set it to *Always Trust* in Keychain Access.
To stop trusting it, remove the profile. Deleting `web-tls/` makes a new CA the next time LAN
access starts, which every device then has to trust again.

### Pairing a device

With LAN access on and the CA trusted on the device:

1. On the Mac, run `aw web pair` in your own terminal, or open
   `http://127.0.0.1:7391/pair/new` in a browser signed in with `aw web open` and press
   **Show a pairing code**. Either shows a QR code and an eight-character code such as
   `K7QD-3MXA`.
2. Scan the QR code with the device's camera and open the link. The pairing page opens with
   the code filled in and a name for the device (edit it if you like).
3. Tap **Pair this device**. The workbench opens, signed in, and stays signed in for 30 days
   from the last time it is used.

Without a camera, open `https://<your-mac>.local:7392/pair` on the device and type the code.

- **A code works once, for five minutes.** Starting pairing again replaces it; turning LAN
  access off withdraws it.
- **Guessing is locked out.** Five wrong codes from one address in ten minutes lock that
  address out of pairing for fifteen; twenty from anywhere lock pairing out for everyone for
  fifteen; and a code that has seen five wrong guesses is withdrawn. While locked, even the right
  code is refused.
- **The forms are protected** by an `Origin` check and a form token tied to a `SameSite=Strict`
  cookie, so another site cannot submit them, and they accept at most 4 KB. (File uploads
  have their own limits: 50 MB a file and 30 a minute per device.)
- **The device's credential** is 256 random bits in a `__Host-`, `Secure`, `HttpOnly`,
  `SameSite=Strict` cookie; Agent Wrangler keeps only its hash, with the device's name, when
  it was added and when it was last seen, in `web-devices.json` (0600).

**Devices and revoking.** Preferences → Browser → *Devices* lists every browser that can sign
in, on this Mac and paired, with **Revoke** (press it twice). `aw web devices` lists them too,
and `aw web devices revoke <id>` (an id or a unique prefix of four or more characters) revokes
one. Revoking disconnects that device's open tabs at once, and it cannot reconnect or sign in
again until it is paired again.

Pairing started, devices paired, wrong codes, lockouts, sign-ins and revocations are recorded
in the access log by id only, never the code.

### Notifications and dictation in a browser (#141)

**Notifications.** A page shows *Enable notifications* while the browser has not been asked;
click it (browsers only prompt on a click) and allow. A tab that has allowed them gets each
"needs you" notice as a browser notification **while it is hidden or its window is not
focused**; a tab you are looking at shows nothing, because the table already says it. Tapping
the notification focuses the tab and opens that session in its conversation pane. Each ask has
a tag, so the same ask arriving twice is one notification, and every device is its own: a
phone and a laptop each get one, and a tab you are looking at is the only one that stays quiet.

Which notices are sent at all is two settings: *Notify when an agent needs you*
(`notifyOnWaiting`, on by default since #145, so allowing notifications in a tab is the only opt-in) while any tab is connected, and *Notify while no tab is
open* (`notifyWhenWindowClosed`, on) while none is. Where a sent notice goes:

| Browser tab connected, notifications allowed | Notice goes to |
|---|---|
| None | The Mac's own notification (`osascript display notification` from the core daemon; clicking it does nothing) |
| One or more | Every such tab, which shows it only if hidden or unfocused. The Mac's own notification stays quiet |

A tab that has not asked, was refused, or cannot show notifications does not count: with only
those connected the Mac's notification still fires. Discord (when remote control is on) posts on
its own either way and is not part of this. Browser notifications need a secure context:
`http://127.0.0.1` on this Mac, or `https://` on the LAN. On plain http the page says so and
offers nothing. iPhone Safari only shows web notifications for a page added to the Home Screen,
and some Android browsers refuse `new Notification()` outside a service worker; neither is built.

**Dictation.** In a browser the mic button records with the browser's own microphone
(`MediaRecorder`: webm/opus where there is one, mp4/AAC on Safari), so it is the phone's
microphone on a phone. Stopping uploads the recording to `POST /dictation` (the device cookie,
`Origin`, and an `x-aw-dictation` header; at most 10 MB and five minutes; one at a time), which
Whisper transcribes on the Mac with ffmpeg and the configured model. The text lands in the
composer. There is no live preview while you speak (the old window's recording with the Mac's
own microphone had one; it went with the window in #142). A refused microphone, a missing
ffmpeg, whisper or model, and a non-secure page are each said beside the composer. The
microphone needs a secure context too: `http://127.0.0.1` on the Mac, `https://` on the LAN.

## The core daemon

Agent Wrangler's core (session tracking, the conversations it runs, Discord, `aw`, the web
workbench) runs as a background service, the **core daemon**: a LaunchAgent,
`com.hammonjj.agentwrangler.core`, on the app bundle's own Node. It keeps running with no
browser open. Opening the app starts it if it is not running. Plan:
`docs/plans/browser-workbench.md` §4.

```bash
aw daemon start          # install or start it, or move it onto this install's build
aw daemon status         # pid, build and uptime
aw daemon stop           # stop it; conversations in session hosts keep running
aw daemon stop --all     # stop it and end them too
```

- **One core at a time.** Whoever answers on `run/core.sock` holds the core; a second daemon
  refuses to start and says why. An Electron-era app (before #142) still running its own core
  is refused the same way: quit it first (`npm run app:install` does).
- **Updates and crashes leave conversations running.** They run in session hosts, not in the
  daemon. `aw daemon start` from a newer install (and `npm run app:install`) rewrites the
  LaunchAgent, which stops the old daemon and starts the new one; it reattaches every host.
  launchd restarts a daemon that crashes, but not one that was stopped.
- **Login:** it starts at login only when *Open at login* is on. Otherwise opening the app,
  `aw daemon start` or `aw web open`'s first run starts it.
- **Discord runs inside it** (#138), with the bot token read from the Keychain, so it works after
  a reboot with no browser open. The old remote daemon of Electron-era builds and its
  LaunchAgent (`com.hammonjj.agentwrangler.remote`) are stopped and removed the first time it
  starts. See [Remote control](#remote-control-experimental).
- **Files:** `run/core-daemon.json` (its pid, build and start time) and `logs/core-daemon.log`
  in the app's support folder; it writes the usual `agent-wrangler.log` too. While agents work
  it holds `caffeinate -i -w <pid>`.
- **Browser workbench:** the daemon serves it (#131), from the bundle's
  `Contents/Resources/app/dist/webview`. A question the core asks goes to the tab whose click
  caused it; one nobody caused (a startup check, Discord, `aw`) is shown to every open tab as a
  notice and answered "cancel".

## Remote control (experimental)

Answer a permission prompt from your phone when you are away from home, through
Discord. (At home, a [paired phone](#pairing-a-device) has the whole workbench.)
Off by default, and under **Preferences → Experimental** because it is the only
thing here that sends anything off your own devices. It needs no inbound
connection: the daemon connects out to Discord.

Agent Wrangler stays in charge throughout. Discord shows the same choices the
table row shows, and pressing one runs the same action — the agent never
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
5. **Connect Discord…** in **Preferences → Experimental**, and paste the token. It is checked
   against Discord before it is saved, so a typo fails there rather than later
   as a connection error. It goes to the **macOS login Keychain**, never to
   `settings.json`.
6. In **Preferences → Experimental**, fill in the server ID, the channel ID and
   the Discord user IDs allowed to answer. Turn Developer Mode on in Discord
   (User Settings → Advanced) to copy IDs. An empty allowlist means **nobody**,
   and nothing is published at all.

**It keeps working with no browser open.** Discord runs inside the core daemon
(#138; see [The core daemon](#the-core-daemon)), fed the core's own session list,
with presses applied by the core directly, as they are from the table. It reads
the bot token from the Keychain itself, so **after a reboot Discord works without
opening a browser** when *Open at login* is on.

- When the daemon starts it stops the old remote daemon of Electron-era builds
  (#74) and removes its LaunchAgent before it connects, so only one process ever
  holds the bot, and the cards that daemon posted are taken over rather than
  posted again. A daemon restart or update hands its cards to the next one the
  same way.
- Its log lines are in `logs/core-daemon.log`, and **Test connection** in Preferences says
  whether it is running and connected.

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
safe. It rides the same working→finished edge the local notifications do, so it fires
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

**Questions and plans are mirrored too, for conversations Agent Wrangler runs.**
A permission prompt is answerable from anywhere because answering one is a file
write into a directory every process shares. An `AskUserQuestion` and an
`ExitPlanMode` are not: they are settled by resolving a callback that exists
only inside the process running the session. For a conversation in a session
host, that callback is reachable over the host's socket by the core daemon; for a
Codex thread, through the core's link to the Codex server. A session
running in a terminal still mirrors permissions only: there is no callback
anywhere to resolve.

A question posts one button per option, and the card lists each option with its
description, since a button label cannot carry one. A plan posts with **Approve**
and nothing else: rejecting a plan carries your feedback back to the model, and a
rejection with no feedback is a worse thing to send than none at all, so *Request
changes* stays in the app. The same goes for anything else that needs typing —
the *Other* box, a multi-select, more than five options, or several questions in
a row. Those still post, so you know an agent is waiting on you, but they say to
answer at the machine rather than offering a button that cannot say what you mean.

**What that means for what leaves the machine.** Until now a card carried a
command and Claude's one-line reason for wanting to run it. A question carries
the model's question and its options; a plan carries the model's prose about your
codebase. Both go through the same scrubbing as a command — home folded to `~`,
secret-looking values masked, length capped — but they are closer to transcript
content than anything sent before, so it is worth knowing before you switch it
on. A plan is capped at 1,200 characters and the card says how many it is not
showing: approving a plan is the one remote action that depends on having read
the thing, and a plan you have read half of is exactly the mistake to avoid.

**What it does not do yet.** There is no Slack transport, no chat, and no way to
start or stop an agent remotely.

**Security.** The token is in the macOS login Keychain (see
[Where secrets are kept](#where-secrets-are-kept)) — never in settings, never
logged, and stripped from error messages. Presses are accepted only from the configured server and channel, only
from a listed user ID (never a username: those can be changed and reused), and
only for a prompt Agent Wrangler still has open — a press on a card whose prompt
has since been answered cannot land on whatever replaced it. Commands are
redacted before they are sent: assignments to secret-looking names, vendor
tokens, bearer headers, PEM blocks and `--password`-style flags are masked, and
your home directory is folded to `~`. Every publish, press, refusal and
resolution is appended to `~/.cache/agent-wrangler/remote/audit.log`, which
records IDs and tool names but not command text — the channel already has that.

**Exactly one gateway socket, always.** Only one process connects: the core
daemon. There is only ever one (launchd runs one per label, and a second copy
that finds the socket answering exits), and it retires the old remote daemon of
Electron-era builds, and waits for it to exit, before it connects. Discord will happily let one bot hold
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

## Where secrets are kept

The Discord bot token and local-endpoint API keys are items in the macOS **login Keychain**:
service **Agent Wrangler**, one item per secret, with the secret's key as the account
(`remote.discord.botToken`, `localEndpoint:<id>`). Keychain Access lists them under
*Agent Wrangler*.

They are written and read with `/usr/bin/security`. A write sends the command on stdin
(`security -i`), so the secret never appears in a process's arguments, where `ps` would show
it. The items' access list trusts `/usr/bin/security`, which does not change when Agent
Wrangler is rebuilt, so there is no Keychain prompt per build. The flip side: any process running
as you can read them with the same command, without a prompt, and that includes the agents
Agent Wrangler runs. This is the same boundary the session hosts' token files already have (a
process running as you is trusted). `safeStorage` asked before a different program read its key.
Restricting the items to a signed Agent Wrangler binary would need a native Keychain binding;
that is a possible later hardening. Secrets must be printable ASCII
(every token and API key is). Code that needs secrets uses `src/core/keychainSecrets.ts`.

**Upgrading from a build that used `safeStorage`.** Builds before #124 kept secrets as Electron
`safeStorage` ciphertext in `secrets.json` in the app's data folder. The Electron builds from
#124 on moved them to the Keychain on their first start. That move needs Electron, which is gone
since #142, so a copy older than #124 must first run a build that has #124 and still has
Electron, then this one (see *Migrating from an Electron build* under
[Installing, updating and restarting](#installing-updating-and-restarting)). A
`secrets.json` left behind is not read.

## How status is detected

Two sources for status itself, in priority order — hooks are ground truth, the transcript is a fallback — plus a third for classifying *why* a session is rate limited, and a fourth for the work a conversation delegated.

Every row answers three questions: **what is happening** (the primary status: Waiting, Busy, Done, Possibly stuck, Ended, plus an activity such as *Delegating*), **what it is waiting for** (the wait reason: a permission, an answer, your reply, an approval, delegated work, background work, a rate limit), and **whether you need to act** (its section, and whether it counts toward the attention badge). §4 below has the model; `docs/plans/status-contract.md` is the full contract.

### 1. Hooks (exact, opt-in)

Click *Install hooks* in the banner above the table (it shows while status is only estimated). It merges a block into `~/.claude/settings.json` in which every hook appends its stdin payload to `~/.claude/agentwrangler/$PPID.jsonl`; Agent Wrangler tails those logs. The one exception is `PermissionRequest`, which runs `~/.claude/agentwrangler/permission-hook.sh` (written by the installer) — see *Allow / Deny* below.

| Signal | Meaning |
|---|---|
| `PermissionRequest` · `Elicitation` · `Notification`/`agent_needs_input` · `PreToolUse` for `AskUserQuestion` / `ExitPlanMode` | **Waiting**, stopped at a prompt (row names the tool, and what for) |
| `Stop` with a reply that asks something · `StopFailure` | **Waiting** |
| `Stop` with a reply that just reports | **Done** |
| `Stop` with a reply that just reports, `background_tasks` not empty | **Busy**, chip *N in background* (never *Possibly stuck*) |
| `UserPromptSubmit` · `PreToolUse` · `PostToolUse`/`PostToolBatch` | **Busy** (row shows the in-flight tool and its elapsed time) |
| no events at all past `stuckThresholdSeconds` (default 10 min), nothing in flight | **Possibly stuck** |
| `SessionEnd`, or pid gone | **Ended** |
| `SessionStart` with no transcript yet | *hidden* (an empty conversation) |

**Allow / Deny from the table.** Claude Code runs `PermissionRequest` hooks and shows its permission dialog *at the same time*, then takes whichever answers first (verified in the 2.1.267 binary: the hook generator and the dialog promise are started together and raced). The installed script logs the payload like every other hook, leaves a marker in `~/.claude/agentwrangler/requests/`, and then polls for `decisions/<id>.json` for up to ~28 minutes (its hook `timeout` is 30 minutes). Clicking **Allow** or **Deny** writes that file with Claude Code's own decision shape (`hookSpecificOutput.decision.behavior`); the script prints it and exits, and Claude Code applies it. If you answer in Claude Code instead, the decision is picked up from the pid file (below), which also removes the marker, and the script exits within half a second. The buttons only render while the marker exists, so they never offer a decision that can no longer land. Tools that require interaction by design (`AskUserQuestion`, `ExitPlanMode`) cannot be answered this way and show no buttons.

**Answering in the Claude Code window** is the one thing hooks cannot report, so it is read off the pid file instead. There is no `PermissionGranted` hook — Claude Code 2.1.270 registers `PermissionDenied` but has no counterpart for the other answer — and the event order is `PreToolUse` → `PermissionRequest` → *you answer* → `PostToolUse`. `PostToolUse` fires when the tool has **finished**, so on hooks alone, allowing a ten-minute test run would leave the row sitting at the top of *Waiting*, still claiming to be stopped at a prompt, for the whole ten minutes, which is exactly backwards. `~/.claude/sessions/<pid>.json` closes the gap: Claude Code rewrites a `status` field there on every state change — `running` → `busy`, `requires_action` → `waiting` (with `waitingFor` = `permission prompt` or `input needed`), `idle` → `idle` — stamped with `statusUpdatedAt`. Measured here, the flip back to `busy` is written within ~0.1 s of the click, and stays `waiting` for as long as a prompt is genuinely open. The registry watcher already sees that write, so the row clears in well under a second however long the allowed command then runs. The status is only ever used to *end* a block, never to start one, and only when its stamp is later than the moment the block was recorded — a `busy` written before the prompt existed cannot cancel it. Sessions from an older Claude Code that writes no `status` simply keep the old behaviour.

**Always allow** is Claude Code's own *don't ask again*, not a second implementation of it. The `PermissionRequest` payload carries `permission_suggestions` — the exact permission updates the dialog's "don't ask again" would apply, e.g. `{type: "addRules", behavior: "allow", destination: "localSettings", rules: [{toolName: "Bash", ruleContent: "npm test:*"}]}`. The button hands that list straight back as `decision.updatedPermissions` on the allow, and Claude Code applies it to the session and saves it where the suggestion says (verified in the 2.1.268 binary: an allow decision's `updatedPermissions` is validated against the same schema as the SDK's, applied via `setSessionToolPermissionContext` and persisted). Only *allow* rules and directory grants are passed through — a `deny` or `ask` suggestion is dropped rather than applied by a button with that label. The button's tooltip names the rule and where it will be saved, the status bar confirms it afterwards, and it does not appear when the payload offered no suggestion.

*Possibly stuck* is deliberately slow to trigger. Hooks fire on tool calls and prompts, not while the model is generating, so a long think or a large `Write` is silent for minutes (measured in one ordinary turn: 121s, 388s, 79s, 104s). The ETA column is what says "running long"; *stuck* means nothing at all for ten minutes.

**Background work is not Done.** A turn can end with work still running: a background subagent, a background shell (`run_in_background`, or a foreground command Claude Code moved to the background when it hit its timeout), a Monitor. When that work finishes, Claude Code queues a `<task-notification>` as a new turn and the agent carries on, so a report like "I'll get back to you when the review finishes" is not the end. Every `Stop` payload says what is still running: `background_tasks`, a list of `{id, type: "subagent" | "shell" | …, status: "running", …}` (checked on Claude Code 2.1.281–2.1.283; `session_crons` alongside it is not counted). While that list is not empty, a reply that would read as **Done** stays **Busy**, with a dashed *N in background* chip and the kinds in its tooltip. It is never *Possibly stuck*, however quiet the wait, and it sends no "is done" toast or Discord done notice. The turn the notification starts fires `UserPromptSubmit` like any other, and its own `Stop` reports the list again, so the row goes to Waiting or Done on that reply, as usual. A reply that asks something stays **Waiting** whatever is running: the human is still the one being waited on. A background shell that never ends (a dev server) keeps its row Busy for as long as it runs.

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
| …the same, with a background launch since this process started and no notification ending it | **Busy**, chip *N in background* |
| last transcript line: assistant `tool_use` / user / queue-op | **Busy** |
| busy but transcript silent > `stuckThresholdSeconds` (default 10 min) | **Possibly stuck** |
| pid gone | **Ended** |

Background work in the transcript (used when no `Stop` of the current process has reported `background_tasks`; same Claude Code versions): a launch is the tool result's `toolUseResult` — `backgroundTaskId` for a shell, `isAsync` + `agentId` for a subagent (the Agent tool can run async without `run_in_background`), `taskId` + `timeoutMs` for a Monitor. Its end is the `queue-operation` enqueue written the moment it finishes, or the user line that enqueue becomes: a `<task-notification>` naming its `<task-id>` with a `<status>` (`completed`, `failed`, `killed`, `stopped`). A notification without a `<status>` is a monitor event, and the monitor is still running. `TaskStop`'s result ends one too. Launches from before the current process started are ignored: Claude Code kills background work when it exits, and a `--resume` appends to the same transcript without closing them. Only what the tail read covers is known, so a launch older than the first read is missed, which errs toward Done.

Inference cannot distinguish a permission prompt from a long tool call from a wedged session — all three look like a silent transcript. That limitation is the reason hooks exist; without them, *Possibly stuck* is a guess.

Transcripts and hook logs are both read incrementally (bounded tail reads with a per-file byte offset) — large files are never loaded whole.

### 3. Rate-limit classification (#75)

A row's rate-limit stoppage (the `ratelimit` chip, on the row and in the conversation header) is classified, not the single generic "rate limited" state this used to be: which provider, which window when known (Claude's five-hour session limit vs. its weekly limit; Codex's primary vs. secondary window), the reported reset time when the source gave one, and the raw evidence for troubleshooting (`shared/rateLimitClassification.ts`). A source that cannot say which window it hit reports `unknown` rather than guessing — in particular, a bare API-level 429 with no accompanying event is never read as the weekly limit, since nothing about a 429 says which window it was.

**Claude.** A running session's own host caches the newest `rate_limit_event` message it has seen (`shared/sessionProtocol.ts`'s `latest`) — an SDK message **undocumented by Anthropic**, observed as `{ rate_limit_info: { rateLimitType: "five_hour" | "weekly" | …, resetsAt } }`. That is the only signal that distinguishes the five-hour limit from the weekly one, and it wins when present. Failing that, a bare `result` line with `is_error: true, api_error_status: 429` and no `rate_limit_event` classifies as `unknown` (`claude/rateLimit.ts`). A session Agent Wrangler only observes (registry + transcript, no host) instead reads the same 429 off the transcript tail's `result` line, when its Claude Code build writes one to the transcript file at all — most do not, so this is an additive fallback, not the primary path.

**Codex.** App Server's `account/rateLimits/read` reports `primary`/`secondary` windows as a percent used; there is no explicit "this window is actively limiting you" flag in that response, so a window is only reported as a stoppage once it reaches 100% used (`codex/usage.ts`) — this "100% = hit" reading is Agent Wrangler's own inference from the shape of the response, not something Codex's API documents as a signal.

Auto-pause (`autoPause.enabled`/`autoPause.percent`) is scoped per provider: a Claude plan limit pauses only Claude sessions and a Codex plan limit only Codex ones, so the two can never pause or clear each other. Codex's own auto-pause has nothing to act on today — see `docs/codex-and-electron.md` for why.

### 4. Delegated work (#101)

A conversation that handed work off (`aw task`, `aw delegate`, the Delegate button) keeps its own status: the six statuses describe its own turn and nothing else. Beside the status, every row carries a **wait reason** (what it is waiting for, where that came from, and how sure it is) and, for a conversation that delegated something, a **linked-work summary**: one entry per mission id, saying whether that work is planning, awaiting approval, running, verifying, ready to merge, merged, failed or cancelled. Both come from one pure derivation, `shared/orchestration/delegatedState.ts`, which the store applies to every row; the Missions view reads the same module's mission phase and counts, so the table, Missions and the conversation cannot disagree. The contract it implements is `docs/plans/status-contract.md`.

- **Waiting is kept only for a real ask.** A finished turn whose reply asks something, and whose missions (created in that same turn) all need nothing more from you, shows Done with the delegated activity beside it. While one of them is still awaiting approval, needs you, or is ready to merge, the row stays Waiting and names that mission. Each wait resolves against its own mission id, so two missions from one conversation never clear or overwrite each other.
- **Tying a turn to its missions.** A mission records when the delegating turn began (hook `UserPromptSubmit`, Codex `turn/started` or rollout `task_started`). A later user prompt ends the tie, and the reply's own wording decides again. Without a turn start (transcript-only sessions, or a hook backlog replayed after a restart) the tie is estimated and shown as such.
- **Quiet waits are not stalls.** Planning, running children, verification, background work (#60) and rate limits (#75) never become *Possibly stuck* and never send an early Done notification. Attempt sessions send no Done toast at all; their mission's notices say it.
- **Merged, verified and closed out are three facts.** A merge says where the branch went, not that it was checked; *unverified* stays unverified (and says when no checks are configured). Agent Wrangler closes no GitHub issue: closing out is yours.
- **Nothing is persisted on the session**, and nothing in the transcript is rewritten: an old reply that says "waiting for your approval" stays as written, with the current state shown beside it.

**Status, activity and wait reason.** The primary status stays one of the six; the reason sits beside it and never changes which section a row is in.

| Row shows | Section | Counts for attention | Click goes to |
|---|---|---|---|
| Waiting · *Needs Bash* (the prompt's tool or kind) | Waiting (top) | yes | the conversation, ask card |
| Waiting · *Asked you something* (full width) / *Your reply* (narrow) | Waiting | yes | the conversation |
| Waiting · *Delegated: 1 task to start* / *plan of 3 to approve* | Waiting | yes, once: on the mission, not again on the row | the conversation's card |
| Busy · *Delegated: planning* (narrow: *Delegating*) | Busy | no | the conversation's card |
| Busy or Done · *Waiting on delegated work · running · 0/1 done* | as its own turn | no: nothing is asked of you | the chip opens the mission in Missions |
| any · *Delegated: t2 needs you* / *ready to merge* / *failed* | as its own turn | yes, on the mission | Missions → that mission |
| Done · *Delegated: merged · unverified · closeout: yours* | Done | no | Missions → that mission |

A conversation with several missions shows the most urgent one (needs you before activity, then the newest) and *+N*; the tooltip lists the rest. At about 300 px each chip switches to its short form (`#app.narrow`), on the row's second line.

**Missions.** Each mission's header shows the same phase the row does, so an open proposal reads *Awaiting approval* and never *running*. A finished mission shows three separate chips instead of *completed*: where the branch went (*Merged*, *PR opened*, *Kept on branch*, *Discarded*), whether it was checked (*Verified*, *Unverified*, *Unverified · no checks configured*, *Checks failed*) and *Closeout: yours*. A task row says *completed* for finished work, with its checks as a separate labelled fact beside it. The Missions tab's count is the missions that need you, each counted once.

**The conversation's delegated-work summary.** Under the conversation header, and outside the transcript, a strip lists every mission this conversation delegated: its phase (*Planning*, *Awaiting approval*, *Running*, *Awaiting results*, *Verifying*, *Ready to merge*, or how it ended), its title and progress, the merged/verified/closeout facts once it has finished, and *Open in Missions* (plus *Show card* while there is a card to answer). It updates as a mission is approved, launched, finished or merged. It is sent to the pane as its own message, so nothing already drawn in the transcript is re-rendered. The proposal and plan cards take their headings from the same entries. The strip folds to one line. A started mission stays listed while it runs, and for a day after it ends.

**Uncertainty markers.** A value a provider or Agent Wrangler's own records report has no marker. An estimate carries `~`: a status read from the transcript (also the hollow dot), a Waiting read from the reply's wording, or delegated work tied to a turn whose start is unknown. What no signal can say right now carries `?`, and is never filled in with a guess. A row whose session host is reconnecting keeps its last status with a *? reconnecting* chip and is not counted as needing you. Each tooltip names the source and whether it is verified or estimated.

**Notifications.** Each notice has a dedupe key and is sent once per run of the core daemon, and never for a state that already held when it started:
- a permission or question: once per request;
- becoming Waiting on your reply: as before, with a 30 s cooldown;
- a proposal or plan to approve: once per mission and plan run. The row's own Waiting toast is suppressed for it;
- a task needing you: once per task attempt;
- ready for review: once per mission;
- merged: once per mission. The notice says whether it was verified, and that the issue was not closed.

There is no Done toast while delegated work is still going, and none for attempt sessions.

## Settings

All of them are in Preferences (`#/preferences`) and stored in `settings.json` in the app's support folder (`~/Library/Application Support/Agent Wrangler/`), keyed by the names below. Edit the file by hand only with the core daemon stopped.

`runner.defaultPermissionMode` (`acceptEdits` — or `default` to be asked every time, `plan` to plan first) · `runner.model` (empty — Claude Code's own default) · `runner.autoResumeLastOnStartup` (true) · `claudeBinaryPath` · `stuckThresholdSeconds` (600 — generation is silent for minutes; see above) · `endedWindowHours` (48) · `maxEndedSessions` (50) · `notifyOnWaiting` (notify an open tab when an agent needs you or is done) · `notifyWhenWindowClosed` (a Mac notification when no tab can show one) · `openAtLogin` (false — start the daemon at login) · `lifecycle.orphanIdleHours` (24) · `pollIntervalSeconds` (5) · `showUsage` (true) · `usagePollIntervalSeconds` (60, and 20 by itself near a limit) · `autoPause.enabled` (false) · `autoPause.percent` (98) · `web.enabled` (true — the browser workbench on 127.0.0.1) · `web.port` (7391) · `web.lan.enabled` (false) · `web.lan.port` (7392) · `web.lan.certFile` / `web.lan.keyFile` (your own certificate)

**Preferences → Orchestration** lists every model Claude Code and Codex have reported. For each one it shows the capability tier Agent Wrangler assigns it (`basic < standard < expert < frontier`; `frontier` is reached only by escalation), whether it is enabled, how AW's effort levels map onto the model's own, what is known about it and where each fact came from, and how its cost is worked out. Unassigned models are listed first, and routing never picks one automatically. Your choices go into `settings.json` under `orchestration.models`; anything left at its default is not written.

## Troubleshooting

Relative paths below are in the app's support folder, `~/Library/Application Support/Agent Wrangler/`.

**Nothing opens, or the page will not load.** Check the core daemon:

```bash
aw daemon status
```

- `Core daemon: running` with a pid and build: the daemon is fine; see the next items.
- `not running (nothing is running the core)`: start it with `aw daemon start`, or open the
  app. A daemon you stopped stays stopped; launchd only restarts one that crashed.
- `not running (an older Agent Wrangler app is running it)`: an Electron-era copy (from before
  #142) still holds the core. Quit it (`osascript -e 'quit app "Agent Wrangler"'`, never
  *Quit and Stop All Agents*), then `aw daemon start`. `npm run app:install` does this for you.
- It starts and dies: read `logs/core-daemon.log` (the daemon's own output, including a crash)
  and `agent-wrangler.log`. `launchctl print gui/$(id -u)/com.hammonjj.agentwrangler.core`
  shows what launchd thinks: whether it is loaded, its pid, and the last exit code. The
  LaunchAgent itself is `~/Library/LaunchAgents/com.hammonjj.agentwrangler.core.plist`;
  `aw daemon start` rewrites it, so do not edit it by hand.
- `aw` itself is not found: run `npm run cli:install` again (it says which folder it used and
  whether that is on your `PATH`), and check that `/Applications/Agent Wrangler.app` exists.

**The port is in use.** Something else is listening on 7391 (or 7392 for the LAN). The daemon
logs `web: not serving on port 7391: …` in `agent-wrangler.log`; Preferences → Browser lists
each LAN address with `port in use`. Find the other program with `lsof -nP -iTCP:7391
-sTCP:LISTEN`, or change *Port* (`web.port`) or *HTTPS port* (`web.lan.port`). With no page to
reach Preferences from, stop the daemon, set the port in `settings.json`, and start it again.

**"Not signed in" (401).** The browser has no valid credential for this listener. On the Mac,
run `aw web open` (or open the app) for a fresh one-time link: a link works once, for two
minutes, and a browser stays signed in for 30 days from its last visit. A credential from
`127.0.0.1` does not work on the LAN address and the other way round, and a revoked device stays
out until it is paired again. The cookie belongs to the exact name the link used, so on the Mac
bookmark `http://127.0.0.1:7391/`, not `localhost`. A 421 means the page was reached under a
name the daemon does not answer to; on the LAN use `<your-mac>.local` or an address Preferences
lists.

**Certificate warnings on the phone.** Safari says the connection is not private, or the page
will not load at all:

- the CA profile is installed but not trusted: **Settings → General → About → Certificate Trust
  Settings**, turn on *Agent Wrangler Local CA*;
- the profile is from an older CA: deleting `web-tls/` makes a new one, which every device must
  trust again. Remove the old profile, and install the new one from
  `http://127.0.0.1:7391/ca.mobileconfig` on the Mac;
- the name does not match: open the address Preferences → Browser lists, or
  `https://<your-mac>.local:7392/`. The server certificate covers those names and is re-issued
  when an address changes;
- the phone is on another network (cellular, a guest Wi-Fi): it cannot reach the Mac at all.
  That is by design; use Discord away from home.

Never accept the warning and carry on: the device credential would then travel to whoever
answered.

**A lost or retired device.** Revoke it: Preferences → Browser → *Devices* → **Revoke** (press
twice), or `aw web devices` to list and `aw web devices revoke <id>`. Its open tabs disconnect at
once and it cannot sign in again until it is paired again. To lock every LAN device out at
once, turn *Allow devices on my home network* off.

**A Keychain prompt the first time a secret is used.** Secrets (the Discord token, local
endpoint keys) are read with `/usr/bin/security`. If macOS asks whether `security` may use the
*Agent Wrangler* item, the item was created or last changed by another program (Keychain Access,
for example); choose **Always Allow** and it will not ask again. If it never stops asking, or
the Keychain is locked, `agent-wrangler.log` says `cannot read … from the Keychain`; delete the
item in Keychain Access and store the secret again from Preferences.

**A browser tab opens at login.** The Electron app registered itself as a Login Item when *Open
at login* was on, and opening the app now opens a browser. Remove *Agent Wrangler* from
**System Settings → General → Login Items** (*Login Items & Extensions* on recent macOS), under
*Open at Login*. Starting at login is
now the LaunchAgent's job (*Open at login* in Preferences), which opens no browser. Electron's
caches (`Cache`, `Code Cache`, `GPUCache`, `Local Storage` and similar) may also be left in the
support folder; nothing reads them now.

**A fix did not take.** The daemon is probably still on the old build: `aw daemon status` shows
the build it runs. `npm run app:install` moves a running daemon onto the new one; a stopped one
stays stopped until you start it. An open tab reloads itself onto the new build when it
reconnects.

## Development

```bash
npm run watch             # esbuild watch
npm run typecheck         # tsc --noEmit
npm test                  # vitest: tail parser, status table, live ~/.claude smoke test
npm run test:integration  # session hosts and their lifecycle, end to end
npm run app:package       # release/Agent Wrangler.app, signed and verified
```

Source layout: `src/claude/*` (registry reader, incremental tail parser, transcript→block reducer, status derivation, hook event reducer + log tailer + settings installer, binary resolution, provider, and `runner/` — the Agent SDK session driver and its pure message reducer), `src/core/*` (provider-agnostic store), `src/daemon/*` (the core daemon), `src/launcher/*` (what opening the app runs), `src/ui/*` (pane hosts and click routing), `src/webview/*` (browser bundles). Webview code may only import from `src/shared/*` and `src/webview/common/*`.

The Agent SDK is bundled into `dist/daemon/main.js` and `dist/sessionHost/main.js`. It is ESM and calls `createRequire(import.meta.url)` at load, which is empty in a CJS bundle, so `esbuild.mjs` defines that expression as the bundle's own URL — without it the program throws at load.

## Conversation continuity

- Recently interrupted sessions carry a **was here** chip. Only the most recent session auto-resumes; open another and send or choose Resume here.
- **Load earlier messages** pages backward through the transcript; **Find in conversation** searches the archive and shows up to the latest 100 matching blocks. Clear restores the live view.
- Tool output can be expanded in full. Agent/Task cards offer **Load subagent work** after the parent transcript links the sidecar; live subagent messages nest under their parent.
- Type `/` for commands; Tab focuses the first completion. `/compact`, `/clear`, and `/context` were checked in streaming mode. Commands advertised by the CLI are also offered. `/clear` changes the session identity, just as in Claude Code.
- Cost is the cumulative **estimate for this runner invocation**, not lifetime billing. Context is the latest summary supplied by the CLI, refreshed after each turn when supported.
- `runner.confirmTakeoverOnSend` restores confirmation for all send-triggered takeovers. Estimated status always requires confirmation.
- The table and conversation share one page; row clicks stay in it. Deliberate terminal release remains available.
