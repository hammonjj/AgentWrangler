/**
 * What Preferences reads and calls on the app (#135): the one backend every
 * browser's `#/preferences` route is served from, so a setting, a button or
 * the orchestration tables cannot be on one and missing from another.
 *
 * Built by the core daemon, through `startWebWorkbench`.
 */
import type { AgentWranglerApp } from './createApp';
import type { Disposable } from '../core/events';
import type { WebDeviceStore } from '../core/web/devices';
import type { LanStatus } from '../core/web/lan';
import type { HostServices } from '../host/hostServices';
import { parseRoutingSettings, ROUTING_KEY } from '../shared/orchestration/executionPolicy';
import { sourceStatus } from '../shared/orchestration/sourceHealth';
import type { OrchestrationPrefsView } from '../shared/preferences';
import type { PreferencesBackend } from '../ui/preferencesHost';

export interface PreferencesBackendOptions {
  app: AgentWranglerApp;
  host: HostServices;
  /** The browser listener's LAN state (#136), read when asked: the web workbench may not exist yet. */
  lan: { status(): LanStatus; onDidChange(listener: () => void): Disposable };
  /** The process's device store (#137). */
  devices: WebDeviceStore;
}

export function createPreferencesBackend(opts: PreferencesBackendOptions): PreferencesBackend {
  const { app, host, lan, devices } = opts;
  return {
    settings: host.settings,
    log: (line) => host.log(line),
    // Prompts (a bot token) go to whoever pressed the button: the host runs this in that request.
    runAction: (id) => app.runSettingAction(id),
    // The addresses LAN access is bound to (#136), under its switch.
    status: {
      read: () => {
        const s = lan.status();
        return { 'web.lan.enabled': { ok: s.state !== 'error', lines: s.lines } };
      },
      onDidChange: lan.onDidChange,
    },
    // Never a credential: only what the list shows. The host authorises a revocation before this runs.
    webDevices: {
      list: () => devices.list().map(({ id, name, scope, createdAt, lastSeen }) => ({ id, name, scope, createdAt, lastSeen })),
      revoke: (id) => void devices.revoke(id),
      onDidChange: devices.onDidChange,
    },
    // Orchestration → tier map (#29): the catalog, and each source's health
    // from the same usage reads the dashboard cards use.
    orchestration: {
      view: (): OrchestrationPrefsView => {
        const routing = parseRoutingSettings(host.settings.get<unknown>(ROUTING_KEY, undefined));
        return {
          catalog: app.models.catalog,
          sources: [
            sourceStatus('anthropic', app.usage.usage, Date.now()),
            sourceStatus('openai', app.codexUsage.usage, Date.now()),
            ...Object.values(app.localEndpoints.statuses()),
          ],
          // Local endpoints (#51): the registry, and what each model has done (§19.4).
          // `hasKey` and `secretsAvailable` only: a stored key is never in a view.
          local: {
            endpoints: app.localEndpoints.view(app.models.catalog),
            summaries: app.localMetrics.summaries(),
            secretsAvailable: host.secrets.available,
          },
          // The global scope of pins and caps (#40), with anything in settings.json that was ignored.
          // With automatic routing's gate and the shadow comparison report (#42).
          routing: {
            mode: routing.mode,
            policy: routing.policy,
            ignored: routing.errors.map((e) => `${e.path}: ${e.message}`),
            ...(routing.autoOverride ? { autoOverride: routing.autoOverride } : {}),
            ...app.autoRouting(),
          },
        };
      },
      onDidChange: (listener) => {
        const subs = [
          app.models.onDidChange(listener),
          app.usage.onDidChange(listener),
          app.codexUsage.onDidChange(listener),
          app.localEndpoints.onDidChange(listener),
          app.localMetrics.onDidChange(listener),
          app.onDidChangeRoutingEvidence(listener),
        ];
        return { dispose: () => subs.forEach((s) => s.dispose()) };
      },
      setPolicy: (change) => app.models.setPolicy(change),
      // Can ask for an endpoint's key: the host runs this as the client that pressed the button.
      localEndpoint: (change) => app.localEndpoints.apply(change),
      // Frozen into each mission recorded after this; a started mission keeps what it had (§10.2).
      setRouting: (value) => host.settings.update(ROUTING_KEY, value),
    },
  };
}
