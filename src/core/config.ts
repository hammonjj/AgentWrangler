/**
 * Settings snapshot. The vscode-backed reader lives in extension.ts; core and
 * provider code only ever see this plain object via a getter function.
 */

export interface WranglerConfig {
  claudeBinaryPath: string;
  codexBinaryPath: string;
  showCodexSubagents: boolean;
  stuckThresholdSeconds: number;
  endedWindowHours: number;
  maxEndedSessions: number;
  notifyOnWaiting: boolean;
  pollIntervalSeconds: number;
  /** Plan-usage cards above the table (session / weekly limits, as in Claude Code's /usage). */
  showUsage: boolean;
  usagePollIntervalSeconds: number;
  /** Pause every running agent by itself once a plan limit reaches `autoPausePercent`. */
  autoPauseEnabled: boolean;
  autoPausePercent: number;
}

export const DEFAULT_CONFIG: WranglerConfig = {
  claudeBinaryPath: 'claude',
  codexBinaryPath: 'codex',
  showCodexSubagents: false,
  // Ten minutes, not one. Neither the transcript nor the hooks say anything
  // while the model is generating, and a long think or a big `Write` is
  // routinely silent for 2–6 minutes (measured: gaps of 121s, 388s, 79s and
  // 104s inside one ordinary turn). A one-minute threshold called all of those
  // "stuck"; the ETA column is the tool for "running long", this is for "dead".
  stuckThresholdSeconds: 600,
  endedWindowHours: 48,
  maxEndedSessions: 50,
  notifyOnWaiting: false,
  pollIntervalSeconds: 5,
  showUsage: true,
  // One minute. Five was chosen when the cards only answered "am I near the
  // weekly limit", which does not change by the minute. They are now also what
  // auto-pause reads, and near a limit the question becomes "how many minutes
  // are left" — at five-minute granularity a burst of agents can cross 98% and
  // reach 100% inside a single interval. The read costs no tokens (it is an
  // account-metadata endpoint, not an inference call) and the cross-window
  // cache keeps it to one request per interval for the whole machine, so the
  // only budget being spent is the endpoint's own rate limit. Near a limit the
  // service tightens this further by itself; see `usageIntervalSeconds`.
  usagePollIntervalSeconds: 60,
  // Off by default: freezing every agent on the machine is not something that
  // should start happening to someone who never asked for it.
  autoPauseEnabled: false,
  // 98%, not 100: the reading can be a poll old, and a turn that starts at 99%
  // still has to finish. Two points is the margin for both.
  autoPausePercent: 98,
};

export type ConfigGetter = () => WranglerConfig;
