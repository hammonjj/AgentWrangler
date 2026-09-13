import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectDTO } from '../shared/model';
import { claudeHome, isSessionJsonlName, projectsDir, slugForCwd } from './paths';

/**
 * Every folder Claude Code has been used in, newest first — the list behind the
 * dashboard's project dropdown.
 *
 * The names come from `~/.claude.json`, whose `projects` map is keyed by the
 * real absolute path. The sibling `~/.claude/projects/` directory is
 * deliberately NOT the source: its directory names are slugs, and `slugForCwd`
 * is lossy in exactly the direction that would be needed to read them back (a
 * `-` in a folder name is indistinguishable from a path separator). Going
 * *forward* through the same slug is exact, so that is how a path finds its own
 * transcripts, and through their mtimes, when it was last used.
 */

/**
 * `~/.claude.json` — Claude Code's own config, which sits *beside* `~/.claude`
 * rather than inside it. Derived from `claudeHome()` so a `CLAUDE_CONFIG_DIR`
 * test fixture stays self-consistent; if that ever stops matching the real
 * layout the cost is an empty history list, not a wrong one, because the
 * workspace and live-session folders are gathered separately.
 */
export function configFile(): string {
  return `${claudeHome()}.json`;
}

export interface ProjectCandidate {
  dir: string;
  lastUsedAt?: number;
}

/**
 * Trailing separators and `.` segments make the same folder look like two
 * entries in a Map, and the dropdown would then show it twice.
 */
function normalizeDir(dir: unknown): string | undefined {
  if (typeof dir !== 'string' || dir.length === 0) return undefined;
  if (!path.isAbsolute(dir)) return undefined;
  const norm = path.normalize(dir);
  // `path.normalize` keeps a trailing separator; the root is the one place it means something.
  const trimmed = norm.length > 1 ? norm.replace(/[\\/]+$/, '') : norm;
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Dedupe by path and sort newest-used first, with never-used folders last in
 * name order. Pure — every caller does its own IO and hands the results in,
 * which is what makes the ordering testable without a `~/.claude`.
 */
export function rankProjects(candidates: ProjectCandidate[]): ProjectDTO[] {
  const byDir = new Map<string, { dir: string; lastUsedAt?: number }>();
  for (const c of candidates) {
    const dir = normalizeDir(c.dir);
    if (!dir) continue;
    const prev = byDir.get(dir);
    // One folder can arrive from the config, the workspace and a live session
    // at once. Keep the most recent timestamp any of them knows about.
    if (!prev) byDir.set(dir, { dir, lastUsedAt: c.lastUsedAt });
    else if ((c.lastUsedAt ?? 0) > (prev.lastUsedAt ?? 0)) prev.lastUsedAt = c.lastUsedAt;
  }

  return [...byDir.values()]
    .map((c) => ({ dir: c.dir, name: path.basename(c.dir) || c.dir, lastUsedAt: c.lastUsedAt }))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
}

/** The `projects` keys of `~/.claude.json`. A missing or unreadable file is not an error: no list, no dropdown entries. */
export async function readConfigProjectDirs(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  const projects = (obj as { projects?: unknown })?.projects;
  if (typeof projects !== 'object' || projects === null) return [];
  return Object.keys(projects as Record<string, unknown>).filter((k) => normalizeDir(k) !== undefined);
}

/**
 * When each folder was last active, by the newest transcript it owns. Folders
 * with no transcript directory yet (used once, never prompted) simply get no
 * timestamp and sort to the bottom rather than disappearing.
 */
export async function lastUsedByDir(dirs: string[], root = projectsDir()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    dirs.map(async (dir) => {
      const slugDir = path.join(root, slugForCwd(dir));
      let names: string[];
      try {
        names = await fs.readdir(slugDir);
      } catch {
        return;
      }
      let newest = 0;
      await Promise.all(
        names.map(async (name) => {
          if (!isSessionJsonlName(name)) return;
          try {
            const st = await fs.stat(path.join(slugDir, name));
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          } catch {
            /* raced a delete — the other files still count */
          }
        }),
      );
      if (newest > 0) out.set(dir, newest);
    }),
  );
  return out;
}

