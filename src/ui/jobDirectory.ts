/**
 * What the table pane needs from the app to show scheduled jobs (#165,
 * #166): list them, create and edit them, turn them on and off, and run one
 * now. Every input is what a client sent and is checked again here.
 */
import type { Disposable } from '../core/events';
import type { JobView } from '../shared/scheduledJobs';
import type { SweepItem } from '../shared/prSweep';

export interface JobDirectory {
  views(): JobView[];
  /** Create (no `id`) or edit. */
  save(id: string | undefined, input: unknown): { id: string } | { error: string };
  setEnabled(id: string, on: boolean): { error?: string };
  /** Confirm, then delete the job and its history. Sessions it started stay. */
  remove(id: string): Promise<void>;
  /** Start a run now, enabled or not. Admission (pause, usage) still applies. */
  runNow(id: string): Promise<{ runId: string } | { error: string }>;
  /** A PR sweep's preview (#168): what it would review now. Reviews nothing. */
  preview(id: string): Promise<{ repo: string; items: SweepItem[] } | { error: string }>;
  onDidChange(listener: () => void): Disposable;
}
