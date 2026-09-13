import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Files to offer after an `@` in the composer.
 *
 * The plan called for the SDK's `file_suggestions` control request, which would
 * have returned exactly what the TUI shows. That request exists in the wire
 * protocol but `Query` does not expose it in v0.3.268, so the list is built
 * here instead. `git ls-files` is the good case — it is fast, and it already
 * honours `.gitignore`, so `node_modules` never appears without a rule having
 * to be invented for it. A folder that is not a repository falls back to a
 * bounded walk.
 */

/** Never offer more than this; the popup is a shortlist, not a file tree. */
export const SUGGEST_LIMIT = 12;
/** Ceiling on the fallback walk, so a home directory cannot hang the pane. */
const MAX_WALK_FILES = 20_000;
/** Directories never worth walking into when there is no `.gitignore` to say so. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'target', 'vendor', '__pycache__', '.venv']);

/**
 * Score `file` against `query`, or `undefined` when it does not match.
 *
 * Lower is better. Matching is subsequence-based, like every editor's file
 * picker: the characters must appear in order but need not be adjacent, so
 * `cwh` finds `conversation/webview/host.ts`. Rank favours, in order: a match
 * in the basename over one in the directory, an earlier start, and a tighter
 * span — which is what makes an exact filename beat a path that merely
 * contains the same letters scattered through it.
 */
export function scorePath(file: string, query: string): number | undefined {
  if (query === '') return file.length; // no query: shortest paths first
  const hay = file.toLowerCase();
  const needle = query.toLowerCase();
  const base = path.basename(hay);

  // Scored against the basename first and *in basename coordinates*. Measuring
  // the offset from the start of the whole path instead would rank by how
  // shallow the directory is, so `test/dictation.test.ts` would beat
  // `src/core/dictation.ts` for "dictation" purely by having a shorter prefix.
  const inBase = matchSpan(base, needle);
  if (inBase) {
    const kind = base === needle ? -1000 : base.startsWith(needle) ? -500 : 0;
    // Length breaks the tie between two prefix matches, so the name closest to
    // what was typed wins: `dictation.ts` over `dictation.test.ts`.
    return kind + inBase.span * 2 + inBase.first + base.length / 100;
  }

  // Otherwise the match is spread across the directory part, which is a weaker
  // thing to have meant — always behind any basename match.
  const whole = matchSpan(hay, needle);
  return whole ? 1000 + whole.span * 2 + whole.first : undefined;
}

/** Leftmost subsequence match: where it starts and how far it stretches. */
function matchSpan(hay: string, needle: string): { first: number; span: number } | undefined {
  let first = -1;
  let last = -1;
  let qi = 0;
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) continue;
    if (first < 0) first = i;
    last = i;
    qi++;
  }
  return qi < needle.length ? undefined : { first, span: last - first };
}

/** Best `limit` matches, best first. Pure: the caller supplies the file list. */
export function rankPaths(files: string[], query: string, limit = SUGGEST_LIMIT): string[] {
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const score = scorePath(file, query);
    if (score !== undefined) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}

function gitLsFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // Tracked plus untracked-but-not-ignored: a file created this morning is
      // exactly the one being talked about, and it is not committed yet.
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout.split('\n').filter(Boolean)),
    );
  });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length > 0 && out.length < MAX_WALK_FILES) {
    const rel = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(child);
      } else if (e.isFile()) {
        out.push(child);
        if (out.length >= MAX_WALK_FILES) break;
      }
    }
  }
  return out;
}

/** Every candidate path in `cwd`, relative and posix-separated. */
export async function listFiles(cwd: string): Promise<string[]> {
  return (await gitLsFiles(cwd)) ?? (await walk(cwd)).map((f) => f.split(path.sep).join('/'));
}

/**
 * The file list for a folder, cached.
 *
 * Listing is one `git ls-files` — cheap, but not cheap enough to repeat on
 * every keystroke of an `@` mention. The TTL is short because the interesting
 * file is often one that was created a moment ago.
 */
export class FileSuggestService {
  private cache = new Map<string, { files: string[]; at: number }>();
  private inFlight = new Map<string, Promise<string[]>>();

  constructor(private ttlMs = 10_000) {}

  async suggest(cwd: string, query: string, limit = SUGGEST_LIMIT): Promise<string[]> {
    return rankPaths(await this.files(cwd), query, limit);
  }

  private files(cwd: string): Promise<string[]> {
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < this.ttlMs) return Promise.resolve(hit.files);
    const running = this.inFlight.get(cwd);
    if (running) return running;

    const job = listFiles(cwd)
      .then((files) => {
        this.cache.set(cwd, { files, at: Date.now() });
        return files;
      })
      .catch(() => hit?.files ?? [])
      .finally(() => this.inFlight.delete(cwd));
    this.inFlight.set(cwd, job);
    return job;
  }
}
