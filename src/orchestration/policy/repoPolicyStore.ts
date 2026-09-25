/**
 * Loads per-repository policies from AW's side (`docs/plans/intelligent-orchestration.md`
 * §13.6, §34 decision 1): `<dataDir>/repos/<repo-id>.json`. Nothing is read
 * from or written into the repository itself.
 *
 * `repo-id` comes from the repository's git common directory, so the primary
 * checkout and every linked worktree resolve to one policy. It is found from
 * the files (`checkoutFor`), not a `git` subprocess.
 *
 * A file that fails validation is ignored whole and the defaults apply, with
 * the errors returned (and logged once per distinct file content) so the
 * Preferences page can show them. It is never half-applied.
 */
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import {
  type PolicyError,
  type RepoPolicy,
  type RepoPolicyFile,
  canonicalPolicy,
  parseRepoPolicy,
  resolveRepoPolicy,
  worktreeRootFor,
} from '../../shared/orchestration/repoPolicy';
import { checkoutFor } from '../../core/checkout';

export interface RepoIdentity {
  /** `<folder-name>-<12 hex of the common dir>`: readable, and unique per repository. */
  id: string;
  /** The primary checkout's folder name, which `<repo>` in `worktrees.root` expands to. */
  name: string;
  /** The primary checkout. */
  primaryRoot: string;
  /** The git common directory the id is derived from. */
  commonDir: string;
}

export interface LoadedRepoPolicy {
  repo: RepoIdentity;
  policy: RepoPolicy;
  /**
   * What an attempt records as the policy it ran under: `default` without a
   * usable file, else `v1-<12 hex of the effective policy>`. The same meaning
   * gives the same version however the file is formatted.
   */
  version: string;
  source: 'default' | 'file';
  file: string;
  /** Present when a file exists but was rejected; the defaults applied instead. */
  errors?: PolicyError[];
}

export interface PolicyFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  mkdirSync(dir: string, opts: { recursive: true }): unknown;
  realpathSync(file: string): string;
}

export function repoPoliciesDir(dataDir: string): string {
  return path.join(dataDir, 'repos');
}

/** The repository `folder` is in, or undefined outside git. */
export function repoIdentity(folder: string, fs: Pick<PolicyFs, 'realpathSync'> = nodeFs): RepoIdentity | undefined {
  const { repoRoot } = checkoutFor(folder);
  if (!repoRoot) return undefined;
  return identityFor(repoRoot, fs);
}

/** The identity of a primary checkout whose `.git` is a directory. */
export function identityFor(primaryRoot: string, fs: Pick<PolicyFs, 'realpathSync'> = nodeFs): RepoIdentity {
  const dotGit = path.join(primaryRoot, '.git');
  let commonDir: string;
  try {
    commonDir = fs.realpathSync(dotGit);
  } catch {
    commonDir = path.resolve(dotGit);
  }
  const name = path.basename(path.dirname(commonDir)) || 'repo';
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'repo';
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 12);
  return { id: `${slug}-${hash}`, name, primaryRoot: path.dirname(commonDir), commonDir };
}

export class RepoPolicyStore {
  private readonly fs: PolicyFs;
  private readonly log: (msg: string) => void;
  /** File content already reported as invalid, per repo, so a bad file is logged once, not on every load. */
  private readonly reported = new Map<string, string>();

  /** `dir` is `<dataDir>/repos`. */
  constructor(
    private readonly dir: string,
    opts: { fs?: PolicyFs; log?: (msg: string) => void } = {},
  ) {
    this.fs = opts.fs ?? nodeFs;
    this.log = opts.log ?? (() => undefined);
  }

  fileFor(repoId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(repoId) || repoId.startsWith('.')) throw new Error(`bad repo id ${JSON.stringify(repoId)}`);
    return path.join(this.dir, `${repoId}.json`);
  }

  /** The effective policy for the repository `folder` is in, or undefined outside git. */
  forFolder(folder: string): LoadedRepoPolicy | undefined {
    const repo = repoIdentity(folder, this.fs);
    return repo ? this.load(repo) : undefined;
  }

  /** Read on every call: the user may edit the file between attempts, and each attempt freezes what it read. */
  load(repo: RepoIdentity): LoadedRepoPolicy {
    const file = this.fileFor(repo.id);
    let text: string;
    try {
      text = this.fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.defaults(repo, file);
      return this.rejected(repo, file, String(e), [{ path: '', message: `cannot read the file: ${(e as Error).message}` }]);
    }
    const parsed = parseRepoPolicy(text);
    if (!parsed.ok) return this.rejected(repo, file, text, parsed.errors);
    const resolved = resolveRepoPolicy([parsed.file]);
    if (!resolved.ok) return this.rejected(repo, file, text, resolved.errors);
    this.reported.delete(repo.id);
    return { repo, policy: resolved.policy, version: versionOf(resolved.policy), source: 'file', file };
  }

  /**
   * Replace a repository's policy. Validated first: an invalid policy is
   * refused with its errors and the file on disk is left as it was.
   */
  save(repo: RepoIdentity, policy: RepoPolicyFile): { ok: true; loaded: LoadedRepoPolicy } | { ok: false; errors: PolicyError[] } {
    const text = `${JSON.stringify(policy, null, 2)}\n`;
    const parsed = parseRepoPolicy(text);
    if (!parsed.ok) return parsed;
    const resolved = resolveRepoPolicy([parsed.file]);
    if (!resolved.ok) return resolved;
    const file = this.fileFor(repo.id);
    this.fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    this.fs.writeFileSync(tmp, text, 'utf8');
    this.fs.renameSync(tmp, file);
    return { ok: true, loaded: this.load(repo) };
  }

  private defaults(repo: RepoIdentity, file: string): LoadedRepoPolicy {
    return { repo, policy: resolveDefaults(), version: 'default', source: 'default', file };
  }

  private rejected(repo: RepoIdentity, file: string, content: string, errors: PolicyError[]): LoadedRepoPolicy {
    if (this.reported.get(repo.id) !== content) {
      this.reported.set(repo.id, content);
      const first = errors.slice(0, 3).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
      const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
      this.log(`repo policy ${repo.id}: ignored, using defaults: ${first.join('; ')}${more}`);
    }
    return { ...this.defaults(repo, file), errors };
  }
}

function resolveDefaults(): RepoPolicy {
  const r = resolveRepoPolicy([]);
  if (!r.ok) throw new Error('the default repo policy is invalid'); // a bug, caught by the tests
  return r.policy;
}

export function versionOf(policy: RepoPolicy): string {
  return `v1-${createHash('sha256').update(canonicalPolicy(policy)).digest('hex').slice(0, 12)}`;
}

/** The absolute worktree root for a repository under its policy. */
export function worktreeRootPath(loaded: Pick<LoadedRepoPolicy, 'repo' | 'policy'>): string {
  return path.resolve(loaded.repo.primaryRoot, worktreeRootFor(loaded.policy, loaded.repo.name));
}
