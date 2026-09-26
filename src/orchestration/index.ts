/**
 * The orchestration composition root (`docs/plans/intelligent-orchestration.md`
 * §2.4 item 6, §5.3).
 *
 * `createApp` calls this once. It takes narrow interfaces, never `createApp`
 * internals, so orchestration can be built and tested on its own. Behind
 * `orchestration.enabled` (off by default) it opens the mission store, waits
 * for #4's startup to settle, then runs the task runner's recovery (§23.3).
 */
import * as path from 'node:path';
import type { Disposable } from '../core/events';
import type { LaunchDefaults } from '../core/launchDefaults';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import type { SessionRegistry } from '../core/session/sessionRegistry';
import type { ModelChoice } from '../shared/conversation';
import type { TelemetryRecord, TurnRecord } from '../shared/orchestration/telemetry';
import type { HarnessId, ModelSourceId } from '../shared/orchestration/types';
import { ClaudeStructuredCompletion, type CompletionQueryFn, type StructuredCompletion } from './completion/structuredCompletion';
import { TaskRunner } from './engine/taskRunner';
import { ClaudeCodeHarness } from './harness/claudeCodeHarness';
import { CodexHarness } from './harness/codexHarness';
import type { AgentHarness } from './harness/types';
import { Assessor } from './policy/assessor';
import { RepoPolicyStore, repoPoliciesDir, worktreeRootPath } from './policy/repoPolicyStore';
import { MissionStore } from './store/missionStore';
import type { Exec } from './worktrees/exec';
import { WorktreeManager } from './worktrees/worktreeManager';

/** The setting that switches orchestration on. Read once at start; changing it takes a restart. */
export const ORCHESTRATION_ENABLED_KEY = 'orchestration.enabled';

/** Why a Claude attempt cannot start with session hosts off (G1, plan §35.4). */
export const HOSTS_REQUIRED =
  'Running a task needs “Keep conversations running when Agent Wrangler quits” (Preferences → Conversations): an attempt has to survive a quit or a reinstall.';

export interface OrchestrationDeps {
  settings: { get<T>(key: string, defaultValue: T): T };
  /** The app's data directory; missions live under `orchestration/missions/`. */
  dataDir: string;
  sessions: Pick<SessionExecutors, 'launch' | 'get' | 'list' | 'onDidChange'>;
  registry: Pick<SessionRegistry, 'all' | 'get'> & Partial<Pick<SessionRegistry, 'restoreOrigin'>>;
  /**
   * Whether new Claude sessions run in session hosts. An attempt must survive
   * `app:install`, so a Claude attempt is refused while this is false (G1).
   * Codex threads survive a quit either way. Absent: refused.
   */
  hostsEnabled?: () => boolean;
  /** Turn records as #27 writes them, to sum each attempt's usage. */
  onTurnRecord?: (listener: (record: TurnRecord) => void) => Disposable;
  /** Where `attempt` records go: the telemetry log. */
  telemetry?: { append(record: TelemetryRecord): boolean };
  notify?: (notice: { title: string; body: string; onClick?: () => void }) => void;
  openFile?: (file: string) => void;
  /** The catalog's tier for a model, if it has one. */
  tierOf?: (source: ModelSourceId, model: string) => string | undefined;
  /** How worktree git commands run (tests inject one). */
  exec?: Exec;
  /** Test hook: how long a finished-looking session must stay so. */
  settleMs?: number;
  launchDefaults: LaunchDefaults;
  /**
   * Resolves once #4's startup has settled: hosts adopted and Codex threads
   * rejoined. Recovery must not look at session states before (§23.3).
   */
  startupSettled: Promise<void>;
  log: (msg: string) => void;
  /** The model lists the CLIs last reported (`ModelCatalogService`); the harnesses offer them. */
  models?: () => ModelChoice[];
  /** How structured completions reach Claude: the SDK's `query` and the `claude` to run (§6.1). */
  completion?: { query: CompletionQueryFn; binary: () => string | undefined };
}

