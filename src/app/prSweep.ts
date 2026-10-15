/**
 * The PR review sweep as the daemon runs it (#168, #169, #170).
 *
 * A sweep job works on the repository of its folder. Discovery asks `gh`
 * for open PRs where the user's review is requested (by name or through a
 * team; `review-requested:@me` covers both) and cross-checks review-request
 * notifications, which also say when a review was asked for again. Drafts
 * are listed and skipped.
 *
 * Each PR that is due gets one session in its own detached worktree beside
 * the folder (`<folder>.aw-review/pr-<n>`), using the job's settings and the
 * repository's own review process. Nothing is posted unless the job opted in
 * (#170): then the session leaves its review in a file under Agent
 * Wrangler's state, and once the session finishes the daemon posts it as a
 * PENDING review (no `event`), which only the user can submit. The agent
 * never approves or requests changes, and never posts itself.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeyValueStorage } from '../core/archive';
import { Emitter, type Disposable, type Listener } from '../core/events';
import { toolPath } from '../core/toolPath';
import type { HostNotice } from '../host/hostServices';
import {
  isDue,
  isRepoName,
  isSha,
  MAX_REVIEWS_PER_SWEEP,
  mergeCandidates,
  parsePrList,
  parseReviewFile,
  parseReviewNotifications,
  pendingReviewPayload,
  planSweep,
  reviewPrompt,
  sweepSummary,
  type LedgerEntry,
  type PrCandidate,
  type SweepItem,
} from '../shared/prSweep';
import { jobOrigin, type ScheduledJob } from '../shared/scheduledJobs';
import type { PrSweepRunner, StartJobSession } from './scheduledJobs';

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => Promise<string>;

export interface PrSweepDeps {
  storage: KeyValueStorage;
  exec?: Exec;
  /** Where opted-in review files are written (Agent Wrangler's state, never the repository). */
  reviewsDir: string;
  /** The job a finished review belongs to, read now (it may have been edited or deleted since). */
  job: (id: string) => ScheduledJob | undefined;
  /** May the daemon post a pending review for this job (`authorize`, audited). */
  mayPost: (jobId: string) => boolean;
  notify: (notice: HostNotice) => void;
  log: (line: string) => void;
  now?: () => number;
}

export interface SweepPreview {
  repo: string;
  items: SweepItem[];
}

export interface PrSweep extends PrSweepRunner {
  /** What a sweep would review now. Reviews nothing. Throws a reason. */
  preview(cwd: string): Promise<SweepPreview>;
  sessionDone(provider: string, sessionId: string): void;
  onDidChange(listener: Listener<void>): Disposable;
}

const STORAGE_KEY = 'agentWrangler.prSweepLedger';

