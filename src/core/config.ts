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
  stuckThresholdSeconds: 60,
  endedWindowHours: 48,
  maxEndedSessions: 50,
  notifyOnWaiting: false,
  pollIntervalSeconds: 5,
};

export type ConfigGetter = () => WranglerConfig;
