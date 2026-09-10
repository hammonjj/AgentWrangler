/**
 * Shared data model. This file is imported by BOTH the extension host and the
 * webview bundles — it must stay free of `vscode`, Node, and DOM imports.
 */

export type SessionStatus = 'waiting' | 'busy' | 'stuck' | 'ended';

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker';

export interface PrLink {
  prNumber: number;
  prUrl: string;
  prRepository?: string;
}

export interface AgentSession {
  /** Provider id, e.g. 'claude'. */
  provider: string;
  sessionId: string;
  /** Globally unique key: `${provider}:${sessionId}`. */
  key: string;
  /** Friendly handle from the live registry (e.g. "my-app-backend-cf"). Live sessions only. */
  name?: string;
  /** Best-effort human title (ai-title → registry name → slug → first prompt → id prefix). */
  title: string;
  /** Last prompt preview (~200 chars). */
  subtitle?: string;
  cwd?: string;
  projectName?: string;
  gitBranch?: string;
  status: SessionStatus;
  /** ms epoch of last observed activity (transcript mtime, else registry startedAt). */
  lastActivityAt: number;
  startedAt?: number;
  kind?: SessionKind;
  entrypoint?: string;
  transcriptPath?: string;
  pid?: number;
  prLink?: PrLink;
  /** User shoved this session out of the way (host decorates from ArchiveService). */
  archived?: boolean;
  /** Session cwd is inside this window's workspace → click opens it in the Claude panel (host decorates). */
  inWorkspace?: boolean;
}

/** DTO sent over the webview wire — AgentSession is already JSON-safe. */
export type SessionDTO = AgentSession;

export const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  stuck: 1,
  busy: 2,
  ended: 3,
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: 'Waiting on you',
  stuck: 'Possibly stuck',
  busy: 'Busy',
  ended: 'Ended',
};

/** Waiting first, then stuck, busy, ended; within a rank, most recent activity first. */
export function compareSessions(a: AgentSession, b: AgentSession): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return b.lastActivityAt - a.lastActivityAt;
}

/** Dashboard sections: the four statuses, plus Archived pinned last. */
export type SectionId = SessionStatus | 'archived';

export const SECTION_ORDER: SectionId[] = ['waiting', 'stuck', 'busy', 'ended', 'archived'];

export const SECTION_LABEL: Record<SectionId, string> = {
  ...STATUS_LABEL,
  archived: 'Archived',
};

export function sectionOf(s: AgentSession): SectionId {
  return s.archived ? 'archived' : s.status;
}

/** One rendered block of a transcript in the viewer. */
export type ViewerBlock =
  | { kind: 'user'; text: string; ts?: string }
  | { kind: 'assistant'; text: string; ts?: string; msgId?: string }
  | { kind: 'tool'; name: string; inputPreview: string; ts?: string };

export function formatAge(nowMs: number, thenMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
