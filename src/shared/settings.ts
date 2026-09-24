/**
 * Every setting, declared once.
 *
 * The Preferences window renders straight from this list: `group` is its
 * section heading and the order here is the order on screen. Keys are written
 * without the `agentWrangler.` prefix, the way `HostSettings` takes them.
 *
 * This used to be the single source for two front ends — the app's Preferences
 * window and VSCode's settings UI, which read a hand-mirrored copy in
 * `package.json` that a test checked for drift. The extension is gone, so the
 * mirror, the `hosts` filter and that test went with it.
 */

export type SettingType = 'string' | 'boolean' | 'number';

export interface SettingSpec {
  /** Dotted, without the `agentWrangler.` prefix — e.g. `autoPause.percent`. */
  key: string;
  /**
   * What the Preferences window calls it. The key is still shown underneath,
   * because that is its name in `settings.json` and in the documentation — the
   * label is there to be scanned, not to replace it.
   */
  label: string;
  /** The Preferences window's section heading. */
  group: string;
  type: SettingType;
  default: string | boolean | number;
  /** The sentence under the control in Preferences. */
  description: string;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  /**
   * The key of a boolean this setting only matters under. Preferences nests it
   * beneath that one and reveals it when it is on — so a feature's own settings
   * are not four unexplained fields sitting next to the switch that governs
   * them. Purely presentational: the value is still read whatever is showing.
   */
  dependsOn?: string;
}

