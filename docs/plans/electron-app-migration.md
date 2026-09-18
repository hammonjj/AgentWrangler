# Electron app migration

Status: **in progress** on `feat/electron-app`, worktree `../AgentWrangler-electron`.

The analysis this executes is `docs/codex-and-electron.md` § "Electron seam". The prerequisite
— removing window jumping so the pane is the whole product — landed on `main` and is recorded
in `docs/plans/electron-prep-handoff.md`. Read both before changing anything here.

## Decisions taken

Three questions were put to James before starting; these are his answers, and the shape of
everything below follows from them.

1. **The extension keeps shipping.** The port is a refactor into a host adapter, not a
   rewrite: `src/` stays one codebase, `npm run install-local` keeps working the whole time,
   and the desktop app is a second front end on the same services. The alternative — rip the
   VSCode host out as soon as Electron runs — is faster but takes away the tool he uses all
   day while the app is still half built, with nothing to fall back to.
2. **The 56 `--vscode-*` variables get shimmed, not renamed.** One new stylesheet defines
   them in light and dark. The three pane stylesheets are not touched, so nothing regresses
   in the extension and the rename to an own token set stays available later.
3. **First milestone is a runnable dev app**, not a packaged one. `npm run electron` opens a
   window on the real session store. Packaging, signing and the genuinely-missing pieces
   (diff editor, terminal handoff, tray) come after something is on screen.

## The shape

The extension's `activate()` was 1008 lines, and roughly 800 of them are host-neutral: build
the store, the two providers, the runners, the preference services, the usage pollers, and
the `SessionActions` the panes call. Only the outer edge is VSCode — dialogs, settings,
`Memento`, commands, the webview panel.

So the split is a seam, not a fork:

```
src/host/hostServices.ts   the interface: log, config, state, dialogs, clipboard, shell, surface
src/app/createApp.ts       the composition root — everything above, built from a HostServices
src/host/vscode/*          HostServices over the vscode API
src/electron/*             HostServices over Electron, plus the BrowserWindow and its IPC
```

`src/extension.ts` shrinks to: build a `VscodeHost`, call `createApp`, register the 15
commands and the panel serializers against what it returns. `src/electron/main.ts` does the
same with an `ElectronHost` and a `BrowserWindow`.

Two things already anticipated this and do not change:

- `createWebviewBridge` (`src/shared/webviewBridge.ts`) already prefers a preload-injected
  `agentWranglerHost` over `acquireVsCodeApi`, and it is called in exactly one place
  (`src/webview/common/paneApi.ts`). The renderer needs a preload and nothing else.
- `PaneChannel` (`src/ui/paneChannel.ts`) is the host-side mirror of that, and both
  `DashboardHost` and `ConversationHost` take one instead of a `vscode.Webview`. An Electron
  implementation over `ipcMain`/`webContents` drops straight in. Its only `vscode` reference
  is the `Disposable` type, which is structural.

## Phases

### Phase 1 — the seam (no behaviour change) — **done**

`HostServices`, `createApp`, `VscodeHost`, and `extension.ts` rewritten onto them. Nothing
Electron. Typecheck, build and 53 files / 630 tests green; `extension.ts` went from 1008
lines to 180 and does nothing it did not do before.

### Phase 2 — the window — **done**

`src/electron/main.ts`, `preload.ts`, an `ElectronHost`, a `WorkbenchWindow` that owns one
`BrowserWindow` and two `PaneChannel`s over IPC, JSON-file storage, and the theme shim.
`npm run electron` opens it.

Verified against the real machine: the table lists this machine's sessions in their correct
sections with live status chips and tool activity, the usage cards fill, the conversation
pane restores onto a session and renders it *live* — streaming tool cards, history paging,
find bar, composer with its permission dropdown and the adopt notice — the divider drags, the
column folding responds to pane width, the menu works, and `flash` lands in the shell's
toast. Both panes log that they are talking to the host.

Three things the window needed that the tab did not:

- **A scheme of its own.** `file://` has an opaque origin, so `style-src 'self'` matches
  nothing and the CSP the panes are written against cannot be expressed. `aw://bundle` is a
  registered standard scheme serving `dist/webview`, and it is also what confines the window
  to that directory the way VSCode's `localResourceRoots` did.
