/**
 * Every setting, declared once.
 *
 * There are two places a person changes these now — VSCode's settings UI, which
 * reads `contributes.configuration` in `package.json`, and the app's
 * Preferences window, which has to render the same list itself. Two hand-kept
 * copies of twenty-two settings would drift on the first one added, and the
 * drift would be silent: the app would simply not offer it.
 *
 * So this is the list, `package.json` is generated-shaped from it, and
 * `test/settingsSchema.test.ts` fails if they stop matching. Keys are written
 * without the `agentWrangler.` prefix, the way `HostSettings` takes them.
 *
 * `group` and `label` are for the Preferences window and mean nothing to
 * VSCode, which derives its own headings from the key path. `hosts` is how a
 * setting that only makes sense in one of them stays out of the other's UI
 * without disappearing from `package.json`.
 */

export type SettingType = 'string' | 'boolean' | 'number';

export interface SettingSpec {
  /** Dotted, without the `agentWrangler.` prefix — e.g. `autoPause.percent`. */
  key: string;
  /** The Preferences window's section heading. */
  group: string;
  type: SettingType;
  default: string | boolean | number;
  /** The same prose VSCode shows. Kept identical so the test can compare them. */
  description: string;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  /**
   * Which front ends offer it. Absent means both. `openOnStartup` is the
   * current exception: the app has one window and always opens it.
   */
  hosts?: ('vscode' | 'app')[];
}

