/**
 * The orchestration composition root (`docs/plans/intelligent-orchestration.md`
 * §2.4 item 6, §5.3).
 *
 * `createApp` calls this once. It takes narrow interfaces, never `createApp`
 * internals, so orchestration can be built and tested on its own. In #26 it is
 * wired but inert: behind `orchestration.enabled` (off by default) it opens the
 * mission store and waits for #4's startup to settle, which is where #33's
 * recovery (§23.3) will run. Nothing starts a session yet.
 */
import * as path from 'node:path';
import type { Disposable } from '../core/events';
import type { LaunchDefaults } from '../core/launchDefaults';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import type { SessionRegistry } from '../core/session/sessionRegistry';
import { RepoPolicyStore, repoPoliciesDir } from './policy/repoPolicyStore';
import { MissionStore } from './store/missionStore';

/** The setting that switches orchestration on. Not in Preferences until it does something (#33). */
export const ORCHESTRATION_ENABLED_KEY = 'orchestration.enabled';

export interface OrchestrationDeps {
  settings: { get<T>(key: string, defaultValue: T): T };
  /** The app's data directory; missions live under `orchestration/missions/`. */
  dataDir: string;
  sessions: Pick<SessionExecutors, 'launch' | 'get' | 'list' | 'onDidChange'>;
  registry: Pick<SessionRegistry, 'all' | 'get'>;
  launchDefaults: LaunchDefaults;
  /**
   * Resolves once #4's startup has settled: hosts adopted and Codex threads
   * rejoined. Recovery must not look at session states before (§23.3).
   */
  startupSettled: Promise<void>;
  log: (msg: string) => void;
}

export interface Orchestration extends Disposable {
  readonly enabled: boolean;
  /** The mission store, when enabled. */
  readonly store?: MissionStore;
  /** Per-repository policies (§13.6), when enabled. Read by the task runner (#33) at each launch. */
  readonly repoPolicies?: RepoPolicyStore;
  /** Resolves when the startup pass is over (immediately when disabled). */
  readonly ready: Promise<void>;
}

export function missionsDir(dataDir: string): string {
  return path.join(dataDir, 'orchestration', 'missions');
}

export function createOrchestration(deps: OrchestrationDeps): Orchestration {
  // Read once: turning it on or off takes a restart, like the other lifecycle switches.
  const enabled = deps.settings.get<boolean>(ORCHESTRATION_ENABLED_KEY, false) === true;
  if (!enabled) return { enabled: false, ready: Promise.resolve(), dispose: () => undefined };

  const store = new MissionStore(missionsDir(deps.dataDir), { log: (m) => deps.log(`orchestration: ${m}`) });
  const ready = deps.startupSettled
    .catch(() => undefined)
    .then(() => {
      const active = store.loadActive();
      // #33 reconciles these with the registry. Until then, say they exist.
      if (active.length > 0) deps.log(`orchestration: ${active.length} unfinished mission(s) on disk; nothing resumes them yet`);
    });
  const repoPolicies = new RepoPolicyStore(repoPoliciesDir(deps.dataDir), { log: (m) => deps.log(`orchestration: ${m}`) });
  return { enabled: true, store, repoPolicies, ready, dispose: () => undefined };
}