- **`acquireVsCodeApi` referenced lazily.** `createWebviewBridge(acquireVsCodeApi)` evaluated
  the bare identifier, which is a `ReferenceError` outside VSCode — thrown before the bridge
  could prefer the preload's host. It is `() => acquireVsCodeApi()` now. This was the whole of
  "the window opens but is blank".
- **`ELECTRON_RUN_AS_NODE`.** VSCode sets it in its terminals, so `electron main.js` launched
  under plain Node and every Electron API was `undefined`. The dev scripts `env -u` it.

Left for later on this phase: the title bar is an ordinary one. `hiddenInset` would give the
panes the whole window, but the dashboard's header starts at y=0 and its project filter lands
under the traffic lights; reclaiming those 28px means the panes knowing they are in an app.

### Phase 2a — the window's own chrome — **done**

**The inset.** In VSCode the room around the panes is the editor's — a sidebar, a tab bar,
the gap a tab leaves at its edges. A window has none of that, so the same markup sat flush
against the frame and read as cramped. The shell supplies it: `renderWebviewHtml` takes a
`bodyClass`, Electron passes `aw-shell`, and the theme sheet pads the body and puts a rounded
hairline frame around `#wb`. It is in the shell's stylesheet rather than the panes' because it
is a fact about the window — the extension has to keep looking exactly as it does. The
selectors are `body.aw-shell …` rather than `body …` because `workbench.css` is concatenated
after and sets `padding: 0` and `height: 100vh`; this has to win on specificity, not order.

**Preferences (⌘,).** VSCode generates its settings UI from
`contributes.configuration`; the app has to draw its own, and a second hand-kept list of
twenty-two settings would drift on the first one added — silently, because the app would
simply not offer it. So the settings are declared once in `src/shared/settings.ts`,
`test/settingsSchema.test.ts` fails if that and `package.json` stop matching field for field,
and `src/webview/preferences/` renders the declaration. A new setting is now declared once
and appears in both front ends.

Two rules the window follows, both in `settingUpdate` in `src/shared/preferences.ts` so they
are testable without a window:

- **Only a declared key, only its declared type.** `pollIntervalSeconds` written as a string
  would read back as `NaN` and stop the poll with no error anywhere.
- **The default is stored by absence.** Setting a field back to its default removes the key
  rather than writing the value, and an unchanged field is not written at all — every text
  input commits on blur, so tabbing through would otherwise persist all twenty-two. Writing
  `600` because that is today's `stuckThresholdSeconds` default would pin the user to today's
  number if it were ever revised.

`openOnStartup` is the one setting the app hides: it has a single window and always opens it.
`SettingSpec.hosts` is how that is said, and the test asserts the list of hidden ones is
exactly that.

**The launcher bar.** The folder dropdown was `flex: 1 1 auto`, so it grew to fill whatever
was left — which in an editor pane is a sensible amount and in a full-screen window is one
dropdown stretched across two thousand pixels with every other control crushed against the
right edge. The folder button and *+ New* are wrapped in a `.launch` group now, capped at
`--aw-launch-w` (18rem, shared with the popup so the two cannot drift), and the bar's two
halves are held apart by that group's `margin-right: auto` rather than by one control growing.
It still shrinks first: at 300px the pair gives up space before the controls do.

### Phase 3 — the dialogs

The message boxes and the folder picker are done — `dialog.showMessageBox` and
`showOpenDialog` — and the fifteen commands are an application menu. **What is left is the
palette.** `HostDialogs.input` and `HostDialogs.pick` have no native Electron equivalent, so
today they decline out loud ("…needs VSCode for now") and return `undefined`, which every
caller already treats as cancelled. That costs three things in the app: renaming a
conversation, the session picker behind every menu item that needs to ask *which*, and the
folder list when *New Conversation* is invoked without one. A small renderer-side palette —
a filtered list and a text field, in a child window — covers all three.

Also here: `openInTab`. In VSCode it gives a conversation an editor tab of its own; here it
would be a second window, which is a product decision rather than a port. It currently shows
the session in the one window and says so.

### Phase 4 — packaging — **done for local use**

`npm run app:install` builds, packages and puts `Agent Wrangler.app` in `/Applications`.
Config is `electron-builder.yml`, kept out of `package.json` because that file is already the
VSCode manifest and two products' metadata in one document is how they get edited into each
other.

