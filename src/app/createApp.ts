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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { waitForAdoptable } from '../core/adoptQueue';
import { sessionsDir } from '../claude/paths';
import { resolveClaudeBinary } from '../claude/binary';
import { ClaudeProvider } from '../claude/claudeProvider';
import { CodexProvider } from '../codex/codexProvider';
import { CodexAppServer } from '../codex/appServer';
import { codexUsageReader } from '../codex/usage';
import { CodexRunnerService } from '../codex/runner';
import { isPidAlive, readRegistry } from '../claude/registry';
import { endProcess } from '../claude/runner/adopt';
import { RunnerRegistry } from '../claude/runner/runnerRegistry';
import { RunnerService } from '../claude/runner/runnerService';
import type { RunnerSession } from '../claude/runner/runnerSession';
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
import type { HostServices, WorkbenchSurface } from '../host/hostServices';
import type { PermissionModeName } from '../shared/conversation';
import { displayLabel, displayTitle, STATUS_LABEL, type AgentSession, type SessionStatus } from '../shared/model';
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
  runnerRegistry: RunnerRegistry;
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
  newConversation(cwd?: string): Promise<RunnerSession | undefined>;
  startCodexConversation(cwd: string): Promise<void>;
  browseForProject(): Promise<string | undefined>;
  refresh(): void;
  pauseAll(wanted: boolean): void;
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
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
  const codexRunners = new CodexRunnerService(codexAppServer);
  host.subscribe(codexRunners);
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
  // Surface state, not global: two windows sharing one record would both
  // resume the same session, and two processes on one id corrupt its transcript.
  // What the launcher's model dropdown offers: the list the last conversation
  // reported, since the launcher has no running CLI of its own to ask.
  const models = new ModelCatalogService(host.globalState);
  const runnerRegistry = new RunnerRegistry(host.workspaceState);
  const runners = new RunnerService({
    query: sdkQuery,
    binary: () => resolveClaudeBinary(getConfig().claudeBinaryPath),
    log,
    registry: runnerRegistry,
    rememberModels: (list) => models.remember(list),
  });
  host.subscribe(runners);
  const runnerOwnership: RunnerOwnership = {
    owns: (id: string | undefined) => runners.owns(id) || codexRunners.owns(id),
    wasRunning: (id: string) => runners.wasRunning(id),
    onDidChange: (listener: () => void) => {
      const claude = runners.onDidChange(listener);
      const codex = codexRunners.onDidChange(listener);
      return { dispose: () => { claude.dispose(); codex.dispose(); } };
    },
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
    const model = host.settings.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd: s.cwd,
      resume: s.sessionId,
      permissionMode: host.settings.get<PermissionModeName>('runner.defaultPermissionMode', 'acceptEdits'),
      effort: host.settings.get<string>('runner.effort', '').trim() || undefined,
      model: model || undefined,
    });
    surface?.showRunner(runner);
    log(`adopted ${s.sessionId} into this window`);
    return runner;
  };

  /**
   * End the process running a session, and stop there.
   *
   * This is not `adopt` without the resume, and not `release` either: both of
   * those hand the session on to something else, and this deliberately hands it
   * to nobody. What makes that safe to offer is the same fact they rest on — a
   * Claude Code conversation *is* its transcript — so closing a session is
   * parking it, not destroying it. The row moves to Ended and `claude --resume`
   * picks it up where it stopped.
   *
   * A turn in flight is the one thing that does not survive, and unlike `adopt`
   * that does not withdraw the offer: the session most worth closing is the one
   * that has wedged, which is `stuck` or `busy` by definition. The modal is
   * where that cost gets stated instead.
   */
  const confirmAndCloseSession = async (s: AgentSession): Promise<void> => {
    const label = displayLabel(s);
    if (!runners.owns(s.sessionId) && s.pid === undefined) {
      void dialogs.warn(
        `Agent Wrangler: no process is known for ${label}, so there is nothing to close.`,
        {},
      );
      return;
    }

    const working = s.status === 'busy' || s.status === 'stuck' || s.status === 'blocked';
    const detail = [
      runners.owns(s.sessionId)
        ? 'This window stops running the session.'
        : 'The process running it ends. Its terminal or Claude Code panel will show it as ended.',
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
    if (runner) {
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

  /** Spawn and show. The only path that starts a runner, so the cwd check lives here. */
  const startConversation = (cwd: string): RunnerSession | undefined => {
    if (!fs.existsSync(cwd)) {
      dialogs.error(`Agent Wrangler: ${cwd} no longer exists.`);
      return undefined;
    }
    // Working in a folder is the strongest possible statement that it belongs
    // in the list, so it also undoes a removal — the same rule as browsing.
    projects.add(cwd);
    const model = host.settings.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd,
      permissionMode: host.settings.get<PermissionModeName>('runner.defaultPermissionMode', 'acceptEdits'),
      effort: host.settings.get<string>('runner.effort', '').trim() || undefined,
      model: model || undefined,
    });
    surface?.showRunner(runner);
    return runner;
  };

  const startCodexConversation = async (cwd: string): Promise<void> => {
    if (!fs.existsSync(cwd)) {
      dialogs.error(`Agent Wrangler: ${cwd} no longer exists.`);
      return;
    }
    projects.add(cwd);
    try {
      const model = host.settings.get<string>('codexRunner.model', '').trim() || undefined;
      const runner = await codexRunners.start(cwd, model);
      surface?.showCodexRunner(runner);
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
  const newConversation = async (cwd?: string): Promise<RunnerSession | undefined> => {
    if (cwd) return startConversation(cwd);

    // Newest first, the same order and the same list the dashboard dropdown shows.
    await projects.refresh();
    const folders: { label: string; description?: string; dir?: string; browse?: boolean }[] = projects.value.map(
      (p) => ({ label: p.name, description: p.dir, dir: p.dir }),
    );
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
        runner.send(text, images);
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
    togglePinned(key) {
      pins.toggle(key);
      // Wanting a row out of the way and at the top of the table at once is not
      // a state worth being able to reach, so the two clear each other.
      if (pins.isPinned(key)) archive.set(key, false);
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
      void adoptSession(s).catch((e) => dialogs.error(String(e))).finally(() => adopting.delete(key));
    },
    release(key) {
      const s = store.get(key);
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
  };

  // One microphone, so one recorder for the whole process however many panes are open.
  const dictation = new DictationService({
    spawn,
    settings: () => ({
      ffmpegPath: host.settings.get<string>('dictation.ffmpegPath', ''),
      whisperPath: host.settings.get<string>('dictation.whisperPath', ''),
      modelPath: host.settings.get<string>('dictation.modelPath', ''),
      inputDevice: host.settings.get<string>('dictation.inputDevice', ':default'),
    }),
  });

  // Files offered after an `@` in the composer, per session folder.
  const files = new FileSuggestService();

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
   * Runner sessions are children of this process, so a reload or a quit ends
   * every one of them — but only the process. Resuming the id reads the same
   * transcript back, so the only thing actually lost is a turn that was in
   * flight. Bounded deliberately: the most recent session only, recorded in
   * *this* surface's state, within a few hours, and never one something else is
   * already running.
   */
  const resumeLastRunner = async (): Promise<void> => {
    if (!host.settings.get<boolean>('runner.autoResumeLastOnStartup', true)) return;
    const record = runnerRegistry.resumable();
    if (!record) return;
    if (!fs.existsSync(record.cwd)) {
      runnerRegistry.forget(record.sessionId);
      return;
    }
    const live = store.sessions.find(
      (s) => s.sessionId.toLowerCase() === record.sessionId.toLowerCase() && s.status !== 'ended',
    );
    if (live) {
      // Someone else picked it up — another window, or a terminal. Leave it.
      log(`not resuming ${record.sessionId}: it is running elsewhere`);
      return;
    }
    // The check above only sees sessions the Claude Code registry knows about,
    // and a session driven by *another Agent Wrangler runner* — the extension
    // in a VSCode window, or a second copy of the app — has no registry entry
    // at all. To that check it looks dead, and resuming it puts two processes
    // on one transcript, which is the one thing that corrupts a conversation.
    //
    // A transcript written to seconds ago is proof something is driving it, and
    // it needs no lease to observe. The converse does not hold — a model can
    // think in silence for minutes — so this only ever refuses, never confirms.
    // The real fix is an ownership lease; see the plan.
    try {
      const writtenMsAgo = Date.now() - fs.statSync(transcriptPathFor(record.sessionId, record.cwd)).mtimeMs;
      if (writtenMsAgo < RECENT_TRANSCRIPT_WRITE_MS) {
        log(`not resuming ${record.sessionId}: its transcript was written ${Math.round(writtenMsAgo / 1000)}s ago`);
        return;
      }
    } catch {
      // No transcript yet, or unreadable. Nothing is writing it either.
    }
    const model = host.settings.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd: record.cwd,
      resume: record.sessionId,
      permissionMode: host.settings.get<PermissionModeName>('runner.defaultPermissionMode', 'acceptEdits'),
      effort: host.settings.get<string>('runner.effort', '').trim() || undefined,
      model: model || undefined,
    });
    log(`resumed ${record.sessionId} after a restart`);
    // Beside the dashboard, without taking the cursor: a window that has just
    // come back should not start by moving your focus.
    surface?.showRunner(runner, { preserveFocus: true });
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
    runnerRegistry,
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
    pickSession,
    withSession,

    start() {
      usage.start();
      codexUsage.start();
      void store.register(provider).catch((err) => log(`provider start failed: ${String(err)}`));
      void store.register(codexProvider).catch((err) => log(`Codex provider start failed: ${String(err)}`));
      log('Agent Wrangler started');
      void checkHookHealth();
      // After the store's first scan, so "is it running elsewhere?" has an answer.
      setTimeout(() => void resumeLastRunner().catch((err) => log(`resume failed: ${String(err)}`)), 2000);
    },

    dispose() {
      store.dispose();
    },
  };
}
