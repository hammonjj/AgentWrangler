/**
 * Settings snapshot. The vscode-backed reader lives in extension.ts; core and
 * provider code only ever see this plain object via a getter function.
 */

export interface WranglerConfig {
  claudeBinaryPath: string;
  stuckThresholdSeconds: number;
  endedWindowHours: number;
  maxEndedSessions: number;
  notifyOnWaiting: boolean;
  pollIntervalSeconds: number;
}

export const DEFAULT_CONFIG: WranglerConfig = {
  claudeBinaryPath: 'claude',
  // Ten minutes, not one. Neither the transcript nor the hooks say anything
  // while the model is generating, and a long think or a big `Write` is
  // routinely silent for 2–6 minutes (measured: gaps of 121s, 388s, 79s and
  // 104s inside one ordinary turn). A one-minute threshold called all of those
  // "stuck"; the pace chip is the tool for "running long", this is for "dead".
  stuckThresholdSeconds: 600,
  endedWindowHours: 48,
  maxEndedSessions: 50,
  notifyOnWaiting: false,
  pollIntervalSeconds: 5,
};

export type ConfigGetter = () => WranglerConfig;