- **`extraMetadata.main`** is the line that matters. Electron reads `main` from `package.json`
  exactly as VSCode does, and there it points at the extension host bundle — the packaged app
  would load the extension and die on its first `require('vscode')`. This overrides it in the
  packaged copy only.
- **`identity: "-"`, not `identity: null`.** `null` means "skip signing", which leaves the
  bundle carrying the Electron binary's own linker signature and nothing sealing the contents;
  `codesign --verify` rejects that outright. It launches anyway today, but what an unsealed
  bundle cannot do is hold a microphone permission, because TCC keys those on a signature —
  so dictation would have broken. `-` is ad-hoc, which verifies.
- **No `node_modules`.** Everything is bundled by esbuild and `electron` comes from the
  runtime, so listing `files` at all is what keeps 300MB of modules out of a 297MB app.
- **The hook helpers were already safe.** `docs/codex-and-electron.md` flags them as an ASAR
  hazard, but `hookLogDir()` is `~/.claude/agentwrangler` — outside the bundle already, and
  the installed hook command is an absolute path into it. Nothing to move.

Still open here: notarization and a Developer ID (this is ad-hoc, for one machine); a
versioned preference migration; re-testing the Claude SDK bundle under a packaged app rather
than a dev run. And the ad-hoc signature changes on every rebuild, so macOS will re-prompt for
the microphone each time dictation is used after an install.

### Later, deliberately not now

- **The diff editor.** `commands.executeCommand('vscode.diff')` has no honest replacement
  short of bundling Monaco. Until then an edit opens as a unified diff in the pane.
- **Terminal handoff.** *Release* and the dictation `brew install` helper type into an
  integrated terminal. There is no `sendText`; this wants `node-pty` + xterm.js, or a
  shell-out to Terminal.app.
- **One backend per login.** The app and the extension can both be running, and runner
  ownership between them has no lease yet — the same gap the extension already has between
  two VSCode windows. Surviving app exit needs a daemon and is a later feature.
- **The status bar.** `MarkdownString` tooltip and `ThemeColor` background have no analogue;
  a tray item is the nearest thing.

## Rules for this branch

- The extension must stay green at every commit. `npm run typecheck && npm test` before each.
- `src/shared/**` still has no `vscode`, Node or DOM imports, and `src/webview/**` still
  imports only from `src/shared/**` and `src/webview/common/**`. The Electron main process is
  `src/electron/**` and is host-side code, like `src/ui/**`.
- The repo is public. No real project paths, session titles or transcript content.
- `npm run install-local` from this worktree installs *this* build over the one James uses.
  Say so when it happens, and never reload his window.

## Running it

```
npm run electron          # build, then open the window
npm run electron:nobuild  # open it against the current dist/
npm run app:install       # build, package, and put it in /Applications
```

The first two `env -u ELECTRON_RUN_AS_NODE` first: VSCode sets that variable in its terminals and it
makes the Electron binary behave as plain Node, so without it the app launches with every
Electron API `undefined` and dies on the first one. It reaches `open -a` too, so launching the
installed app *from a VSCode terminal* fails silently in the same way; from Finder or the Dock
it is fine.

State lives in `~/Library/Application Support/Agent Wrangler` — `settings.json` (what
`agentWrangler.*` was, and holding only what has been deliberately changed), `state.json`
(pins, nicknames, archive, columns, turn stats), `surface.json` (the runner registry),
`window.json` (which conversation was showing) and `agent-wrangler.log`, which is the output
channel's replacement and is where a renderer error turns up.

Adding a setting: put it in `src/shared/settings.ts` and in `package.json`'s
`contributes.configuration`. `npm test` tells you if the two disagree; nothing else has to
change, in either front end.

## State

- Worktree and branch created; `electron@44` and `electron-builder@26` installed. `npm install`
  replaced the `node_modules` symlink with a real tree, so this worktree no longer shares the
  primary checkout's modules and the primary checkout is untouched.
- App icons committed: `build/icon.icns`, `build/icon.png` (1024²) and `build/icons/*.png`
  from James's `agentwrangler.iconset`. Only `icon.png` is used so far — it is the window
  icon; the `.icns` is for phase 4.
- **`npm run install-local` has deliberately not been run from this worktree.** It would put
  this branch's build over the extension James uses all day, and while the refactor is
  behaviour-neutral and green, nothing has exercised it inside VSCode yet. Install from `main`
  unless he asks otherwise.
