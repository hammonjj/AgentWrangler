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
