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

### Phase 4 — packaging

`electron-builder`, `build/icon.icns`, a double-clickable `.app`. Then the hazards listed in
`docs/codex-and-electron.md` § "Packaging hazards": binaries and hook helpers outside ASAR,
hook helpers in stable user data, a versioned preference migration, and re-testing the Claude
SDK's ESM/CJS bundle under Electron.

One thing to settle first: `package.json`'s `main` is `./dist/extension.js`, which is what
VSCode loads, and Electron reads the same field. The dev scripts sidestep it by passing the
entry explicitly (`electron dist/electron/main.js`); a packaged app needs its own
`package.json` in the app directory rather than this one.

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
```

Both `env -u ELECTRON_RUN_AS_NODE` first: VSCode sets that variable in its terminals and it
makes the Electron binary behave as plain Node, so without it the app launches with every
Electron API `undefined` and dies on the first one.

State lives in `~/Library/Application Support/Agent Wrangler` — `settings.json` (what
`agentWrangler.*` was), `state.json` (pins, nicknames, archive, columns, turn stats),
`surface.json` (the runner registry), `window.json` (which conversation was showing) and
`agent-wrangler.log`, which is the output channel's replacement and is where a renderer error
turns up.

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
