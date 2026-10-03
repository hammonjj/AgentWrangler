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
import { runInRequest } from '../core/requestScope';
import { guardSessionActions } from '../ui/guardedActions';
import { WINDOW_CONTEXT } from './workbenchWindow';

export function installApplicationMenu(
  wrangler: AgentWranglerApp,
  surface: WorkbenchSurface,
  openPreferences: () => void,
  /** The app's own quits, which is how a menu quit is told apart from every other kind. */
  quits: { quit: () => void; quitAndStopAll: () => void },
): void {
  const mac = process.platform === 'darwin';
  // Session actions pass the access gate like a pane's click does (#123): the
  // window's own chrome is the owner at this Mac, via 'browser', as the window client (#126).
  const context = WINDOW_CONTEXT;
  const actions = guardSessionActions(wrangler.actions, { context, gate: wrangler.access });
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
          click: () => void wrangler.withSession((k) => actions.smartOpen(k))(),
        },
        {
          label: 'Rename a Conversation…',
          click: () => void wrangler.withSession((k) => actions.rename(k))(),
        },
        {
          label: 'Copy Session ID…',
          click: () => void wrangler.withSession((k) => actions.copyId(k))(),
        },
        {
          label: 'Reveal Transcript in Finder…',
          click: () =>
            void wrangler.withSession(
              (k) => actions.reveal(k),
              (s) => s.transcriptPath !== undefined,
            )(),
        },
        { type: 'separator' },
        // The token-emergency pair. Pausing asks first, like the toolbar
        // button; resuming does not. See `requestPauseAll` in createApp.
        { label: 'Pause All Agents', click: () => actions.pauseAll(true) },
        { label: 'Resume All Paused Agents', click: () => actions.pauseAll(false) },
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(asWindowClient(template)));
}

/**
 * Every click in `items` run as the window client (#126). The menu and the
 * menu-bar item are this Mac's chrome, so the pickers and confirmations their
 * items open appear here, never in a browser and never cancelled for want of
 * a client. Recurses into submenus.
 */
export function asWindowClient(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const { click, submenu } = item;
    return {
      ...item,
      ...(click ? { click: (...args: Parameters<typeof click>) => runInRequest(WINDOW_CONTEXT, () => click(...args)) } : {}),
      ...(Array.isArray(submenu) ? { submenu: asWindowClient(submenu) } : {}),
    };
  });
}
