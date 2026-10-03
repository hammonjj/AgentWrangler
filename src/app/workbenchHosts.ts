/**
 * The two pane hosts behind one workbench document, and what the conversation
 * pane needs from its host to talk to a person.
 *
 * Host-neutral, so the Electron window (`src/electron/workbenchWindow.ts`),
 * the window's own web server and the core daemon's (#131,
 * `webWorkbench.ts`) build the same panes over the same app. Nothing here may
 * import `electron`: the daemon runs on plain Node.
 */
import type { AgentWranglerApp } from './createApp';
import type { RequestContext } from '../core/access';
import { DictationSetupError, defaultModelPath } from '../core/dictation';
import type { HostServices } from '../host/hostServices';
import { ConversationHost, type ConversationHostUi } from '../ui/conversation/conversationHost';
import { DashboardHost } from '../ui/dashboardHost';
import { paneChannel, type EnvelopeTransport } from '../ui/paneChannel';
import { PreferencesHost, type PreferencesBackend } from '../ui/preferencesHost';

/**
 * The two pane hosts for one workbench document, over whatever carries its
 * envelopes. The window has one document; each connected browser has one of
 * its own, with hosts of its own over the same app.
 */
export function createWorkbenchHosts(
  app: AgentWranglerApp,
  host: HostServices,
  ui: ConversationHostUi,
  transport: EnvelopeTransport,
  /**
   * Who this document's messages act as (#123). The window is one client
   * with one context; each browser connection brings its own, naming itself.
   */
  context: RequestContext,
  /**
   * What Preferences is served from (#135). Given, the document also has a
   * `preferences` pane for its `#/preferences` route: each browser does. The
   * Electron window has a window of its own for Preferences and passes none.
   */
  preferences?: PreferencesBackend,
): { dashboard: DashboardHost; conversation: ConversationHost; preferences?: PreferencesHost } {
  const access = { context, gate: app.access };
  const actions = app.actions;
  const dashboard = new DashboardHost(
    paneChannel(transport, 'dashboard'),
    app.store,
    app.archive,
    actions,
    app.provider,
    app.usage,
    app.codexUsage,
    app.columns,
    app.runnerOwnership,
    app.projects,
    app.launcher,
    app.pause,
    host.settings,
    host.dialogs,
    app.models,
    access,
    app.taskPanes,
    app.missions,
    app.analytics,
  );
  const conversation = new ConversationHost(
    paneChannel(transport, 'conversation'),
    app.store,
    app.provider,
    app.codexProvider,
    app.sessions,
    app.runners,
    actions,
    app.dictation,
    app.files,
    // The workbench is the whole of the document, not one conversation, so
    // its title does not follow the session — the pane shows the name in its header.
    () => undefined,
    ui,
    access,
    app.taskPanes,
  );
  const prefs = preferences ? new PreferencesHost(paneChannel(transport, 'preferences'), preferences, access) : undefined;
  return { dashboard, conversation, ...(prefs ? { preferences: prefs } : {}) };
}

/**
 * The conversation pane's way to a person: the host's dialogs, and what to do
 * when dictation is asked for and a piece of it is missing.
 *
 * The VSCode version offered to run the Homebrew command in a terminal. There
 * is no terminal here, so it names the command and offers to put it on the
 * clipboard — installing software on someone's behalf is not a thing this
 * should do either way.
 */
export function workbenchUi(host: HostServices): ConversationHostUi {
  const offerDictationSetup = async (err: DictationSetupError): Promise<void> => {
    const command =
      err.remedy === 'download-model'
        ? `curl -L --create-dirs -o ${defaultModelPath()} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
        : `brew install ${err.remedy === 'install-whisper' ? 'whisper-cpp' : 'ffmpeg'}`;
    const choice = await host.dialogs.warn(
      `Agent Wrangler: ${err.message}`,
      { detail: `Run this in a terminal, then try dictating again:\n\n${command}` },
      'Copy command',
    );
    if (choice === 'Copy command') await host.clipboard.writeText(command);
  };
  return { dialogs: host.dialogs, offerDictationSetup };
}