/** Folders that are gone are not offerable: spawning into one fails, so they never reach the dropdown. */
async function existingDirs(dirs: string[]): Promise<string[]> {
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return (await fs.stat(dir)).isDirectory() ? dir : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((d): d is string => d !== undefined);
}

/** What a caller contributes on top of Claude Code's own history — workspace folders and live session cwds. */
export interface ExtraProjects {
  /** Always offered, even when Claude Code has never run there. */
  workspaceFolders: string[];
  /** `cwd` + `lastActivityAt` of sessions the store knows, which beat a file mtime for recency. */
  sessions: ProjectCandidate[];
}

/**
 * Read the whole list once. The scan is a `readdir` plus a `stat` per transcript
 * across every project, so it is cheap but not free — `ProjectsService` is what
 * keeps the dashboard from repeating it on every snapshot.
 */
export async function readProjects(
  extra: ExtraProjects,
  opts: { file?: string; root?: string } = {},
): Promise<ProjectDTO[]> {
  const fromConfig = await readConfigProjectDirs(opts.file ?? configFile());
  const known = await existingDirs([...new Set([...fromConfig, ...extra.workspaceFolders])]);
  const lastUsed = await lastUsedByDir(known, opts.root ?? projectsDir());
  return rankProjects([
    ...known.map((dir) => ({ dir, lastUsedAt: lastUsed.get(dir) })),
    // Session cwds are not filtered by existence: the store only lists folders a
    // session is actually running in, so the path is live by definition.
    ...extra.sessions,
  ]);
}

/**
 * The list, cached. Claude Code appends to `~/.claude.json` the first time a
 * folder is used, so re-reading is the whole of "detecting new projects" — but
 * a dashboard snapshot fires on every store update, which is far too often for
 * a filesystem scan. A short TTL keeps the two apart, and `refresh` is there for
 * the moments a user expects the list to be current (opening the dropdown).
 */
export class ProjectsService {
  private cache: ProjectDTO[] = [];
  private readAt = 0;
  private inFlight: Promise<ProjectDTO[]> | undefined;
  /**
   * Folders browsed to in this window. A folder Claude Code has never run in is
   * in no config file, so a re-scan alone would drop it the moment it was
   * chosen. It stops needing this the first time a conversation runs there,
   * because Claude Code writes it into `~/.claude.json` itself.
   */
  private browsed = new Set<string>();

  constructor(
    private extra: () => ExtraProjects,
    private ttlMs = 30_000,
    /** Overridden only by tests, which must never read the real `~/.claude`. */
    private paths: { file?: string; root?: string } = {},
  ) {}

  /** Last known list. Empty until the first `refresh` resolves. */
  get value(): ProjectDTO[] {
    return this.cache;
  }

  /** Offer this folder from now on, whatever the config says. */
  add(dir: string): void {
    this.browsed.add(dir);
  }

  /** Re-read unless the cache is younger than the TTL. `force` ignores it. */
  async refresh(opts: { force?: boolean } = {}): Promise<ProjectDTO[]> {
    if (!opts.force && Date.now() - this.readAt < this.ttlMs) return this.cache;
    // `??=` short-circuits, so concurrent callers (two dashboards, or a snapshot
    // racing a dropdown) join the scan already running instead of starting one —
    // and `scan` is a method rather than an expression so that gathering the
    // workspace and session folders is part of what they skip.
    this.inFlight ??= this.scan();
    return this.inFlight;
  }

  private scan(): Promise<ProjectDTO[]> {
    const extra = this.extra();
    return readProjects({ ...extra, workspaceFolders: [...extra.workspaceFolders, ...this.browsed] }, this.paths)
      .then((list) => {
        this.cache = list;
        this.readAt = Date.now();
        return list;
      })
      .catch(() => this.cache)
      .finally(() => {
        this.inFlight = undefined;
      });
  }
}
