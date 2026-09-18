import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { waitForAdoptable } from './core/adoptQueue';
import { sessionsDir } from './claude/paths';
import { resolveClaudeBinary } from './claude/binary';
import { ClaudeProvider } from './claude/claudeProvider';
import { CodexProvider } from './codex/codexProvider';
import { CodexAppServer } from './codex/appServer';
import { codexUsageReader } from './codex/usage';
import { CodexRunnerService } from './codex/runner';
import { isPidAlive, readRegistry } from './claude/registry';
import { endProcess } from './claude/runner/adopt';
import { RunnerRegistry } from './claude/runner/runnerRegistry';
import { RunnerService } from './claude/runner/runnerService';
import type { RunnerSession } from './claude/runner/runnerSession';
import {
  currentState,
  installHooks,
  settingsModifiedAtMs,
  settingsPath,
  uninstallHooks,
} from './claude/hookInstall';
import { hookLogDir } from './claude/hookLog';
import { ProjectsService } from './claude/projects';
import { fetchUsage } from './claude/usageFetch';
import { ArchiveService } from './core/archive';
import { ColumnPrefsService } from './core/columnPrefs';
import { DEFAULT_CONFIG, type ConfigGetter, type WranglerConfig } from './core/config';
import { DictationService } from './core/dictation';
import { HiddenProjectsService } from './core/hiddenProjects';
import { MAX_NICKNAME_LENGTH, NicknameService } from './core/nicknameService';
import { PinService } from './core/pinService';
import { autoPauseDecision, maxUsagePercent } from './core/autoPause';
import { PauseService } from './core/pauseService';
import { readStoppedPids } from './core/procTree';
import { SessionStore } from './core/sessionStore';
import { TurnStats } from './core/turnStats';
import { FileUsageCache } from './core/usageCache';
import { UsageService } from './core/usageService';
import type { PermissionModeName } from './shared/conversation';
import { displayLabel, displayTitle, STATUS_LABEL, type AgentSession, type SessionStatus } from './shared/model';
import type { SessionActions } from './ui/actions';
import {
  CONVERSATION_PINNED_TYPE,
  ConversationPanelManager,
  ConversationPanelSerializer,
} from './ui/conversation/conversationPanel';
import { FileSuggestService } from './core/fileSuggest';
import { DiffContentProvider } from './ui/conversation/diffView';
import type { ConversationLauncher } from './ui/dashboardHost';
import { WORKBENCH_PANEL_TYPE, WorkbenchPanelManager, WorkbenchPanelSerializer } from './ui/workbenchPanel';
import { watchForDevReload } from './ui/devReload';
import { adoptActionFor } from './ui/openTarget';
import { createStatusBar } from './ui/statusBar';
import { resumeInTerminal } from './ui/terminal';

/** How long to let a session emit its first hook event before calling hooks broken. */
const HOOK_HEALTH_GRACE_MS = 90_000;

/**
 * Grace period before the startup auto-open. VSCode restores editor tabs (and
 * hands ours back through the serializer) shortly after activation, so waiting
 * keeps us from opening a second dashboard next to the restored one.
 */
const STARTUP_OPEN_DELAY_MS = 1500;

