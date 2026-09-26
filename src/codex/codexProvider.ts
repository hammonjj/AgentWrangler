import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigGetter } from '../core/config';
import { Emitter, type Disposable } from '../core/events';
import type { AgentProvider, TranscriptAppendEvent } from '../core/provider';
import { worktreeFor } from '../core/worktree';
import { projectNameFor } from '../core/checkout';
import type { AgentSession } from '../shared/model';
import { summarizeSubagents, visibleCodexSummaries } from './subagents';
import { codexSessionIndex, codexSessionsDir } from './paths';
import { findRollouts, readRolloutSummary, rolloutStatus, type CodexRolloutSummary } from './rollout';

const RESCAN_MS = 5_000;

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  private summaries = new Map<string, CodexRolloutSummary>();
  private paths = new Map<string, string>();
  private change = new Emitter<void>();
  private append = new Emitter<TranscriptAppendEvent>();
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private started = false;
  private disposed = false;
  private threadNames = new Map<string, string>();

  constructor(private getConfig: ConfigGetter, private log: (message: string) => void = () => undefined) {}

  onDidChange = (listener: () => void): Disposable => this.change.event(listener);
  onTranscriptAppended = (listener: (event: TranscriptAppendEvent) => void): Disposable => this.append.event(listener);

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    this.watch();
    this.schedule();
  }

  async refresh(): Promise<void> {
    const cfg = this.getConfig();
    const cutoff = Date.now() - cfg.endedWindowHours * 3_600_000;
    const files = await findRollouts(codexSessionsDir(), cutoff);
    this.threadNames = await readThreadNames(codexSessionIndex());
    const livePaths = new Set(files);
    for (const [file, id] of this.paths) {
      if (!livePaths.has(file)) {
        this.paths.delete(file);
        this.summaries.delete(id);
      }
    }
    const changed = await Promise.all(files.map(async (file) => {
      const knownId = this.paths.get(file);
      const known = knownId ? this.summaries.get(knownId) : undefined;
      try {
        const stat = await fs.promises.stat(file);
        if (known && known.lastActivityAt === stat.mtimeMs) return undefined;
        return await readRolloutSummary(file);
      } catch {
        return undefined;
      }
    }));
    for (const summary of changed) {
      if (!summary) continue;
      const id = summary.sessionId.toLowerCase();
      this.summaries.set(id, summary);
      this.paths.set(summary.path, id);
    }
    this.change.fire();
  }

  async scan(): Promise<AgentSession[]> {
    const cfg = this.getConfig();
    const now = Date.now();
    const summaries = [...this.summaries.values()];
    const subagents = summarizeSubagents(summaries, now, cfg.stuckThresholdSeconds * 1000);
    // Subagents are never rows of their own; their counts ride on the parent (`subagents`).
    return visibleCodexSummaries(summaries, false)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, cfg.maxEndedSessions + 100)
      .map((summary) => {
        const cwd = summary.cwd;
        const worktree = worktreeFor(cwd);
        return {
          provider: this.id,
          subagents: subagents.get(summary.sessionId.toLowerCase()),
          sessionId: summary.sessionId,
          key: `${this.id}:${summary.sessionId.toLowerCase()}`,
          title: this.threadNames.get(summary.sessionId.toLowerCase()) ?? summary.title ?? summary.subtitle ?? summary.sessionId.slice(0, 8),
          subtitle: summary.subtitle,
          cwd,
          projectName: projectNameFor(cwd),
          worktree: worktree?.name,
          worktreePath: worktree?.root,
          gitBranch: summary.gitBranch,
          model: summary.model,
          status: rolloutStatus(summary, now, cfg.stuckThresholdSeconds * 1000),
          lastActivityAt: summary.lastActivityAt,
          conversationStartedAt: summary.startedAtMs,
          transcriptPath: summary.path,
          statusIsEstimated: true,
          client: summary.source,
          progress: !summary.turnComplete && summary.turnStartedAtMs
            ? { startedAtMs: summary.turnStartedAtMs, blockedMs: 0, toolCalls: 0 }
            : undefined,
        } satisfies AgentSession;
      });
  }

  private watch(): void {
    if (this.watcher || this.disposed) return;
    try {
      this.watcher = fs.watch(codexSessionsDir(), { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename?.toString().endsWith('.jsonl')) return;
        const file = path.join(codexSessionsDir(), filename.toString());
        void readRolloutSummary(file).then((summary) => {
          if (!summary) return;
          this.summaries.set(summary.sessionId.toLowerCase(), summary);
          this.paths.set(file, summary.sessionId.toLowerCase());
          this.append.fire({ sessionId: summary.sessionId.toLowerCase(), path: file });
          this.change.fire();
        }).catch(() => undefined);
      });
      this.watcher.on('error', (error) => {
        this.log(`codex watcher error: ${String(error)}`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (error) {
      this.log(`cannot watch Codex sessions: ${String(error)}`);
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(async () => {
      await this.refresh().catch((error) => this.log(`codex refresh error: ${String(error)}`));
      this.watch();
      this.schedule();
    }, RESCAN_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.change.dispose();
    this.append.dispose();
  }
}

export async function readThreadNames(file: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (typeof value.id === 'string' && typeof value.thread_name === 'string' && value.thread_name.trim()) {
          names.set(value.id.toLowerCase(), value.thread_name.trim());
        }
      } catch { /* one partial index line does not invalidate the rest */ }
    }
  } catch { /* the index is optional on older Codex builds */ }
  return names;
}
