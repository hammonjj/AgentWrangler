/**
 * The application, minus the window.
 *
 * This was the body of `activate()`. Almost none of it was about VSCode: it
 * builds the session store, the two providers, the runners, the preference
 * services and the usage pollers, and it defines what taking a session over,
 * closing one, pausing one and starting one actually do. Only the outer edge —
 * where settings live, what a modal looks like, what a window is — differed
 * between hosting it in an editor and hosting it in an app, and that edge is
 * `HostServices`.
 *
 * So both front ends call this. `src/extension.ts` builds a VSCode host, calls
 * `createApp`, and registers fifteen commands that call the methods it returns.
 * `src/electron/main.ts` builds an Electron host, calls `createApp`, and puts
 * the same methods in a menu.
 *
 * The one thing that cannot be built here is the surface the panes live on —
 * an editor tab versus a `BrowserWindow` — and several of these behaviours have
 * to show something on it ("take this session over, then put it in front of
 * me"). It is therefore attached afterwards, through `attachSurface`. Until it
 * is, everything still works; it simply has nowhere to display the result,
 * which is the honest description of an app whose window has been closed.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { waitForAdoptable } from '../core/adoptQueue';
import { globalConversationDir, sessionsDir } from '../claude/paths';
import { resolveClaudeBinary } from '../claude/binary';
import { ClaudeProvider } from '../claude/claudeProvider';
import { CodexProvider } from '../codex/codexProvider';
import { CodexAppServer, hostConnector } from '../codex/appServer';
import { CodexHost, stopSignalFor } from '../codex/codexHost';
import { resolveCodexBinary } from '../codex/binary';
import { readRolloutBlocks } from '../codex/rollout';
import { codexUsageReader } from '../codex/usage';
import { CodexRunnerService } from '../codex/runner';
import { isPidAlive, readProcessEntries, readRegistry } from '../claude/registry';
import { bootTimeMs, parentPidOf, startTimeOf } from '../core/procStart';
import { sweepOrphans, sweepRefusal, type SweepResult } from '../core/session/orphanSweep';
import { endProcess } from '../claude/runner/adopt';
import { SessionRegistry, type SessionRecord } from '../core/session/sessionRegistry';
import { autoResumeCandidate, outcomesFromDeadHosts, recordFromManifest } from '../core/session/recovery';
import { checkoutFor } from '../core/checkout';
import { RunnerService } from '../claude/runner/runnerService';
import type { RunnerView } from '../claude/runner/runnerView';
import type { HostManifest } from '../shared/sessionProtocol';
import { SessionExecutors } from '../core/session/sessionExecutors';
import type { SessionHandle } from '../core/session/sessionHandle';
import { LaunchDefaults } from '../core/launchDefaults';
import { createOrchestration, parseRoutingSettings, ROUTING_KEY } from '../orchestration';
import { TaskError, type TaskAction, type TaskRoute, type TaskRunner } from '../orchestration/engine/taskRunner';
import { explainRecommendation, targetLabel } from '../orchestration/view/routeExplain';
import { sourceStatus } from '../shared/orchestration/sourceHealth';
import { EFFORT_LEVELS, isOrchestrationOrigin, type RouteRecommendation } from '../shared/orchestration/types';
import { nativeEffortFor, tierRank } from '../shared/orchestration/catalog';
import { policyContextFor } from '../shared/orchestration/executionPolicy';
import { editPolicy, type PolicyEditorDeps } from './policyEditor';
import { Emitter } from '../core/events';
import type { DelegationSuggestionRecord, TelemetryRecord, TurnRecord } from '../shared/orchestration/telemetry';
import { isEndpointSource } from '../shared/orchestration/localEndpoints';
import { LocalEndpointService } from '../orchestration/local/localEndpointService';
import { taskQualifier } from '../orchestration/local/taskQualifier';
import { CodexHarness } from '../orchestration/harness/codexHarness';
import { ClaudeCodeHarness } from '../orchestration/harness/claudeCodeHarness';
import { CONVERSATION_DELEGATION_INSTRUCTIONS, withConversationDelegation } from '../shared/conversationDelegation';
import { LocalMetricsIndex } from '../core/telemetry/localMetricsIndex';
import { RoutingEvidenceIndex } from '../core/telemetry/routingEvidenceIndex';
import { AnalyticsIndex } from '../core/telemetry/telemetryIndex';
import { comparisonReport, effectiveMode, evaluateGate, type ComparisonReport, type GateResult } from '../shared/orchestration/autoRouting';
import { CORPUS_STATUS } from '../orchestration/policy/corpusStatus';
import { ROUTER_VERSION } from '../orchestration/policy/router';
import { ASSESSOR_VERSION } from '../orchestration/policy/assessment';
import type { Mission } from '../shared/orchestration/types';
import type { DelegationAction, DelegationView, ProposalDecision, TaskProposalView, TaskView, TaskViewAction } from '../shared/orchestration/taskView';
import { harnessLabel } from '../shared/harness';
import { modelLabel } from '../shared/modelName';
import { sessionKeyFor, taskBadges, taskViewOf } from '../orchestration/view/taskViews';
import {
  delegationOutcome,
  delegationViewOf,
  isOpenDelegation,
  isOpenProposal,
  proposalChoice,
  proposalViewOf,
  type DelegationOutcome,
} from '../orchestration/view/proposalView';
import { TelemetryLog } from '../core/telemetry/telemetryLog';
import { TELEMETRY_ENABLED_KEY, TELEMETRY_PRICES_KEY, TurnTelemetry } from '../core/telemetry/turnTelemetry';
import type { PriceTable } from '../core/telemetry/turnUsage';
import { SessionUsageIndex } from '../core/telemetry/sessionUsageIndex';
import { HostSupervisor } from '../core/session/hostSupervisor';
import { shouldAutoResume } from '../core/session/resumePolicy';
import {
  currentState,
  refreshPermissionScript,
  installHooks as writeHooks,
  settingsModifiedAtMs,
  settingsPath,
  uninstallHooks as removeHooks,
} from '../claude/hookInstall';
import { hookLogDir } from '../claude/hookLog';
import { ProjectsService } from '../claude/projects';
import { transcriptPathFor } from '../claude/transcriptHistory';
import { fetchUsage } from '../claude/usageFetch';
import { ArchiveService } from '../core/archive';
import { attentionNotice } from '../core/menuBar';
import { DecoratedSessions } from '../core/sessionView';
import { ColumnPrefsService } from '../core/columnPrefs';
import { readConfig, type ConfigGetter } from '../core/config';
import { DictationService } from '../core/dictation';
import { FavouriteProjectsService } from '../core/favouriteProjects';
import { HiddenProjectsService } from '../core/hiddenProjects';
import { CapabilityCatalog } from '../core/capabilityCatalog';
import { MAX_NICKNAME_LENGTH, NicknameService } from '../core/nicknameService';
import { autoPauseDecision, maxUsagePercent } from '../core/autoPause';
import { PauseService } from '../core/pauseService';
import { readStoppedPids } from '../core/procTree';
import { SessionStore } from '../core/sessionStore';
import { TurnStats } from '../core/turnStats';
import { FileUsageCache } from '../core/usageCache';
import { UsageService } from '../core/usageService';
import { FileSuggestService } from '../core/fileSuggest';
import { RemoteDaemonLink } from '../remote/daemon/client';
import { DISCORD_BOT_TOKEN_KEY } from '../remote/paths';
import { doneNoticeFor, type RemoteNotice } from '../shared/remote';
import type { PermissionModeName } from '../shared/conversation';
import type { HostServices, WorkbenchSurface } from '../host/hostServices';
import { displayLabel, displayTitle, GLOBAL_PROJECT_DIR, STATUS_LABEL, type AgentSession, type SessionStatus } from '../shared/model';
import type { SessionActions } from '../ui/actions';
import type {
  ControlDelegateResult as DelegateResult,
  ControlTaskProposeParams as ProposeTaskRequest,
  ControlTaskProposeResult as ProposedTask,
  ControlTaskView as TaskSummary,
  RunBy,
  StopOutcome,
} from '../core/control/protocol';
import type {
  ConversationLauncher,
  MissionSource,
  ProjectSource,
  RunnerOwnership,
  TaskBadgeSource,
  UsageSource,
} from '../ui/dashboardHost';
import { missionViewOf } from '../orchestration/view/missionViews';
import type { TaskPaneSource } from '../ui/conversation/conversationHost';
import { adoptActionFor } from '../ui/openTarget';
import { resumeInTerminal } from '../ui/terminal';

/** How long to let a session emit its first hook event before calling hooks broken. */
const HOOK_HEALTH_GRACE_MS = 90_000;

/**
 * A transcript touched this recently is being driven by something. Used only to
 * refuse an automatic resume — see `resumeLastRunner`. Deliberately short: this
 * is "somebody is definitely there", not "nobody is".
 */
const RECENT_TRANSCRIPT_WRITE_MS = 90_000;

/**
 * How long `aw delegate` waits for the planner's decision before answering
 * `planning`. Under the two minutes an agent's shell command gets by default,
 * so the agent that ran it is not cut off; the card shows the decision anyway.
 */
const DELEGATE_WAIT_MS = 100_000;

/**
 * Icons for the session picker. VSCode renders `$(name)` as a codicon; a host
 * with no codicon font should strip them rather than show the source.
 */
export const QUICKPICK_ICON: Record<SessionStatus, string> = {
  blocked: '$(shield)',
  waiting: '$(bell)',
  done: '$(check)',
  busy: '$(play)',
  stuck: '$(warning)',
  ended: '$(circle-slash)',
};

/**
 * Everything a front end needs: the services to build its panes from, and the
 * behaviours its commands and menus invoke.
 */
export interface AgentWranglerApp {
  // --- services the panes are constructed from ---
  store: SessionStore;
  provider: ClaudeProvider;
  codexProvider: CodexProvider;
  runners: RunnerService;
  codexRunners: CodexRunnerService;
  /** Every session this process runs, Claude or Codex, by id. */
  sessions: SessionExecutors;
  /** Every session this app runs and what became of each, across restarts. */
  sessionRegistry: SessionRegistry;
  runnerOwnership: RunnerOwnership;
  archive: ArchiveService;
  nicknames: NicknameService;
  columns: ColumnPrefsService;
  /** Every model the CLIs report, by capability, with AW's tier for each (#29). */
  models: CapabilityCatalog;
  /** Registered local model endpoints (#51): Preferences → Orchestration → Local endpoints. */
  localEndpoints: LocalEndpointService;
  /** What local models have done (§19.4), from the telemetry log. */
  localMetrics: LocalMetricsIndex;
  /** Automatic routing's gate and the shadow comparison report (#42), from the telemetry log, computed now. */
  autoRouting: () => { gate: GateResult; report: ComparisonReport };
  /** Fires when a routing or attempt record is added: the gate and the report may have moved. */
  onDidChangeRoutingEvidence: (listener: () => void) => { dispose(): void };
  pause: PauseService;
  usage: UsageSource;
  codexUsage: UsageSource;
  projects: ProjectSource;
  launcher: ConversationLauncher;
  /**
   * Orchestration as the two panes see it: row chips and the task strip (#34).
   * Absent while orchestration is off, and the panes then draw neither.
   */
  taskPanes?: TaskBadgeSource & TaskPaneSource;
  /** The table's Missions view (#43). Absent while orchestration is off. */
  missions?: MissionSource;
  dictation: DictationService;
  files: FileSuggestService;
  actions: SessionActions;
  getConfig: ConfigGetter;

  /**
   * Hand over the surface the panes live on. Called once, by the front end,
   * after it has built its window. Everything that has to *show* something goes
   * through this; before it is attached those behaviours run and display
   * nothing, which is what an app with no window should do.
   */
  attachSurface(surface: WorkbenchSurface): void;

  // --- the behaviours commands and menus invoke ---
  /** Start a conversation this process runs itself. No cwd: ask which folder. */
  newConversation(cwd?: string): Promise<SessionHandle | undefined>;
  /**
   * Live sessions, for the quit decision: `hosted` Claude ones run in session
   * hosts and survive a quit; `local` ones (in-process Claude, and Codex
   * threads without the background server) do not. Codex threads on the
   * background server are in neither: they keep running on their own terms.
   */
  sessionCounts(): { hosted: number; local: number };
  /** Who runs this session: AW somewhere that survives a quit, AW in-process, or not AW. */
  runBy(sessionId: string): RunBy;
  /**
   * End the process running a session, with no dialog: `aw stop`. The menu's
   * Stop… asks first and then does the same. A session mid-turn is left alone
   * (`working`) unless `force`, since stopping it throws the turn away.
   */
  stopSession(key: string, opts?: { force?: boolean }): Promise<StopOutcome | 'gone'>;
  /**
   * `aw task` (#80): assess and route a task, and leave the proposal waiting
   * for the user — announced by a notification whose click opens it, and in
   * the Tasks menu. Launches nothing. Throws `TaskError` for anything the
   * caller should read (orchestration off, not a repository, no catalog).
   */
  proposeTask(req: ProposeTaskRequest): Promise<ProposedTask>;
  /**
   * `aw delegate` (#82): hand an outcome over and let the planner decide one
   * task or several. Answers once it has decided (or after a bounded wait,
   * as `planning`); the card in the origin conversation shows the rest.
   * Launches nothing. Throws `TaskError` for anything the caller should read.
   */
  delegate(req: ProposeTaskRequest): Promise<DelegateResult>;
  /** Tasks that are not finished, newest first. Empty while orchestration is off. */
  taskList(): TaskSummary[];
  /**
   * The app is quitting: end the sessions that cannot survive it (and hosted
   * ones too with `includeHosted`), awaited and bounded by `withinMs`. Ended
   * ones stay resumable (interrupted); hosted ones left running are adopted
   * on the next start.
   */
  stopAllForQuit(withinMs: number, opts?: { includeHosted?: boolean }): Promise<void>;
  /**
   * The machine woke from sleep (`powerMonitor` `resume`): heartbeats missed
   * across the sleep are forgotten and each host link rechecks at once, and
   * the Discord gateway reconnects now rather than at its next heartbeat (§8).
   */
  onSystemResume(): void;
  startCodexConversation(cwd: string): Promise<void>;
  /** Restart the background Codex server (e.g. to pick up a Codex update). Asks first if it would interrupt anything. */
  restartCodexServer(): Promise<void>;
  browseForProject(): Promise<string | undefined>;
  refresh(): void;
  pauseAll(wanted: boolean): void;
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
  /** Experimental: store a Discord bot token and open the connection. */
  connectDiscord(): Promise<{ ok: boolean; lines: string[] }>;
  /** Forget the token and close the connection. */
  disconnectDiscord(): Promise<{ ok: boolean; lines: string[] }>;
  /** Check every part of the remote setup, reporting each in a dialog. */
  testRemoteControl(): Promise<void>;
  /** The same actions, for the Preferences window, reporting in place. */
  runSettingAction(id: 'connectDiscord' | 'testRemote' | 'disconnectDiscord'): Promise<{ ok: boolean; lines: string[] }>;
  /** The session picker, for commands invoked without one. */
  pickSession(filter?: (s: AgentSession) => boolean): Promise<AgentSession | undefined>;
  /** Wrap a key-taking action so it asks which session when given nothing. */
  withSession(fn: (key: string) => void, filter?: (s: AgentSession) => boolean): (key?: unknown) => Promise<void>;

  /**
   * Begin: register the providers, start the usage pollers, check the hooks,
   * and bring back the conversation this process was running before it
   * restarted. Separate from construction so a front end can attach its surface
   * first and see the first scan land in it.
   */
  start(): void;
  dispose(): void;
}

