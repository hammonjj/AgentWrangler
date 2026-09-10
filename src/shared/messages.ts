/**
 * Typed message protocol between the extension host and the webviews.
 * Imported by both bundles — keep free of `vscode`/Node/DOM imports.
 */
import type { SessionDTO, SessionStatus, ViewerBlock } from './model';

// ---- Dashboard ----

export type HostToDashboard = { type: 'snapshot'; sessions: SessionDTO[]; nowMs: number };

export type DashboardAction = 'viewer' | 'resume' | 'archive';

export type DashboardToHost =
  | { type: 'ready' }
  | { type: 'rowClick'; key: string }
  | { type: 'action'; key: string; action: DashboardAction }
  | { type: 'openExternal'; url: string }
  | { type: 'refresh' };

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
