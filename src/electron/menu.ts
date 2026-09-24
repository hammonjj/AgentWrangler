/**
 * The application menu.
 *
 * VSCode's fifteen `agentWrangler.*` commands and the palette that runs them
 * have no equivalent here, so the menu is where they go. The ones that need to
 * ask *which session* are listed anyway rather than hidden: they call the same
 * `withSession` the commands do, which asks — and until the picker exists
 * (phase 3) that asking declines out loud, which is a better answer than a menu
 * item that is not there.
 */

import { Menu, type MenuItemConstructorOptions, app, shell } from 'electron';
import type { AgentWranglerApp } from '../app/createApp';
import type { WorkbenchSurface } from '../host/hostServices';

export function installApplicationMenu(
  wrangler: AgentWranglerApp,
  surface: WorkbenchSurface,
  openPreferences: () => void,
  /** The app's own quits, which is how a menu quit is told apart from every other kind. */
  quits: { quit: () => void; quitAndStopAll: () => void },
): void {
  const mac = process.platform === 'darwin';
  // Not `role: 'quit'`: that bypasses the click handler, and then a ⌘Q looks
  // exactly like a script's quit (spike S2). Same accelerator, our handler.
  const quitItem: MenuItemConstructorOptions = {
    label: mac ? `Quit ${app.name}` : 'Quit',
    accelerator: 'CmdOrCtrl+Q',
    click: quits.quit,
  };
  // With session hosts, ⌘Q leaves hosted agents running; this is the way to
  // stop them as well. Without hosts it is the same as Quit, minus the question.
  const quitAndStopItem: MenuItemConstructorOptions = {
    label: 'Quit and Stop All Agents',
    accelerator: 'Alt+CmdOrCtrl+Q',
    click: quits.quitAndStopAll,
  };

  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            // ⌘, where macOS puts it. This window renders `src/shared/settings.ts`.
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openPreferences },
            { type: 'separator' },
            { label: 'Install Status Hooks…', click: () => void wrangler.installHooks() },
            { label: 'Remove Status Hooks', click: () => void wrangler.uninstallHooks() },
            { type: 'separator' },
            // Experimental. The token goes to the keychain, so it cannot be a
            // setting and needs somewhere of its own to be typed.
            { label: 'Connect Discord…', click: () => void wrangler.connectDiscord() },
            { label: 'Disconnect Discord', click: () => void wrangler.disconnectDiscord() },
            { label: 'Test Remote Control…', click: () => void wrangler.testRemoteControl() },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            quitItem,
            quitAndStopItem,
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        {
          label: 'New Conversation…',
          accelerator: 'CmdOrCtrl+N',
          click: () => void wrangler.newConversation(),
        },
        { type: 'separator' },
        ...(mac
          ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
          : ([
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openPreferences },
              { type: 'separator' },
              { label: 'Install Status Hooks…', click: () => void wrangler.installHooks() },
              { label: 'Remove Status Hooks', click: () => void wrangler.uninstallHooks() },
              { type: 'separator' },
              { label: 'Connect Discord…', click: () => void wrangler.connectDiscord() },
              { label: 'Disconnect Discord', click: () => void wrangler.disconnectDiscord() },
              { label: 'Test Remote Control…', click: () => void wrangler.testRemoteControl() },
              { type: 'separator' },
              quitItem,
              quitAndStopItem,
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Agents',
      submenu: [
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => wrangler.refresh() },
        { type: 'separator' },
        {
          label: 'Open Conversation…',
          click: () => void wrangler.withSession((k) => wrangler.actions.smartOpen(k))(),
        },
        {
          label: 'Rename a Conversation…',
          click: () => void wrangler.withSession((k) => wrangler.actions.rename(k))(),
        },
        {
          label: 'Copy Session ID…',
          click: () => void wrangler.withSession((k) => wrangler.actions.copyId(k))(),
        },
        {
          label: 'Reveal Transcript in Finder…',
          click: () =>
            void wrangler.withSession(
              (k) => wrangler.actions.reveal(k),
              (s) => s.transcriptPath !== undefined,
            )(),
        },
        { type: 'separator' },
        // The token-emergency pair. Deliberately not behind a confirmation:
        // see the header of `setPausedAll` in createApp.
        { label: 'Pause All Agents', click: () => wrangler.pauseAll(true) },
        { label: 'Resume All Paused Agents', click: () => wrangler.pauseAll(false) },
        { type: 'separator' },
        // Codex threads outlive the app in a background server; this is how
        // a Codex update reaches it while something is running (Stage 5).
        { label: 'Restart Codex Server…', click: () => void wrangler.restartCodexServer() },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Agent Wrangler', accelerator: 'CmdOrCtrl+0', click: () => surface.open() },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(mac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Agent Wrangler on GitHub',
          click: () => void shell.openExternal('https://github.com/hammonjj/AgentWrangler'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
