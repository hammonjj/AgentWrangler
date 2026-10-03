/**
 * `WebFiles` (#139) over this app: which folders a remote browser may download
 * from, and which projects its folder browser offers first. Shared by
 * whatever hosts the web server (the window's main process today, the daemon
 * after #131) so the allowlist is written once.
 */
import * as path from 'node:path';
import { claudeHome, projectsDir } from '../claude/paths';
import { codexSessionsDir } from '../codex/paths';
import type { AccessGate } from '../core/access';
import { WebFiles } from '../core/web/files';
import type { AgentSession, ProjectDTO } from '../shared/model';

export interface WebFilesApp {
  store: { sessions: AgentSession[] };
  projects: { value: ProjectDTO[] };
  access: AccessGate;
}

/**
 * Download roots: the working directory of every known session, its worktree,
 * and the transcript directories. Nothing else on the host is reachable.
 */
export function downloadRootsFor(sessions: readonly AgentSession[]): string[] {
  const roots = new Set<string>([projectsDir(), codexSessionsDir()]);
  for (const s of sessions) {
    if (s.cwd) roots.add(s.cwd);
    if (s.worktreePath) roots.add(s.worktreePath);
    // A transcript outside the usual directory (a custom CLAUDE_CONFIG_DIR is already covered by projectsDir()).
    if (s.transcriptPath) roots.add(path.dirname(s.transcriptPath));
  }
  roots.delete(claudeHome());
  return [...roots];
}

export function createWebFiles(app: WebFilesApp, opts: { dataDir: string; log: (line: string) => void }): WebFiles {
  return new WebFiles({
    dataDir: opts.dataDir,
    gate: app.access,
    log: opts.log,
    downloadRoots: () => downloadRootsFor(app.store.sessions),
    projects: () => app.projects.value.map((p) => ({ name: p.name, dir: p.dir })),
  });
}
