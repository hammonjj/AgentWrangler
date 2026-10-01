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
import { parseRoutingSettings, ROUTING_KEY } from '../shared/orchestration/executionPolicy';
import type { HarnessId, ModelSourceId } from '../shared/orchestration/types';
import type { ResolverSnapshot } from './policy/resolver';
import type { LearnedRule } from '../shared/orchestration/routingProposals';
import { ClaudeStructuredCompletion, type CompletionQueryFn, type CompletionResult, type StructuredCompletion } from './completion/structuredCompletion';
import { RoutedCompletion } from './completion/localCompletion';
import type { LocalEndpointService } from './local/localEndpointService';
import type { CapabilityCatalogView } from '../shared/orchestration/catalog';
import { TaskRunner, type SchedulingDeps } from './engine/taskRunner';
import { ClaudeCodeHarness } from './harness/claudeCodeHarness';
import { CodexHarness } from './harness/codexHarness';
import type { AgentHarness } from './harness/types';
import { Assessor } from './policy/assessor';
import { Planner, type LocalPlannerDeps } from './policy/planner';
import { gatherRepoContext } from './policy/repoContext';
import { nodeExec } from './worktrees/exec';
import { RepoPolicyStore, repoPoliciesDir, worktreeRootPath } from './policy/repoPolicyStore';
import { MissionStore } from './store/missionStore';
import { Reviewer } from './verify/reviewer';
import type { Exec } from './worktrees/exec';
import { WorktreeManager } from './worktrees/worktreeManager';

/** The setting that switches orchestration on. Read once at start; changing it takes a restart. */
export const ORCHESTRATION_ENABLED_KEY = 'orchestration.enabled';

/**
 * Parallel missions (#46), off by default: a plan approved with it on runs its
 * independent tasks at once, each in a worktree of its own, and merges them
 * into the mission branch one at a time. Read at each approval.
 */
export const PARALLEL_TASKS_KEY = 'orchestration.parallelTasks';

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
  /** Bring up the conversation a delegation came from (#82), for a notification's click. */
  showOrigin?: (origin: { provider: 'claude' | 'codex'; sessionId: string }) => void;
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
  /** The catalog and source health, read fresh for each recommendation (#38). Absent: no routing. */
  routingSnapshot?: () => ResolverSnapshot;
  /** Proposals a person accepted (#52), read fresh for each recommendation. */
  learnedRules?: () => readonly LearnedRule[];
  /**
   * The registered local endpoints (#51) and the catalog they are in. Codex
   * reaches their models through a model provider; completions go to one
   * assigned the weakest tier before the hosted model; a server lost
   * mid-attempt is `infra` and fails over within the tier.
   */
  local?: {
    service: Pick<
      LocalEndpointService,
      'codexProvider' | 'claudeProvider' | 'checkNow' | 'onDown' | 'pickCompletion' | 'completionFor' | 'recordCall' | 'runFacts'
    > &
      Partial<Pick<LocalEndpointService, 'pickPlanner'>>;
    catalog: () => CapabilityCatalogView;
  };
  /**
   * What the scheduler reads beyond the missions (#45): the fleet pause and
   * its levers (`PauseService`), limits, and a signal when capacity or a usage
   * window moves. Absent: default limits, never paused.
   */
  scheduling?: SchedulingDeps;
}

/**
 * How new tasks are routed, and the global scope of §10.2 (#38, #40):
 * `{ "mode": "manual" | "assisted", "pins"?, "caps"?, "preferences"?, "exclusions"? }`,
 * edited in Preferences → Orchestration → Routing defaults. `manual` (the
 * default) runs on the launcher's route and records the router's choice in
 * shadow; `assisted` proposes a route and waits for a click. The global layer
 * is frozen into each mission when it is recorded.
 */
export { ROUTING_KEY, parseRoutingSettings, type RoutingSettings } from '../shared/orchestration/executionPolicy';

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