export const SETTINGS: SettingSpec[] = [

  // ---- Conversations ----
  {
    key: 'runner.defaultPermissionMode',
    group: 'Conversations',
    type: 'string',
    default: "acceptEdits",
    enum: ["default", "acceptEdits", "plan"],
    enumDescriptions: [
      'Ask before every tool that needs permission.',
      'Accept file edits without asking; still ask for everything else.',
      'Plan first: no tools run until you approve a plan.',
    ],
    description:
      'Permission mode for conversations started from Agent Wrangler. Changeable per session from the pane.',
  },
  {
    key: 'runner.model',
    group: 'Conversations',
    type: 'string',
    default: "",
    description:
      'Model for conversations started from Agent Wrangler (e.g. claude-opus-5). Empty means Claude Code\'s own default.',
  },
  {
    key: 'runner.effort',
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
    group: 'Conversations',
    type: 'string',
    default: "",
    description:
      'Model for Codex conversations started from Agent Wrangler. Empty uses the Codex default.',
  },
  {
    key: 'runner.confirmTakeoverOnSend',
    group: 'Conversations',
    type: 'boolean',
    default: false,
    description:
      'Confirm before taking over an idle external session when sending. Estimated status always requires confirmation.',
  },
  {
    key: 'runner.autoResumeLastOnStartup',
    group: 'Conversations',
    type: 'boolean',
    default: true,
    description:
      'After a window reload, resume the conversation this window was running. Only the most recent one, only if it was running in the last few hours, and never one something else has picked up in the meantime.',
  },
  {
    key: 'openOnStartup',
    group: 'Conversations',
    type: 'boolean',
    default: true,
    // The app has one window and opens it; there is nothing to decide.
    hosts: ['vscode'],
    description:
      'Open the Agent Wrangler workbench automatically when a window starts. A tab restored by VSCode is left as it came back.',
  },

  // ---- Agents and status ----
  {
    key: 'stuckThresholdSeconds',
    group: 'Agents and status',
    type: 'number',
    default: 600,
    minimum: 10,
    description:
      'A busy session with no transcript writes or hook events for this long is shown as POSSIBLY STUCK. Keep it generous: the model is silent while thinking or writing a large file, routinely for 2–6 minutes.',
  },
  {
    key: 'pollIntervalSeconds',
    group: 'Agents and status',
    type: 'number',
    default: 5,
    minimum: 2,
    description:
      'Reconciliation poll interval (pid liveness, staleness, missed file events).',
  },
  {
    key: 'endedWindowHours',
    group: 'Agents and status',
    type: 'number',
    default: 48,
    minimum: 1,
    description:
      'Show ended sessions whose last activity is within this window.',
  },
  {
    key: 'maxEndedSessions',
    group: 'Agents and status',
    type: 'number',
    default: 50,
    minimum: 0,
    description:
      'Maximum number of ended sessions to show.',
  },
  {
    key: 'notifyOnWaiting',
    group: 'Agents and status',
    type: 'boolean',
    default: false,
    description:
      'Show a toast notification when a session flips to WAITING ON YOU.',
  },
  {
    key: 'showCodexSubagents',
    group: 'Agents and status',
    type: 'boolean',
    default: false,
    description:
      'Show internal and subagent Codex sessions as separate rows for debugging. Main conversations always summarize linked workers in the Subagents column.',
  },

  // ---- Plan usage ----
  {
    key: 'showUsage',
    group: 'Plan usage',
    type: 'boolean',
    default: true,
    description:
      'Show provider-specific plan-usage cards above the agent table for Claude Code and Codex. Each provider is read through its own local authenticated client.',
  },
  {
    key: 'usagePollIntervalSeconds',
    group: 'Plan usage',
    type: 'number',
    default: 60,
    minimum: 15,
    description:
      'How often to re-read plan usage, in seconds. Reads cost no tokens and every window shares one read per interval, so the only limit is the endpoint\'s own. Near a limit (90%, or 10 points below the auto-pause threshold) Agent Wrangler polls every 20s regardless, since that is when the numbers start mattering by the minute. The reset countdown ticks locally between reads, and a failed read leaves the last numbers up until the next one.',
  },
  {
    key: 'autoPause.enabled',
    group: 'Plan usage',
    type: 'boolean',
    default: false,
    description:
      'Pause every running agent automatically once a plan limit reaches the percentage below, so a burst of agents cannot spend the rest of the window while you are not looking. Paused agents are stopped, not ended: resume them from the dashboard\'s pause button and they carry on from where they were. A turn in flight when the pause lands may have to be retried.',
  },
  {
    key: 'autoPause.percent',
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
    key: 'dictation.inputDevice',
    group: 'Dictation',
    type: 'string',
    default: ":default",
    description:
      'Microphone for dictation, as an ffmpeg avfoundation input. \':default\' is the system input device; \':1\' picks audio device 1 (run \'ffmpeg -f avfoundation -list_devices true -i ""\' to list them).',
  },
  {
    key: 'dictation.modelPath',
    group: 'Dictation',
    type: 'string',
    default: "",
    description:
      'Whisper model (.bin) for dictation. Empty uses ~/.cache/agent-wrangler/whisper/ggml-base.en.bin, which Agent Wrangler offers to download.',
  },
  {
    key: 'dictation.whisperPath',
    group: 'Dictation',
    type: 'string',
    default: "",
    description:
      'Path to whisper-cli. Empty searches PATH and the Homebrew prefixes.',
  },
  {
    key: 'dictation.ffmpegPath',
    group: 'Dictation',
    type: 'string',
    default: "",
    description:
      'Path to ffmpeg, used to record the microphone. Empty searches PATH and the Homebrew prefixes.',
  },

  // ---- Binaries ----
  {
    key: 'claudeBinaryPath',
    group: 'Binaries',
    type: 'string',
    default: "claude",
    description:
      'Binary used when resuming a session in a terminal (claude --resume <id>).',
  },
  {
    key: 'codexBinaryPath',
    group: 'Binaries',
    type: 'string',
    default: "codex",
    description:
      'Codex CLI binary used for plan usage and conversations. The default discovers the newest compatible executable bundled with the OpenAI VS Code extension, then falls back to PATH. Set an explicit path to override discovery.',
  },
];

/** The `agentWrangler.`-prefixed name, which is what `package.json` uses. */
export function qualifiedKey(key: string): string {
  return `agentWrangler.${key}`;
}

/** The settings a given front end should show, in declaration order. */
export function settingsFor(host: 'vscode' | 'app'): SettingSpec[] {
  return SETTINGS.filter((s) => (s.hosts ?? ['vscode', 'app']).includes(host));
}

/** Group headings in declaration order, with no duplicates. */
export function settingGroups(host: 'vscode' | 'app'): { group: string; settings: SettingSpec[] }[] {
  const out: { group: string; settings: SettingSpec[] }[] = [];
  for (const s of settingsFor(host)) {
    const last = out[out.length - 1];
    if (last && last.group === s.group) last.settings.push(s);
    else out.push({ group: s.group, settings: [s] });
  }
  return out;
}

/**
 * The `contributes.configuration.properties` entry for a setting — the shape
 * `package.json` holds, rebuilt from the declaration so the test can compare
 * the two rather than trusting them to have been edited together.
 */
export function vscodeProperty(s: SettingSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type };
  if (s.enum) {
    out.enum = s.enum;
    out.enumDescriptions = s.enumDescriptions;
  }
  out.default = s.default;
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  out.description = s.description;
  return out;
}