export interface Orchestration extends Disposable {
  readonly enabled: boolean;
  /** The mission store, when enabled. */
  readonly store?: MissionStore;
  /** The harnesses attempts launch through (§6.2), by id, when enabled. */
  readonly harnesses?: ReadonlyMap<HarnessId, AgentHarness>;
  /** One-shot structured calls (§6.1), when enabled and given a way to reach Claude. */
  readonly completion?: StructuredCompletion;
  /** Per-repository policies (§13.6), when enabled. Read by the task runner at each launch. */
  readonly repoPolicies?: RepoPolicyStore;
  /** Describes what a task's work is like (#37), when enabled. */
  readonly assessor?: Assessor;
  /** Runs tasks (#33), when enabled. */
  readonly tasks?: TaskRunner;
  /** Resolves when the startup pass is over (immediately when disabled). */
  readonly ready: Promise<void>;
}

export function missionsDir(dataDir: string): string {
  return path.join(dataDir, 'orchestration', 'missions');
}

export function createOrchestration(deps: OrchestrationDeps): Orchestration {
  // Read once: turning it on or off takes a restart, like the other lifecycle switches.
  const enabled = deps.settings.get<boolean>(ORCHESTRATION_ENABLED_KEY, false) === true;
  if (!enabled) return { enabled: false, ready: Promise.resolve(), dispose: () => undefined };

  const log = (m: string) => deps.log(`orchestration: ${m}`);
  const store = new MissionStore(missionsDir(deps.dataDir), { log });
  const models = deps.models ?? (() => []);
  // The adapters are the only orchestration code that touches the executors (§6.2).
  const harnesses = new Map<HarnessId, AgentHarness>([
    ['claude-code', new ClaudeCodeHarness({ sessions: deps.sessions, models })],
    ['codex', new CodexHarness({ sessions: deps.sessions, models })],
  ]);
  const completion = deps.completion
    ? new ClaudeStructuredCompletion({ ...deps.completion, log: (m) => deps.log(`orchestration: ${m}`) })
    : undefined;
  const repoPolicies = new RepoPolicyStore(repoPoliciesDir(deps.dataDir), { log });
  // Without a completion the assessor still runs, from rules alone, at low confidence (§8.3).
  const assessor = new Assessor({ completion, log: deps.log });
  const tasks = new TaskRunner({
    store,
    harnesses,
    sessions: deps.sessions,
    registry: deps.registry,
    repoPolicies,
    openWorktrees: (loaded, record) =>
      WorktreeManager.open(
        {
          repoRoot: loaded.repo.primaryRoot,
          root: worktreeRootPath(loaded),
          setup: loaded.policy.worktrees.setup,
          // The user's own setup commands, and nothing else (§13.2).
          allowedCommands: loaded.policy.worktrees.setup.flatMap((s) => ('run' in s ? [s.run] : [])),
        },
        { record, exec: deps.exec, log },
      ),
    launchDefaults: deps.launchDefaults,
    cannotLaunch: (harness) => (harness === 'claude-code' && deps.hostsEnabled?.() !== true ? HOSTS_REQUIRED : undefined),
    assessor,
    tierOf: deps.tierOf,
    telemetry: deps.telemetry,
    onTurnRecord: deps.onTurnRecord,
    notify: deps.notify,
    openFile: deps.openFile,
    diffsDir: path.join(deps.dataDir, 'orchestration', 'diffs'),
    settleMs: deps.settleMs,
    log,
  });
  // Recovery (§23.3) waits for #4: hosts adopted, Codex threads rejoined.
  const ready = deps.startupSettled
    .catch(() => undefined)
    .then(() => tasks.recover())
    .catch((e) => log(`recovery failed: ${String(e)}`));
  return { enabled: true, store, harnesses, completion, repoPolicies, assessor, tasks, ready, dispose: () => tasks.dispose() };
}
