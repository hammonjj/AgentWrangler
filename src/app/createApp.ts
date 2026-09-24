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
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { waitForAdoptable } from '../core/adoptQueue';
import { globalConversationDir, sessionsDir } from '../claude/paths';
import { resolveClaudeBinary } from '../claude/binary';
import { ClaudeProvider } from '../claude/claudeProvider';
import { CodexProvider } from '../codex/codexProvider';
import { CodexAppServer } from '../codex/appServer';
import { readRolloutBlocks } from '../codex/rollout';
import { codexUsageReader } from '../codex/usage';
import { CodexRunnerService } from '../codex/runner';
import { isPidAlive, readRegistry } from '../claude/registry';
import { endProcess } from '../claude/runner/adopt';
import { SessionRegistry, type SessionRecord } from '../core/session/sessionRegistry';
import { autoResumeCandidate } from '../core/session/recovery';
import { checkoutFor } from '../core/checkout';
import { RunnerService } from '../claude/runner/runnerService';
import type { RunnerView } from '../claude/runner/runnerView';
import { SessionExecutors } from '../core/session/sessionExecutors';
import { HostSupervisor } from '../core/session/hostSupervisor';
import { shouldAutoResume } from '../core/session/resumePolicy';
import {
  currentState,
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
import { DecoratedSessions } from '../core/sessionView';
import { ColumnPrefsService } from '../core/columnPrefs';
import { readConfig, type ConfigGetter } from '../core/config';
import { DictationService } from '../core/dictation';
import { HiddenProjectsService } from '../core/hiddenProjects';
import { ModelCatalogService } from '../core/modelCatalog';
import { MAX_NICKNAME_LENGTH, NicknameService } from '../core/nicknameService';
import { PinService } from '../core/pinService';
import { autoPauseDecision, maxUsagePercent } from '../core/autoPause';
import { PauseService } from '../core/pauseService';
import { readStoppedPids } from '../core/procTree';
import { SessionStore } from '../core/sessionStore';
import { TurnStats } from '../core/turnStats';
import { FileUsageCache } from '../core/usageCache';
import { UsageService } from '../core/usageService';
import { FileSuggestService } from '../core/fileSuggest';
import { FileAuditLog } from '../remote/audit';
import { DiscordTransport } from '../remote/discord/transport';
import { MirrorStore } from '../remote/mirrorStore';
import { auditFile, DISCORD_BOT_TOKEN_KEY, mirrorFile } from '../remote/paths';
import { RemoteControlService } from '../remote/service';
import type { RemoteTransport } from '../remote/transport';
import { doneNoticeFor, type RemoteNotice } from '../shared/remote';
import type { HostServices, WorkbenchSurface } from '../host/hostServices';
import type { PermissionModeName } from '../shared/conversation';
import { displayLabel, displayTitle, GLOBAL_PROJECT_DIR, STATUS_LABEL, type AgentSession, type SessionStatus } from '../shared/model';
import type { SessionActions } from '../ui/actions';
import type { ConversationLauncher, ProjectSource, RunnerOwnership, UsageSource } from '../ui/dashboardHost';
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
  pins: PinService;
  nicknames: NicknameService;
  columns: ColumnPrefsService;
  models: ModelCatalogService;
  pause: PauseService;
  usage: UsageSource;
  codexUsage: UsageSource;
  projects: ProjectSource;
  launcher: ConversationLauncher;
  dictation: DictationService;
  files: FileSuggestService;
  /** Mirrors permission prompts to a remote surface. Inert until given a transport. */
  remoteControl: RemoteControlService;
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
  newConversation(cwd?: string): Promise<RunnerView | undefined>;
  /**
   * Live sessions, for the quit decision: `hosted` ones run in session hosts
   * and survive a quit; `local` ones (in-process Claude, and every Codex
   * thread) do not.
   */
  sessionCounts(): { hosted: number; local: number };
  /**
   * The app is quitting: end the sessions that cannot survive it (and hosted
   * ones too with `includeHosted`), awaited and bounded by `withinMs`. Ended
   * ones stay resumable (interrupted); hosted ones left running are adopted
   * on the next start.
   */
  stopAllForQuit(withinMs: number, opts?: { includeHosted?: boolean }): Promise<void>;
  startCodexConversation(cwd: string): Promise<void>;
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
  const codexAppServer = new CodexAppServer(() => getConfig().codexBinaryPath, log);
  const models = new ModelCatalogService(host.globalState);
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
      })
    : undefined;
  const hostScan = hostSupervisor?.scan() ?? { alive: [], dead: [], foreign: [] };
  // Then classify what the last run left behind: every session that was live
  // is interrupted, except those still running in a host (including one this
  // build cannot talk to, which must not look ownerless). The old runner
  // registry is imported once from the surface store.
  const sessionRegistry = new SessionRegistry(host.sessionState, { legacy: host.workspaceState });
  const startup = sessionRegistry.startup(
    new Set(
      [...hostScan.alive, ...hostScan.foreign].map((m) => m.sessionId).filter((id): id is string => typeof id === 'string'),
    ),
  );
  if (startup.interrupted.length > 0) {
    log(`${startup.interrupted.length} session(s) were interrupted by the last restart`);
  }
  for (const m of hostScan.foreign) {
    log(`host ${m.hostId} (session ${m.sessionId}) runs a manifest version this build does not know; leaving it alone`);
  }
  // Hosts that died while the app was away, by their exit record. A failure
  // is recorded as one; an agent that finished on its own ended. Anything
  // else (a logout, Quit and Stop All) stays resumable, as classified above.
  // A host that died silently may have left its agent running: the orphan
  // sweep is Stage 4, and its manifest is kept for it.
  for (const m of hostScan.dead) {
    if (!m.sessionId) continue;
    if (!m.exit) {
      log(`host ${m.hostId} (session ${m.sessionId}) died without an exit record; its agent may still be running`);
      continue;
    }
    const reason = m.exit.reason ?? 'ended';
    if (reason === 'ended') sessionRegistry.setState(m.sessionId, 'ended');
    // Stopped by a client or a signal: resumable, as startup classified it.
    else if (reason === 'stopped' || reason === 'signal') continue;
    // `error`, `crashed`, and (per the protocol) any reason this build does not know.
    else sessionRegistry.setState(m.sessionId, 'failed', m.exit.error ?? `host exit: ${reason}`);
  }
  hostSupervisor?.collect(hostScan);
  const locate = (cwd: string) => checkoutFor(cwd);
  const codexRunners = new CodexRunnerService(codexAppServer, (list) => models.remember('openai', list), {
    registry: sessionRegistry,
    locate,
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
  // Rows kept at the top, and the names the user gave them. Global state like
  // the archive: both are about the session, not about the window looking at it.
  const pins = new PinService(host.globalState);
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
    // Experimental until Stage 4 hardens recovery: new sessions run in hosts
    // only with the setting on. Surviving hosts are adopted either way.
    hosts: hostSupervisor
      ? { supervisor: hostSupervisor, enabled: () => host.settings.get<boolean>('experimental.sessionHosts', false) }
      : undefined,
  });
  host.subscribe(runners);
  const sessions = new SessionExecutors([runners, codexRunners]);

  // Take back every session still running in a host, before the providers'
  // first scan: each is ours from the first snapshot, never an external
  // session to take over or a stale one to resume.
  for (const manifest of hostScan.alive) {
    if (!manifest.sessionId) continue;
    const record = sessionRegistry.get(manifest.sessionId);
    if (!record) sessionRegistry.live({ sessionId: manifest.sessionId, provider: 'claude', cwd: manifest.cwd });
    runners.adopt(manifest, record);
  }

  /**
   * How to start a Claude session: the way it was started before, if the
   * registry remembers (a resume should come back on the same model, mode and
   * effort), otherwise the current defaults.
   */
  const claudeLaunch = (previous?: SessionRecord) => {
    const model = previous?.launch.model ?? (host.settings.get<string>('runner.model', '').trim() || undefined);
    const effort = previous?.launch.effort ?? (host.settings.get<string>('runner.effort', '').trim() || undefined);
    const permissionMode = (previous?.launch.permissionMode ??
      host.settings.get<PermissionModeName>('runner.defaultPermissionMode', 'auto')) as PermissionModeName;
    return { model, effort, permissionMode };
  };
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
    const kind = adoptActionFor(s, runners.owns(s.sessionId));
    if (!kind || !s.cwd) return;
    if (!fs.existsSync(s.cwd)) {
      dialogs.error(`Agent Wrangler: ${s.cwd} no longer exists.`);
      return;
    }

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
        const outcome = await endProcess(now.pid, {
          kill: (pid, sig) => process.kill(pid, sig),
          isAlive: isPidAlive,
          delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
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
    const runner = runners.start({ cwd: s.cwd, resume: s.sessionId, ...claudeLaunch(previous), origin: previous?.origin });
    surface?.showSession(runner);
    log(`adopted ${s.sessionId} into this window`);
    return runner;
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
  const confirmAndCloseSession = async (s: AgentSession): Promise<void> => {
    const label = displayLabel(s);
    const ours = runners.owns(s.sessionId) || codexRunners.owns(s.sessionId);
    if (!ours && s.pid === undefined) {
      void dialogs.warn(
        `Agent Wrangler: no process is known for ${label}, so there is nothing to close.`,
        {},
      );
      return;
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

    const choice = await dialogs.warn(`Close ${label}?`, { modal: true, detail }, 'Close session');
    if (choice !== 'Close session') return;

    // It may have finished, or ended on its own, while the dialog was up.
    const now = store.get(s.key) ?? s;
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
    } else if (now.pid !== undefined) {
      // A stopped process cannot act on SIGTERM, so ending a paused session
      // would burn the whole grace period and then SIGKILL it — the one outcome
      // that can strand a half-written transcript line. Let it run first.
      if (pause.isPaused(now.pid)) pause.resume(now.pid);
      const outcome = await endProcess(now.pid, {
        kill: (pid, sig) => process.kill(pid, sig),
        isAlive: isPidAlive,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      log(`close ${now.sessionId}: ending pid ${now.pid} → ${outcome}`);
      if (outcome === 'refused') {
        dialogs.error(
          `Agent Wrangler: could not stop the process running ${label} — it is ignoring both signals. ` +
            'End it from its own terminal.',
        );
        return;
      }
    }
    // The registry and the transcript will both say "ended" shortly; ask now so
    // the row the user just acted on does not sit there looking alive.
    void store.forceRefresh();
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

  const setPausedAll = (wanted: boolean, why?: string): boolean => {
    let acted = false;
    if (wanted) {
      const candidates = store.sessions
        .filter((s) => s.status !== 'ended' && s.pid !== undefined && !pause.isPaused(s.pid))
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
      if (setPausedAll(true, `plan usage reached ${percent}%`)) autoPauseArmed = false;
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
    { hidden: hiddenProjects },
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
  const startConversation = (requested: string): RunnerView | undefined => {
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
    const model = host.settings.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd,
      permissionMode: host.settings.get<PermissionModeName>('runner.defaultPermissionMode', 'auto'),
      effort: host.settings.get<string>('runner.effort', '').trim() || undefined,
      model: model || undefined,
    });
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
      const model = host.settings.get<string>('codexRunner.model', '').trim() || undefined;
      const effort = host.settings.get<string>('codexRunner.effort', '').trim() || undefined;
      const runner = await codexRunners.start(cwd, model, effort);
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
  const newConversation = async (cwd?: string): Promise<RunnerView | undefined> => {
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

  const launcher: ConversationLauncher = {
    newConversation: (cwd, selectedProvider) =>
      selectedProvider === 'codex' ? startCodexConversation(cwd) : newConversation(cwd),
    browseForProject: () => browseForProject(),
  };

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
    // reconnect has to be asked for here.
    await disconnectTransport();
    await syncRemoteTransport();

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

      lines.push(remoteControl.connected ? '✓  Connected to the Discord gateway' : '✗  Not connected to the gateway yet');

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
    await disconnectTransport();
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
    if (existing) {
      surface?.showSession(existing);
      return;
    }
    const history = session.transcriptPath
      ? await readRolloutBlocks(session.transcriptPath).catch(() => ({ blocks: [], truncated: false }))
      : { blocks: [], truncated: false };
    let runner: Awaited<ReturnType<CodexRunnerService['resume']>>;
    for (;;) {
      try {
        runner = await codexRunners.resume(session.sessionId, session.cwd, history.blocks, session.model);
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
        runner = await codexRunners.fork(session.sessionId, session.cwd, history.blocks, session.model);
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
        resumeInTerminal(s, getConfig, host.shell, dialogs);
        log(`released ${s.sessionId} to a terminal`);
      })();
    },
    closeSession(key) {
      const s = store.get(key);
      if (!s) return;
      void confirmAndCloseSession(s);
    },
    pauseSession(key, wanted) {
      const s = store.get(key);
      if (!s) return;
      setPaused(s, wanted);
    },
    pauseAll(wanted) {
      setPausedAll(wanted);
    },
    resume(key) {
      const s = store.get(key);
      if (s) resumeInTerminal(s, getConfig, host.shell, dialogs);
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
      // Caught here only to say the right thing: this snapshot can be a poll
      // behind, so `HookLog.decide` re-checks against the id it read off the
      // event stream, which is the one that actually decides.
      if (expected !== undefined && s.permissionRequestId !== expected) {
        dialogs.flash(`Agent Wrangler: that prompt for ${displayLabel(s)} has already been answered.`, 4000);
        return 'stale';
      }
      // A session in a host is answered through the host first (§6.1): its ask
      // waits for days, where the hook gives up after ~28 minutes. Only when
      // exactly one permission is pending, so the answer cannot land on the
      // wrong one; otherwise the hook file, as for any session.
      const hosted = runners.get(s.sessionId);
      if (hosted?.hosted) {
        const pending = hosted.blocks.filter(
          (b): b is Extract<(typeof hosted.blocks)[number], { kind: 'permission' }> => b.kind === 'permission' && b.state === 'pending',
        );
        if (pending.length === 1 && (await hosted.decide(pending[0].requestId, behavior)) === 'applied') {
          log(`permission ${behavior} sent to the host running ${s.name ?? s.sessionId}`);
          return 'applied';
        }
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
   * Mirroring permission prompts to a remote surface.
   *
   * Constructed always, connected never — so far. It holds no transport until
   * something hands it one, and with none it does nothing at all: no file is
   * written, no message is posted, and `remote.enabled` does not exist as a
   * setting yet. The transport and the leader lease that decides which process
   * gets it arrive in later phases; this is here so the wiring is reviewed
   * once, against a service whose whole behaviour is already covered by tests.
   */
  const remoteConfig = () => {
    const cfg = getConfig();
    return {
      enabled: cfg.remoteEnabled,
      notificationsEnabled: cfg.remoteNotificationsEnabled,
      guildId: cfg.remoteGuildId,
      channelId: cfg.remoteChannelId,
      authorizedUserIds: cfg.remoteAuthorizedUserIds,
      homeDir: os.homedir(),
    };
  };
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
    },
    [archive, pause, runnerOwnership],
  );
  host.subscribe(remoteSessions);
  const remoteControl = new RemoteControlService(
    remoteSessions,
    actions,
    new MirrorStore(mirrorFile()),
    remoteConfig,
    new FileAuditLog(auditFile()),
    (message) => log(`remote: ${message}`),
  );
  host.subscribe(remoteControl);
  announceRemote = (notice) => void remoteControl.notify(notice);

  /**
   * Connect the transport, or take it away — whichever the settings now say.
   *
   * The token is read on every connect rather than held: it can be replaced or
   * revoked while the app runs, and a cached copy would keep a dead credential
   * alive until a restart. Nothing is constructed at all until the setting is
   * on and a token exists, so the default configuration opens no socket and
   * touches no file.
   */
  let transport: RemoteTransport | undefined;
  let syncing: Promise<void> = Promise.resolve();

  const disconnectTransport = async (): Promise<void> => {
    if (!transport) return;
    remoteControl.setTransport(undefined);
    const going = transport;
    transport = undefined;
    await going.disconnect();
    going.dispose();
  };

  const syncRemoteTransport = (): Promise<void> => {
    syncing = syncing.then(async () => {
      const cfg = remoteConfig();
      const token = cfg.enabled ? await host.secrets.get(DISCORD_BOT_TOKEN_KEY) : undefined;
      const wanted = cfg.enabled && !!token && !!cfg.guildId && !!cfg.channelId;

      if (!wanted) {
        if (transport) log('remote: disconnecting');
        await disconnectTransport();
        return;
      }
      if (transport) return; // already connected, and the token is read per connect

      const next = new DiscordTransport({
        config: () => ({ guildId: cfg.guildId, channelId: cfg.channelId }),
        restDeps: { token: () => token!, log: (m) => log(`remote: ${m}`) },
        // No `gatewayUrl`: the transport asks `GET /gateway/bot` through its
        // own REST client, which already has the token and the rate limiter.
        gatewayDeps: { token: () => token!, log: (m) => log(`remote: ${m}`) },
        log: (m) => log(`remote: ${m}`),
      });
      transport = next;
      remoteControl.setTransport(next);
      try {
        await next.connect();
        log('remote: connecting to Discord');
      } catch (err) {
        log(`remote: could not connect — ${String(err)}`);
      }
    });
    return syncing;
  };

  host.subscribe({ dispose: () => void disconnectTransport() });
  host.subscribe(
    host.settings.onDidChange((affects) => {
      if (
        affects('remote.enabled') ||
        affects('remote.discord.guildId') ||
        affects('remote.discord.channelId') ||
        affects('remote.discord.authorizedUserIds')
      ) {
        void syncRemoteTransport();
      }
      // The toolbar button. Nothing about the connection changes, but what may
      // be published does, so the surface has to be reconciled: off closes the
      // open cards, on republishes whatever is still being asked.
      if (affects('remote.notificationsEnabled')) void remoteControl.reconcile();
    }),
  );

  // Opt-in "waiting on you" toasts, with a per-session cooldown.
  const lastToastAt = new Map<string, number>();
  host.subscribe(
    store.onDidUpdate((u) => {
      if (u.becameWaiting.length === 0 || !getConfig().notifyOnWaiting) return;
      const now = Date.now();
      for (const s of u.becameWaiting) {
        if (archive.isArchived(s.key)) continue; // archived sessions stay quiet
        if (now - (lastToastAt.get(s.key) ?? 0) < 30_000) continue;
        lastToastAt.set(s.key, now);
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
    const runner = runners.start({
      cwd: decision.cwd,
      resume: decision.sessionId,
      ...claudeLaunch(candidate),
      origin: candidate?.origin,
    });
    log(`resumed ${decision.sessionId} after a restart`);
    // Beside the dashboard, without taking the cursor: a window that has just
    // come back should not start by moving your focus.
    surface?.showSession(runner, { preserveFocus: true });
  };

  /**
   * Hooks can be suppressed with no error we'd ever see: `disableAllHooks`,
   * safe mode, an org policy allowing only managed hooks, or unaccepted
   * workspace trust. Left undetected that looks exactly like a broken feature,
   * so say so instead of showing every session as estimated forever.
   */
  const checkHookHealth = async (): Promise<void> => {
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
      const codex = codexRunners.list().filter((h) => h.lifecycle !== 'ended' && h.lifecycle !== 'error').length;
      return { hosted: claude.hosted, local: claude.local + codex };
    },
    async stopAllForQuit(withinMs: number, opts: { includeHosted?: boolean } = {}) {
      // Codex threads end with the app-server in `dispose`; the Claude CLIs
      // get the graceful end sequence first, awaited and bounded. Hosted ones
      // are let go of (and keep running) unless asked to stop them too.
      await runners.endAllForQuit(withinMs, opts);
    },
    runnerOwnership,
    archive,
    pins,
    nicknames,
    columns,
    models,
    pause,
    usage,
    codexUsage,
    projects,
    launcher,
    dictation,
    files,
    actions,
    remoteControl,
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
      setPausedAll(wanted);
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
      void store.register(provider).catch((err) => log(`provider start failed: ${String(err)}`));
      void store.register(codexProvider).catch((err) => log(`Codex provider start failed: ${String(err)}`));
      log('Agent Wrangler started');
      void checkHookHealth();
      // Off by default, so this normally reads the setting and stops.
      void syncRemoteTransport();
      // After the store's first scan, so "is it running elsewhere?" has an answer.
      setTimeout(() => void resumeLastRunner().catch((err) => log(`resume failed: ${String(err)}`)), 2000);
    },

    dispose() {
      dictation.cancel(); // never leave ffmpeg holding the microphone after the app has gone
      store.dispose();
    },
  };
}