/** A `local-call` record for a completion a local endpoint served (or failed to). Counts and timings only. */
function recordLocalCall(
  service: Pick<LocalEndpointService, 'recordCall'>,
  r: CompletionResult<unknown>,
  fellBack: boolean,
  purpose: 'completion' | 'planner' = 'completion',
): void {
  if (!r.local) return;
  service.recordCall({
    source: r.local.source,
    model: r.model,
    purpose,
    ok: r.ok,
    ...(r.ok ? {} : { failure: r.reason }),
    ...(r.infra ? { infra: true } : {}),
    ...(r.usage.inputTokens !== undefined ? { inputTokens: r.usage.inputTokens } : {}),
    ...(r.usage.outputTokens !== undefined ? { outputTokens: r.usage.outputTokens } : {}),
    durationMs: r.durationMs,
    attempts: r.attempts,
    local: r.local,
    ...(fellBack ? { fellBackToHosted: true } : {}),
  });
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
  const local = deps.local;
  // The adapters are the only orchestration code that touches the executors (§6.2).
  const harnesses = new Map<HarnessId, AgentHarness>([
    ['claude-code', new ClaudeCodeHarness({ sessions: deps.sessions, models, ...(local ? { localProvider: (s, m) => local.service.claudeProvider(s, m) } : {}) })],
    [
      'codex',
      new CodexHarness({ sessions: deps.sessions, models, ...(local ? { localProvider: (s, m) => local.service.codexProvider(s, m) } : {}) }),
    ],
  ]);
  const hosted = deps.completion
    ? new ClaudeStructuredCompletion({ ...deps.completion, log: (m) => deps.log(`orchestration: ${m}`) })
    : undefined;
  const completion: StructuredCompletion | undefined = local
    ? new RoutedCompletion(
        hosted,
        () => {
          const entry = local.service.pickCompletion(local.catalog());
          return entry ? local.service.completionFor(entry) : undefined;
        },
        { log, onLocal: (r, fellBack) => recordLocalCall(local.service, r, fellBack) },
      )
    : hosted;
  const repoPolicies = new RepoPolicyStore(repoPoliciesDir(deps.dataDir), { log });
  // Without a completion the assessor still runs, from rules alone, at low confidence (§8.3).
  const assessor = new Assessor({ completion, log: deps.log });
  // Without a completion there is no reviewer, and `review` stages say so (#36).
  // The reviewer reads the worktree, which only the hosted completion can (a local one has no tools).
  const reviewer = hosted && completion ? new Reviewer({ completion }) : undefined;
  // The hosted planner reads the repository itself (#44), so it gets the hosted
  // completion directly, never one routed to the weakest local tier. A local
  // planner (§11.5) is asked first when a mission prefers local models: AW
  // gathers the excerpt, and the call has no workspace.
  const exec = deps.exec ?? nodeExec;
  const pickPlanner = local?.service.pickPlanner?.bind(local.service);
  const localPlanner: LocalPlannerDeps | undefined =
    local && pickPlanner
      ? {
          pick: (opts) => {
            const p = pickPlanner(local.catalog(), opts);
            if (!p) return undefined;
            return {
              completion: local.service.completionFor(p.entry),
              model: p.entry.descriptor.modelId,
              source: p.entry.descriptor.source,
              tier: p.entry.tier!,
              contextWindow: p.contextWindow,
            };
          },
          gather: (req, limits) => gatherRepoContext(req, limits, { exec }),
          onCall: (r, fellBack) => recordLocalCall(local.service, r, fellBack, 'planner'),
          log,
        }
      : undefined;
  const planner = hosted || localPlanner ? new Planner({ ...(hosted ? { completion: hosted } : {}), ...(localPlanner ? { local: localPlanner } : {}) }) : undefined;
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
    reviewer,
    planner,
    tierOf: deps.tierOf,
    // The global scope (§10.2), read when a mission is recorded and frozen into it.
    globalPolicy: () => parseRoutingSettings(deps.settings.get<unknown>(ROUTING_KEY, undefined)).policy,
    ...(deps.routingSnapshot ? { routing: { snapshot: deps.routingSnapshot, ...(deps.learnedRules ? { learnedRules: deps.learnedRules } : {}) } } : {}),
    ...(local
      ? {
          local: {
            check: (source) => local.service.checkNow(source),
            onDown: (listener) => local.service.onDown(listener),
            facts: (source, model) => local.service.runFacts(source, model),
          },
        }
      : {}),
    telemetry: deps.telemetry,
    onTurnRecord: deps.onTurnRecord,
    notify: deps.notify,
    openFile: deps.openFile,
    showOrigin: deps.showOrigin,
    diffsDir: path.join(deps.dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(deps.dataDir, 'orchestration', 'logs'),
    settleMs: deps.settleMs,
    ...(deps.scheduling ? { scheduling: deps.scheduling } : {}),
    parallelTasks: () => deps.settings.get<unknown>(PARALLEL_TASKS_KEY, false) === true,
    log,
  });
  // Recovery (§23.3) waits for #4: hosts adopted, Codex threads rejoined.
  const ready = deps.startupSettled
    .catch(() => undefined)
    .then(() => tasks.recover())
    .catch((e) => log(`recovery failed: ${String(e)}`));
  return { enabled: true, store, harnesses, completion, repoPolicies, assessor, tasks, ready, dispose: () => tasks.dispose() };
}
