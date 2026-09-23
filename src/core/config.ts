/**
 * Settings snapshot. The host-backed reader is `readConfig` below; core and
 * provider code only ever see this plain object via a getter function.
 */

import type { HostSettings } from '../host/hostServices';

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
  /** Experimental: mirror permission prompts to a remote surface. */
  remoteEnabled: boolean;
  /**
   * The toolbar's Discord button: whether announcements are posted at all.
   * Separate from `remoteEnabled` because it is a thing you flip several times
   * a day — turning the integration off instead would drop the socket and take
   * the permission cards with it.
   */
  remoteNotificationsEnabled: boolean;
  remoteGuildId: string;
  remoteChannelId: string;
  /** Comma-separated in the setting; split and trimmed here. */
  remoteAuthorizedUserIds: string[];
  /** Also post a buttonless message when an agent finishes. */
  remoteNotifyOnDone: boolean;
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
  // Off, and empty. Nothing about this runs until someone goes looking for it.
  remoteEnabled: false,
  // On, so switching the integration on does not also need a second switch.
  remoteNotificationsEnabled: true,
  remoteGuildId: '',
  remoteChannelId: '',
  remoteAuthorizedUserIds: [],
  // On, but only reachable once `remoteEnabled` is: someone who has connected a
  // channel to hear about their agents wants to hear the one thing that is not
  // a question.
  remoteNotifyOnDone: true,
};

/** `123, 456` → `['123','456']`, dropping blanks so a trailing comma is harmless. */
export function parseIdList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type ConfigGetter = () => WranglerConfig;

/**
 * Read the snapshot out of whatever the host keeps settings in.
 *
 * Every field is listed, rather than iterated over `DEFAULT_CONFIG`, because
 * two of the keys are nested (`autoPause.enabled`, `autoPause.percent`) and the
 * property names do not match the setting names. Read fresh on every call: the
 * poll interval and the stuck threshold are meant to take effect without a
 * reload, so nothing may cache this.
 */
export function readConfig(settings: HostSettings): WranglerConfig {
  const d = DEFAULT_CONFIG;
  return {
    claudeBinaryPath: settings.get('claudeBinaryPath', d.claudeBinaryPath),
    codexBinaryPath: settings.get('codexBinaryPath', d.codexBinaryPath),
    showCodexSubagents: settings.get('showCodexSubagents', d.showCodexSubagents),
    stuckThresholdSeconds: settings.get('stuckThresholdSeconds', d.stuckThresholdSeconds),
    endedWindowHours: settings.get('endedWindowHours', d.endedWindowHours),
    maxEndedSessions: settings.get('maxEndedSessions', d.maxEndedSessions),
    notifyOnWaiting: settings.get('notifyOnWaiting', d.notifyOnWaiting),
    pollIntervalSeconds: settings.get('pollIntervalSeconds', d.pollIntervalSeconds),
    showUsage: settings.get('showUsage', d.showUsage),
    usagePollIntervalSeconds: settings.get('usagePollIntervalSeconds', d.usagePollIntervalSeconds),
    autoPauseEnabled: settings.get('autoPause.enabled', d.autoPauseEnabled),
    autoPausePercent: settings.get('autoPause.percent', d.autoPausePercent),
    remoteEnabled: settings.get('remote.enabled', d.remoteEnabled),
    remoteNotificationsEnabled: settings.get('remote.notificationsEnabled', d.remoteNotificationsEnabled),
    remoteGuildId: settings.get('remote.discord.guildId', d.remoteGuildId),
    remoteChannelId: settings.get('remote.discord.channelId', d.remoteChannelId),
    remoteAuthorizedUserIds: parseIdList(settings.get('remote.discord.authorizedUserIds', '')),
    remoteNotifyOnDone: settings.get('remote.notifyOnDone', d.remoteNotifyOnDone),
  };
}