export function createPrSweep(deps: PrSweepDeps): PrSweep {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const emitter = new Emitter<void>();

  const readLedger = (): Map<string, LedgerEntry> => {
    const raw = deps.storage.get<unknown>(STORAGE_KEY, []);
    const out = new Map<string, LedgerEntry>();
    if (Array.isArray(raw)) for (const e of raw) if (e && typeof (e as LedgerEntry).key === 'string') out.set((e as LedgerEntry).key, e as LedgerEntry);
    return out;
  };
  const writeEntry = (key: string, fn: (e: LedgerEntry) => LedgerEntry): void => {
    const ledger = readLedger();
    ledger.set(key, fn(ledger.get(key) ?? { key }));
    void deps.storage.update(STORAGE_KEY, [...ledger.values()]);
    emitter.fire();
  };

  const gh = (args: string[], cwd: string, input?: string) => exec('gh', args, { cwd, ...(input !== undefined ? { input } : {}) });
  const git = (args: string[], cwd: string) => exec('git', args, { cwd });

  async function discover(cwd: string): Promise<{ repo: string; candidates: PrCandidate[] }> {
    const repo = (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd)).trim();
    if (!isRepoName(repo)) throw new Error(`${cwd} is not a GitHub repository gh knows`);
    const login = (await gh(['api', 'user', '-q', '.login'], cwd)).trim();
    const fields = 'number,title,url,headRefOid,isDraft,author,reviewRequests';
    const search = parsePrList(JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--search', 'review-requested:@me', '--json', fields, '--limit', '100'], cwd)), login);
    // The search can miss a team-only request; a notification also dates a re-request.
    let notes: Array<{ number: number; requestedAt?: number }> = [];
    try {
      notes = parseReviewNotifications(JSON.parse(await gh(['api', 'notifications?all=false&participating=false&per_page=100'], cwd)), repo);
    } catch (error) {
      deps.log(`pr sweep: notifications not read (${(error as Error).message})`);
    }
    const extra: PrCandidate[] = [];
    for (const n of notes) {
      const known = search.find((c) => c.number === n.number);
      if (known) {
        extra.push({ ...known, ...(n.requestedAt !== undefined ? { requestedAt: n.requestedAt } : {}) });
        continue;
      }
      try {
        const one = JSON.parse(await gh(['pr', 'view', String(n.number), '--repo', repo, '--json', `${fields},state`], cwd)) as Record<string, unknown>;
        if (one.state !== 'OPEN') continue;
        const [c] = parsePrList([one], login);
        // Still requested of the user (by name or team)? A notification outlives the request.
        if (c && Array.isArray(one.reviewRequests) && one.reviewRequests.length > 0) extra.push({ ...c, ...(n.requestedAt !== undefined ? { requestedAt: n.requestedAt } : {}) });
      } catch {
        // A PR that cannot be read is not one to review.
      }
    }
    return { repo, candidates: mergeCandidates(search, extra) };
  }

  /** A detached worktree on the PR's head, beside the folder; any earlier tree for the PR goes first. */
  async function prepareTree(cwd: string, item: SweepItem): Promise<string> {
    if (!isSha(item.headSha)) throw new Error(`#${item.number}: unexpected head ${item.headSha}`);
    const top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    const dir = path.join(`${top}.aw-review`, `pr-${item.number}`);
    await removeTree(top, dir);
    await git(['fetch', '--quiet', 'origin', `+refs/pull/${item.number}/head:refs/aw-review/pr-${item.number}`], top);
    if (item.lastReviewedSha && isSha(item.lastReviewedSha)) {
      // The old head, for the re-review diff. Gone after a force-push, which the prompt allows for.
      await git(['fetch', '--quiet', 'origin', item.lastReviewedSha], top).catch(() => undefined);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['worktree', 'add', '--detach', dir, item.headSha], top);
    return dir;
  }

  async function removeTree(top: string, dir: string): Promise<void> {
    if (!fs.existsSync(dir)) return;
    await git(['worktree', 'remove', '--force', dir], top).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
  }

  /** Trees for PRs no longer waiting on the user. */
  async function pruneTrees(cwd: string, keep: ReadonlySet<number>): Promise<void> {
    const top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    const base = `${top}.aw-review`;
    let names: string[] = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^pr-(\d+)$/.exec(name);
      if (m && !keep.has(Number(m[1]))) await removeTree(top, path.join(base, name));
    }
    await git(['worktree', 'prune'], top).catch(() => undefined);
  }

  async function postPending(entry: LedgerEntry, job: ScheduledJob): Promise<void> {
    const [repo, num] = entry.key.split('#');
    if (!entry.reviewFile || !entry.lastReviewedSha || !repo || !num) return;
    let text: string;
    try {
      text = fs.readFileSync(entry.reviewFile, 'utf8');
    } catch {
      throw new Error('the session left no review file');
    }
    const file = parseReviewFile(text);
    if ('error' in file) throw new Error(file.error);
    if (!deps.mayPost(job.id)) throw new Error('not authorized to post');
    const out = await gh(['api', '--method', 'POST', `repos/${repo}/pulls/${num}/reviews`, '--input', '-'], process.cwd(), JSON.stringify(pendingReviewPayload(file, entry.lastReviewedSha)));
    const id = Number((JSON.parse(out) as { id?: unknown }).id);
    writeEntry(entry.key, (e) => ({ ...e, ...(Number.isFinite(id) ? { reviewId: id } : {}), postError: undefined }));
    deps.notify({ title: 'Pending review ready', body: `${repo}#${num}: open the PR on GitHub to read and submit it.`, tag: `prsweep:${entry.key}:${entry.lastReviewedSha}` });
    deps.log(`pr sweep: posted a pending review on ${entry.key}`);
  }

  return {
    async preview(cwd) {
      const { repo, candidates } = await discover(cwd);
      return { repo, items: planSweep(repo, candidates, readLedger(), now()) };
    },

    async run(job, cwd, runId, start: StartJobSession) {
      const { repo, candidates } = await discover(cwd);
      const items = planSweep(repo, candidates, readLedger(), now());
      const due = items.filter((i) => isDue(i.need));
      await pruneTrees(cwd, new Set(items.filter((i) => i.need !== 'reviewed' && i.need !== 'draft').map((i) => i.number))).catch((error: Error) => deps.log(`pr sweep: prune failed (${error.message})`));
      let started = 0;
      let failed = 0;
      for (const item of due.slice(0, MAX_REVIEWS_PER_SWEEP)) {
        try {
          const tree = await prepareTree(cwd, item);
          const reviewFile = job.postPendingReview ? path.join(deps.reviewsDir, `${repo.replace('/', '__')}-${item.number}-${item.headSha.slice(0, 12)}.json`) : undefined;
          if (reviewFile) {
            fs.mkdirSync(deps.reviewsDir, { recursive: true });
            fs.rmSync(reviewFile, { force: true });
          }
          writeEntry(item.key, (e) => ({ ...e, pendingSha: item.headSha, pendingAt: now(), jobId: job.id, ...(reviewFile ? { reviewFile } : { reviewFile: undefined }), postError: undefined }));
          await start(job, {
            cwd: tree,
            prompt: reviewPrompt(job.prompt, repo, item, reviewFile),
            origin: { ...jobOrigin(job.id, runId), pr: item.key },
            // `//` is an absolute path in Claude Code's rule syntax: exactly this file, nothing else.
            ...(reviewFile ? { extraAllowedTools: [`Write(/${reviewFile})`, `Edit(/${reviewFile})`] } : {}),
            onSessionId: (sessionId) => writeEntry(item.key, (e) => ({ ...e, provider: job.provider, sessionId })),
          });
          started++;
        } catch (error) {
          failed++;
          writeEntry(item.key, (e) => ({ ...e, pendingSha: undefined, pendingAt: undefined }));
          deps.log(`pr sweep: ${item.key} did not start (${(error as Error).message})`);
        }
      }
      return sweepSummary(started, due.length, items.filter((i) => i.need !== 'draft').length, failed);
    },

    sessionDone(provider, sessionId) {
      const id = sessionId.toLowerCase();
      for (const entry of readLedger().values()) {
        if (entry.provider !== provider || entry.sessionId?.toLowerCase() !== id || !entry.pendingSha) continue;
        const reviewed: LedgerEntry = { ...entry, lastReviewedSha: entry.pendingSha, reviewedAt: now(), pendingSha: undefined, pendingAt: undefined };
        writeEntry(entry.key, () => reviewed);
        deps.log(`pr sweep: review of ${entry.key} finished`);
        const job = entry.jobId ? deps.job(entry.jobId) : undefined;
        if (job?.postPendingReview && entry.reviewFile) {
          void postPending(reviewed, job).catch((error: Error) => {
            writeEntry(entry.key, (e) => ({ ...e, postError: error.message }));
            deps.notify({ title: 'Pending review not posted', body: `${entry.key}: ${error.message}`, tag: `prsweep:${entry.key}:${reviewed.lastReviewedSha}:error` });
            deps.log(`pr sweep: ${entry.key} not posted (${error.message})`);
          });
        }
        return;
      }
    },

    onDidChange: (listener) => emitter.event(listener),
  };
}

const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts?.cwd, encoding: 'utf8', maxBuffer: 16 << 20, timeout: 120_000, env: { ...process.env, PATH: toolPath(process.env.PATH), GH_PROMPT_DISABLED: '1' } },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n')[0] || `${cmd} failed`));
        else resolve(stdout);
      },
    );
    if (opts?.input !== undefined) child.stdin?.end(opts.input);
  });
