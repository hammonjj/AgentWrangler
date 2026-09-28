/**
 * Work a Claude Code session leaves running after its turn ends (#60): background
 * subagents, background shells, monitors. When such work finishes, Claude Code
 * queues a `<task-notification>` as a new turn and the agent carries on, so a
 * turn that ended with any of it outstanding is not Done.
 *
 * Signals, checked against Claude Code 2.1.281–2.1.283:
 *
 * - **Hooks.** Every `Stop` payload carries `background_tasks`, a list of
 *   `{ id, type: "subagent" | "shell" | …, status: "running", description, … }`.
 *   It is Claude Code's own list at the moment the turn ended, so it is used as
 *   is. The turn a task notification starts fires `UserPromptSubmit` like any
 *   other, and its `Stop` reports the list again.
 * - **Transcript.** Launches are the tool result's `toolUseResult`:
 *   `backgroundTaskId` for a shell (whether `run_in_background` asked for it or
 *   a foreground command was moved to the background on timeout), `isAsync` +
 *   `agentId` for a subagent (the Agent tool can be async without
 *   `run_in_background`), `taskId` + `timeoutMs` for a Monitor. The end is a
 *   `queue-operation` enqueue (or the user line it becomes) whose content is a
 *   `<task-notification>` with that `<task-id>` and a `<status>` (completed,
 *   failed, killed, stopped); one without `<status>` is a monitor event, and
 *   the monitor is still running. `TaskStop`'s result (`task_id`) ends one too.
 *   A notification can name a task this transcript never launched (one started
 *   inside a subagent); that is simply ignored.
 */
import type { BackgroundTaskCounts } from '../shared/model';

export type BackgroundTaskKind = 'subagent' | 'shell' | 'other';

export interface BackgroundTaskRef {
  id: string;
  kind: BackgroundTaskKind;
  /** When the transcript recorded the launch; absent for the hook list. */
  launchedAtMs?: number;
}

/** A transcript tracks at most this many open tasks; the oldest go first. */
export const MAX_TRACKED_TASKS = 50;

const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error']);

function kindOf(type: unknown): BackgroundTaskKind {
  if (type === 'subagent' || type === 'agent') return 'subagent';
  if (type === 'shell' || type === 'bash' || type === 'local_bash') return 'shell';
  return 'other';
}

/**
 * The `background_tasks` field of a `Stop` payload. Undefined when the field
 * is absent (a Claude Code too old to send it), which is not the same as an
 * empty list: the caller then falls back to the transcript.
 */
export function parseHookBackgroundTasks(raw: unknown): BackgroundTaskRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: BackgroundTaskRef[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.status === 'string' && FINISHED.has(o.status)) continue;
    out.push({ id: typeof o.id === 'string' ? o.id : '', kind: kindOf(o.type) });
  }
  return out;
}

/** The task a tool result launched into the background, if it did. */
export function launchedTaskOf(toolUseResult: unknown, launchedAtMs: number | undefined): BackgroundTaskRef | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object' || Array.isArray(toolUseResult)) return undefined;
  const r = toolUseResult as Record<string, unknown>;
  if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) {
    return { id: r.backgroundTaskId, kind: 'shell', launchedAtMs };
  }
  if ((r.isAsync === true || r.status === 'async_launched') && typeof r.agentId === 'string' && r.agentId) {
    return { id: r.agentId, kind: 'subagent', launchedAtMs };
  }
  if (typeof r.taskId === 'string' && r.taskId && 'timeoutMs' in r) {
    return { id: r.taskId, kind: 'other', launchedAtMs };
  }
  return undefined;
}

/** The task a tool result stopped (`TaskStop`), if it did. */
export function stoppedTaskOf(toolUseResult: unknown): string | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object' || Array.isArray(toolUseResult)) return undefined;
  const r = toolUseResult as Record<string, unknown>;
  return typeof r.task_id === 'string' && r.task_id && typeof r.task_type === 'string' ? r.task_id : undefined;
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/;
const STATUS = /<status>([^<]*)<\/status>/;

/** Ids of the tasks a queued prompt reports as over. A status-less notification is a monitor event, not an end. */
export function finishedTaskIdsIn(text: string): string[] {
  if (!text.includes('<task-notification>')) return [];
  const ids: string[] = [];
  for (const m of text.matchAll(NOTIFICATION)) {
    const id = TASK_ID.exec(m[1])?.[1]?.trim();
    if (id && STATUS.test(m[1])) ids.push(id);
  }
  return ids;
}

/** Open tasks after a chunk of transcript: `prev` plus what it launched, minus what it ended. */
export function applyTaskChanges(
  prev: readonly BackgroundTaskRef[] | undefined,
  opened: readonly BackgroundTaskRef[],
  closed: readonly string[],
): BackgroundTaskRef[] | undefined {
  if (opened.length === 0 && closed.length === 0) return prev ? [...prev] : undefined;
  const byId = new Map<string, BackgroundTaskRef>();
  for (const t of prev ?? []) byId.set(t.id, t);
  for (const t of opened) byId.set(t.id, t);
  for (const id of closed) byId.delete(id);
  const all = [...byId.values()];
  return all.slice(Math.max(0, all.length - MAX_TRACKED_TASKS));
}

/**
 * Tasks the *current* process can still be running. Claude Code kills its
 * background work when it exits, and a `--resume` appends to the same
 * transcript, so a launch from before this process started is long dead even
 * though no notification ever closed it.
 */
export function liveTranscriptTasks(
  tasks: readonly BackgroundTaskRef[] | undefined,
  processStartedAtMs: number | undefined,
): BackgroundTaskRef[] {
  if (!tasks) return [];
  if (processStartedAtMs === undefined) return [...tasks];
  // A second of slack: the pid file and the transcript are stamped by different writes.
  return tasks.filter((t) => t.launchedAtMs === undefined || t.launchedAtMs >= processStartedAtMs - 1000);
}

export function countTasks(tasks: readonly BackgroundTaskRef[]): BackgroundTaskCounts | undefined {
  if (tasks.length === 0) return undefined;
  const c: BackgroundTaskCounts = { subagents: 0, shells: 0, other: 0 };
  for (const t of tasks) {
    if (t.kind === 'subagent') c.subagents++;
    else if (t.kind === 'shell') c.shells++;
    else c.other++;
  }
  return c;
}
