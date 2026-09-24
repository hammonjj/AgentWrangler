/**
 * The menu-bar item (playbook Stage 6, §5.5).
 *
 * Closing the window leaves Agent Wrangler running — the agents it runs, the
 * status watching, Discord — and with the Dock icon hidden this is the only
 * sign of it. So it says what is going on (a count of agents that need you
 * beside the icon, the rest in the menu), lists every live agent with Open
 * and Stop, and has the two quits the application menu has.
 *
 * What it says is `src/core/menuBar.ts`; this only draws it.
 */

import { Menu, type MenuItemConstructorOptions, nativeImage, type NativeImage, Tray } from 'electron';
import type { AgentWranglerApp } from '../app/createApp';
import type { Disposable } from '../core/events';
import { menuBarAgents, menuBarBadge, menuBarCounts, menuBarSummary, type MenuBarSession } from '../core/menuBar';
import type { WorkbenchSurface } from '../host/hostServices';
import { displayTitle } from '../shared/model';

export interface MenuBarOptions {
  app: AgentWranglerApp;
  surface: WorkbenchSurface;
  openPreferences(): void;
  quit(): void;
  quitAndStopAll(): void;
}

/** The store's sessions as the menu bar reads them. Shared with the power-blocker in `main.ts`. */
export function menuBarSessions(app: AgentWranglerApp): MenuBarSession[] {
  return app.store.sessions.map((s) => ({
    key: s.key,
    status: s.status,
    title: displayTitle(s),
    projectName: s.projectName,
    archived: app.archive.isArchived(s.key),
    owned: app.runners.owns(s.sessionId) || app.codexRunners.owns(s.sessionId),
    pid: s.pid,
    blockedReason: s.blockedReason,
  }));
}

/**
 * A template glyph, drawn rather than shipped: a ring with a dot, 16pt, in
 * black with alpha so macOS tints it for the light and dark menu bar. Drawn at
 * 2x with 4x4 supersampling for the edges.
 */
function trayIcon(): NativeImage {
  const size = 32;
  const scale = size / 16;
  const samples = 4;
  const buf = Buffer.alloc(size * size * 4);
  const inside = (u: number, v: number) => {
    const d = Math.hypot(u - 8, v - 8);
    return (d <= 7 && d >= 5) || d <= 2.25;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (inside((x + (sx + 0.5) / samples) / scale, (y + (sy + 0.5) / samples) / scale)) hits++;
        }
      }
      // BGRA; black, so premultiplied or not is the same bytes.
      buf[(y * size + x) * 4 + 3] = Math.round((255 * hits) / (samples * samples));
    }
  }
  const image = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

export class MenuBar implements Disposable {
  private readonly tray: Tray;
  private readonly subs: Disposable[] = [];
  private pending?: ReturnType<typeof setTimeout>;
  private lastRenderedAt = 0;

  constructor(private readonly opts: MenuBarOptions) {
    this.tray = new Tray(trayIcon());
    this.render();
    this.subs.push(opts.app.store.onDidUpdate(() => this.schedule()));
    // Archiving a row changes what is counted without changing the store.
    this.subs.push(opts.app.archive.onDidChange(() => this.schedule()));
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    for (const s of this.subs) s.dispose();
    this.tray.destroy();
  }

  /** At most once a second: the store updates on every hook event, and a menu is not a live view. */
  private schedule(): void {
    if (this.pending) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.lastRenderedAt));
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.render();
    }, wait);
  }

  private render(): void {
    this.lastRenderedAt = Date.now();
    const { app, surface } = this.opts;
    const sessions = menuBarSessions(app);
    const counts = menuBarCounts(sessions);
    const summary = menuBarSummary(counts);
    this.tray.setTitle(menuBarBadge(counts), { fontType: 'monospacedDigit' });
    this.tray.setToolTip(`Agent Wrangler — ${summary}`);

    const { agents, more } = menuBarAgents(sessions);
    const agentItems: MenuItemConstructorOptions[] = agents.map((a) => ({
      label: a.label,
      sublabel: a.detail,
      submenu: [
        { label: 'Open', click: () => surface.show(a.key, { preserveFocus: false }) },
        // `closeSession` asks first, and says what stopping costs.
        { label: 'Stop…', enabled: a.stoppable, click: () => app.actions.closeSession(a.key) },
      ],
    }));
    if (more > 0) agentItems.push({ label: `${more} more — open the window to see them`, enabled: false });

    const template: MenuItemConstructorOptions[] = [
      { label: summary, enabled: false },
      { type: 'separator' },
      ...agentItems,
      ...(agentItems.length ? [{ type: 'separator' } as const] : []),
      { label: 'Open Agent Wrangler', click: () => surface.open() },
      { label: 'Settings…', click: this.opts.openPreferences },
      { type: 'separator' },
      { label: 'Quit Agent Wrangler', click: this.opts.quit },
      { label: 'Quit and Stop All Agents', click: this.opts.quitAndStopAll },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
