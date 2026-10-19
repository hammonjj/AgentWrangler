/**
 * `WebFiles` (#139) over this app: which folders a remote browser may download
 * from, and which projects its folder browser offers first. Shared by
 * whatever hosts the web server (the window's main process today, the daemon
 * after #131) so the allowlist is written once.
 */
import { appPathRoots } from '../core/web/fileView';
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
 * Download roots: what the app itself works in (`appPathRoots`, shared with the
 * file viewer, #140) and the transcript directories. Nothing else on the host
 * is reachable.
 */
export function downloadRootsFor(sessions: () => readonly AgentSession[], dataDir: string): () => string[] {
  const app = appPathRoots(sessions, dataDir);
  return () => {
    const roots = new Set<string>([...app(), projectsDir(), codexSessionsDir()]);
    roots.delete(claudeHome());
    return [...roots];
  };
}

export function createWebFiles(app: WebFilesApp, opts: { dataDir: string; log: (line: string) => void }): WebFiles {
  return new WebFiles({
    dataDir: opts.dataDir,
    gate: app.access,
    log: opts.log,
    downloadRoots: downloadRootsFor(() => app.store.sessions, opts.dataDir),
    projects: () => app.projects.value.map((p) => ({ name: p.name, dir: p.dir })),
  });
}