export function createApp(host: HostServices): AgentWranglerApp {
  const log = (msg: string) => host.log(msg);
  const dialogs = host.dialogs;
  const getConfig: ConfigGetter = () => readConfig(host.settings);

  /** Attached by the front end once its window exists. See `attachSurface`. */
  let surface: WorkbenchSurface | undefined;

  const store = new SessionStore();
  // Turn durations are a property of how this person works, not of one folder,
  // so the baseline is global state shared across windows.
  const turnStats = new TurnStats(host.globalState);
  const provider = new ClaudeProvider(getConfig, log, turnStats);
  const codexProvider = new CodexProvider(getConfig, log);
  // Codex threads run in one AW-owned app-server. By default it is detached
  // (`CodexHost`), so a quit, crash or reinstall of the app leaves its turns
  // and pending asks running; the fallback is a `--stdio` child that ends with
  // the app. Read once: switching needs a restart.
  const codexKeepAlive = host.settings.get<boolean>('codexRunner.keepAcrossRestarts', true);
  const codexHost = new CodexHost({
    baseDir: host.dataDir,
    binary: () => resolveCodexBinary(getConfig().codexBinaryPath),
    log,
  });
  const codexAppServer = new CodexAppServer(
    codexKeepAlive ? hostConnector(codexHost) : () => getConfig().codexBinaryPath,
    log,
  );
  const models = new CapabilityCatalog(host.globalState, host.settings);
  host.subscribe(models);
  // Registered local endpoints (#51): probed, health-checked, keys in
  // safeStorage. Their models join the catalog unassigned. `localTelemetry`
  // is bound once the telemetry log exists, below.
  let localTelemetry: (record: TelemetryRecord) => boolean = () => false;
  const localEndpoints = new LocalEndpointService({
    settings: host.settings,
    secrets: host.secrets,
    storage: host.globalState,
    log,
    telemetry: { append: (record) => localTelemetry(record) },
    promptKey: (endpoint) =>
      dialogs.input({
        title: `Key for ${endpoint.name}`,
        prompt: 'The API key the endpoint expects, if it expects one. Stored in the system keychain, never in settings.',
        password: true,
      }),
  });
  host.subscribe(localEndpoints);
  models.setLocal(localEndpoints.reports());
  host.subscribe(localEndpoints.onDidChange(() => models.setLocal(localEndpoints.reports())));
  // Session hosts first (playbook §7.3 step 1): which sessions a previous run
  // left running in hosts that are still alive. Nothing may classify, resume
  // or adopt a session before this is known, or AW could end or double-resume
  // its own surviving session.
  const hostSupervisor = host.sessionHosts
    ? new HostSupervisor({
        runDir: host.sessionHosts.runDir,
        fallbackRunDir: host.sessionHosts.fallbackRunDir,
        logDir: host.sessionHosts.logDir,
        runtime: host.sessionHosts.runtime,
        log,
        build: host.sessionHosts.runtime.buildId,
        orphanIdleHours: () => host.settings.get<number>('lifecycle.orphanIdleHours', 24),
        endpointKey: (ref) => localEndpoints.keyByRef(ref),
      })
    : undefined;
  const hostScan = hostSupervisor?.scan() ?? { alive: [], dead: [], foreign: [] };
  // Then classify what the last run left behind (§7.3): every session that
  // was live is interrupted, except those still running in a host (including
  // one this build cannot talk to, which must not look ownerless), and those
  // whose host has since died and said why in its exit record (ended, failed,
  // parked by the idle rule, or lost: no record at all). Decided before the
  // interrupted list exists, so auto-resume never picks a session whose host
  // finished, failed or crashed. The old runner registry is imported once
  // from the surface store.
  const sessionRegistry = new SessionRegistry(host.sessionState, { legacy: host.workspaceState });
  const startup = sessionRegistry.startup(
    new Set(
      [...hostScan.alive, ...hostScan.foreign].map((m) => m.sessionId).filter((id): id is string => typeof id === 'string'),
    ),
    outcomesFromDeadHosts(hostScan.dead, hostScan.dead.some((m) => !m.exit) ? bootTimeMs() : undefined),
  );
  if (startup.interrupted.length > 0) {
    log(`${startup.interrupted.length} session(s) were interrupted by the last restart`);
  }
  for (const m of hostScan.foreign) {
    log(`host ${m.hostId} (session ${m.sessionId}) runs a manifest version this build does not know; leaving it alone`);
  }
  hostSupervisor?.collect(hostScan);

  // ---- The orphan sweep (§7.3) ----
  //
  // Nothing stops a second `claude` resuming an id that one is still running
  // (spike S1), so before any resume, whatever runs the id is accounted for,
  // and a `claude` whose host died is ended and waited for. One sweep per id
  // at a time: a second caller shares the one in flight.
  const sweeps = new Map<string, Promise<SweepResult>>();
  const sweepSession = (sessionId: string): Promise<SweepResult> => {
    const id = sessionId.toLowerCase();
    const running = sweeps.get(id);
    if (running) return running;
    const sweep = sweepOrphans(sessionId, {
      entries: () => readProcessEntries(sessionsDir()),
      heldAgentPids: () => hostSupervisor?.heldAgentPids() ?? new Set(),
      // The only processes it may end: agents a dead host's manifest names
      // (pid + start time, #62). Anything else is take-over, confirmed.
      lostAgents: (id) => hostSupervisor?.lostAgents(id) ?? [],
      isAlive: isPidAlive,
      startTimeOf,
      parentOf: parentPidOf,
      kill: (pid, sig) => process.kill(pid, sig),
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    })
      .then((r) => {
        if (r.swept.length > 0 || !r.clear) {
          log(`orphan sweep for ${sessionId}: swept [${r.swept.join(', ')}], refused [${r.refused.join(', ')}], owners [${r.owners.join(', ')}], held [${r.held.join(', ')}]`);
        }
        return r;
      })
      .finally(() => sweeps.delete(id));
    sweeps.set(id, sweep);
    return sweep;
  };
  /** Resolves when nothing else runs the id; rejects with the reason otherwise. */
  const beforeResume = async (sessionId: string): Promise<void> => {
    const why = sweepRefusal(await sweepSession(sessionId));
    if (why) throw new Error(why);
  };
  // Hosts that died with no exit record while the app was away: their agents
  // may still be running headless. Sweep now; once the id is clear the
  // manifest has served its purpose.
  for (const m of hostScan.dead) {
    if (m.exit || !m.sessionId) continue;
    log(`host ${m.hostId} (session ${m.sessionId}) died without an exit record; sweeping for its agent`);
    void sweepSession(m.sessionId)
      .then((r) => {
        if (r.clear) hostSupervisor?.forget(m);
      })
      .catch((err) => log(`orphan sweep for ${m.sessionId} failed: ${String(err)}`));
  }
  const locate = (cwd: string) => checkoutFor(cwd);
  const codexRunners = new CodexRunnerService(codexAppServer, (list) => models.remember('openai', list), {
    registry: sessionRegistry,
    locate,
    log,
    // A thread on a local endpoint gets the endpoint's key per request; it is never recorded.
    endpointKey: (ref) => localEndpoints.keyByRef(ref),
  });
  host.subscribe(codexRunners);
  store.useLiveSessions((session) => session.provider === 'codex' ? codexRunners.get(session.sessionId)?.session : undefined);
  host.subscribe(codexRunners.onDidChange(() => void store.refresh()));
  const archive = new ArchiveService(host.globalState);
  // Which agents are frozen. Nothing is persisted: the answer is the process
  // state itself, which every window reads the same way and which a reload
  // cannot lose. See the header of pauseService.ts for why the persisted
  // version of this was wrong.
  const pause = new PauseService(
    {
      signal: (pid, sig) => process.kill(pid, sig),
      isAlive: isPidAlive,
      stopped: readStoppedPids,
    },
    log,
  );
  // The names the user gave sessions. Global state like the archive: both are
  // about the session, not about the window looking at it.
  const nicknames = new NicknameService(host.globalState);
  // Applied in the store rather than at each render, because the dashboard, the
  // conversation pane, the status bar, the quick picks, the toasts and the
  // terminal label do not share a decoration step — only the store.
  store.useNicknames((key) => nicknames.get(key));
  // A rename changes nothing a provider scan would notice, so the store has to
  // be told to re-apply and re-fire, or the new name waits for the session to
  // do something before it appears.
  host.subscribe(nicknames.onDidChange(() => store.renameApplied()));
  // Column widths and the hidden set: a preference, so global state rather than
  // per-webview state — the same layout in the editor tab, the app, and after
  // a restart.
  const columns = new ColumnPrefsService(host.globalState);
  host.subscribe({ dispose: () => store.dispose() }); // store disposes providers

  // Plan usage for the cards above the table — the same numbers as Claude
  // Code's /usage, read with the login token Claude Code stored. The cache is
  // in the host's storage directory so every window shares one read per interval.
  const usage = new UsageService(
    fetchUsage,
    new FileUsageCache(path.join(host.storageDir, 'usage.json')),
    getConfig,
    log,
  );
  host.subscribe(usage);
  const codexUsage = new UsageService(
    codexUsageReader(codexAppServer),
    new FileUsageCache(path.join(host.storageDir, 'codex-usage.json')),
    getConfig,
    (message) => log(`codex ${message}`),
  );
  host.subscribe(codexUsage);
  host.subscribe(
    host.settings.onDidChange((affects) => {
      // autoPause.enabled belongs here too: it decides whether usage is read at
      // all when the cards are hidden, so turning it on must start the reads.
      if (
        affects('showUsage') ||
        affects('usagePollIntervalSeconds') ||
        affects('autoPause.enabled') ||
        affects('autoPause.percent')
      ) {
        void usage.refresh();
        void codexUsage.refresh();
      }
    }),
  );

  // Sessions this process runs itself, through the Agent SDK. The binary is
  // resolved per start so changing the setting does not need a restart.
  // `rememberModels`: what the launcher's model dropdown offers is the list the
  // last conversation reported, since the launcher has no running CLI to ask.
  const runners = new RunnerService({
    query: sdkQuery,
    binary: () => resolveClaudeBinary(getConfig().claudeBinaryPath),
    log,
    registry: sessionRegistry,
    locate,
    rememberModels: (list) => models.remember('anthropic', list),
    localKey: (ref) => localEndpoints.keyByRef(ref),
    // Experimental until the Stage 4 soak: new sessions run in hosts only
    // with the setting on. Surviving hosts are adopted either way.
    hosts: hostSupervisor
      ? { supervisor: hostSupervisor, enabled: () => host.settings.get<boolean>('experimental.sessionHosts', false) }
      : undefined,
    beforeResume,
    onHostLost: (id) => void sweepSession(id).catch((err) => log(`orphan sweep for ${id} failed: ${String(err)}`)),
  });
  host.subscribe(runners);
  host.subscribe(
    host.settings.onDidChange((affects) => {
      if (affects('lifecycle.orphanIdleHours')) runners.reconfigureAll();
    }),
  );
  const sessions = new SessionExecutors([runners, codexRunners]);
  // Qualification stage 2 (§19.6): scratch-repo tasks as Codex threads on the
  // endpoint, through the same harness adapter a routed attempt uses, whether
  // or not orchestration is on. The fixtures are copied next to the bundle by
  // the build (`dist/qualification-fixtures`, from `src/orchestration/local/qualification-fixtures`).
  localEndpoints.useTaskQualifier(
    taskQualifier({
      harness: new CodexHarness({ sessions, models: () => [], localProvider: (s, m) => localEndpoints.codexProvider(s, m) }),
      fixturesDir: path.join(__dirname, '..', 'qualification-fixtures'),
      log,
    }),
  );
  localEndpoints.useTaskQualifier(
    taskQualifier({
      harness: new ClaudeCodeHarness({ sessions, models: () => [], localProvider: (s, m) => localEndpoints.claudeProvider(s, m) }),
      fixturesDir: path.join(__dirname, '..', 'qualification-fixtures'),
      log,
    }),
    'claude-code',
  );

  // Take back every session still running in a host, before the providers'
  // first scan: each is ours from the first snapshot, never an external
  // session to take over or a stale one to resume.
  // A host with no record gets one rebuilt from its manifest, so it comes back
  // the way it was launched rather than on the defaults (#72).
  for (const manifest of hostScan.alive) {
    const rebuilt = manifest.sessionId && !sessionRegistry.get(manifest.sessionId) ? recordFromManifest(manifest) : undefined;
    if (rebuilt) {
      const place = locate(manifest.cwd);
      sessionRegistry.live({ ...rebuilt, repoRoot: place.repoRoot, worktree: place.worktree, branchAtStart: place.branch });
      log(`session ${manifest.sessionId}: no record for its host ${manifest.hostId}; rebuilt from the manifest`);
    }
    runners.adopt(manifest, sessionRegistry.get(manifest.sessionId));
  }

  // One typed reader for launch settings (#26), instead of ad hoc reads here.
  const launchDefaults = new LaunchDefaults(host.settings);
  /**
   * How to start a Claude session: the way it was started before, if the
   * registry remembers (a resume should come back on the same model, mode and
   * effort), otherwise the current defaults.
   */
  const claudeLaunch = (previous?: SessionRecord) => {
    const launch = launchDefaults.resumed('claude', previous?.launch);
    if (!previous || isOrchestrationOrigin(previous.origin)) return launch;
    return { ...launch, policy: { ...launch.policy, claude: { ...launch.policy?.claude, conversationInstructions: withConversationDelegation(launch.policy?.claude?.conversationInstructions) } } };
  };

  // #4's startup is settled once hosts are adopted (above, synchronously) and
  // Codex threads are rejoined (in `start()`). Orchestration's recovery waits for it.
  let settleStartup: () => void = () => undefined;
  const startupSettled = new Promise<void>((resolve) => (settleStartup = resolve));
  // Per-turn usage for every session AW runs (#27): local JSONL, metadata only,
  // on by default and switched off by `telemetry.enabled`. Attempt records (#33) go in the same log.
  const telemetryDir = path.join(host.dataDir, 'orchestration', 'telemetry');
  const telemetryLog = new TelemetryLog(telemetryDir);
  // Local observability (§19.4, #51): attempt and local-call records, folded per local model.
  const localMetrics = new LocalMetricsIndex();
  host.subscribe(localMetrics);
  void localMetrics.load(telemetryDir).catch((err) => log(`telemetry: could not read local metrics: ${String(err)}`));
  // Automatic routing's evidence (§27.3, #42): routing and attempt records.
  const routingEvidence = new RoutingEvidenceIndex();
  host.subscribe(routingEvidence);
  void routingEvidence.load(telemetryDir).catch((err) => log(`telemetry: could not read routing evidence: ${String(err)}`));
  // Routing analytics (§17, #49): every record the analytics view reads, read-only.
  const analyticsIndex = new AnalyticsIndex();
  host.subscribe(analyticsIndex);
  void analyticsIndex.load(telemetryDir).catch((err) => log(`telemetry: could not read analytics records: ${String(err)}`));
  const autoRouting = (): { gate: GateResult; report: ComparisonReport } => {
    const input = { records: routingEvidence.records(), tiers: models.catalog.tiers.map((t) => t.name) };
    return {
      gate: evaluateGate({ ...input, corpus: CORPUS_STATUS, routerVersion: ROUTER_VERSION, assessorVersion: ASSESSOR_VERSION }),
      report: comparisonReport(input),
    };
  };
  const appendTelemetry = (record: TelemetryRecord): boolean => {
    if (host.settings.get<boolean>(TELEMETRY_ENABLED_KEY, true) === false) return false;
    const written = telemetryLog.append(record);
    if (written) {
      localMetrics.add(record);
      routingEvidence.add(record);
      analyticsIndex.add(record);
    }
    return written;
  };
  const turnRecords = new Emitter<TurnRecord>();
  host.subscribe(turnRecords);
  /** Attempts running now on each local endpoint. */
  const localBusy = (): Record<string, number> => {
    const busy: Record<string, number> = {};
    for (const m of orchestration.tasks?.list() ?? []) {
      // Every task's: a parallel mission (#46) can have several running.
      for (const t of m.tasks) {
        const a = orchestration.tasks!.currentAttempt(m, t.id);
        if (!a || !['launching', 'running', 'waiting-human'].includes(a.state)) continue;
        const source = m.decisions.find((d) => d.id === a.routingDecisionId)?.resolution.target.source;
        if (source && isEndpointSource(source)) busy[source] = (busy[source] ?? 0) + 1;
      }
    }
    return busy;
  };
  // Behind `orchestration.enabled` (off by default): tasks (#33) and nothing else yet.
  const orchestration = createOrchestration({
    settings: host.settings,
    dataDir: host.dataDir,
    sessions,
    registry: sessionRegistry,
    // G1: an attempt must survive `app:install`, so Claude attempts need hosts.
    hostsEnabled: () => !!hostSupervisor && host.settings.get<boolean>('experimental.sessionHosts', false) === true,
    onTurnRecord: (listener) => turnRecords.event(listener),
    telemetry: {
      append: (record) => appendTelemetry(record),
    },
    notify: host.notify,
    openFile: (file) => host.shell.openFile(file),
    // A delegation's notification brings up the conversation that delegated it, where its card is (#82).
    showOrigin: (origin) => {
      const s = store.get(originKey(origin));
      if (s) surface?.show(s.key);
    },
    launchDefaults,
    startupSettled,
    log,
    models: () => models.value,
    completion: { query: sdkQuery, binary: () => resolveClaudeBinary(getConfig().claudeBinaryPath) },
    // What the resolver decides against (#38): the catalog as it stands, and each source's usage window.
    routingSnapshot: () => {
      const now = Date.now();
      return {
        catalog: models.catalog,
        sources: {
          anthropic: sourceStatus('anthropic', usage.usage, now),
          openai: sourceStatus('openai', codexUsage.usage, now),
          // Slots are concurrency (§19.2): attempts running on an endpoint hold one each.
          ...localEndpoints.statuses(localBusy()),
        },
        now,
      };
    },
    local: { service: localEndpoints, catalog: () => models.catalog },
    // The scheduler (#45): nothing starts while the fleet is paused (every
    // live agent frozen, as Pause all and auto-pause leave it), and a mission's
    // "Pause now" uses the same PauseService. Usage, pause and endpoint changes step it.
    scheduling: {
      fleet: {
        paused: () => {
          if (pause.count === 0) return false;
          const live = store.sessions.filter((s) => s.status !== 'ended' && s.pid !== undefined);
          return live.length > 0 && live.every((s) => pause.isPaused(s.pid));
        },
        pauseSession: (id) => {
          const s = store.sessions.find((x) => x.sessionId === id);
          const outcome = s ? pause.pause(s.pid) : 'gone';
          return outcome === 'paused' || outcome === 'already';
        },
        resumeSession: (id) => {
          const s = store.sessions.find((x) => x.sessionId === id);
          const outcome = s ? pause.resume(s.pid) : 'gone';
          return outcome === 'resumed' || outcome === 'already';
        },
      },
      onDidChange: (listener) => {
        const subs = [usage.onDidChange(listener), codexUsage.onDidChange(listener), pause.onDidChange(listener), localEndpoints.onDidChange(listener)];
        return { dispose: () => subs.forEach((s) => s.dispose()) };
      },
    },
  });
  host.subscribe(orchestration);
  localTelemetry = appendTelemetry;
  localEndpoints.start();

  // What each session has used, summed from its records, on every surface's
  // copy of the session (#28): the Usage column and the conversation header.
  const sessionUsage = new SessionUsageIndex();
  host.subscribe(sessionUsage);
  store.useUsage((id) => sessionUsage.get(id));
  host.subscribe(sessionUsage.onDidChange(() => store.usageApplied()));
  void sessionUsage.load(telemetryDir).catch((err) => log(`telemetry: could not read past records: ${String(err)}`));
  const turnTelemetry = new TurnTelemetry({
    sessions,
    log: telemetryLog,
    onRecord: (record) => {
      sessionUsage.add(record);
      turnRecords.fire(record);
    },
    onModelLimits: (model, limits) => models.observe('anthropic', model, limits),
    enabled: () => host.settings.get<boolean>(TELEMETRY_ENABLED_KEY, true) !== false,
    prices: () => {
      const table = host.settings.get<unknown>(TELEMETRY_PRICES_KEY, undefined);
      return table && typeof table === 'object' ? (table as PriceTable) : undefined;
    },
    appliedEffort: (id) => provider.appliedEffort(id),
    registry: sessionRegistry,
    logLine: log,
  });
  host.subscribe(turnTelemetry);
  /** The permission cards a runner shows as still pending, oldest first. */
  const hostedPermissions = (handle: RunnerView) =>
    handle.blocks.filter(
      (b): b is Extract<RunnerView['blocks'][number], { kind: 'permission' }> => b.kind === 'permission' && b.state === 'pending',
    );
  const runnerOwnership: RunnerOwnership = {
    owns: (id: string | undefined) => sessions.owns(id),
    // Interrupted by the last restart and not running here now, either provider.
    wasRunning: (id: string) => !sessions.owns(id) && sessionRegistry.isInterrupted(id),
    pendingQuestion: (id: string | undefined) => {
      const question = sessions.get(id)?.pendingQuestion;
      return question ? { requestId: question.requestId, questions: question.questions } : undefined;
    },
    answer: async (id: string | undefined, requestId: string, answers: Record<string, string>) => {
      const handle = sessions.get(id);
      return handle ? (await handle.answer(requestId, answers)) === 'applied' : false;
    },
    // Only Claude has plans: Codex has no plan-mode concept, and its handle
    // never reports one.
    pendingPlan: (id: string | undefined) => {
      const plan = sessions.get(id)?.pendingPlan;
      return plan ? { requestId: plan.requestId, plan: plan.plan, more: plan.more } : undefined;
    },
    decidePlan: async (id: string | undefined, requestId: string, approve: boolean, feedback?: string) => {
      const handle = sessions.get(id);
      return handle ? (await handle.decidePlan(requestId, approve, feedback)) === 'applied' : false;
    },
    // Hosted sessions only: an in-process runner's prompt still reaches the
    // hook file, which the row answers as for any session.
    pendingPermission: (id: string | undefined) => {
      const handle = runners.get(id);
      if (!handle?.hosted) return undefined;
      const ask = hostedPermissions(handle).at(-1);
      return ask
        ? { requestId: ask.requestId, toolName: ask.toolName, ask: { summary: ask.summary, body: ask.body, isCommand: ask.isCommand } }
        : undefined;
    },
    rateLimit: (id: string | undefined) => sessions.get(id)?.rateLimit,
    onDidChange: (listener: () => void) => sessions.onDidChange(listener),
  };

  /**
   * Take a session over: end whatever runs it, then resume the same id here.
   *
   * The whole move rests on one fact — a Claude Code conversation *is* its
   * transcript, and resuming an id appends to the same file — so an idle
   * session survives the handover intact. What it cannot survive is a turn in
   * flight, which is why the offer is withdrawn while one is running and
   * re-checked here in case it started between the click and the confirm.
   */
  const adoptSession = async (s: AgentSession, confirm = true, signal?: AbortSignal) => {
    let kind = adoptActionFor(s, runners.owns(s.sessionId));
    if (!kind || !s.cwd) return;
    if (!fs.existsSync(s.cwd)) {
      dialogs.error(`Agent Wrangler: ${s.cwd} no longer exists.`);
      return;
    }
    // A live session host this app is not following holds it (one whose
    // manifest this build cannot read): never taken over or resumed around
    // it (§7.3). Stopping that host is offered instead.
    const held = hostSupervisor?.heldBy(s.sessionId);
    if (held && !runners.owns(s.sessionId)) {
      await offerStopHost(held.manifest, displayLabel(s));
      return;
    }
    // A `claude` whose host died is ended first, and waited for (§7.3). If
    // that is the process this row was showing, there is no owner left to
    // take over from: it is a plain resume.
    const swept = await sweepSession(s.sessionId);
    if (s.pid !== undefined && swept.swept.includes(s.pid)) kind = 'resume-here';
    if (signal?.aborted) throw new Error('Send cancelled; your draft is preserved.');

    if (kind === 'adopt') {
      const choice = !confirm ? 'Take over' : await dialogs.warn(
        `Take over ${displayLabel(s)} in this window?`,
        {
          modal: true,
          detail:
            (s.statusIsEstimated ? 'Status is estimated. This may interrupt a turn in flight; that unfinished turn can be lost.\n\n' : '') +
            'The process running it now ends, and this window resumes the same session. Its terminal ' +
            'or Claude Code panel will show it as ended.\n\n' +
            'The conversation is kept — it lives in the transcript — and you can hand it back at any time.',
        },
        'Take over',
      );
      if (choice !== 'Take over') return;
      if (signal?.aborted) throw new Error('Send cancelled; your draft is preserved.');

      // It may have started a turn while the dialog was up.
      const now = store.get(s.key) ?? s;
      if (adoptActionFor(now, runners.owns(now.sessionId)) !== 'adopt') {
        void dialogs.info(
          `Agent Wrangler: ${displayLabel(now)} started working again; take it over once it is idle.`,
        );
        return;
      }

      const live = (await readRegistry(sessionsDir())).filter((entry) => entry.sessionId === now.sessionId);
      if (live.length > 1 || (live.length === 1 && live[0].pid !== now.pid)) throw new Error('Session ownership changed; takeover cancelled.');
      if (now.pid !== undefined && isPidAlive(now.pid) && !live.some((entry) => entry.pid === now.pid)) throw new Error('Cannot verify this process belongs to the session.');
      if (!confirm && live.some((entry) => entry.liveStatus && entry.liveStatus !== 'idle')) throw new Error('Session is no longer idle; your draft is preserved.');
      if (signal?.aborted) throw new Error('Send cancelled; your draft is preserved.');
      if (!confirm && ((store.get(s.key) ?? now).statusIsEstimated || adoptActionFor(store.get(s.key) ?? now, runners.owns(s.sessionId)) !== 'adopt')) throw new Error('Session started working again; your draft is preserved.');
      if (now.pid !== undefined) {
      // A stopped process cannot act on SIGTERM, so ending a paused session
      // would burn the whole grace period and then SIGKILL it — the one outcome
      // that can strand a half-written transcript line. Let it run first.
        if (pause.isPaused(now.pid)) pause.resume(now.pid);
        // Checked against the start time Claude Code recorded before every signal.
        const outcome = await endProcess(now.pid, processControl, live[0]?.procStart);
        log(`adopt ${now.sessionId}: ending pid ${now.pid} → ${outcome}`);
        if (outcome === 'refused') {
          dialogs.error(
            `Agent Wrangler: could not stop the process running ${displayLabel(now)}, so it was not taken over. ` +
              'Two processes on one session would corrupt its transcript.',
          );
          return;
        }
      }
    }

    if ((await readRegistry(sessionsDir())).some((entry) => entry.sessionId === s.sessionId)) throw new Error('Another live process owns this session; takeover cancelled.');
    if (signal?.aborted) throw new Error('Send cancelled; your draft is preserved.');
    if (s.pid !== undefined && isPidAlive(s.pid)) throw new Error('The previous process is still alive; takeover was cancelled.');
    if (s.status !== 'ended' && s.pid === undefined) throw new Error('Cannot prove the previous process has stopped.');
    // A session AW ran before comes back the way it was started; one from a
    // terminal gets the current defaults.
    const previous = sessionRegistry.get(s.sessionId);
    const runner = await runners.resume({ cwd: s.cwd, resume: s.sessionId, ...claudeLaunch(previous), origin: previous?.origin });
    surface?.showSession(runner);
    log(`adopted ${s.sessionId} into this window`);
    return runner;
  };

  /** How AW signals a pid it means to end: start-time checked when the caller knows the start time. */
  const processControl = {
    kill: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => process.kill(pid, sig),
    isAlive: isPidAlive,
    startTimeOf,
    delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };

  /**
   * A session held by a live host this app cannot follow (§7.3: unreachable,
   * or a manifest version it does not know). Its session must not be
   * resumed or taken over while that host lives; the choices are to stop the
   * host (which ends its agent the way a logout does) or to leave it.
   */
  const offerStopHost = async (manifest: HostManifest, label: string): Promise<void> => {
    const choice = await dialogs.warn(
      `${label} is held by a background session host this version of Agent Wrangler cannot talk to.`,
      {
        modal: true,
        detail:
          'It may still be working. Stopping the host ends its agent gracefully; the conversation is kept in its ' +
          'transcript and can be resumed afterwards. Leave it to let it carry on.',
      },
      'Stop host',
      'Leave',
    );
    if (choice !== 'Stop host' || !hostSupervisor) return;
    const outcome = await hostSupervisor.stopHost(manifest);
    if (outcome === 'refused') {
      dialogs.error(`Agent Wrangler: the host holding ${label} did not stop. See the log.`);
      return;
    }
    if (manifest.sessionId && !runners.owns(manifest.sessionId)) sessionRegistry.setState(manifest.sessionId, 'interrupted', 'host stopped');
    dialogs.flash(`Agent Wrangler: stopped the host holding ${label}. Resume it when you are ready.`, 5000);
    void store.forceRefresh();
  };

  /**
   * End the process running a session, and stop there.
   *
   * This is not `adopt` without the resume, and not `release` either: both of
   * those hand the session on to something else, and this deliberately hands it
   * to nobody. What makes that safe to offer is the same fact they rest on — a
   * conversation *is* its transcript, whichever provider wrote it — so closing a
   * session is parking it, not destroying it. The row moves to Ended and
   * `claude --resume` (or Take over, for Codex) picks it up where it stopped.
   *
   * Three shapes of "the process running it", in the order they are tried: a
   * Claude runner this window owns, a Codex thread this window owns (there is no
   * pid to signal — one app-server serves every thread, so closing one means
   * releasing it), and anything else, which is a pid on the process table.
   *
   * A turn in flight is the one thing that does not survive, and unlike `adopt`
   * that does not withdraw the offer: the session most worth closing is the one
   * that has wedged, which is `stuck` or `busy` by definition. The modal is
   * where that cost gets stated instead.
   */
  const confirmAndCloseSession = async (
    s: AgentSession,
    opts: { confirmOnlyIfWorking?: boolean } = {},
  ): Promise<boolean> => {
    const label = displayLabel(s);
    const ours = runners.owns(s.sessionId) || codexRunners.owns(s.sessionId);
    if (!ours && s.pid === undefined) {
      void dialogs.warn(
        `Agent Wrangler: no process is known for ${label}, so there is nothing to close.`,
        {},
      );
      return false;
    }

    const working = s.status === 'busy' || s.status === 'stuck' || s.status === 'blocked';
    const elsewhere =
      s.provider === 'codex'
        ? 'The process running it ends. Its terminal or editor will show it as ended.'
        : 'The process running it ends. Its terminal or Claude Code panel will show it as ended.';
    const detail = [
      ours ? 'This window stops running the session.' : elsewhere,
      working ? 'It is working right now, and that turn is thrown away.' : '',
      'The conversation is kept — it lives in the transcript — so you can resume it later.',
    ]
      .filter(Boolean)
      .join('\n\n');

    // The dashboard row's × asks only when a turn would be thrown away: the
    // rest of the modal's text is the reassurance (transcript kept, resumable)
    // that the button's own tooltip already carries, and one click is the whole
    // point of it.
    if (!(opts.confirmOnlyIfWorking && !working)) {
      const choice = await dialogs.warn(`Close ${label}?`, { modal: true, detail }, 'Close session');
      if (choice !== 'Close session') return false;
    }

    // It may have finished, or ended on its own, while the dialog was up.
    const outcome = await closeSessionNow(store.get(s.key) ?? s);
    if (outcome === 'hostRefused') dialogs.error(`Agent Wrangler: the host holding ${label} did not stop. See the log.`);
    if (outcome === 'refused') {
      dialogs.error(
        `Agent Wrangler: could not stop the process running ${label} — it is ignoring both signals. ` +
          'End it from its own terminal.',
      );
    }
    // `nothing` counts as closed: the process was gone by the time we looked,
    // which is the state the click was asking for.
    return outcome !== 'refused' && outcome !== 'hostRefused';
  };

  /**
   * The close itself, with no dialog: what the menu's Stop… does once it has
   * been confirmed, and what `aw stop` does (the typed command is the
   * confirmation). `nothing` means there was no process to end.
   */
  const closeSessionNow = async (now: AgentSession): Promise<StopOutcome> => {
    const runner = runners.get(now.sessionId);
    if (codexRunners.owns(now.sessionId)) {
      codexRunners.release(now.sessionId);
      log(`closed ${now.sessionId}: released the Codex thread this window was running`);
    } else if (runner) {
      // A SIGSTOPped CLI can answer neither the interrupt nor SIGTERM that
      // ending it sends. Let it run first, as adopting one does.
      if (now.pid !== undefined && pause.isPaused(now.pid)) pause.resume(now.pid);
      await runners.end(runner);
      log(`closed ${now.sessionId}: ended the runner in this window`);
    } else if (now.provider === 'claude' && hostSupervisor?.heldBy(now.sessionId)) {
      // A host this app cannot follow: stop the host, which ends its agent
      // gracefully, rather than kill the agent out from under it.
      if (now.pid !== undefined && pause.isPaused(now.pid)) pause.resume(now.pid);
      const held = hostSupervisor.heldBy(now.sessionId)!;
      const outcome = await hostSupervisor.stopHost(held.manifest);
      if (outcome === 'refused') return 'hostRefused';
      if (!runners.owns(now.sessionId)) sessionRegistry.setState(now.sessionId, 'stopped');
    } else if (now.pid !== undefined) {
      // A stopped process cannot act on SIGTERM, so ending a paused session
      // would burn the whole grace period and then SIGKILL it — the one outcome
      // that can strand a half-written transcript line. Let it run first.
      if (pause.isPaused(now.pid)) pause.resume(now.pid);
      // Checked against the start time Claude Code recorded, when it did: a
      // pid reused since the row was drawn is never signalled.
      const entry = now.provider === 'claude'
        ? (await readRegistry(sessionsDir())).find((e) => e.pid === now.pid)
        : undefined;
      const outcome = await endProcess(now.pid, processControl, entry?.procStart);
      log(`close ${now.sessionId}: ending pid ${now.pid} → ${outcome}`);
      if (outcome === 'refused') return 'refused';
      if (outcome === 'already-gone') {
        void store.forceRefresh();
        return 'nothing';
      }
    } else {
      // Its process went while the dialog was up (or there never was one).
      void store.forceRefresh();
      return 'nothing';
    }
    // The registry and the transcript will both say "ended" shortly; ask now so
    // the row the user just acted on does not sit there looking alive.
    void store.forceRefresh();
    return 'stopped';
  };

  /**
   * Freeze or thaw one session.
   *
   * No confirm, deliberately. Closing a session asks first because it cannot be
   * taken back; pausing can, by pressing the same thing again, and a dialog in
   * front of the button you reach for when you are watching the last of your
   * tokens disappear is friction in exactly the wrong place.
   */
  const setPaused = (s: AgentSession, wanted: boolean): void => {
    const label = displayLabel(s);
    const outcome = wanted ? pause.pause(s.pid) : pause.resume(s.pid);
    log(`${wanted ? 'pause' : 'resume'} ${s.sessionId} (pid ${s.pid ?? '?'}) → ${outcome}`);
    if (outcome === 'gone') {
      void dialogs.warn(
        `Agent Wrangler: the process running ${label} is gone, so there was nothing to ${wanted ? 'pause' : 'resume'}.`,
        {},
      );
      return;
    }
    if (outcome === 'refused') {
      dialogs.error(
        `Agent Wrangler: could not ${wanted ? 'pause' : 'resume'} ${label} — the signal was refused. ` +
          'It may belong to another user.',
      );
      return;
    }
    dialogs.flash(`Agent Wrangler: ${label} ${wanted ? 'paused' : 'resumed'}`, 4000);
    // A resumed session starts writing again immediately; a paused one has just
    // stopped. Either way the row is out of date the moment the signal lands.
    void store.forceRefresh();
  };

  /**
   * Everything at once — the token-emergency button.
   *
   * Archived sessions are included. Archiving is about what is in the way on
   * screen, not about what is spending, and a forgotten agent grinding through
   * a plan in a folder you stopped looking at is precisely what this is for.
   */
  /**
   * How a notice reaches Discord from up here.
   *
   * A hole rather than a direct call, because `remoteControl` is constructed
   * several hundred lines below and the first usage reading can land before
   * then — auto-pause firing during startup would otherwise hit the temporal
   * dead zone and take the window down. Undefined simply means nothing is
   * listening yet, which is the correct behaviour for a notice anyway.
   */
  let announceRemote: ((notice: RemoteNotice) => void) | undefined;

  /**
   * `provider`: scope the pause/resume to one provider's sessions, so a
   * Claude plan limit does not freeze Codex sessions and vice versa (#75).
   * Undefined — the human's own Pause All button — still means everything.
   */
  const setPausedAll = (wanted: boolean, why?: string, provider?: AgentSession['provider']): boolean => {
    let acted = false;
    if (wanted) {
      const candidates = store.sessions
        .filter(
          (s) =>
            s.status !== 'ended' &&
            s.pid !== undefined &&
            !pause.isPaused(s.pid) &&
            (provider === undefined || s.provider === provider),
        )
        .map((s) => s.pid);
      if (candidates.length === 0) {
        // Only worth saying when a human pressed the button. Auto-pause reaching
        // an empty machine is not news, and the caller uses the `false` to stay
        // armed rather than spending its one shot on nothing.
        if (!why) void dialogs.info('Agent Wrangler: nothing is running to pause.');
        return false;
      }
      const r = pause.pauseAll(candidates);
      acted = r.ok > 0;
      log(`pause all${why ? ` (${why})` : ''}: ${r.ok} paused, ${r.gone} already gone, ${r.refused} refused`);
      const trouble = r.refused > 0 ? `, ${r.refused} refused the signal` : '';
      void dialogs.info(
        `Agent Wrangler: paused ${r.ok} agent${r.ok === 1 ? '' : 's'}${trouble}${why ? ` — ${why}` : ''}.`,
      );
      // Only when something did it for you. A pause you pressed yourself needs
      // no notification: you are sitting in front of the machine that did it.
      // The point of this one is the opposite case — the cap trips while you are
      // out, and every agent stops until somebody comes back and resumes them.
      if (why && acted) {
        announceRemote?.({
          title: `⏸️ Agents paused — ${why}`,
          body: [
            `Paused ${r.ok} agent${r.ok === 1 ? '' : 's'} on ${os.hostname()}${trouble}.`,
            'Nothing will run until they are resumed from Agent Wrangler.',
          ].join('\n'),
          tone: 'warn',
        });
      }
    } else {
      const r = pause.resumeAll();
      acted = r.ok > 0;
      log(`resume all: ${r.ok} resumed, ${r.gone} gone, ${r.refused} refused`);
      const trouble = r.refused > 0 ? `, ${r.refused} refused the signal` : '';
      void dialogs.info(`Agent Wrangler: resumed ${r.ok} agent${r.ok === 1 ? '' : 's'}${trouble}.`);
    }
    void store.forceRefresh();
    return acted;
  };

  /**
   * Pause All as a person asks for it — the toolbar button and the menu item.
   *
   * Pausing asks first (#79): the button sits beside the Discord toggle, and a
   * stray click froze every running agent. Cancel is the default so Return and
   * Escape both back out. Resuming does not ask; it only undoes a pause.
   * Auto-pause calls `setPausedAll` directly and never sees this: a modal nobody
   * is there to answer would leave the plan spending.
   *
   * `confirmingPauseAll` swallows clicks that land while the dialog is up, so
   * one confirmation pauses once.
   */
  let confirmingPauseAll = false;
  const requestPauseAll = async (wanted: boolean): Promise<void> => {
    if (!wanted) {
      setPausedAll(false);
      return;
    }
    if (confirmingPauseAll) return;
    const running = store.sessions.filter(
      (s) => s.status !== 'ended' && s.pid !== undefined && !pause.isPaused(s.pid),
    ).length;
    // Nothing to pause: let setPausedAll say so rather than asking about nothing.
    if (running === 0) {
      setPausedAll(true);
      return;
    }
    confirmingPauseAll = true;
    try {
      const choice = await dialogs.warn(
        `Pause all ${running} running agent${running === 1 ? '' : 's'}?`,
        {
          modal: true,
          defaultToCancel: true,
          detail:
            'Every running Claude Code and Codex agent on this machine stops where it is. ' +
            'Nothing is lost: Resume All carries on from exactly where they stopped.',
        },
        'Pause All Agents',
      );
      if (choice === 'Pause All Agents') setPausedAll(true);
    } finally {
      confirmingPauseAll = false;
    }
  };

  /**
   * Auto-pause: stop everything by itself when the plan is nearly spent.
   *
   * Armed state is per-process and deliberately not persisted. Two windows both
   * firing is harmless — the second finds everything paused already and pauses
   * nothing — whereas a persisted flag would have a restart mid-window decide
   * it had already fired and sail past the threshold in silence.
   *
   * It only disarms once it has actually stopped something. The first usage
   * reading lands within milliseconds of startup (it is adopted from the
   * shared cache file), long before the provider's first scan has found any
   * sessions, so a window restarted while over the threshold would otherwise
   * spend its one shot on an empty store and never fire again for the rest of
   * the limit window.
   */
  let autoPauseArmed = true;
  host.subscribe(
    usage.onDidChange(() => {
      const cfg = getConfig();
      const percent = maxUsagePercent(usage.usage.last);
      const decision = autoPauseDecision(
        percent,
        { enabled: cfg.autoPauseEnabled, percent: cfg.autoPausePercent },
        autoPauseArmed,
      );
      if (!decision.fire) {
        autoPauseArmed = decision.armed;
        return;
      }
      // Scoped to Claude: a Claude plan limit must not freeze Codex sessions.
      if (setPausedAll(true, `plan usage reached ${percent}%`, 'claude')) autoPauseArmed = false;
    }),
  );

  /**
   * Codex's own auto-pause arming, kept separate from Claude's `autoPauseArmed`
   * so the two windows can never clear each other: a Claude five-hour reset
   * re-arming Claude's flag says nothing about whether Codex is still over its
   * own limit, and vice versa.
   *
   * `setPausedAll(true, …, 'codex')` is scoped correctly, but today it always
   * finds zero candidates: Codex sessions carry no `pid` (`CodexProvider`
   * never sets one — Wrangler-owned Codex conversations all run inside one
   * shared `codex app-server --stdio` process, and an external Codex rollout
   * is observational only), so there is no single process a Codex-only pause
   * could safely SIGSTOP without freezing every other Codex conversation too
   * (`docs/codex-and-electron.md` §"Codex integration and Electron boundary").
   * This still fixes the conflation bug — a Codex limit no longer reaches
   * Claude sessions, and a Claude limit no longer reaches Codex ones — and is
   * ready to actually stop something the day Codex sessions get a suspendable
   * process of their own.
   */
  let codexAutoPauseArmed = true;
  host.subscribe(
    codexUsage.onDidChange(() => {
      const cfg = getConfig();
      const percent = maxUsagePercent(codexUsage.usage.last);
      const decision = autoPauseDecision(
        percent,
        { enabled: cfg.autoPauseEnabled, percent: cfg.autoPausePercent },
        codexAutoPauseArmed,
      );
      if (!decision.fire) {
        codexAutoPauseArmed = decision.armed;
        return;
      }
      if (setPausedAll(true, `Codex plan usage reached ${percent}%`, 'codex')) codexAutoPauseArmed = false;
    }),
  );

  // Folders the launcher offers. Claude Code's own history is the bulk of it;
  // the workspace and anything currently running are added so a folder is
  // never missing just because it has not been used through the CLI yet.
  const hiddenProjects = new HiddenProjectsService(host.globalState);
  const projects = new ProjectsService(
    () => ({
      workspaceFolders: host.workspaceFolders(),
      sessions: store.sessions
        .filter((s): s is typeof s & { cwd: string } => typeof s.cwd === 'string')
        .map((s) => ({ dir: s.cwd, lastUsedAt: s.lastActivityAt })),
    }),
    { hidden: hiddenProjects, favourites: new FavouriteProjectsService(host.globalState) },
  );

  /** The folder dialog, shared by the dashboard's Browse… row and the picker's. */
  const browseForProject = async (): Promise<string | undefined> => {
    const dir = await dialogs.pickFolder({ openLabel: 'Start here' });
    if (dir) projects.add(dir);
    return dir;
  };

  /**
   * Turn what the launcher asked for into a folder to run in.
   *
   * The "Global" row is a sentinel, not a path: it means "no project". It
   * resolves to a scratch folder that is created on demand, and — unlike every
   * other folder — is deliberately *not* added to the project list, because it
   * is not a project and offering it twice would say it was.
   */
  const resolveLaunchDir = (cwd: string): { dir: string; remember: boolean } | undefined => {
    if (cwd !== GLOBAL_PROJECT_DIR) return { dir: cwd, remember: true };
    const dir = globalConversationDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      dialogs.error(`Agent Wrangler: could not create ${dir} — ${(error as Error).message}`);
      return undefined;
    }
    return { dir, remember: false };
  };

  /** Spawn and show. The only path that starts a runner, so the cwd check lives here. */
  const startConversation = async (requested: string): Promise<SessionHandle | undefined> => {
    const resolved = resolveLaunchDir(requested);
    if (!resolved) return undefined;
    const { dir: cwd, remember } = resolved;
    if (!fs.existsSync(cwd)) {
      dialogs.error(`Agent Wrangler: ${cwd} no longer exists.`);
      return undefined;
    }
    // Working in a folder is the strongest possible statement that it belongs
    // in the list, so it also undoes a removal — the same rule as browsing.
    if (remember) projects.add(cwd);
    const runner = await sessions.launch(launchDefaults.request('claude', cwd, { sessionId: randomUUID(), policy: { claude: { conversationInstructions: CONVERSATION_DELEGATION_INSTRUCTIONS } } }));
    surface?.showSession(runner);
    return runner;
  };

  const startCodexConversation = async (requested: string): Promise<void> => {
    const resolved = resolveLaunchDir(requested);
    if (!resolved) return;
    const { dir: cwd, remember } = resolved;
    if (!fs.existsSync(cwd)) {
      dialogs.error(`Agent Wrangler: ${cwd} no longer exists.`);
      return;
    }
    if (remember) projects.add(cwd);
    try {
      const runner = await sessions.launch(launchDefaults.request('codex', cwd, { policy: { codex: { developerInstructions: CONVERSATION_DELEGATION_INSTRUCTIONS } } }));
      surface?.showSession(runner);
    } catch (error) {
      log(`starting Codex conversation failed: ${String(error)}`);
      dialogs.error(`Agent Wrangler: could not start Codex — ${(error as Error).message}`);
    }
  };

  /**
   * Start a session this process runs itself. The folder matters more than
   * usual here: it is the session's working directory, and unlike the Claude
   * Code panel — which is bound to its window's workspace — the pane can run a
   * session in any project on the machine.
   *
   * With a `cwd` (the dashboard's launcher, which has its own dropdown) it goes
   * straight to the session. Without one (the palette, the title-bar button)
   * the same folders arrive as a picker instead.
   */
  const newConversation = async (cwd?: string): Promise<SessionHandle | undefined> => {
    if (cwd) return startConversation(cwd);

    // Newest first, the same order and the same list the dashboard dropdown shows.
    await projects.refresh();
    const folders: { label: string; description?: string; dir?: string; browse?: boolean }[] = [
      { label: '$(globe) Global', description: 'No project — a scratch folder', dir: GLOBAL_PROJECT_DIR },
      ...projects.value.map((p) => ({ label: p.name, description: p.dir, dir: p.dir })),
    ];
    folders.push({ label: '$(folder-opened) Browse…', description: 'Pick another folder', browse: true });

    const picked = await dialogs.pick(folders, {
      placeHolder: 'Start a conversation in which project?',
      matchOnDescription: true,
    });
    if (!picked) return undefined;

    const dir = picked.browse ? await browseForProject() : picked.dir;
    return dir ? startConversation(dir) : undefined;
  };

  const tasks = orchestration.tasks;

  /**
   * What the two panes see of orchestration (#34): chips for the table, a strip
   * for the conversation, and the strip's buttons.
   *
   * One object implementing both `TaskBadgeSource` and `TaskPaneSource`, so
   * neither pane host imports the runner and both fire off the same change
   * event. `undefined` while orchestration is off — which is the default — and
   * then no row has chips and no conversation has a strip.
   *
   * The views are rebuilt on demand rather than cached: a snapshot is pushed
   * when something moved, and a mission is a handful of records, so there is
   * nothing here worth the risk of a stale copy.
   */
  const taskPanes = tasks
    ? {
        conversationDelegation: {
          context: (session: AgentSession) => {
            if (!session.cwd || session.sessionId === 'pending' || isOrchestrationOrigin(sessionRegistry.get(session.sessionId)?.origin)) return undefined;
            const loaded = orchestration.repoPolicies?.forFolder(session.cwd);
            return loaded ? { repoRoot: loaded.repo.primaryRoot, policyVersion: loaded.version,
              verificationCommands: Object.keys(loaded.policy.verification.commands).sort() } : undefined;
          },
          delegate: (request: ProposeTaskRequest) => delegate(request, false),
          record: (record: DelegationSuggestionRecord) => { appendTelemetry(record); },
        },
        badges: () => taskBadges(tasks.list()),
        viewFor: (sessionKey: string): TaskView | undefined => {
          const badge = taskBadges(tasks.list()).get(sessionKey);
          const mission = badge && tasks.get(badge.missionId);
          return mission ? taskViewOf(mission, tasks.actions(mission.id, badge.taskId), badge.taskId, policyContextFor(models.catalog)) : undefined;
        },
        run: async (missionId: string, action: TaskViewAction, taskId?: string): Promise<void> => {
          await runTaskAction(tasks, missionId, action, taskId);
        },
        proposalsFor: (sessionKey: string): TaskProposalView[] =>
          tasks
            .list()
            .filter((m) => m.origin && originKey(m.origin) === sessionKey.toLowerCase() && isOpenProposal(m))
            .map((m) => proposalViewOf(m, m.tasks[0].recommendation!, models.catalog))
            .reverse(),
        decideProposal: async (missionId: string, decision: ProposalDecision): Promise<void> => {
          const m = tasks.get(missionId);
          if (!m || !isOpenProposal(m)) throw new TaskError('That proposal has already been started or cancelled.');
          if (decision.kind === 'cancel') {
            await tasks.cancel(missionId);
            dialogs.flash(`Task proposal cancelled: ${m.title}`);
            return;
          }
          const started = await tasks.startProposed(missionId, proposalChoice(m.tasks[0].recommendation!, models.catalog, decision));
          dialogs.flash(`Task started on ${started.worktrees.at(-1)?.branch ?? 'its own branch'}`);
        },
        delegationsFor: (sessionKey: string): DelegationView[] =>
          tasks
            .list()
            .filter((m) => m.origin && originKey(m.origin) === sessionKey.toLowerCase() && isOpenDelegation(m))
            .map((m) => delegationViewOf(m, { canPlan: tasks.canPlan, route: delegationRoute(m).label }))
            .reverse(),
        delegationAction: async (missionId: string, action: DelegationAction): Promise<void> => {
          const m = tasks.get(missionId);
          if (!m || !isOpenDelegation(m)) throw new TaskError('That delegation has already been started or cancelled.');
          switch (action) {
            case 'approve':
              // As the Missions view's Approve and start: tasks without a pin run on the launcher's route.
              await tasks.approvePlan(missionId, delegationRoute(m).route);
              dialogs.flash('Plan approved: its tasks run one at a time on the mission branch.');
              return;
            case 'cancel':
              await tasks.cancel(missionId);
              dialogs.flash(`Delegation cancelled: ${m.title}`);
              return;
            case 'plan-again': {
              const note = await dialogs.input({ title: 'Plan again', prompt: 'Anything the planner should do differently? (Optional)' });
              if (note === undefined) return;
              await tasks.planAgain(missionId, note);
              return;
            }
            case 'as-task':
              await tasks.delegateAsTask(missionId);
              return;
            case 'open-mission':
              showMissionRequests.fire(missionId);
              return;
          }
        },
        onDidChange: (listener: () => void) => tasks.onDidChange(listener),
      }
    : undefined;

  /**
   * What a delegated plan's tasks run on when it is approved from its card
   * (#82): the launcher's defaults for the harness it prefers, as the
   * Missions view's Approve and start uses. A task's own pin still wins.
   */
  function delegationRoute(m: Mission): { route: TaskRoute; label: string } {
    const harness = m.policy.preferences?.harness === 'codex' ? 'codex' : 'claude-code';
    const defaults = launchDefaults.for(harness === 'codex' ? 'codex' : 'claude');
    const route: TaskRoute = { harness, ...(defaults.model ? { model: defaults.model } : {}), ...(defaults.effort ? { effort: defaults.effort } : {}) };
    const label = `${defaults.model ? modelLabel(defaults.model) : 'the default model'}${defaults.effort ? ` · ${defaults.effort}` : ''} (${harnessLabel(harness)})`;
    return { route, label };
  }

  /** The session key of the conversation a proposal came from. */
  function originKey(origin: NonNullable<Mission['origin']>): string {
    return `${origin.provider}:${origin.sessionId}`.toLowerCase();
  }

  /**
   * Run one of the strip's actions.
   *
   * `show-session` and `open-diff` are the two that are not the runner's to
   * perform: one points a pane at a session and the other opens a file, both of
   * which belong to the app. The rest go straight through.
   */
  async function runTaskAction(runner: TaskRunner, missionId: string, action: TaskViewAction, taskId?: string): Promise<void> {
    const m = runner.get(missionId);
    // A button drawn for one task must not land on another: only offered actions run, and
    // the ones that move a task along only on the task the mission is on.
    if (taskId && m) {
      if (!runner.actions(missionId, taskId).includes(action)) throw new TaskError('That action is no longer available for this task.');
      // In a parallel mission (#46) every task is its own; `recreate-worktree` is still the current task's.
      if (['accept', 'resume', 'retry', 'recreate-worktree'].includes(action) && runner.currentTask(m).id !== taskId && !(m.parallel && action !== 'recreate-worktree')) {
        throw new TaskError('That task is not the one the mission is on.');
      }
    }
    switch (action) {
      case 'show-session': {
        const handle = runner.handleOf(missionId, taskId);
        if (handle) surface?.showSession(handle);
        return;
      }
      case 'open-diff':
        host.shell.openFile(await runner.diff(missionId, taskId));
        return;
      case 'accept':
        return runner.accept(missionId, taskId);
      case 'resume':
        return runner.resume(missionId, { taskId });
      case 'retry':
        return runner.retry(missionId, taskId);
      case 'recreate-worktree':
        return runner.recreateWorktree(missionId);
      case 'skip':
        return runner.skip(missionId, taskId);
      case 'edit-policy':
        return editPolicy(policyEditorDeps(runner), missionId);
      case 'cancel':
        return runner.cancel(missionId);
    }
  }

  function policyEditorDeps(runner: TaskRunner): PolicyEditorDeps {
    return { dialogs, runner, catalog: () => models.catalog, log };
  }

  const showMissionRequests = new Emitter<string | undefined>();

  /**
   * The Missions view (#43): every mission as the table's third view draws it,
   * and the clicks it sends back — plan edits, Approve and start, a task's
   * buttons, the finish buttons. `undefined` while orchestration is off.
   */
  const missionSource: MissionSource | undefined = tasks
    ? {
        snapshot: () => ({
          missions: tasks
            .list()
            // A proposal waiting on its card (#81) is not a mission yet.
            .filter((m) => !isOpenProposal(m))
            .map((m) =>
              missionViewOf(m, {
                actions: (taskId) => tasks.actions(m.id, taskId),
                finishDefault: m.state === 'review' ? orchestration.repoPolicies?.forFolder(m.repoRoot)?.policy.finish.default : undefined,
                canPlan: tasks.canPlan,
              }),
            ),
          tiers: models.catalog.tiers.map((t) => t.name),
          harnesses: [
            { id: 'claude-code', label: 'Claude Code' },
            { id: 'codex', label: 'Codex' },
          ],
        }),
        run: async (missionId, op, provider) => {
          switch (op.kind) {
            case 'edit':
              await tasks.editPlan(missionId, op.edit);
              return;
            case 'approve': {
              const defaults = launchDefaults.for(provider);
              const approved = await tasks.approvePlan(missionId, { harness: provider === 'codex' ? 'codex' : 'claude-code', model: defaults.model, effort: defaults.effort });
              dialogs.flash(
                approved.parallel
                  ? 'Plan approved: independent tasks run at once, each in its own worktree, and are merged into the mission branch one at a time.'
                  : 'Plan approved: its tasks run one at a time on the mission branch.',
              );
              return;
            }
            case 'cancel': {
              const m = tasks.get(missionId);
              const ok = await dialogs.warn(`Cancel “${m?.title ?? 'this mission'}”?`, { modal: true, detail: 'Its session is ended. Its worktree and branches are kept.' }, 'Cancel Mission');
              if (ok === 'Cancel Mission') await tasks.cancel(missionId);
              return;
            }
            case 'pause':
              await tasks.pauseMission(missionId, { now: op.now === true });
              dialogs.flash(op.now ? 'Mission paused, and its running agents with it.' : 'Mission paused: nothing new starts; what is running carries on.');
              return;
            case 'resume':
              await tasks.resumeMission(missionId);
              dialogs.flash('Mission resumed.');
              return;
            case 'finish': {
              if (op.how === 'discard') {
                const ok = await dialogs.warn('Discard this mission’s result?', { modal: true, detail: 'Its worktrees are removed if they are clean. Its branches are kept until you delete them.' }, 'Discard');
                if (ok !== 'Discard') return;
              }
              const done = await tasks.finishMission(missionId, op.how);
              const r = done.finishResult;
              if (r?.pullRequestUrl) {
                dialogs.flash(`Pull request opened: ${r.pullRequestUrl}`, 6000);
                if (/^https:\/\//.test(r.pullRequestUrl)) host.shell.openExternal(r.pullRequestUrl);
              } else dialogs.flash(`Mission ${op.how === 'merge-local' ? 'merged' : op.how === 'keep' ? 'kept' : 'discarded'}${r?.note ? `: ${r.note}` : ''}.`);
              return;
            }
            case 'task':
              await runTaskAction(tasks, missionId, op.action, op.taskId);
              return;
            case 'plan-again':
            case 'replan': {
              // Optional: what to do differently. Escape cancels; an empty answer plans without a note.
              const note = await dialogs.input({
                title: op.kind === 'replan' ? 'Replan the mission' : 'Plan again',
                prompt:
                  op.kind === 'replan'
                    ? 'What should change? Done tasks stay as they are; unfinished work is set aside on a branch of its own. (Optional)'
                    : 'Anything the planner should do differently? (Optional)',
              });
              if (note === undefined) return;
              if (op.kind === 'replan') await tasks.replan(missionId, note);
              else await tasks.planAgain(missionId, note);
              return;
            }
            case 'write-plan':
              await tasks.writePlan(missionId);
              return;
            case 'open': {
              // The task's current attempt's conversation, in the right pane; never another window.
              const m = tasks.get(missionId);
              const handle = tasks.handleOf(missionId, op.taskId);
              if (handle) {
                surface?.showSession(handle);
                return;
              }
              const t = m?.tasks.find((x) => x.id === op.taskId);
              const a = t && m?.attempts.find((x) => x.id === t.attemptIds.at(-1));
              const key = a && sessionKeyFor(a.assignment.harness, a.assignment.sessionIds.at(-1));
              if (key && store.get(key)) surface?.show(key);
              else dialogs.flash(t && t.attemptIds.length === 0 ? `${t.key} has not started yet.` : 'That conversation is not in the table any more.');
              return;
            }
          }
        },
        create: async (cwd) => {
          if (cwd === GLOBAL_PROJECT_DIR) throw new TaskError('A mission runs in a worktree of a git repository. Pick a project folder in the launcher first.');
          const objective = await dialogs.input({
            title: 'New mission',
            prompt: `What is the mission? Its plan is reviewed before anything runs, and nothing runs until you approve it. (${path.basename(cwd)})`,
            validateInput: (v) => (v.trim() ? undefined : 'Say what the mission is for.'),
          });
          if (!objective?.trim()) return undefined;
          // The planner (#44), when there is one: a read-only look at the repository, then the same review.
          if (tasks.canPlan) {
            const how = await dialogs.pick(
              [
                { label: '$(sparkle) Plan it for me', description: 'a read-only planner reads the repository and proposes the tasks; usually one', plan: true },
                { label: '$(edit) Write the tasks myself', description: 'start plan review from the objective', plan: false },
              ],
              { placeHolder: 'How should the plan be written? Either way you review it before anything runs.' },
            );
            if (!how) return undefined;
            if (how.plan) return (await tasks.planMission({ folder: cwd, objective })).id;
          }
          // The global routing defaults are frozen into the mission by the runner (#40).
          const m = await tasks.createMission({ folder: cwd, objective });
          return m.id;
        },
        onDidChange: (listener) => tasks.onDidChange(listener),
        onDidRequestShow: (listener) => showMissionRequests.event(listener),
      }
    : undefined;

  const launcher: ConversationLauncher = {
    newConversation: (cwd, selectedProvider) =>
      selectedProvider === 'codex' ? startCodexConversation(cwd) : newConversation(cwd),
    browseForProject: () => browseForProject(),
    // Only with orchestration on; the launcher shows its Tasks button only then.
    taskMenu: tasks ? (cwd, provider) => taskMenu(tasks, cwd, provider) : undefined,
  };

  /**
   * "Run as task" (#33): the launcher's Tasks button. A quick pick, not a
   * view: the task table and task strip are #34's. Runs a new task in the
   * launcher's folder on the launcher's route, or acts on one already running.
   */
  async function taskMenu(runner: TaskRunner, cwd: string, provider: 'claude' | 'codex'): Promise<void> {
    type Row = { label: string; description?: string; detail?: string; missionId?: string; create?: true };
    const recent = runner.list().filter((m) => !['completed', 'cancelled'].includes(m.state));
    const rows: (Row & { mission?: true })[] = [
      { label: '$(add) Run a new task…', description: cwd === GLOBAL_PROJECT_DIR ? 'pick a project folder first' : cwd, create: true },
      { label: '$(list-tree) New mission…', description: 'several tasks, reviewed as a plan before anything runs', mission: true },
      ...recent.map((m) => ({ label: m.title, description: taskStateLabel(m), detail: runner.currentTask(m).stateReason, missionId: m.id })),
    ];
    const picked = await dialogs.pick(rows, { placeHolder: 'Tasks run in a worktree and branch of their own' });
    if (!picked) return;
    if (picked.create) return newTask(runner, cwd, provider);
    if (picked.mission) {
      try {
        const id = await missionSource?.create(cwd);
        if (id) showMissionRequests.fire(id);
      } catch (error) {
        dialogs.error(`Agent Wrangler: ${(error as Error).message}`);
      }
      return;
    }
    // A planned mission lives in the Missions view, where its plan and tasks are.
    if (picked.missionId && runner.get(picked.missionId)?.planned) {
      showMissionRequests.fire(picked.missionId);
      return;
    }
    if (picked.missionId) {
      // An `assisted` proposal nobody has started yet: back to the proposal (#38).
      const task = runner.get(picked.missionId)?.tasks[0];
      if (task?.recommendation && task.attemptIds.length === 0 && ['routed', 'needs-human'].includes(task.state)) {
        return reviewProposal(runner, picked.missionId, task.recommendation);
      }
      return taskActionsMenu(runner, picked.missionId);
    }
  }

  async function newTask(runner: TaskRunner, cwd: string, provider: 'claude' | 'codex'): Promise<void> {
    if (cwd === GLOBAL_PROJECT_DIR) {
      dialogs.error('Agent Wrangler: a task runs in a worktree of a git repository. Pick a project folder in the launcher first.');
      return;
    }
    const objective = await dialogs.input({
      title: 'Run as task',
      prompt: `What should the task do? It runs in a new worktree and branch of ${path.basename(cwd)}, on the launcher's model and effort.`,
      validateInput: (v) => (v.trim() ? undefined : 'Say what the task should do.'),
    });
    if (!objective?.trim()) return;
    const criteria = await dialogs.input({
      title: 'Run as task',
      prompt: 'Acceptance criteria, separated by semicolons (optional).',
    });
    if (criteria === undefined) return;
    const defaults = launchDefaults.for(provider);
    const routing = parseRoutingSettings(host.settings.get<unknown>(ROUTING_KEY, undefined));
    const harness = provider === 'codex' ? 'codex' : 'claude-code';
    // The launcher's harness is a preference, not a pin: the router ranks it first within the tier it picks.
    // It is the mission's own layer; the global defaults are frozen in by the runner (#40).
    const policy = { preferences: { harness } };
    // `auto` only while its gate is met or an override stands (§27.3, #42); otherwise assisted, and say why.
    const { mode, note } = effectiveMode(routing.mode, routing.mode === 'auto' ? autoRouting().gate : undefined, routing.autoOverride);
    if (note) log(`task: ${note}`);
    if (mode === 'auto') {
      try {
        dialogs.flash('Assessing the task to route it automatically…');
        const { mission, recommendation, started } = await runner.startAuto({ folder: cwd, objective, acceptanceCriteria: criteria.split(';'), policy });
        if (!started) {
          // The router could not route it within the caps: it waits as a proposal, as in assisted.
          await reviewProposal(runner, mission.id, recommendation);
          return;
        }
        const handle = runner.handleOf(mission.id);
        if (handle) surface?.showSession(handle);
        const target = recommendation.resolution.target;
        dialogs.flash(`Task routed automatically${target ? ` to ${targetLabel(target)}` : ''} on ${mission.worktrees.at(-1)?.branch ?? 'its own branch'}`);
      } catch (error) {
        log(`task: ${String(error)}`);
        dialogs.error(`Agent Wrangler: ${error instanceof TaskError ? error.message : `could not route the task — ${(error as Error).message}`}`);
      }
      return;
    }
    if (mode === 'assisted') {
      if (note) dialogs.flash(note, 8000);
      try {
        dialogs.flash('Assessing the task to propose a route…');
        const { mission, recommendation } = await runner.propose({ folder: cwd, objective, acceptanceCriteria: criteria.split(';'), policy });
        await reviewProposal(runner, mission.id, recommendation);
      } catch (error) {
        log(`task: ${String(error)}`);
        dialogs.error(`Agent Wrangler: ${error instanceof TaskError ? error.message : `could not propose a route — ${(error as Error).message}`}`);
      }
      return;
    }
    try {
      const mission = await runner.start({
        folder: cwd,
        objective,
        acceptanceCriteria: criteria.split(';'),
        route: { harness, model: defaults.model, effort: defaults.effort },
        policy,
      });
      const handle = runner.handleOf(mission.id);
      if (handle) surface?.showSession(handle);
      dialogs.flash(`Task started on ${mission.worktrees.at(-1)?.branch ?? 'its own branch'}`);
    } catch (error) {
      log(`task: ${String(error)}`);
      dialogs.error(`Agent Wrangler: ${error instanceof TaskError ? error.message : `could not start the task — ${(error as Error).message}`}`);
    }
  }

  /**
   * `assisted` (#38): the proposal, pre-filled. One click runs it; changing
   * the effort or the model runs that instead and is recorded as a labelled
   * disagreement. Dismissing leaves it waiting in the Tasks menu.
   */
  async function reviewProposal(
    runner: TaskRunner,
    missionId: string,
    rec: RouteRecommendation,
    opts: { showSession?: boolean } = {},
  ): Promise<void> {
    type Row = { label: string; description?: string; detail?: string; action: 'accept' | 'effort' | 'model' | 'why' | 'policy' | 'cancel' };
    const target = rec.resolution.target;
    const why = explainRecommendation(rec);
    for (;;) {
      const rows: Row[] = [];
      if (target && rec.verdict !== 'blocked') {
        rows.push({
          label: rec.verdict === 'route' ? `$(check) Run on ${targetLabel(target)}` : `$(warning) Run on ${targetLabel(target)} anyway`,
          description: rec.verdict === 'route' ? 'recommended' : 'needs you',
          detail: rec.verdict === 'route' ? why.summary : rec.note,
          action: 'accept',
        });
        rows.push({ label: 'Change effort…', description: `recommended ${rec.requirement.effort}`, action: 'effort' });
      } else {
        rows.push({ label: '$(warning) No route recommended', description: rec.verdict, detail: rec.note, action: 'why' });
      }
      rows.push({ label: 'Change model…', description: `needs ${rec.requirement.minTier}${rec.requirement.maxTier !== rec.requirement.minTier ? `, capped at ${rec.requirement.maxTier}` : ''}`, action: 'model' });
      rows.push({ label: 'Why this route?', action: 'why' });
      rows.push({ label: 'Edit pins and caps…', description: 'the proposal is routed again under them', action: 'policy' });
      rows.push({ label: 'Cancel the task', action: 'cancel' });
      const picked = await dialogs.pick(rows, { placeHolder: `Proposed route — ${runner.get(missionId)?.title ?? 'task'}`, matchOnDetail: true });
      if (!picked) {
        dialogs.flash('The proposal is waiting in the Tasks menu.');
        return;
      }
      let route: TaskRoute | undefined;
      if (picked.action === 'why') {
        const lines = [why.summary, '', `Needs: ${why.requirement ?? '—'}`, ...why.rules.map((r) => `• ${r.ruleId}: ${r.text}`)];
        if (why.fallbacks.length > 0) lines.push('', `Fallbacks: ${why.fallbacks.join('; ')}`);
        if (why.rejected.length > 0) lines.push('', 'Not chosen:', ...why.rejected.map((r) => `• ${r}`));
        if (why.note) lines.push('', why.note);
        await dialogs.info(lines.join('\n'));
        continue;
      }
      if (picked.action === 'policy') {
        await editPolicy(policyEditorDeps(runner), missionId);
        const again = runner.get(missionId)?.tasks[0].recommendation;
        return again ? reviewProposal(runner, missionId, again, opts) : undefined;
      }
      if (picked.action === 'cancel') {
        await runner.cancel(missionId);
        return;
      }
      if (picked.action === 'effort' && target) {
        const entry = models.catalog.entries.find((e) => e.descriptor.source === target.source && e.aliases.includes(target.model));
        const levels = EFFORT_LEVELS.map((l) => ({ label: l, description: l === rec.requirement.effort ? 'recommended' : entry ? nativeEffortFor(entry, l) : undefined, level: l }));
        const level = await dialogs.pick(levels, { placeHolder: `Effort for ${targetLabel(target)}` });
        if (!level) continue;
        const native = entry ? nativeEffortFor(entry, level.level) : level.level;
        route = {
          harness: target.harness,
          ...(isEndpointSource(target.source) ? { source: target.source } : {}),
          model: target.model,
          ...(native !== 'none' ? { effort: native } : {}),
        };
      }
      if (picked.action === 'model') {
        const cat = models.catalog;
        const cap = tierRank(cat.tiers, rec.requirement.maxTier);
        const choices = cat.entries
          .filter((e) => e.routable && e.tier !== undefined && (cap < 0 || tierRank(cat.tiers, e.tier) <= cap))
          .flatMap((e) => e.harnesses.map((h) => ({ entry: e, harness: h })))
          .map(({ entry, harness: h }) => ({
            label: entry.descriptor.label,
            description: `${entry.tier} · ${h === 'codex' ? 'Codex' : 'Claude Code'}${entry.descriptor.location === 'local' ? ' · local' : ''}${entry.external ? ' · data leaves this machine' : ''}${entry.key === (target && `${target.source}:${target.resolvedModel ?? target.model}`) ? ' · recommended' : ''}`,
            entry,
            harness: h,
          }));
        if (choices.length === 0) {
          dialogs.error('Agent Wrangler: no model is routable within this task’s cap. Give models a tier in Preferences → Orchestration.');
          continue;
        }
        const m = await dialogs.pick(choices, { placeHolder: `Model — the task needs ${rec.requirement.minTier}` });
        if (!m) continue;
        const native = nativeEffortFor(m.entry, rec.requirement.effort);
        route = {
          harness: m.harness,
          ...(isEndpointSource(m.entry.descriptor.source) ? { source: m.entry.descriptor.source } : {}),
          model: m.entry.descriptor.modelId,
          ...(native !== 'none' ? { effort: native } : {}),
        };
      }
      try {
        const mission = await runner.startProposed(missionId, route ? { route } : {});
        const handle = runner.handleOf(mission.id);
        // A handoff from a conversation (`aw task`) leaves that conversation on screen.
        if (handle && opts.showSession !== false) surface?.showSession(handle);
        dialogs.flash(`Task started on ${mission.worktrees.at(-1)?.branch ?? 'its own branch'}`);
        return;
      } catch (error) {
        log(`task ${missionId}: ${String(error)}`);
        dialogs.error(`Agent Wrangler: ${error instanceof TaskError ? error.message : `could not start the task — ${(error as Error).message}`}`);
        if (!(error instanceof TaskError)) return;
      }
    }
  }

  const TASK_ACTION_LABEL: Record<TaskAction, string> = {
    'show-session': 'Show its conversation',
    'open-diff': 'Open the diff',
    accept: 'Accept the result',
    resume: 'Resume the attempt',
    retry: 'Retry fresh, in a new worktree',
    'recreate-worktree': 'Recreate its worktree from its branch',
    skip: 'Skip it; the mission carries on',
    'edit-policy': 'Edit its pins and caps…',
    cancel: 'Cancel the task',
  };

  async function taskActionsMenu(runner: TaskRunner, missionId: string): Promise<void> {
    const m = runner.get(missionId);
    if (!m) return;
    const rows = runner.actions(missionId).map((action) => ({ label: TASK_ACTION_LABEL[action], action }));
    const picked = await dialogs.pick(rows, { placeHolder: `${m.title} — ${taskStateLabel(m)}` });
    if (!picked) return;
    try {
      switch (picked.action) {
        case 'show-session': {
          const handle = runner.handleOf(missionId);
          if (handle) surface?.showSession(handle);
          return;
        }
        case 'open-diff':
          host.shell.openFile(await runner.diff(missionId));
          return;
        case 'accept':
          await runner.accept(missionId);
          dialogs.flash('Accepted. The branch is kept for you to merge.');
          return;
        case 'resume':
          await runner.resume(missionId);
          return;
        case 'retry':
          await runner.retry(missionId);
          return;
        case 'recreate-worktree':
          await runner.recreateWorktree(missionId);
          return;
        case 'skip':
          await runner.skip(missionId);
          return;
        case 'edit-policy':
          await editPolicy(policyEditorDeps(runner), missionId);
          return;
        case 'cancel': {
          const ok = await dialogs.warn(`Cancel “${m.title}”?`, { modal: true, detail: 'Its session is ended. Its worktree and branch are kept.' }, 'Cancel Task');
          if (ok === 'Cancel Task') await runner.cancel(missionId);
          return;
        }
      }
    } catch (error) {
      log(`task ${missionId}: ${String(error)}`);
      dialogs.error(`Agent Wrangler: ${(error as Error).message}`);
    }
  }

  function taskStateLabel(m: Mission): string {
    if (m.planned) {
      if (m.state === 'plan-review') return `plan review — ${m.tasks.length} task(s), nothing runs until you approve`;
      if (m.state === 'review') return 'ready for review — merge, open a PR, keep or discard';
      const current = tasks?.currentTask(m);
      const done = m.tasks.filter((t) => t.state === 'done').length;
      return `${done}/${m.tasks.length} done${current && m.state === 'running' ? ` — ${current.key} ${current.state === 'needs-human' ? 'needs you' : current.state}` : ` — ${m.state}`}`;
    }
    const task = m.tasks[0];
    const attempt = runnerAttempt(m);
    if (m.state === 'review') return 'accepted — branch kept';
    if (task.recommendation && !attempt) return task.state === 'routed' ? 'route proposed — waiting for you' : 'needs you — no route recommended';
    if (task.state === 'needs-human') return attempt?.state === 'succeeded' ? 'ready for review' : `needs you — attempt ${attempt?.state ?? 'not started'}`;
    return attempt ? `attempt ${attempt.n} ${attempt.state}` : task.state;
  }

  function runnerAttempt(m: Mission) {
    const id = m.tasks[0]?.attemptIds.at(-1);
    return id ? m.attempts.find((a) => a.id === id) : undefined;
  }

  function taskSummary(m: Mission): TaskSummary {
    return {
      missionId: m.id,
      title: m.title,
      state: taskStateLabel(m),
      repoRoot: m.repoRoot,
      branch: m.worktrees.at(-1)?.branch,
      createdAt: m.createdAt,
    };
  }

  /**
   * `aw task` (#80). Always the `assisted` path, whatever the routing mode
   * says: the handoff exists to put a route in front of the user, and a
   * proposal is the only thing a caller outside the window may create. The
   * proposal is never popped up in the palette: a palette that opens while
   * the user is typing in the composer would take their Enter as "accept".
   */
  async function proposeTask(req: ProposeTaskRequest): Promise<ProposedTask> {
    if (!tasks) throw new TaskError('Tasks are off. Turn on orchestration ("orchestration.enabled": true in settings.json) first.');
    const runner = tasks;
    const harness = req.harness === 'codex' ? 'codex' : req.harness === 'claude' ? 'claude-code' : undefined;
    const { mission, recommendation } = await runner.propose({
      folder: req.folder,
      objective: req.objective,
      acceptanceCriteria: req.acceptanceCriteria ?? [],
      ...(harness ? { policy: { preferences: { harness } } } : {}),
      ...(req.origin ? { origin: req.origin } : {}),
    });
    const target = recommendation.resolution.target;
    const route = target && recommendation.verdict !== 'blocked' ? targetLabel(target) : undefined;
    // A proposal from a conversation is answered on its card there (#81): the
    // click brings that conversation up. One with no known conversation falls
    // back to the palette, which only a click ever opens.
    const from = mission.origin ? store.get(originKey(mission.origin)) : undefined;
    const open = () => {
      const current = runner.get(mission.id);
      if (!current || !isOpenProposal(current)) {
        dialogs.flash('That proposal has already been started or cancelled.');
        return;
      }
      if (from && store.get(from.key)) surface?.show(from.key);
      else void reviewProposal(runner, mission.id, current.tasks[0].recommendation!, { showSession: false });
    };
    const body = route ? `Proposed: ${route}. Click to review and start it.` : 'No route recommended: click to pick one.';
    if (host.notify) host.notify({ title: `Task proposal: ${mission.title}`, body, onClick: open });
    dialogs.flash(`Task proposal waiting: ${mission.title} (${from ? 'in its conversation' : 'Tasks menu'})`, 6000);
    log(`task ${mission.id}: proposed through aw`);
    return {
      task: taskSummary(runner.get(mission.id) ?? mission),
      verdict: recommendation.verdict,
      route,
      summary: explainRecommendation(recommendation).summary,
      note: recommendation.note,
    };
  }

  /**
   * `aw delegate` (#82). The planner decides, not the caller: one task
   * becomes the proposal `aw task` makes (its card, its assisted route), and
   * several become a planned mission in plan review, drawn as a card in the
   * delegating conversation. That conversation is where the card is shown
   * and nothing more: the work runs in sessions of its own. Waits a bounded
   * time for the decision so the agent can say what it was; after that the
   * card says it.
   */
  async function delegate(req: ProposeTaskRequest, waitForPlan = true): Promise<DelegateResult> {
    if (!tasks) throw new TaskError('Delegating is off. Turn on orchestration ("orchestration.enabled": true in settings.json) first.');
    const runner = tasks;
    const harness = req.harness === 'codex' ? 'codex' : req.harness === 'claude' ? 'claude-code' : undefined;
    const mission = await runner.delegate({
      folder: req.folder,
      objective: req.objective,
      acceptanceCriteria: req.acceptanceCriteria ?? [],
      ...(harness ? { policy: { preferences: { harness } } } : {}),
      ...(req.origin ? { origin: req.origin } : {}),
    });
    const from = mission.origin ? store.get(originKey(mission.origin)) : undefined;
    dialogs.flash(`Delegated: ${mission.title} (${from ? 'its card is in the conversation' : 'see Tasks and Missions'})`, 6000);
    log(`mission ${mission.id}: delegated through aw`);
    const outcome = waitForPlan ? await new Promise<DelegationOutcome>((resolve) => {
      const current = () => delegationOutcome(runner.get(mission.id) ?? mission);
      const first = current();
      if (first.decision !== 'planning') return resolve(first);
      const done = (o: DelegationOutcome) => {
        clearTimeout(timer);
        sub.dispose();
        resolve(o);
      };
      const timer = setTimeout(() => done(current()), DELEGATE_WAIT_MS);
      const sub = runner.onDidChange(() => {
        const o = current();
        if (o.decision !== 'planning') done(o);
      });
    }) : delegationOutcome(runner.get(mission.id) ?? mission);
    const now = runner.get(mission.id) ?? mission;
    const { decision, ...rest } = outcome;
    return { task: taskSummary(now), decision, ...rest };
  }

  /**
   * Store a bot token and connect.
   *
   * The token is checked against Discord before it is saved — a typo otherwise
   * fails much later, as a gateway close code, which reads like a bug rather
   * than a mistyped credential.
   */
  const connectDiscord = async (): Promise<{ ok: boolean; lines: string[] }> => {
    if (!host.secrets.available) {
      return { ok: false, lines: ['✗  This system cannot store secrets securely, so nothing was saved.'] };
    }
    const token = await dialogs.input({
      title: 'Connect Discord',
      prompt: 'Bot token, from the Bot tab of your Discord application. Stored in the system keychain, never in settings.',
      password: true,
    });
    if (token === undefined) return { ok: false, lines: [] };
    if (token.trim() === '') return { ok: false, lines: ['✗  No token was entered.'] };

    let who: { username?: string };
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token.trim()}` },
      });
      if (!res.ok) return { ok: false, lines: [`✗  Discord rejected that token (HTTP ${res.status}).`] };
      who = (await res.json()) as { username?: string };
    } catch (err) {
      return { ok: false, lines: [`✗  Could not reach Discord — ${String(err)}`] };
    }

    await host.secrets.store(DISCORD_BOT_TOKEN_KEY, token.trim());
    log(`remote: stored a bot token for ${who.username ?? 'the bot'}`);
    // A stored token changes nothing a settings listener would see, so the
    // handover has to be asked for here. The daemon reconnects with it.
    await syncRemote();

    const cfg = getConfig();
    const missing = [
      cfg.remoteGuildId ? '' : 'a server ID',
      cfg.remoteChannelId ? '' : 'a channel ID',
      cfg.remoteAuthorizedUserIds.length > 0 ? '' : 'at least one authorised user',
      cfg.remoteEnabled ? '' : 'Discord integration switched on',
    ].filter(Boolean);
    return {
      ok: missing.length === 0,
      lines:
        missing.length === 0
          ? [`✓  Connected as ${who.username ?? 'the bot'}.`]
          : [`✓  Token saved for ${who.username ?? 'the bot'}.`, `✗  Still needed: ${missing.join(', ')}.`],
    };
  };

  /**
   * Check the whole setup and post a real card.
   *
   * Every failure this can have looks the same from the outside — nothing
   * appears in Discord — so it reports each check separately rather than
   * succeeding or failing as a whole. The channel check is its own line on
   * purpose: a private channel needs the bot added *to the channel*, and the
   * server check passes while that is missing.
   */
  const checkRemoteControl = async (): Promise<{ ok: boolean; lines: string[] }> => {
    const cfg = getConfig();
    const token = await host.secrets.get(DISCORD_BOT_TOKEN_KEY);
    const lines: string[] = [];
    const ok = (m: string) => lines.push(`✓  ${m}`);
    const bad = (m: string) => lines.push(`✗  ${m}`);

    lines.push(cfg.remoteEnabled ? '✓  Discord integration is on' : '✗  Discord integration is off in Preferences → Experimental');
    if (!token) {
      bad('No bot token. Press Connect Discord… first.');
      return { ok: false, lines };
    }
    ok('A bot token is stored');

    const api = async (route: string) =>
      fetch(`https://discord.com/api/v10${route}`, { headers: { Authorization: `Bot ${token}` } });

    try {
      const me = await api('/users/@me');
      if (me.ok) ok(`Token works — the bot is ${((await me.json()) as { username?: string }).username ?? 'unnamed'}`);
      else bad(`Discord rejected the token (HTTP ${me.status})`);

      const application = await api('/applications/@me');
      if (application.ok) {
        const url = ((await application.json()) as { interactions_endpoint_url?: string }).interactions_endpoint_url;
        if (url) bad(`An Interactions Endpoint URL is set (${url}). Clear it, or button presses go there instead of to this app.`);
        else ok('No Interactions Endpoint URL, so presses arrive here');
      }

      if (!cfg.remoteGuildId) bad('No server ID set');
      else {
        const guild = await api(`/guilds/${cfg.remoteGuildId}`);
        if (guild.ok) ok(`In the server "${((await guild.json()) as { name?: string }).name ?? cfg.remoteGuildId}"`);
        else bad(`Cannot see that server (HTTP ${guild.status}). Is the bot invited?`);
      }

      if (!cfg.remoteChannelId) bad('No channel ID set');
      else {
        const channel = await api(`/channels/${cfg.remoteChannelId}`);
        if (channel.ok) ok(`Can see #${((await channel.json()) as { name?: string }).name ?? cfg.remoteChannelId}`);
        else bad(`Cannot see that channel (HTTP ${channel.status}). A private channel needs the bot added to the channel itself, not just the server.`);
      }

      if (cfg.remoteAuthorizedUserIds.length === 0) bad('No authorised users, so nothing will be published at all');
      else ok(`${cfg.remoteAuthorizedUserIds.length} authorised user(s)`);

      // The connection is the daemon's, not this process's (#74).
      const status = await remoteLink?.status();
      if (!status) {
        bad('The background service that holds the Discord connection is not running. It starts when Discord integration is on; see logs/remote-daemon.log');
      } else {
        ok(`The background service is running (pid ${status.pid}), so Discord keeps working when Agent Wrangler is closed`);
        if (!status.hasToken) bad('The background service has no bot token yet');
        lines.push(status.connected ? '✓  Connected to the Discord gateway' : '✗  Not connected to the gateway yet');
      }

      // Only post when everything else passed: a card in a channel nobody can
      // act on is litter, and the lines above already say why.
      if (!lines.some((l) => l.startsWith('✗')) && cfg.remoteChannelId) {
        const posted = await fetch(`https://discord.com/api/v10/channels/${cfg.remoteChannelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [
              {
                title: 'Agent Wrangler — test message',
                description: 'Everything checks out. Real permission prompts will appear here, with buttons.',
                color: 0x3ba55d,
              },
            ],
          }),
        });
        lines.push(posted.ok ? '✓  Posted a test message to the channel' : `✗  Could not post (HTTP ${posted.status})`);
      }
    } catch (err) {
      bad(`Could not reach Discord — ${String(err)}`);
    }

    return { ok: !lines.some((l) => l.startsWith('✗')), lines };
  };

  /** The menu's version: run the checks and put them in a dialog. */
  const testRemoteControl = async (): Promise<void> => {
    const { lines } = await checkRemoteControl();
    void dialogs.warn('Agent Wrangler — remote control', { detail: lines.join('\n') }, 'OK');
  };

  const disconnectDiscord = async (): Promise<{ ok: boolean; lines: string[] }> => {
    await host.secrets.delete(DISCORD_BOT_TOKEN_KEY);
    // The daemon forgets its copy and hangs up.
    await remoteLink?.reconfigure();
    log('remote: token removed and disconnected');
    return { ok: true, lines: ['✓  The bot token has been removed and the connection closed.'] };
  };

  /**
   * One entry point for the Preferences window's buttons.
   *
   * The menu versions wrap these in dialogs; the window shows the same lines in
   * place, because a six-line check reads better beside the fields it is about
   * than as a modal over them.
   */
  const runSettingAction = async (id: 'connectDiscord' | 'testRemote' | 'disconnectDiscord') => {
    if (id === 'connectDiscord') return connectDiscord();
    if (id === 'disconnectDiscord') return disconnectDiscord();
    return checkRemoteControl();
  };

  const installHooks = async (): Promise<void> => {
    const dir = hookLogDir();
    const choice = await dialogs.warn(
      'Install Agent Wrangler status hooks?',
      {
        modal: true,
        detail:
          `This adds an Agent Wrangler block to ${settingsPath()} so Claude Code reports exact status ` +
          `(a permission prompt becomes "Blocked" instead of a guess). Your existing hooks and settings ` +
          `are preserved and the file is backed up first.\n\n` +
          `Claude Code reads hook config when a session starts, so only sessions you start afterwards will report.`,
      },
      'Install',
    );
    if (choice !== 'Install') return;
    const res = await writeHooks(dir);
    log(`installHooks: ${res.message}`);
    if (res.ok) void dialogs.info(`Agent Wrangler: ${res.message}`);
    else dialogs.error(`Agent Wrangler: ${res.message}`);
    void store.forceRefresh();
  };

  const uninstallHooks = async (): Promise<void> => {
    const res = await removeHooks();
    log(`uninstallHooks: ${res.message}`);
    if (res.ok) void dialogs.info(`Agent Wrangler: ${res.message}`);
    else dialogs.error(`Agent Wrangler: ${res.message}`);
    void store.forceRefresh();
  };

  const adopting = new Set<string>();
  const adoptCodexSession = async (session: AgentSession): Promise<void> => {
    if (!session.cwd) throw new Error('Agent Wrangler: this Codex conversation has no working folder to resume.');
    if (session.status !== 'waiting' && session.status !== 'done') {
      throw new Error('Agent Wrangler: wait for the current Codex turn to finish before taking over here.');
    }
    const existing = codexRunners.get(session.sessionId);
    // Shown read-only because another app held it: taking over tries again.
    if (existing?.openElsewhere) codexRunners.drop(existing.threadId);
    else if (existing) {
      surface?.showSession(existing);
      return;
    }
    const history = session.transcriptPath
      ? await readRolloutBlocks(session.transcriptPath).catch(() => ({ blocks: [], truncated: false }))
      : { blocks: [], truncated: false };
    // A thread AW started before comes back under the rules it was started with (#71).
    const previous = sessionRegistry.get(session.sessionId);
    const policy = !previous || isOrchestrationOrigin(previous.origin)
      ? previous?.launch.policy
      : { ...previous.launch.policy, codex: { ...previous.launch.policy?.codex, developerInstructions: withConversationDelegation(previous.launch.policy?.codex?.developerInstructions) } };
    let runner: Awaited<ReturnType<CodexRunnerService['resume']>>;
    for (;;) {
      try {
        runner = await codexRunners.resume(session.sessionId, session.cwd, history.blocks, session.model, {
          origin: previous?.origin,
          permissionMode: previous?.launch.permissionMode as PermissionModeName | undefined,
          policy,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already has (?:an active|a live local) writer/i.test(message)) throw error;
        const choice = await dialogs.warn(
          'This Codex conversation is still open in VS Code.',
          {
            modal: true,
            detail:
              'Codex allows only one app to write to a conversation at a time. Close this chat in VS Code, then retry. ' +
              'Or fork it to continue here immediately with the same history under a new conversation ID.',
          },
          'Retry',
          'Fork here',
        );
        if (choice === 'Retry') continue;
        if (choice !== 'Fork here') return;
        runner = await codexRunners.fork(session.sessionId, session.cwd, history.blocks, session.model, policy);
        log(`forked active Codex conversation ${session.sessionId} as ${runner.threadId}`);
        break;
      }
    }
    surface?.showSession(runner);
    log(`controlling Codex conversation ${runner.threadId} here`);
  };
  const actions: SessionActions = {
    async adoptAndSend(key, text, images, signal) {
      if (adopting.has(key)) throw new Error('A takeover is already pending for this session.');
      adopting.add(key);
      try {
        await waitForAdoptable(store, key, signal, true);
        const s = store.get(key);
        if (!s || signal.aborted) throw new Error('Send cancelled; your draft is preserved.');
        const existing = runners.get(s.sessionId);
        const confirm = s.statusIsEstimated === true || host.settings.get<boolean>('runner.confirmTakeoverOnSend', false);
        const runner = existing ?? await adoptSession(s, confirm, signal);
        if (!runner) throw new Error('Takeover cancelled; your draft is preserved.');
        if (signal.aborted) throw new Error('Send cancelled; session was resumed here but no message was sent.');
        if (!runner.canSend) throw new Error('The runner failed to start; your draft is preserved.');
        if ((await runner.send(text, images)) !== 'applied') throw new Error('The runner stopped; your draft is preserved.');
      } finally { adopting.delete(key); }
    },
    smartOpen(key) {
      const s = store.get(key);
      if (!s) return;
      surface?.show(s.key);
    },
    openInTab(key) {
      surface?.openInTab(key);
    },
    rename(key) {
      const s = store.get(key);
      if (!s) return;
      void (async () => {
        const value = await dialogs.input({
          title: `Name for ${s.title}`,
          prompt: 'Your own name for this conversation. Leave it blank to go back to the name it came with.',
          value: s.nickname ?? '',
          placeHolder: s.title,
          validateInput: (v) =>
            v.trim().length > MAX_NICKNAME_LENGTH ? `Keep it to ${MAX_NICKNAME_LENGTH} characters or fewer.` : undefined,
        });
        // Escape gives undefined and must change nothing; an empty string is a
        // deliberate "use its own title again", which is what clearing does.
        if (value === undefined) return;
        nicknames.set(key, value);
      })();
    },
    adopt(key) {
      const s = store.get(key);
      if (!s) return;
      if (adopting.has(key)) return;
      adopting.add(key);
      const adoption = s.provider === 'codex' ? adoptCodexSession(s) : adoptSession(s).then(() => undefined);
      void adoption.catch((e) => dialogs.error(String(e))).finally(() => adopting.delete(key));
    },
    release(key) {
      const s = store.get(key);
      if (s?.provider === 'codex') {
        if (!codexRunners.owns(s.sessionId)) return;
        codexRunners.release(s.sessionId);
        log(`released Codex conversation ${s.sessionId}`);
        return;
      }
      const runner = runners.get(s?.sessionId);
      if (!s || !runner) return;
      if (!host.shell.runInTerminal) {
        dialogs.error('Agent Wrangler: this host has no terminal to hand the session back to.');
        return;
      }
      void (async () => {
        const choice = await dialogs.warn(
          `Hand ${displayLabel(s)} back to a terminal?`,
          {
            modal: true,
            detail:
              'This window stops running the session and a terminal resumes it with the same id. ' +
              'The conversation is the transcript, so nothing is lost — but a turn in flight is cut off.',
          },
          'Release',
        );
        if (choice !== 'Release') return;
        if (s.pid !== undefined && pause.isPaused(s.pid)) pause.resume(s.pid);
        await runners.end(runner);
        // The terminal's `claude --resume` is a new owner: nothing of ours may
        // still be running the id (a host signalled as a fallback gives its
        // agent a few seconds), so sweep and wait first (§7.3).
        try {
          await beforeResume(s.sessionId);
        } catch (err) {
          dialogs.error(`Agent Wrangler: not handed to a terminal. ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        resumeInTerminal(s, getConfig, host.shell, dialogs);
        log(`released ${s.sessionId} to a terminal`);
      })();
    },
    closeSession(key, opts) {
      const s = store.get(key);
      if (!s) return Promise.resolve(false);
      return confirmAndCloseSession(s, opts ?? {});
    },
    pauseSession(key, wanted) {
      const s = store.get(key);
      if (!s) return;
      setPaused(s, wanted);
    },
    pauseAll(wanted) {
      void requestPauseAll(wanted);
    },
    resume(key) {
      const s = store.get(key);
      if (!s) return;
      if (s.provider !== 'claude') {
        resumeInTerminal(s, getConfig, host.shell, dialogs);
        return;
      }
      // A terminal resuming the id is a second owner like any other (§7.3).
      void beforeResume(s.sessionId)
        .then(() => resumeInTerminal(s, getConfig, host.shell, dialogs))
        .catch((err) => dialogs.error(`Agent Wrangler: not resumed. ${err instanceof Error ? err.message : String(err)}`));
    },
    copyId(key) {
      const s = store.get(key);
      if (!s) return;
      void host.clipboard.writeText(s.sessionId).then(() => {
        dialogs.flash(`Copied session id ${s.sessionId}`, 2500);
      });
    },
    reveal(key) {
      const s = store.get(key);
      if (!s?.transcriptPath) {
        void dialogs.warn('Agent Wrangler: no transcript file for this session.', {});
        return;
      }
      host.shell.revealInFileManager(s.transcriptPath);
    },
    refreshAll() {
      void store.forceRefresh();
    },
    openExternal(url) {
      if (/^https?:\/\//i.test(url)) host.shell.openExternal(url);
    },
    openFile(filePath) {
      host.shell.openFile(filePath);
    },
    installHooks() {
      void installHooks();
    },
    async decidePermission(key, behavior, opts) {
      const s = store.get(key);
      if (!s || s.provider !== 'claude') return 'unsupported';
      const expected = opts?.expectedRequestId;
      // A session in a host is answered through the host (§6.1): its ask
      // waits for days, where the hook gives up after ~28 minutes, and since
      // Stage 4 the hook does not wait for hosted sessions at all, so the
      // host is the only way in (`AGENTWRANGLER_HOSTED`). The request named is
      // answered; with none named, only a lone pending one, so the answer
      // cannot land on the wrong prompt.
      const hosted = runners.get(s.sessionId);
      if (hosted?.hosted) {
        const pending = hostedPermissions(hosted);
        const target = expected !== undefined ? pending.find((b) => b.requestId === expected) : pending.length === 1 ? pending[0] : undefined;
        if (target) {
          const outcome = await hosted.decide(target.requestId, behavior);
          if (outcome === 'applied') {
            log(`permission ${behavior} sent to the host running ${s.name ?? s.sessionId}`);
            return 'applied';
          }
          dialogs.flash(`Agent Wrangler: ${displayLabel(s)} is no longer waiting on that permission.`, 4000);
          return outcome === 'stale' ? 'stale' : 'gone';
        }
      }
      // Caught here only to say the right thing: this snapshot can be a poll
      // behind, so `HookLog.decide` re-checks against the id it read off the
      // event stream, which is the one that actually decides.
      if (expected !== undefined && s.permissionRequestId !== expected) {
        dialogs.flash(`Agent Wrangler: that prompt for ${displayLabel(s)} has already been answered.`, 4000);
        return 'stale';
      }
      const sent = await provider.decidePermission(s.sessionId, behavior, expected);
      if (sent) {
        log(`permission ${behavior} sent to ${s.name ?? s.sessionId}`);
        if (behavior === 'always' && s.alwaysAllow) {
          dialogs.flash(
            `Agent Wrangler: allowed ${s.alwaysAllow.rules.join(', ')} in ${s.alwaysAllow.destination}.`,
            5000,
          );
        }
        return 'applied';
      }
      // The prompt was answered in Claude Code first, or the hook gave up
      // waiting; either way there is nothing left to decide from here.
      dialogs.flash(`Agent Wrangler: ${displayLabel(s)} is no longer waiting on that permission.`, 4000);
      return 'gone';
    },
    async answerQuestion(key, requestId, answers) {
      const s = store.get(key);
      if (!s) return 'unsupported';
      // `owns` rather than a try-and-see: a session running in a terminal has
      // no question here to answer, and saying so is not the same as failing.
      if (!runnerOwnership.owns(s.sessionId) || !runnerOwnership.answer) return 'unsupported';
      const parked = runnerOwnership.pendingQuestion?.(s.sessionId);
      if (parked && parked.requestId !== requestId) return 'stale';
      const answered = await runnerOwnership.answer(s.sessionId, requestId, answers);
      if (answered) {
        log(`question answered for ${s.name ?? s.sessionId}`);
        return 'applied';
      }
      dialogs.flash(`Agent Wrangler: ${displayLabel(s)} is no longer waiting on that question.`, 4000);
      return 'gone';
    },
    async decidePlan(key, requestId, approve, feedback) {
      const s = store.get(key);
      if (!s) return 'unsupported';
      if (!runnerOwnership.owns(s.sessionId) || !runnerOwnership.decidePlan) return 'unsupported';
      const parked = runnerOwnership.pendingPlan?.(s.sessionId);
      if (parked && parked.requestId !== requestId) return 'stale';
      const decided = await runnerOwnership.decidePlan(s.sessionId, requestId, approve, feedback);
      if (decided) {
        log(`plan ${approve ? 'approved' : 'rejected'} for ${s.name ?? s.sessionId}`);
        return 'applied';
      }
      dialogs.flash(`Agent Wrangler: ${displayLabel(s)} is no longer waiting on that plan.`, 4000);
      return 'gone';
    },
  };

  // One microphone, so one recorder for the whole process however many panes are open.
  const dictation = new DictationService({
    spawn,
    settings: () => ({
      ffmpegPath: host.settings.get<string>('dictation.ffmpegPath', ''),
      whisperPath: host.settings.get<string>('dictation.whisperPath', ''),
      modelPath: host.settings.get<string>('dictation.modelPath', ''),
      inputDevice: host.settings.get<string>('dictation.inputDevice', ':default'),
      livePreview: host.settings.get<boolean>('dictation.livePreview', true),
    }),
  });

  // Files offered after an `@` in the composer, per session folder.
  const files = new FileSuggestService();

  /**
   * The store as the remote layer must see it: with the archive and the pause
   * state applied.
   *
   * `remoteAskFor` skips archived and paused sessions — a frozen process cannot
   * act on an answer, so a button offering one would appear to work and do
   * nothing — but those two fields are decorations, and handing it raw store
   * sessions meant neither was ever set.
   *
   * It also carries what this window's own runners are parked on. A question or
   * a plan never reaches the `PermissionRequest` hook, so the store has no way
   * to learn about one: it exists only in the heap of the process running the
   * session, which — since the app holds a single-instance lock — is this one.
   *
   * The change sources are why this is a view rather than a mapped array.
   * Archiving a row, pausing a process and a runner reaching an ask all change
   * what should be mirrored while touching nothing a provider scan would
   * notice, so a consumer watching only the store would not hear about any of
   * them until the session next moved of its own accord.
   */
  const remoteSessions = new DecoratedSessions(
    store,
    {
      isArchived: (key) => archive.isArchived(key),
      isPaused: (pid) => pause.isPaused(pid),
      runnerOwned: (id) => runnerOwnership.owns(id),
      pendingQuestion: (id) => runnerOwnership.pendingQuestion?.(id),
      pendingPlan: (id) => runnerOwnership.pendingPlan?.(id),
      rateLimit: (id) => runnerOwnership.rateLimit?.(id),
      pendingPermission: (id) => runnerOwnership.pendingPermission?.(id),
    },
    [archive, pause, runnerOwnership],
  );
  host.subscribe(remoteSessions);
  /**
   * Remote control runs in the remote daemon (#74), not here.
   *
   * The daemon holds the Discord connection and the reconciler, and keeps both
   * going while this app is quit, crashed or being reinstalled. This process is
   * its best feed while it runs: it hands over the settings and the bot token
   * (which stays in `safeStorage`; the daemon keeps it in memory), streams
   * `remoteSessions`, and applies the presses the daemon sends back through
   * `actions`, the same calls the dashboard's buttons make. Nothing is started
   * until `remote.enabled` is on, so the default configuration runs no daemon.
   *
   * The list is not offered as complete (`ready`) until the Claude provider's
   * first scan is in and adopted hosts have had a moment to catch up: until
   * then the daemon keeps following its own feed, rather than close cards for
   * asks this process has not seen yet.
   */
  let remoteReady = false;
  const remoteLink = host.remoteDaemon
    ? new RemoteDaemonLink({
        paths: host.remoteDaemon.paths,
        build: host.sessionHosts?.runtime.buildId ?? 'dev',
        log: (m) => log(`remote: ${m}`),
        ensure: (why) => host.remoteDaemon!.ensure(why),
        replaceOutdated: host.remoteDaemon.replaceOutdated,
        configure: async () => ({
          config: getConfig(),
          homeDir: os.homedir(),
          botToken: getConfig().remoteEnabled ? ((await host.secrets.get(DISCORD_BOT_TOKEN_KEY)) ?? null) : null,
        }),
        sessions: remoteSessions,
        ready: () => remoteReady,
        extras: () => {
          const nicknamed: Record<string, string> = {};
          const archived: string[] = [];
          for (const s of store.sessions) {
            const name = nicknames.get(s.key);
            if (name) nicknamed[s.key] = name;
            if (archive.isArchived(s.key)) archived.push(s.key);
          }
          return { archived, nicknames: nicknamed };
        },
        actions,
      })
    : undefined;
  if (remoteLink) host.subscribe(remoteLink);
  announceRemote = (notice) => void remoteLink?.notify(notice);

  /** Start following the daemon, hand it new settings, or stop it: whichever `remote.enabled` now says. */
  let remoteWanted = false;
  let remoteSyncing: Promise<void> = Promise.resolve();
  const syncRemote = (): Promise<void> => {
    remoteSyncing = remoteSyncing.then(async () => {
      if (!remoteLink || !host.remoteDaemon) return;
      if (getConfig().remoteEnabled) {
        if (!remoteWanted) {
          remoteWanted = true;
          remoteLink.start(); // configures on connect
        } else {
          await remoteLink.reconfigure();
        }
        return;
      }
      if (remoteWanted) {
        remoteWanted = false;
        // Told first, so it closes its cards and hangs up before it is stopped.
        await remoteLink.reconfigure();
        await remoteLink.stop();
      }
      await host.remoteDaemon.remove().catch((err) => log(`remote: could not remove the daemon: ${String(err)}`));
    });
    return remoteSyncing;
  };

  host.subscribe(
    host.settings.onDidChange((affects) => {
      if (
        affects('remote.enabled') ||
        affects('remote.discord.guildId') ||
        affects('remote.discord.channelId') ||
        affects('remote.discord.authorizedUserIds') ||
        // The toolbar button: the daemon closes the open cards when it goes
        // off, and republishes whatever is still being asked when it comes on.
        affects('remote.notificationsEnabled') ||
        affects('remote.notifyOnDone')
      ) {
        void syncRemote();
      }
    }),
  );

  // "Needs you" notifications, with a per-session cooldown. Opt-in while the
  // window is open; on by default while it is closed, when the menu bar and
  // these are the only way to hear about it (Stage 6). An OS notification
  // where the host has one: it takes no focus, where a message box does.
  const lastToastAt = new Map<string, number>();
  host.subscribe(
    store.onDidUpdate((u) => {
      if (u.becameWaiting.length === 0) return;
      const cfg = getConfig();
      const windowOpen = surface?.isOpen ?? false;
      if (!(cfg.notifyOnWaiting || (!windowOpen && cfg.notifyWhenWindowClosed))) return;
      const now = Date.now();
      for (const s of u.becameWaiting) {
        if (archive.isArchived(s.key)) continue; // archived sessions stay quiet
        if (now - (lastToastAt.get(s.key) ?? 0) < 30_000) continue;
        lastToastAt.set(s.key, now);
        if (host.notify) {
          const notice = attentionNotice({ ...s, title: displayTitle(s) });
          if (!notice) continue;
          host.notify({
            ...notice,
            // Clicked: the user asked for it, so the window comes forward.
            onClick: () => surface?.show(s.key, { preserveFocus: false }),
          });
          continue;
        }
        const msg =
          s.status === 'blocked'
            ? `${displayTitle(s)} needs your permission${s.blockedReason ? ` for ${s.blockedReason}` : ''}`
            : s.status === 'done'
              ? `${displayTitle(s)} is done`
              : `${displayTitle(s)} is waiting on you`;
        void dialogs.info(msg, 'Open', 'Dashboard').then((choice) => {
          if (choice === 'Open') actions.smartOpen(s.key);
          else if (choice === 'Dashboard') surface?.open();
        });
      }
    }),
  );

  /**
   * "That one is done", to Discord.
   *
   * Rides the same `becameWaiting` edge the toasts do rather than watching
   * status itself: the store already owns the working→finished transition, and
   * a second opinion about when an agent finished is a second thing that can be
   * wrong. The edge fires once per finish, so this does not repeat while a
   * session sits there done.
   *
   * The cooldown is for the flapping case only — an agent that finishes, is
   * given more work and finishes again inside half a minute is one event worth
   * reporting, not two.
   */
  const lastDoneNoticeAt = new Map<string, number>();
  host.subscribe(
    store.onDidUpdate((u) => {
      if (u.becameWaiting.length === 0) return;
      const cfg = getConfig();
      if (!cfg.remoteEnabled || !cfg.remoteNotifyOnDone) return;
      const now = Date.now();
      for (const s of u.becameWaiting) {
        if (archive.isArchived(s.key)) continue; // archived sessions stay quiet
        const notice = doneNoticeFor(s);
        // Logged rather than silent: "it finished and Discord said nothing" is
        // otherwise impossible to tell apart from "it never looked finished".
        if (!notice) {
          log(`remote: no done notice for ${s.key} (status ${s.status})`);
          continue; // blocked: the permission card is already saying so
        }
        if (now - (lastDoneNoticeAt.get(s.key) ?? 0) < 30_000) {
          log(`remote: done notice for ${s.key} inside the cooldown`);
          continue;
        }
        lastDoneNoticeAt.set(s.key, now);
        announceRemote?.(notice);
      }
    }),
  );

  const pickSession = async (filter?: (s: AgentSession) => boolean): Promise<AgentSession | undefined> => {
    const candidates = store.sessions.filter(filter ?? (() => true));
    if (candidates.length === 0) {
      void dialogs.info('Agent Wrangler: no matching sessions.');
      return undefined;
    }
    const picked = await dialogs.pick(
      candidates.map((s) => ({
        label: `${QUICKPICK_ICON[s.status]} ${displayTitle(s)}`,
        description: [s.projectName, STATUS_LABEL[s.status]].filter(Boolean).join(' · '),
        detail: s.subtitle,
        key: s.key,
      })),
      { placeHolder: 'Select an agent session', matchOnDescription: true, matchOnDetail: true },
    );
    return picked ? store.get(picked.key) : undefined;
  };

  const withSession =
    (fn: (key: string) => void, filter?: (s: AgentSession) => boolean) => async (key?: unknown) => {
      if (typeof key === 'string' && store.get(key)) {
        fn(key);
        return;
      }
      const s = await pickSession(filter);
      if (s) fn(s.key);
    };

  /**
   * Bring back the conversation this process was running before it restarted.
   *
   * Runner sessions are children of this process, so a restart ends every one
   * of them — but only the process. Resuming the id reads the same transcript
   * back, so the only thing actually lost is a turn that was in flight. Every
   * interrupted session is offered on its row; this brings back only the
   * newest Claude one, within a few hours, never one the orchestrator owns,
   * and never one something else is already running.
   */
  /**
   * Stage 5: the Codex threads the last run was driving are, with the
   * background server, most likely still running there. Rejoin each; a
   * running turn carries on, and pending approvals and questions come back as
   * the same cards. If the server itself went (a reboot), the threads load
   * from disk, and what was in flight is recorded in them as interrupted.
   */
  const rejoinCodexThreads = async (): Promise<void> => {
    if (!codexKeepAlive) {
      await retireCodexHost();
      return;
    }
    const records = startup.interrupted.filter((r) => r.provider === 'codex' && r.endedReason === 'app-restart');
    if (records.length > 0) {
      const result = await codexRunners.reattach(records);
      log(
        `codex: rejoined ${result.reattached.length} thread(s)` +
          (result.elsewhere.length ? `, ${result.elsewhere.length} open elsewhere` : '') +
          (result.dropped.length ? `, dropped ${result.dropped.length} with no turns` : '') +
          (result.failed.length ? `, ${result.failed.length} failed` : ''),
      );
    }
    await updateCodexHostIfIdle();
  };

  /**
   * A newer Codex means a server restart, which ends in-flight turns and
   * pending asks, so it happens only when nothing is running (or when the
   * user asks: `restartCodexServer`). Never mid-turn.
   */
  const updateCodexHostIfIdle = async (): Promise<void> => {
    const outdated = codexHost.outdated();
    if (!outdated) return;
    const active = await codexRunners.activeThreads();
    if (active > 0) {
      log(`codex: ${outdated.available} is available (server runs ${outdated.running ?? 'unknown'}); not restarting with ${active} active thread(s)`);
      return;
    }
    log(`codex: restarting the idle server for ${outdated.available} (was ${outdated.running ?? 'unknown'})`);
    // The connection drops, reconnects, and the connector launches the new binary.
    await codexHost.stop('SIGTERM');
  };

  /** The setting is off: a background server left from before would hold its threads' writer locks. */
  const retireCodexHost = async (): Promise<void> => {
    if (!codexHost.running()) return;
    const probe = new CodexAppServer(hostConnector(codexHost), log);
    const probeRunners = new CodexRunnerService(probe);
    let active = 0;
    try {
      active = await probeRunners.activeThreads();
    } finally {
      // Before stopping: a live probe would reconnect, and relaunch it.
      probeRunners.dispose();
    }
    if (active > 0) {
      log(`codex: leaving the background server running: ${active} thread(s) active in it`);
      return;
    }
    await codexHost.stop('SIGTERM');
    log('codex: stopped the background server (setting off)');
  };

  const restartCodexServer = async (): Promise<void> => {
    if (!codexKeepAlive) {
      void dialogs.info('Agent Wrangler: Codex runs as a child of the app (Keep Codex conversations running across restarts is off). Nothing to restart.');
      return;
    }
    if (!codexHost.running()) {
      void dialogs.info('Agent Wrangler: the Codex server is not running. It starts with the next Codex conversation.');
      return;
    }
    const active = await codexRunners.activeThreads().catch(() => 0);
    const signal = stopSignalFor(active);
    const choice = await dialogs.warn(
      active > 0 ? `Restart the Codex server and interrupt ${active} running conversation${active === 1 ? '' : 's'}?` : 'Restart the Codex server?',
      {
        modal: true,
        detail:
          (active > 0
            ? 'Turns in progress are interrupted and their pending approvals and questions are dropped; send again to continue. '
            : '') + 'The server comes back on the newest Codex installed, and every conversation reconnects.',
      },
      'Restart',
    );
    if (choice !== 'Restart') return;
    const stopped = await codexHost.stop(signal);
    if (!stopped) {
      dialogs.error('Agent Wrangler: the Codex server did not stop. See the log.');
      return;
    }
    log(`codex: server restarted on request (${signal})`);
    // A connection that was up reconnects by itself; otherwise the next request starts one.
    void codexAppServer.start().catch((err) => log(`codex: reconnect after restart failed: ${String(err)}`));
  };

  const resumeLastRunner = async (): Promise<void> => {
    const enabled = host.settings.get<boolean>('runner.autoResumeLastOnStartup', true);
    // Cheap checks first, exactly as before the guard was pulled apart: a
    // disabled setting or nothing recent enough to resume must not cost a
    // filesystem read.
    const candidate = enabled ? autoResumeCandidate(startup.interrupted, Date.now()) : undefined;
    const record = candidate ? { sessionId: candidate.sessionId, cwd: candidate.cwd } : undefined;
    const cwdExists = record ? fs.existsSync(record.cwd) : false;
    const runningElsewhere =
      record && cwdExists
        ? store.sessions.some(
            (s) => s.sessionId.toLowerCase() === record.sessionId.toLowerCase() && s.status !== 'ended',
          )
        : false;
    // The registry check above only sees sessions the Claude Code registry
    // knows about, and a session driven by *another Agent Wrangler runner* —
    // the extension in a VSCode window, or a second copy of the app — has no
    // registry entry at all. To that check it looks dead, and resuming it puts
    // two processes on one transcript, which is the one thing that corrupts a
    // conversation.
    //
    // A transcript written to seconds ago is proof something is driving it, and
    // it needs no lease to observe. The converse does not hold — a model can
    // think in silence for minutes — so this only ever refuses, never confirms.
    // The real fix is an ownership lease; see the plan.
    let transcriptWrittenMsAgo: number | undefined;
    if (record && cwdExists && !runningElsewhere) {
      try {
        transcriptWrittenMsAgo = Date.now() - fs.statSync(transcriptPathFor(record.sessionId, record.cwd)).mtimeMs;
      } catch {
        // No transcript yet, or unreadable. Nothing is writing it either.
      }
    }
    const decision = shouldAutoResume({
      enabled,
      record,
      cwdExists,
      runningElsewhere,
      transcriptWrittenMsAgo,
      recentWriteThresholdMs: RECENT_TRANSCRIPT_WRITE_MS,
    });
    if (!decision.resume) {
      if (decision.reason === 'cwd-missing' && decision.sessionId) sessionRegistry.forget(decision.sessionId);
      // Someone else picked it up — another window, or a terminal. Leave it.
      if (decision.reason === 'running-elsewhere') log(`not resuming ${decision.sessionId}: it is running elsewhere`);
      if (decision.reason === 'recent-transcript-write') {
        log(
          `not resuming ${decision.sessionId}: its transcript was written ${Math.round((decision.writtenMsAgo ?? 0) / 1000)}s ago`,
        );
      }
      return;
    }
    let runner: RunnerView;
    try {
      runner = await runners.resume({
        cwd: decision.cwd,
        resume: decision.sessionId,
        ...claudeLaunch(candidate),
        origin: candidate?.origin,
      });
    } catch (err) {
      log(`not resuming ${decision.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    log(`resumed ${decision.sessionId} after a restart`);
    // Beside the dashboard, without taking the cursor: a window that has just
    // come back should not start by moving your focus. And never by opening
    // one: launched at login, the app starts in the menu bar and stays there.
    if (surface?.isOpen) surface.showSession(runner, { preserveFocus: true });
  };

  /**
   * Hooks can be suppressed with no error we'd ever see: `disableAllHooks`,
   * safe mode, an org policy allowing only managed hooks, or unaccepted
   * workspace trust. Left undetected that looks exactly like a broken feature,
   * so say so instead of showing every session as estimated forever.
   */
  const checkHookHealth = async (): Promise<void> => {
    // An older permission script would still let a decision file answer a
    // hosted session's prompt; it is ours, so bring it up to date first.
    try {
      if (await refreshPermissionScript(hookLogDir())) log('permission hook script updated to this version');
    } catch (err) {
      log(`could not update the permission hook script: ${String(err)}`);
    }
    const state = await currentState(hookLogDir());
    log(`hook install state: ${state.kind}${'why' in state ? ` (${state.why})` : ''}`);
    if (state.kind === 'disabled') {
      void dialogs.warn(`Agent Wrangler: hooks cannot run — ${state.why}.`, {});
      return;
    }
    if (state.kind !== 'installed') return;

    const installedAt = await settingsModifiedAtMs();
    setTimeout(() => {
      if (provider.hooksReporting) return;
      // Only complain about sessions that started after the hooks were written;
      // older ones are expected to be silent, since hook config is snapshotted
      // when a session starts.
      const shouldReport = store.sessions.filter(
        (s) => s.status !== 'ended' && installedAt !== undefined && (s.startedAt ?? 0) > installedAt,
      );
      if (shouldReport.length === 0) return;
      log(`hooks installed but ${shouldReport.length} newer session(s) have reported nothing`);
      void dialogs.warn(
        'Agent Wrangler: status hooks are installed but no session is reporting. Check safe mode, workspace trust, and `disableAllHooks` in settings.json.',
        {},
      );
    }, HOOK_HEALTH_GRACE_MS);
  };

  return {
    store,
    provider,
    codexProvider,
    runners,
    codexRunners,
    sessions,
    sessionRegistry,
    sessionCounts: () => {
      const claude = runners.counts();
      const codex = codexKeepAlive
        ? 0
        : codexRunners.list().filter((h) => h.lifecycle !== 'ended' && h.lifecycle !== 'error').length;
      return { hosted: claude.hosted, local: claude.local + codex };
    },
    runBy: (sessionId) => {
      const claude = runners.get(sessionId);
      if (claude) return claude.hosted ? 'hosted' : 'app';
      if (codexRunners.owns(sessionId)) return codexKeepAlive ? 'hosted' : 'app';
      // A host this app holds but is not following (Close stops it as ours).
      if (hostSupervisor?.heldBy(sessionId)) return 'hosted';
      return 'external';
    },
    async stopSession(key, opts = {}) {
      const s = store.get(key);
      if (!s) return 'gone';
      if (!opts.force && (s.status === 'busy' || s.status === 'stuck' || s.status === 'blocked')) return 'working';
      return closeSessionNow(s);
    },
    proposeTask,
    delegate,
    taskList: () => (tasks ? tasks.list().filter((m) => !['completed', 'cancelled'].includes(m.state)).map(taskSummary) : []),
    async stopAllForQuit(withinMs: number, opts: { includeHosted?: boolean } = {}) {
      const { hosted, local } = runners.counts();
      const ending = local + (opts.includeHosted ? hosted : 0);
      if (ending > 0) log(`quitting: ending ${ending} session(s), waiting up to ${withinMs} ms`);
      // The Claude CLIs get the graceful end sequence, awaited and bounded;
      // hosted ones are let go of (and keep running) unless asked to stop
      // them too. Codex threads are left to `dispose`: with the background
      // server that only closes the connection, and they keep running; with
      // `--stdio` the child goes, and them with it.
      await runners.endAllForQuit(withinMs, opts);
    },
    onSystemResume() {
      // The Discord connection is the daemon's, which notices the sleep itself.
      log('woke from sleep: rechecking session hosts');
      runners.wakeAll();
    },
    restartCodexServer,
    runnerOwnership,
    archive,
    nicknames,
    columns,
    models,
    localEndpoints,
    localMetrics,
    autoRouting,
    onDidChangeRoutingEvidence: (listener) => routingEvidence.onDidChange(listener),
    pause,
    usage,
    codexUsage,
    projects,
    launcher,
    taskPanes,
    missions: missionSource,
    dictation,
    files,
    actions,
    getConfig,

    attachSurface(next) {
      surface = next;
    },

    newConversation,
    startCodexConversation,
    browseForProject,
    refresh() {
      void store.forceRefresh();
      void usage.refresh({ force: true });
    },
    pauseAll(wanted) {
      void requestPauseAll(wanted);
    },
    installHooks,
    uninstallHooks,
    connectDiscord,
    disconnectDiscord,
    testRemoteControl,
    runSettingAction,
    pickSession,
    withSession,

    start() {
      usage.start();
      codexUsage.start();
      const remoteFirstScan = store.register(provider).catch((err) => log(`provider start failed: ${String(err)}`));
      void store.register(codexProvider).catch((err) => log(`Codex provider start failed: ${String(err)}`));
      log('Agent Wrangler started');
      void checkHookHealth();
      // Off by default, so this normally reads the setting and stops.
      void syncRemote();
      // The list the daemon follows is complete once the Claude provider's
      // first scan is in, Codex threads are rejoined, and every adopted host
      // has caught up (its view has left `starting`/`connecting`, so its
      // pending asks are known), or after 30 s at most. Until then the daemon
      // keeps following its own feed, which already sees those hosts' asks.
      void Promise.all([remoteFirstScan, startupSettled]).then(async () => {
        const deadline = Date.now() + 30_000;
        const catchingUp = () => runners.list().some((r) => r.hosted && (r.lifecycle === 'starting' || r.lifecycle === 'connecting'));
        while (Date.now() < deadline && catchingUp()) await new Promise((r) => setTimeout(r, 250));
        remoteReady = true;
        remoteLink?.pushSoon();
      });
      // After the store's first scan, so "is it running elsewhere?" has an answer.
      setTimeout(() => void resumeLastRunner().catch((err) => log(`resume failed: ${String(err)}`)), 2000);
      void rejoinCodexThreads()
        .catch((err) => log(`rejoining Codex threads failed: ${String(err)}`))
        .finally(settleStartup);
    },

    dispose() {
      dictation.cancel(); // never leave ffmpeg holding the microphone after the app has gone
      store.dispose();
    },
  };
}