export const SETTINGS: SettingSpec[] = [

  // ---- Conversations ----
  {
    key: 'runner.defaultPermissionMode',
    label: 'Permission mode for new conversations',
    group: 'Conversations',
    type: 'string',
    default: "auto",
    enum: ["default", "acceptEdits", "auto", "plan"],
    enumDescriptions: [
      'Ask before every tool that needs permission.',
      'Accept file edits without asking; still ask for everything else.',
      'A classifier model reviews each action and only asks when it blocks something risky.',
      'Plan first: no tools run until you approve a plan.',
    ],
    description:
      'Permission mode for conversations started from Agent Wrangler. Changeable per session from the pane.',
  },
  {
    key: 'runner.provider',
    label: 'Provider for the next conversation',
    group: 'Conversations',
    type: 'string',
    enum: ['anthropic', 'openai'],
    enumDescriptions: ['Start the next conversation with Claude Code.', 'Start the next conversation with Codex.'],
    default: 'anthropic',
    description: 'Provider selected for the next conversation started from Agent Wrangler.',
  },
  {
    key: 'runner.model',
    label: 'Model for new Claude conversations',
    group: 'Conversations',
    type: 'string',
    default: "",
    description:
      'Model for conversations started from Agent Wrangler (e.g. claude-opus-5). Empty means Claude Code\'s own default.',
  },
  {
    key: 'runner.effort',
    label: 'Reasoning effort',
    group: 'Conversations',
    type: 'string',
    enum: ["", "low", "medium", "high", "xhigh", "max"],
    enumDescriptions: [
      'Claude Code\u2019s own default.',
      'Minimal thinking, fastest answers.',
      'Moderate thinking.',
      'Deep reasoning.',
      'Deeper than high, where the model offers it.',
      'As hard as the model can think. Select models only.',
    ],
    default: "",
    description:
      'How hard Claude thinks before answering, for conversations started from Agent Wrangler. Empty means Claude Code\u2019s own default. A model with no effort levels ignores it, and the conversation pane only offers the levels its own model advertises.',
  },
  {
    key: 'codexRunner.model',
    label: 'Model for new Codex conversations',
    group: 'Conversations',
    type: 'string',
    default: "",
    description:
      'Model for Codex conversations started from Agent Wrangler. Empty uses the Codex default.',
  },
  {
    key: 'codexRunner.effort',
    label: 'Codex reasoning effort',
    group: 'Conversations',
    type: 'string',
    enum: ['', 'low', 'medium', 'high', 'xhigh'],
    enumDescriptions: [
      'Use the selected Codex model\'s default.',
      'Minimal reasoning, fastest answers.',
      'Moderate reasoning.',
      'Deep reasoning.',
      'The deepest reasoning available.',
    ],
    default: '',
    description: 'Reasoning effort for Codex conversations started from Agent Wrangler. Empty uses the model default.',
  },
  {
    key: 'codexRunner.keepAcrossRestarts',
    label: 'Keep Codex conversations running across restarts',
    group: 'Conversations',
    type: 'boolean',
    default: true,
    description:
      'Run Codex conversations in a background Codex server that keeps going when Agent Wrangler quits or is reinstalled, so a running turn finishes and an approval or question is still waiting when the app comes back. Updating Codex restarts that server, which ends a running turn; Agent Wrangler only does that when nothing is running, or when you choose Agents → Restart Codex Server. Off runs Codex as a child of the app, which ends with it. Takes effect after a restart.',
  },
  {
    key: 'runner.confirmTakeoverOnSend',
    label: 'Confirm before taking a session over',
    group: 'Conversations',
    type: 'boolean',
    default: false,
    description:
      'Confirm before taking over an idle external session when sending. Estimated status always requires confirmation.',
  },
  {
    key: 'runner.autoResumeLastOnStartup',
    label: 'Resume the last conversation on startup',
    group: 'Conversations',
    type: 'boolean',
    default: true,
    description:
      'After a window reload, resume the conversation this window was running. Only the most recent one, only if it was running in the last few hours, and never one something else has picked up in the meantime.',
  },
  {
    key: 'experimental.sessionHosts',
    label: 'Keep conversations running when Agent Wrangler quits (experimental)',
    group: 'Conversations',
    type: 'boolean',
    default: false,
    description:
      'Run each new Claude conversation in its own small background process, so quitting, reinstalling or a crash of Agent Wrangler no longer ends it: it keeps working, and Agent Wrangler reconnects when it opens again. ⌘Q then leaves those conversations running; Quit and Stop All Agents (⌥⌘Q) ends them. Applies to conversations started after it is switched on.',
  },
  {
    key: 'lifecycle.orphanIdleHours',
    label: 'End idle sessions with no Agent Wrangler connected after (hours)',
    group: 'Conversations',
    type: 'number',
    default: 24,
    minimum: 0,
    // Drop with the setting it hangs off when session hosts become the default.
    dependsOn: 'experimental.sessionHosts',
    description:
      'A conversation left running in the background while Agent Wrangler is quit is ended after this many hours with nothing connected to it, but only if it is idle: never one that is working, waiting on a question or permission, or running background tasks. It can be resumed afterwards with nothing lost. Time the machine spends asleep does not count. 0 = never.',
  },

  // ---- Agents and status ----
  {
    key: 'stuckThresholdSeconds',
    label: 'Call a silent agent stuck after',
    group: 'Agents and status',
    type: 'number',
    default: 600,
    minimum: 10,
    description:
      'A busy session with no transcript writes or hook events for this long is shown as POSSIBLY STUCK. Keep it generous: the model is silent while thinking or writing a large file, routinely for 2–6 minutes.',
  },
  {
    key: 'pollIntervalSeconds',
    label: 'Reconciliation poll interval',
    group: 'Agents and status',
    type: 'number',
    default: 5,
    minimum: 2,
    description:
      'Reconciliation poll interval (pid liveness, staleness, missed file events).',
  },
  {
    key: 'endedWindowHours',
    label: 'Keep ended sessions visible for',
    group: 'Agents and status',
    type: 'number',
    default: 48,
    minimum: 1,
    description:
      'Show ended sessions whose last activity is within this window.',
  },
  {
    key: 'maxEndedSessions',
    label: 'Most ended sessions to show',
    group: 'Agents and status',
    type: 'number',
    default: 50,
    minimum: 0,
    description:
      'Maximum number of ended sessions to show.',
  },
  {
    key: 'notifyOnWaiting',
    label: 'Notify when an agent needs you',
    group: 'Agents and status',
    type: 'boolean',
    default: false,
    description:
      'Show a toast notification when a session flips to WAITING ON YOU.',
  },
  {
    key: 'showCodexSubagents',
    label: 'Show Codex subagents as their own rows',
    group: 'Agents and status',
    type: 'boolean',
    default: false,
    description:
      'Show internal and subagent Codex sessions as separate rows for debugging. Main conversations always summarize linked workers in the Subagents column.',
  },

  // ---- Plan usage ----
  {
    key: 'showUsage',
    label: 'Show plan usage cards',
    group: 'Plan usage',
    type: 'boolean',
    default: true,
    description:
      'Show provider-specific plan-usage cards above the agent table for Claude Code and Codex. Each provider is read through its own local authenticated client.',
  },
  {
    key: 'usagePollIntervalSeconds',
    label: 'How often to re-read plan usage',
    group: 'Plan usage',
    type: 'number',
    default: 60,
    minimum: 15,
    description:
      'How often to re-read plan usage, in seconds. Reads cost no tokens and every window shares one read per interval, so the only limit is the endpoint\'s own. Near a limit (90%, or 10 points below the auto-pause threshold) Agent Wrangler polls every 20s regardless, since that is when the numbers start mattering by the minute. The reset countdown ticks locally between reads, and a failed read leaves the last numbers up until the next one.',
  },
  {
    key: 'autoPause.enabled',
    label: 'Pause every agent near the plan limit',
    group: 'Plan usage',
    type: 'boolean',
    default: false,
    description:
      'Pause every running agent automatically once a plan limit reaches the percentage below, so a burst of agents cannot spend the rest of the window while you are not looking. Paused agents are stopped, not ended: resume them from the dashboard\'s pause button and they carry on from where they were. A turn in flight when the pause lands may have to be retried.',
  },
  {
    key: 'autoPause.percent',
    label: 'Pause at this percentage',
    group: 'Plan usage',
    type: 'number',
    default: 98,
    minimum: 50,
    maximum: 100,
    description:
      'The usage percentage that triggers the automatic pause, across any limit window (5-hour, weekly, or model-scoped). It fires once per approach: after firing it re-arms only when usage falls back below this, so resuming an agent on purpose is not undone at the next poll.',
  },

  // ---- Dictation ----
  {
    key: 'dictation.livePreview',
    label: 'Live preview while dictating',
    group: 'Dictation',
    type: 'boolean',
    default: true,
    description:
      'Show the words being recognised beside the composer while you speak. The preview re-runs whisper.cpp on the last few seconds of audio about once a second, on this machine, so it costs CPU and may change as you talk. The text put in the composer when you stop is always a fresh transcription of the whole recording. Turn this off on a slow machine or with a large model.',
  },
  {
    key: 'dictation.inputDevice',
    label: 'Microphone',
    group: 'Dictation',
    type: 'string',
    default: ":default",
    description:
      'Microphone for dictation, as an ffmpeg avfoundation input. \':default\' is the system input device; \':1\' picks audio device 1 (run \'ffmpeg -f avfoundation -list_devices true -i ""\' to list them).',
  },
  {
    key: 'dictation.modelPath',
    label: 'Whisper model',
    group: 'Dictation',
    type: 'string',
    default: "",
    description:
      'Whisper model (.bin) for dictation. Empty uses ~/.cache/agent-wrangler/whisper/ggml-base.en.bin, which Agent Wrangler offers to download.',
  },
  {
    key: 'dictation.whisperPath',
    label: 'Path to whisper-cli',
    group: 'Dictation',
    type: 'string',
    default: "",
    description:
      'Path to whisper-cli. Empty searches PATH and the Homebrew prefixes.',
  },
  {
    key: 'dictation.ffmpegPath',
    label: 'Path to ffmpeg',
    group: 'Dictation',
    type: 'string',
    default: "",
    description:
      'Path to ffmpeg, used to record the microphone. Empty searches PATH and the Homebrew prefixes.',
  },

  // ---- Binaries ----
  {
    key: 'claudeBinaryPath',
    label: 'Claude Code binary',
    group: 'Binaries',
    type: 'string',
    default: "claude",
    description:
      'Binary used when resuming a session in a terminal (claude --resume <id>).',
  },
  {
    key: 'codexBinaryPath',
    label: 'Codex binary',
    group: 'Binaries',
    type: 'string',
    default: "codex",
    description:
      'Codex CLI binary used for plan usage and conversations. The default discovers the newest compatible executable bundled with the OpenAI Codex extension, then falls back to PATH. Set an explicit path to override discovery.',
  },

  // ---- Experimental ----
  // Off by default and grouped apart on purpose: everything here can reach
  // outside the machine, and none of it has been lived with long enough to be
  // switched on for someone who did not go looking for it.
  {
    key: 'remote.enabled',
    label: 'Discord integration',
    group: 'Experimental',
    type: 'boolean',
    default: false,
    description:
      'Mirror permission prompts to a Discord channel, so you can answer them while away from the machine. Agent Wrangler stays in charge: Discord shows the same choices the dashboard does, and pressing one runs the same action. Connect a bot from the Agent Wrangler menu — the token is kept in the keychain, not here. Nothing is published until that is done and at least one user below is authorised.',
  },
  {
    key: 'remote.discord.guildId',
    dependsOn: 'remote.enabled',
    label: 'Discord server ID',
    group: 'Experimental',
    type: 'string',
    default: '',
    description:
      'The server the channel belongs to. A press from anywhere else is ignored. Turn on Developer Mode in Discord, then right-click the server and Copy Server ID.',
  },
  {
    key: 'remote.discord.channelId',
    dependsOn: 'remote.enabled',
    label: 'Discord channel ID',
    group: 'Experimental',
    type: 'string',
    default: '',
    description:
      'The channel prompts are posted to. A private channel is the sensible choice, in which case the bot must be given access to it explicitly — being in the server is not enough.',
  },
  {
    key: 'remote.discord.authorizedUserIds',
    dependsOn: 'remote.enabled',
    label: 'Authorised Discord users',
    group: 'Experimental',
    type: 'string',
    default: '',
    description:
      'Comma-separated Discord user IDs allowed to answer prompts. IDs rather than usernames: a username can be changed and reused, and this is the only thing between someone in the channel and a permission decision. Empty means nobody, and nothing is published at all.',
  },
  {
    key: 'remote.notificationsEnabled',
    dependsOn: 'remote.enabled',
    label: 'Post to Discord',
    group: 'Experimental',
    type: 'boolean',
    default: true,
    description:
      'The master switch behind the toolbar’s Discord button, which is the same setting and is the quick way to flip it. Off posts nothing at all — no permission prompts, no finished-agent messages, no auto-pause announcements — and closes any card still open in the channel. The prompts themselves are untouched: they wait in Agent Wrangler, and switching this back on republishes the ones still being asked.',
  },
  {
    key: 'remote.notifyOnDone',
    dependsOn: 'remote.enabled',
    label: 'Say when an agent finishes',
    group: 'Experimental',
    type: 'boolean',
    default: true,
    description:
      'Post a message when an agent finishes its task, alongside the permission prompts. It has no buttons — nothing is waiting on you — and names the agent, repository and branch, never anything it said. Auto-pause is announced the same way and is not covered by this switch: everything stopping is not optional news.',
  },
];

/** Group headings in declaration order, with no duplicates. */
export function settingGroups(): { group: string; settings: SettingSpec[] }[] {
  const out: { group: string; settings: SettingSpec[] }[] = [];
  for (const s of SETTINGS) {
    const last = out[out.length - 1];
    if (last && last.group === s.group) last.settings.push(s);
    else out.push({ group: s.group, settings: [s] });
  }
  return out;
}

