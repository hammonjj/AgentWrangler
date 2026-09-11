/**
 * Typed message protocol between the extension host and the webviews.
 * Imported by both bundles — keep free of `vscode`/Node/DOM imports.
 */
import type { HookHealth, SessionDTO, SessionStatus, ViewerBlock } from './model';

// ---- Dashboard ----

/** `hooks` is absent until the host has checked settings.json once. */
export type HostToDashboard = { type: 'snapshot'; sessions: SessionDTO[]; nowMs: number; hooks?: HookHealth };

/** `allow` / `deny` answer the permission prompt a blocked row is sitting on. */
export type DashboardAction = 'viewer' | 'resume' | 'archive' | 'allow' | 'deny';

export type DashboardToHost =
  | { type: 'ready' }
  | { type: 'rowClick'; key: string }
  | { type: 'action'; key: string; action: DashboardAction }
  | { type: 'openExternal'; url: string }
  | { type: 'refresh' }
  /** Banner button: runs the same confirm-then-install flow as the palette command. */
  | { type: 'installHooks' };

// ---- Transcript viewer ----

export type HostToViewer =
  | { type: 'init'; session: SessionDTO; blocks: ViewerBlock[]; truncated: boolean }
  | { type: 'append'; blocks: ViewerBlock[] }
  | { type: 'status'; status: SessionStatus }
  | { type: 'title'; title: string };

export type ViewerToHost =
  | { type: 'ready' }
  | { type: 'resumeClicked' }
  | { type: 'openExternal'; url: string };
