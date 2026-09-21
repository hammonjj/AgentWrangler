import * as os from 'node:os';
import * as path from 'node:path';

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function sessionsDir(): string {
  return path.join(claudeHome(), 'sessions');
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

/**
 * Where a "Global" conversation runs: a scratch folder of our own, not the home
 * directory and not a project.
 *
 * A session has to have *some* working directory — Claude Code writes its
 * transcript under a slug of it, and a shell there is what tools get. Running
 * one straight in `~` would put an agent's `ls` and its file writes in the
 * middle of everything the user owns, and would file the transcript under a
 * "project" that is the whole home directory. A dedicated empty folder gives
 * the session a harmless place to stand, and makes the table read `Global`.
 */
export function globalConversationDir(): string {
  return path.join(os.homedir(), '.agent-wrangler', 'Global');
}

const SESSION_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Top-level `<uuid>.jsonl` transcript names. Excludes sidecar dirs
 * (`<sessionId>/subagents/agent-*.jsonl`, `tool-results/`) and `memory/`. */
export function isSessionJsonlName(name: string): boolean {
  return SESSION_JSONL_RE.test(name);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * cwd → project-dir slug (the direction Claude Code itself computes; the
 * reverse is lossy and must never be attempted). Best-effort hint only —
 * session merging is keyed by sessionId, not by this path.
 */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}