const QUICKPICK_ICON: Record<SessionStatus, string> = {
  blocked: '$(shield)',
  waiting: '$(bell)',
  done: '$(check)',
  busy: '$(play)',
  stuck: '$(warning)',
  ended: '$(circle-slash)',
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Wrangler');
  context.subscriptions.push(output);
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const getConfig: ConfigGetter = () => {
    const c = vscode.workspace.getConfiguration('agentWrangler');
    const cfg: WranglerConfig = {
      claudeBinaryPath: c.get('claudeBinaryPath', DEFAULT_CONFIG.claudeBinaryPath),
      codexBinaryPath: c.get('codexBinaryPath', DEFAULT_CONFIG.codexBinaryPath),
      showCodexSubagents: c.get('showCodexSubagents', DEFAULT_CONFIG.showCodexSubagents),
      stuckThresholdSeconds: c.get('stuckThresholdSeconds', DEFAULT_CONFIG.stuckThresholdSeconds),
      endedWindowHours: c.get('endedWindowHours', DEFAULT_CONFIG.endedWindowHours),
      maxEndedSessions: c.get('maxEndedSessions', DEFAULT_CONFIG.maxEndedSessions),
      notifyOnWaiting: c.get('notifyOnWaiting', DEFAULT_CONFIG.notifyOnWaiting),
      pollIntervalSeconds: c.get('pollIntervalSeconds', DEFAULT_CONFIG.pollIntervalSeconds),
      showUsage: c.get('showUsage', DEFAULT_CONFIG.showUsage),
      usagePollIntervalSeconds: c.get('usagePollIntervalSeconds', DEFAULT_CONFIG.usagePollIntervalSeconds),
      autoPauseEnabled: c.get('autoPause.enabled', DEFAULT_CONFIG.autoPauseEnabled),
      autoPausePercent: c.get('autoPause.percent', DEFAULT_CONFIG.autoPausePercent),
    };
    return cfg;
  };

  const store = new SessionStore();
  // Turn durations are a property of how this person works, not of one folder,
  // so the baseline is global state shared across windows.
  const turnStats = new TurnStats(context.globalState);
  const provider = new ClaudeProvider(getConfig, log, turnStats);
  const codexProvider = new CodexProvider(getConfig, log);
  const codexAppServer = new CodexAppServer(() => getConfig().codexBinaryPath, log);
  const codexRunners = new CodexRunnerService(codexAppServer);
  context.subscriptions.push(codexRunners);
  const archive = new ArchiveService(context.globalState);
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
  const pins = new PinService(context.globalState);
  const nicknames = new NicknameService(context.globalState);
  // Applied in the store rather than at each render, because the dashboard, the
  // conversation pane, the status bar, the quick picks, the toasts and the
  // terminal label do not share a decoration step — only the store.
  store.useNicknames((key) => nicknames.get(key));
  // A rename changes nothing a provider scan would notice, so the store has to
  // be told to re-apply and re-fire, or the new name waits for the session to
  // do something before it appears.
  context.subscriptions.push(nicknames.onDidChange(() => store.renameApplied()));
  // Column widths and the hidden set: a preference, so global state rather than
  // per-webview state — the same layout in the editor tab, the dock, and after
  // a restart.
  const columns = new ColumnPrefsService(context.globalState);
  context.subscriptions.push({ dispose: () => store.dispose() }); // store disposes providers

  // Plan usage for the cards above the table — the same numbers as Claude
  // Code's /usage, read with the login token Claude Code stored. The cache is
  // in globalStorage so every window shares one read per interval.
  const usage = new UsageService(
    fetchUsage,
    new FileUsageCache(vscode.Uri.joinPath(context.globalStorageUri, 'usage.json').fsPath),
    getConfig,
    log,
  );
  context.subscriptions.push(usage);
  usage.start();
  const codexUsage = new UsageService(
    codexUsageReader(codexAppServer),
    new FileUsageCache(vscode.Uri.joinPath(context.globalStorageUri, 'codex-usage.json').fsPath),
    getConfig,
    (message) => log(`codex ${message}`),
  );
  context.subscriptions.push(codexUsage);
  codexUsage.start();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // autoPause.enabled belongs here too: it decides whether usage is read at
      // all when the cards are hidden, so turning it on must start the reads.
      if (
        e.affectsConfiguration('agentWrangler.showUsage') ||
        e.affectsConfiguration('agentWrangler.usagePollIntervalSeconds') ||
        e.affectsConfiguration('agentWrangler.autoPause.enabled') ||
        e.affectsConfiguration('agentWrangler.autoPause.percent')
      ) {
        void usage.refresh();
        void codexUsage.refresh();
      }
    }),
  );

  // Sessions this window runs itself, through the Agent SDK. The binary is
  // resolved per start so changing the setting does not need a reload.
  // Workspace state, not global: two windows sharing one record would both
  // resume the same session, and two processes on one id corrupt its transcript.
  const runnerRegistry = new RunnerRegistry(context.workspaceState);
  const runners = new RunnerService({
    query: sdkQuery,
    binary: () => resolveClaudeBinary(getConfig().claudeBinaryPath),
    log,
    registry: runnerRegistry,
  });
  context.subscriptions.push(runners);
  const runnerOwnership = {
    owns: (id: string | undefined) => runners.owns(id) || codexRunners.owns(id),
    wasRunning: (id: string) => runners.wasRunning(id),
    onDidChange: (listener: () => void) => {
      const claude = runners.onDidChange(listener);
      const codex = codexRunners.onDidChange(listener);
      return { dispose: () => { claude.dispose(); codex.dispose(); } };
    },
  };

  const showInPane = (s: AgentSession) => workbench.show(s.key);


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
      void vscode.window.showErrorMessage(`Agent Wrangler: ${s.cwd} no longer exists.`);
      return;
    }

    if (kind === 'adopt') {
      const choice = !confirm ? 'Take over' : await vscode.window.showWarningMessage(
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
        void vscode.window.showInformationMessage(
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
          kill: (pid, signal) => process.kill(pid, signal),
          isAlive: isPidAlive,
          delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        log(`adopt ${now.sessionId}: ending pid ${now.pid} → ${outcome}`);
        if (outcome === 'refused') {
          void vscode.window.showErrorMessage(
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
    const cfg = vscode.workspace.getConfiguration('agentWrangler');
    const model = cfg.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd: s.cwd,
      resume: s.sessionId,
      permissionMode: cfg.get<PermissionModeName>('runner.defaultPermissionMode', 'acceptEdits'),
      model: model || undefined,
    });
    workbench.showRunner(runner);
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
      void vscode.window.showWarningMessage(
        `Agent Wrangler: no process is known for ${label}, so there is nothing to close.`,
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

    const choice = await vscode.window.showWarningMessage(`Close ${label}?`, { modal: true, detail }, 'Close session');
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
        kill: (pid, signal) => process.kill(pid, signal),
        isAlive: isPidAlive,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      log(`close ${now.sessionId}: ending pid ${now.pid} → ${outcome}`);
      if (outcome === 'refused') {
        void vscode.window.showErrorMessage(
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
      void vscode.window.showWarningMessage(
        `Agent Wrangler: the process running ${label} is gone, so there was nothing to ${wanted ? 'pause' : 'resume'}.`,
      );
      return;
    }
    if (outcome === 'refused') {
      void vscode.window.showErrorMessage(
        `Agent Wrangler: could not ${wanted ? 'pause' : 'resume'} ${label} — the signal was refused. ` +
          'It may belong to another user.',
      );
      return;
    }
    vscode.window.setStatusBarMessage(`Agent Wrangler: ${label} ${wanted ? 'paused' : 'resumed'}`, 4000);
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
        if (!why) void vscode.window.showInformationMessage('Agent Wrangler: nothing is running to pause.');
        return false;
      }
      const r = pause.pauseAll(candidates);
      acted = r.ok > 0;
      log(`pause all${why ? ` (${why})` : ''}: ${r.ok} paused, ${r.gone} already gone, ${r.refused} refused`);
      const trouble = r.refused > 0 ? `, ${r.refused} refused the signal` : '';
      void vscode.window.showInformationMessage(
        `Agent Wrangler: paused ${r.ok} agent${r.ok === 1 ? '' : 's'}${trouble}${why ? ` — ${why}` : ''}.`,
      );
    } else {
      const r = pause.resumeAll();
      acted = r.ok > 0;
      log(`resume all: ${r.ok} resumed, ${r.gone} gone, ${r.refused} refused`);
      const trouble = r.refused > 0 ? `, ${r.refused} refused the signal` : '';
      void vscode.window.showInformationMessage(
        `Agent Wrangler: resumed ${r.ok} agent${r.ok === 1 ? '' : 's'}${trouble}.`,
      );
    }
    void store.forceRefresh();
    return acted;
  };

  /**
   * Auto-pause: stop everything by itself when the plan is nearly spent.
   *
   * Armed state is per-window and deliberately not persisted. Two windows both
   * firing is harmless — the second finds everything paused already and pauses
   * nothing — whereas a persisted flag would have a restart mid-window decide
   * it had already fired and sail past the threshold in silence.
   *
   * It only disarms once it has actually stopped something. The first usage
   * reading lands within milliseconds of activation (it is adopted from the
   * shared cache file), long before the provider's first scan has found any
   * sessions, so a window reloaded while over the threshold would otherwise
   * spend its one shot on an empty store and never fire again for the rest of
   * the limit window.
   */
  let autoPauseArmed = true;
  context.subscriptions.push(
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
        const confirm = s.statusIsEstimated === true || vscode.workspace.getConfiguration('agentWrangler').get<boolean>('runner.confirmTakeoverOnSend', false);
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
      showInPane(s);
    },
    openInTab(key) {
      conversations.pin(key);
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
        const value = await vscode.window.showInputBox({
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
      void adoptSession(s).catch((e) => vscode.window.showErrorMessage(String(e))).finally(() => adopting.delete(key));
    },
    release(key) {
      const s = store.get(key);
      const runner = runners.get(s?.sessionId);
      if (!s || !runner) return;
      void (async () => {
        const choice = await vscode.window.showWarningMessage(
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
        resumeInTerminal(s, getConfig);
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
      if (s) resumeInTerminal(s, getConfig);
    },
    copyId(key) {
      const s = store.get(key);
      if (!s) return;
      void vscode.env.clipboard.writeText(s.sessionId).then(() => {
        vscode.window.setStatusBarMessage(`Copied session id ${s.sessionId}`, 2500);
      });
    },
    reveal(key) {
      const s = store.get(key);
      if (!s?.transcriptPath) {
        void vscode.window.showWarningMessage('Agent Wrangler: no transcript file for this session.');
        return;
      }
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.transcriptPath));
    },
    refreshAll() {
      void store.forceRefresh();
    },
    openExternal(url) {
      if (/^https?:\/\//i.test(url)) void vscode.env.openExternal(vscode.Uri.parse(url));
    },
    openFile(filePath) {
      void vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(
        (doc) => vscode.window.showTextDocument(doc, { preview: true }),
        () => vscode.window.setStatusBarMessage(`Agent Wrangler: cannot open ${filePath}`, 4000),
      );
    },
    installHooks() {
      void vscode.commands.executeCommand('agentWrangler.installHooks');
    },
    decidePermission(key, behavior) {
      const s = store.get(key);
      if (!s || s.provider !== 'claude') return;
      void provider.decidePermission(s.sessionId, behavior).then((sent) => {
        if (sent) {
          log(`permission ${behavior} sent to ${s.name ?? s.sessionId}`);
          if (behavior === 'always' && s.alwaysAllow) {
            vscode.window.setStatusBarMessage(
              `Agent Wrangler: allowed ${s.alwaysAllow.rules.join(', ')} in ${s.alwaysAllow.destination}.`,
              5000,
            );
          }
          return;
        }
        // The prompt was answered in Claude Code first, or the hook gave up
        // waiting; either way there is nothing left to decide from here.
        vscode.window.setStatusBarMessage(
          `Agent Wrangler: ${displayLabel(s)} is no longer waiting on that permission.`,
          4000,
        );
      });
    },
  };

  // One microphone, so one recorder for the whole window however many panes are open.
  const dictation = new DictationService({
    spawn,
    settings: () => {
      const cfg = vscode.workspace.getConfiguration('agentWrangler');
      return {
        ffmpegPath: cfg.get<string>('dictation.ffmpegPath', ''),
        whisperPath: cfg.get<string>('dictation.whisperPath', ''),
        modelPath: cfg.get<string>('dictation.modelPath', ''),
        inputDevice: cfg.get<string>('dictation.inputDevice', ':default'),
      };
    },
  });

  // Pinned conversations only: a session given a tab of its own, which row
  // clicks never swap away. The reusable pane lives in the workbench.
  // Serves the two sides of an edit's diff to VSCode's diff editor.
  const diffs = new DiffContentProvider();
  context.subscriptions.push(diffs);

  // Files offered after an `@` in the composer, per session folder.
  const fileSuggest = new FileSuggestService();

  const conversations = new ConversationPanelManager(
    context.extensionUri,
    store,
    provider,
    codexProvider,
    runners,
    codexRunners,
    actions,
    dictation,
    diffs,
    fileSuggest,
  );
  context.subscriptions.push(
    conversations,
    vscode.window.registerWebviewPanelSerializer(
      CONVERSATION_PINNED_TYPE,
      new ConversationPanelSerializer(conversations),
    ),
  );

  // Folders the launcher offers. Claude Code's own history is the bulk of it;
  // the workspace and anything currently running are added so a folder is
  // never missing just because it has not been used through the CLI yet.
  const hiddenProjects = new HiddenProjectsService(context.globalState);
  const projects = new ProjectsService(
    () => ({
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      sessions: store.sessions
        .filter((s): s is typeof s & { cwd: string } => typeof s.cwd === 'string')
        .map((s) => ({ dir: s.cwd, lastUsedAt: s.lastActivityAt })),
    }),
    { hidden: hiddenProjects },
  );

  // Defined as closures rather than direct references: `newConversation` is
  // declared further down, and only the calls happen after activation.
  const launcher: ConversationLauncher = {
    newConversation: (cwd, selectedProvider) => selectedProvider === 'codex' ? startCodexConversation(cwd) : newConversation(cwd),
    browseForProject: () => browseForProject(),
  };

  // The workbench: the table and the conversation in one tab.
  const workbench = new WorkbenchPanelManager({
    extensionUri: context.extensionUri,
    store,
    provider,
    codexProvider,
    runners,
    codexRunners,
    actions,
    dictation,
    diffs,
    files: fileSuggest,
    archive,
    health: provider,
    usage,
    codexUsage,
    runnerOwnership,
    columns,
    projects,
    launcher,
    pause,
    pins,
  });
  context.subscriptions.push(
    workbench,
    vscode.window.registerWebviewPanelSerializer(WORKBENCH_PANEL_TYPE, new WorkbenchPanelSerializer(workbench)),
  );

  const openDashboard = (opts?: { preserveFocus?: boolean }) => workbench.open(opts);

  createStatusBar(store, archive, pause, context);

  // Opt-in "waiting on you" toasts, with a per-session cooldown.
  const lastToastAt = new Map<string, number>();
  context.subscriptions.push(
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
        void vscode.window
          .showInformationMessage(msg, 'Open', 'Dashboard')
          .then((choice) => {
            if (choice === 'Open') actions.smartOpen(s.key);
            else if (choice === 'Dashboard') void vscode.commands.executeCommand('agentWrangler.openDashboard');
          });
      }
    }),
  );

  // ---- commands ----

  const pickSession = async (filter?: (s: AgentSession) => boolean): Promise<AgentSession | undefined> => {
    const candidates = store.sessions.filter(filter ?? (() => true));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('Agent Wrangler: no matching sessions.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
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
   * Start a session this window runs itself. The folder matters more than
   * usual here: it is the session's working directory, and unlike the Claude
   * Code panel — which is bound to its window's workspace — the pane can run a
   * session in any project on the machine.
   */
  /** The folder dialog, shared by the dashboard's Browse… row and the quick pick's. */
  const browseForProject = async (): Promise<string | undefined> => {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Start here',
    });
    const dir = chosen?.[0]?.fsPath;
    if (dir) projects.add(dir);
    return dir;
  };

  /** Spawn and show. The only path that starts a runner, so the cwd check lives here. */
  const startConversation = (cwd: string): RunnerSession | undefined => {
    if (!fs.existsSync(cwd)) {
      void vscode.window.showErrorMessage(`Agent Wrangler: ${cwd} no longer exists.`);
      return undefined;
    }
    // Working in a folder is the strongest possible statement that it belongs
    // in the list, so it also undoes a removal — the same rule as browsing.
    projects.add(cwd);
    const cfg = vscode.workspace.getConfiguration('agentWrangler');
    const model = cfg.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd,
      permissionMode: cfg.get<PermissionModeName>('runner.defaultPermissionMode', 'acceptEdits'),
      model: model || undefined,
    });
    workbench.showRunner(runner);
    return runner;
  };

  const startCodexConversation = async (cwd: string): Promise<void> => {
    if (!fs.existsSync(cwd)) {
      void vscode.window.showErrorMessage(`Agent Wrangler: ${cwd} no longer exists.`);
      return;
    }
    projects.add(cwd);
    try {
      const cfg = vscode.workspace.getConfiguration('agentWrangler');
      const model = cfg.get<string>('codexRunner.model', '').trim() || undefined;
      const runner = await codexRunners.start(cwd, model);
      workbench.showCodexRunner(runner);
    } catch (error) {
      log(`starting Codex conversation failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`Agent Wrangler: could not start Codex — ${(error as Error).message}`);
    }
  };

  /**
   * Start a session this window runs itself. The folder matters more than
   * usual here: it is the session's working directory, and unlike the Claude
   * Code panel — which is bound to its window's workspace — the pane can run a
   * session in any project on the machine.
   *
   * With a `cwd` (the dashboard's launcher, which has its own dropdown) it goes
   * straight to the session. Without one (the palette, the title-bar button)
   * the same folders arrive as a quick pick instead.
   */
  const newConversation = async (cwd?: string): Promise<RunnerSession | undefined> => {
    if (cwd) return startConversation(cwd);

    // Newest first, the same order and the same list the dashboard dropdown shows.
    await projects.refresh();
    const folders: { label: string; description?: string; dir?: string; browse?: boolean }[] = projects.value.map(
      (p) => ({ label: p.name, description: p.dir, dir: p.dir }),
    );
    folders.push({ label: '$(folder-opened) Browse…', description: 'Pick another folder', browse: true });

    const picked = await vscode.window.showQuickPick(folders, {
      placeHolder: 'Start a conversation in which project?',
      matchOnDescription: true,
    });
    if (!picked) return undefined;

    const dir = picked.browse ? await browseForProject() : picked.dir;
    return dir ? startConversation(dir) : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentWrangler.newConversation', () => void newConversation()),
    vscode.commands.registerCommand('agentWrangler.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('agentWrangler.refresh', () => {
      actions.refreshAll();
      void usage.refresh({ force: true });
    }),
    vscode.commands.registerCommand(
      'agentWrangler.openConversation',
      withSession((k) => actions.smartOpen(k)),
    ),
    // The command id still says "pin" because ids are the stable thing a
    // keybinding points at; only what it is called changed, when pinning a row
    // took the word.
    vscode.commands.registerCommand(
      'agentWrangler.pinConversation',
      withSession((k) => actions.openInTab(k)),
    ),
    vscode.commands.registerCommand('agentWrangler.renameConversation', withSession((k) => actions.rename(k))),
    vscode.commands.registerCommand('agentWrangler.pinToTop', withSession((k) => actions.togglePinned(k))),
    vscode.commands.registerCommand(
      'agentWrangler.resumeInTerminal',
      withSession((k) => actions.resume(k), (s) => s.status === 'ended'),
    ),
    vscode.commands.registerCommand('agentWrangler.copySessionId', withSession((k) => actions.copyId(k))),
    vscode.commands.registerCommand('agentWrangler.pauseAll', () => setPausedAll(true)),
    vscode.commands.registerCommand('agentWrangler.resumeAll', () => setPausedAll(false)),
    vscode.commands.registerCommand(
      'agentWrangler.pauseSession',
      withSession(
        (k) => actions.pauseSession(k, !pause.isPaused(store.get(k)?.pid)),
        (s) => s.status !== 'ended' && s.pid !== undefined,
      ),
    ),
    vscode.commands.registerCommand(
      'agentWrangler.revealTranscript',
      withSession((k) => actions.reveal(k), (s) => s.transcriptPath !== undefined),
    ),
    vscode.commands.registerCommand('agentWrangler.installHooks', async () => {
      const dir = hookLogDir();
      const choice = await vscode.window.showWarningMessage(
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
      const res = await installHooks(dir);
      log(`installHooks: ${res.message}`);
      if (res.ok) void vscode.window.showInformationMessage(`Agent Wrangler: ${res.message}`);
      else void vscode.window.showErrorMessage(`Agent Wrangler: ${res.message}`);
      void store.forceRefresh();
    }),
    vscode.commands.registerCommand('agentWrangler.uninstallHooks', async () => {
      const res = await uninstallHooks();
      log(`uninstallHooks: ${res.message}`);
      if (res.ok) void vscode.window.showInformationMessage(`Agent Wrangler: ${res.message}`);
      else void vscode.window.showErrorMessage(`Agent Wrangler: ${res.message}`);
      void store.forceRefresh();
    }),
  );

  void store.register(provider).catch((err) => log(`provider start failed: ${String(err)}`));
  void store.register(codexProvider).catch((err) => log(`Codex provider start failed: ${String(err)}`));
  log('Agent Wrangler activated');
  watchForDevReload(context, log);

  /**
   * Bring back the conversation this window was running before it reloaded.
   *
   * Runner sessions are children of the extension host, so a reload ends every
   * one of them — but only the process. Resuming the id reads the same
   * transcript back, so the only thing actually lost is a turn that was in
   * flight. Bounded deliberately: the most recent session only, recorded in
   * *this* window's state, within a few hours, and never one something else is
   * already running.
   */
  const resumeLastRunner = async (): Promise<void> => {
    if (!vscode.workspace.getConfiguration('agentWrangler').get<boolean>('runner.autoResumeLastOnStartup', true)) {
      return;
    }
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
    const cfg = vscode.workspace.getConfiguration('agentWrangler');
    const model = cfg.get<string>('runner.model', '').trim();
    const runner = runners.start({
      cwd: record.cwd,
      resume: record.sessionId,
      permissionMode: cfg.get<PermissionModeName>('runner.defaultPermissionMode', 'acceptEdits'),
      model: model || undefined,
    });
    log(`resumed ${record.sessionId} after a reload`);
    // Beside the dashboard, without taking the cursor: a window that has just
    // come back should not start by moving your focus.
    workbench.showRunner(runner, { preserveFocus: true });
  };

  // After the store's first scan, so "is it running elsewhere?" has an answer.
  setTimeout(() => void resumeLastRunner().catch((err) => log(`resume failed: ${String(err)}`)), STARTUP_OPEN_DELAY_MS + 500);

  // Hooks can be suppressed with no error we'd ever see: `disableAllHooks`,
  // safe mode, an org policy allowing only managed hooks, or unaccepted
  // workspace trust. Left undetected that looks exactly like a broken feature,
  // so say so instead of showing every session as estimated forever.
  void (async () => {
    const state = await currentState(hookLogDir());
    log(`hook install state: ${state.kind}${'why' in state ? ` (${state.why})` : ''}`);
    if (state.kind === 'disabled') {
      void vscode.window.showWarningMessage(`Agent Wrangler: hooks cannot run — ${state.why}.`);
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
      void vscode.window.showWarningMessage(
        'Agent Wrangler: status hooks are installed but no session is reporting. Check safe mode, workspace trust, and `disableAllHooks` in settings.json.',
      );
    }, HOOK_HEALTH_GRACE_MS);
  })();

  // Open the dashboard for the window, so a day spent with agents starts on
  // the agents. A tab VSCode restored for us already counts: leave it exactly
  // where and how it came back rather than adding a second one.
  if (vscode.workspace.getConfiguration('agentWrangler').get<boolean>('openOnStartup', true)) {
    setTimeout(() => {
      if (workbench.isOpen) return;
      openDashboard();
    }, STARTUP_OPEN_DELAY_MS);
  }
}

export function deactivate(): void {
  // everything is disposed via context.subscriptions
}
