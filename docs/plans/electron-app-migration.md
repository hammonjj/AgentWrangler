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

### Phase 1 — the seam (no behaviour change)

`HostServices`, `createApp`, `VscodeHost`, and `extension.ts` rewritten onto them. Nothing
Electron yet. Test of done: typecheck, tests and `npm run install-local` all green, and the
extension behaves identically after a reload.

### Phase 2 — the window

`src/electron/main.ts`, `preload.ts`, an `ElectronHost`, a `WorkbenchWindow` that owns one
`BrowserWindow` and two `PaneChannel`s over IPC, a JSON-file `MementoLike`, and the theme
shim. `npm run electron` opens a window showing live sessions and lets you talk to one.

Test of done: the table lists this machine's real sessions with correct status, clicking a
row fills the conversation half, and a message sent from the composer reaches a session.

### Phase 3 — the dialogs

The roughly twenty `showInformationMessage`/`showWarningMessage`/`showErrorMessage` sites
(several modal, with `detail` and custom buttons) become Electron `dialog.showMessageBox`.
The two quick picks, the input box and the folder picker become real UI: `showOpenDialog`
covers the folder, the other three need a renderer-side palette. The 15 commands become an
application menu with the same ids.

### Phase 4 — packaging

`electron-builder`, `build/icon.icns`, a double-clickable `.app`. Then the hazards listed in
`docs/codex-and-electron.md` § "Packaging hazards": binaries and hook helpers outside ASAR,
hook helpers in stable user data, a versioned preference migration, and re-testing the Claude
SDK's ESM/CJS bundle under Electron.

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

## State

- Worktree and branch created; `electron@44` and `electron-builder@26` installed. `npm install`
  replaced the `node_modules` symlink with a real tree, so this worktree no longer shares the
  primary checkout's modules and the primary checkout is untouched.
- App icons committed: `build/icon.icns`, `build/icon.png` (1024²) and `build/icons/*.png`
  from James's `agentwrangler.iconset`.
