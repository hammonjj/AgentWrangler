/**
 * The glob matching orchestration policy does: repo-policy risk paths and
 * exclusive resources against a task's scope (§8.2, §13.5, §13.6).
 *
 * Small on purpose, and with no dependency. It covers what a policy file is
 * allowed to write — `*`, `**` and `?` over `/`-separated, repository-relative
 * paths — and two conveniences a person expects:
 *
 * - **A pattern with no wildcard also matches everything under it.**
 *   `src/remote` covers `src/remote/discord/bot.ts`, because that is what a
 *   user who typed a directory meant.
 * - **Globs can be compared to globs.** A task's scope is itself globs, so
 *   before any file exists to match, `globsOverlap` asks whether two patterns
 *   could ever name the same path. It answers conservatively: a maybe is a
 *   yes, because in the deterministic pass a missed risk path is the expensive
 *   mistake (§9.2).
 */

/** `*`, `?` or `**`. A pattern without one is a literal path or a directory. */
const WILDCARD = /[*?]/;

function normal(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function quote(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/** A glob as an anchored regular expression. `**` crosses `/`; `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  const g = normal(glob);
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        // `**/x` matches `x` as well as `a/b/x`.
        out += '(?:.*/)?';
        i++;
      } else {
        out += '.*';
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += quote(c);
    }
  }
  return new RegExp(`^${out}$`);
}

/** Does `file` (repository-relative) match `glob`? A wildcard-free glob also matches what is under it. */
export function matchGlob(file: string, glob: string): boolean {
  const f = normal(file);
  const g = normal(glob);
  if (g === '') return false;
  if (!WILDCARD.test(g)) return f === g || f.startsWith(`${g}/`);
  return globToRegExp(g).test(f);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(file, g));
}

/** The part of a glob before its first wildcard, cut back to a whole path segment. */
export function literalPrefix(glob: string): string {
  const g = normal(glob);
  const at = g.search(WILDCARD);
  if (at < 0) return g;
  const head = g.slice(0, at);
  const slash = head.lastIndexOf('/');
  return slash < 0 ? '' : head.slice(0, slash);
}

/**
 * Could these two patterns ever name the same file? Used where no file list
 * exists yet, so it errs towards yes: two patterns whose literal prefixes are
 * nested (or one of which is `**`) are treated as overlapping, even though a
 * later wildcard might in fact keep them apart.
 */
export function globsOverlap(a: string, b: string): boolean {
  const x = normal(a);
  const y = normal(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  // One side literal: a straight match is exact, not a guess.
  if (!WILDCARD.test(x)) return matchGlob(x, y);
  if (!WILDCARD.test(y)) return matchGlob(y, x);
  const px = literalPrefix(x);
  const py = literalPrefix(y);
  if (px === '' || py === '') return true;
  return px === py || px.startsWith(`${py}/`) || py.startsWith(`${px}/`);
}

/** The globs in `globs` that could touch anything `scope` names. */
export function overlapping(globs: readonly string[], scope: readonly string[]): string[] {
  return globs.filter((g) => scope.some((s) => globsOverlap(g, s)));
}
