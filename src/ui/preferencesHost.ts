/**
 * The host end of Preferences (#135): what the Preferences window and the
 * `#/preferences` route of the browser workbench are both served by.
 *
 * It is written against a `PaneChannel`, so the Electron window (its own IPC
 * channel) and each browser connection (the `preferences` envelope on the
 * WebSocket) share every rule below: which messages write, how a setting is
 * checked, what an action reports, how the orchestration view and the device
 * list reach the page. What differs is only who is on the other end, and that
 * is the `RequestContext` it acts as.
 *
 * Every message is one request, classified by `preferencesRequest` and admitted
 * through the access gate (#123) before anything it asks for runs, the same as
 * `DashboardHost` does. A message that gets past the gate is then still
 * checked for shape: a browser is a client the host does not trust.
 *
 * Secrets never travel in this protocol's replies. A local endpoint's key is
 * asked for by a prompt to the client that pressed the button (#126), and goes
 * to the host's secret store; the view says only whether one is set.
 */
import type { AccessRequest, BoundAccess, ResourceRef } from '../core/access';
import { type Disposable } from '../core/events';
import { runInRequest } from '../core/requestScope';
import type { HostSettings } from '../host/hostServices';
import type { ModelPolicyChange } from '../shared/orchestration/catalog';
import { localEndpointChange, type LocalEndpointChange } from '../shared/orchestration/localEndpoints';
import {
  isSettingActionId,
  modelPolicyChange,
  revokeWebDeviceId,
  routingPolicyUpdate,
  settingUpdate,
  type HostToPreferences,
  type OrchestrationPrefsView,
  type PreferencesToHost,
  type SettingActionId,
  type SettingStatus,
  type WebDeviceView,
} from '../shared/preferences';
import { SETTINGS } from '../shared/settings';
import type { PaneChannel } from './paneChannel';

/**
 * What Preferences reads and calls on the app. One per process, shared by the
 * window and every browser connection; built by `createPreferencesBackend`
 * (`src/app/preferencesBackend.ts`) so Electron and the daemon offer the same.
 */
export interface PreferencesBackend {
  settings: HostSettings;
  log(message: string): void;
  /** Run one of the page's buttons. Absent: nothing to run. */
  runAction?(id: SettingActionId): Promise<{ ok: boolean; lines: string[] }>;
  /** Read-only status lines under settings (the LAN addresses, #136), and when they change. */
  status?: {
    read(): Record<string, SettingStatus>;
    onDidChange(listener: () => void): Disposable;
  };
  /**
   * Browser devices under Preferences → Browser (#137), with Revoke. The host
   * authorises the revocation before calling this; this only does it.
   */
  webDevices?: {
    list(): WebDeviceView[];
    revoke(id: string): void;
    onDidChange(listener: () => void): Disposable;
  };
  /** Orchestration → tier map. Absent: the section says there is nothing to show. */
  orchestration?: {
    view(): OrchestrationPrefsView;
    onDidChange(listener: () => void): Disposable;
    setPolicy(change: ModelPolicyChange): Promise<boolean>;
    /** Orchestration → Local endpoints (#51). */
    localEndpoint?(change: LocalEndpointChange): Promise<{ ok: boolean; lines: string[] }>;
    /** Write the global routing defaults (#40), already checked by `routingPolicyUpdate`. */
    setRouting?(value: Record<string, unknown>): Promise<void>;
  };
}

export interface PreferencesHostOptions {
  /** `close` was sent: the window closes itself. A browser page navigates on its own and never sends it. */
  onClose?(): void;
}

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const setting = (id: string): ResourceRef => ({ kind: 'setting', id });

/** A setting key as a resource: only one that is declared, so a made-up string is never written to the audit log. */
function settingKeyRef(key: unknown): ResourceRef {
  return setting(typeof key === 'string' && BY_KEY.has(key) ? key : 'unknown');
}

/**
 * What a Preferences message asks to do, for `authorize`. Exhaustive: a
 * message type added to `PreferencesToHost` without a line here is a compile
 * error. A type a page made up is authorised as a settings write, so its
 * refusal is audited, and then matches nothing in `dispatch`.
 */
export function preferencesRequest(m: PreferencesToHost): AccessRequest {
  switch (m.type) {
    case 'ready':
    case 'close':
      return { action: 'view.read' };
    case 'set':
    case 'reset':
      return { action: 'settings.write', resource: settingKeyRef(m.key) };
    case 'action':
      // Connect and disconnect store and forget a credential; the test reaches out. All three are settings work.
      return { action: 'settings.write', resource: setting(isSettingActionId(m.id) ? `action.${m.id}` : 'action.unknown') };
    case 'modelPolicy':
      return { action: 'settings.write', resource: setting('orchestration.models') };
    case 'localEndpoint':
      return { action: 'settings.write', resource: setting('orchestration.localEndpoints') };
    case 'routingPolicy':
      return { action: 'settings.write', resource: setting('orchestration.routing') };
    case 'revokeWebDevice': {
      const id = revokeWebDeviceId(m);
      return { action: 'web.device.revoke', resource: id ? { kind: 'device', id } : undefined };
    }
    default: {
      const unknown: never = m;
      void unknown;
      return { action: 'settings.write' };
    }
  }
}

export class PreferencesHost implements Disposable {
  private readonly subs: Disposable[] = [];
  /** The page has said `ready`: until then it has no use for pushes. */
  private active = false;
  private disposed = false;

  constructor(
    private readonly channel: PaneChannel,
    private readonly backend: PreferencesBackend,
    private readonly access: BoundAccess,
    private readonly opts: PreferencesHostOptions = {},
  ) {
    this.subs.push(channel.onDidReceiveMessage((m: unknown) => this.onMessage(m as PreferencesToHost)));
    // A setting changed elsewhere — the dashboard's Codex-subagents checkbox, another
    // browser — has to reach an open page, or it shows a value that is no longer true
    // and writing anything else puts the stale one back.
    this.subs.push(backend.settings.onDidChange(() => this.push()));
    // The catalog changes when a CLI reports its models, when a usage read lands,
    // and when a tier is changed here: all of it belongs on screen.
    if (backend.orchestration) this.subs.push(backend.orchestration.onDidChange(() => this.pushOrchestration()));
    if (backend.status) this.subs.push(backend.status.onDidChange(() => this.pushStatus()));
    if (backend.webDevices) this.subs.push(backend.webDevices.onDidChange(() => this.pushWebDevices()));
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
  }

  /** Authorised here, before anything it asks for runs. */
  private onMessage(m: PreferencesToHost): void {
    if (this.disposed || !m || typeof m !== 'object') return;
    const req = preferencesRequest(m);
    if (!this.access.gate.admit(this.access.context, req.action, req.resource)) return;
    // As this page's client: the prompts and toasts it causes (a local endpoint's key)
    // go back to it, however many awaits later (#126).
    runInRequest(this.access.context, () => this.dispatch(m));
  }

  private dispatch(message: PreferencesToHost): void {
    const { backend } = this;
    if (message.type === 'ready') {
      this.active = true;
      this.push();
      this.pushStatus();
      this.pushWebDevices();
      this.pushOrchestration();
      return;
    }
    if (message.type === 'close') {
      this.opts.onClose?.();
      return;
    }
    if (message.type === 'revokeWebDevice') {
      const id = revokeWebDeviceId(message);
      if (!id || !backend.webDevices) {
        backend.log('preferences: refused a device revocation');
        return;
      }
      backend.webDevices.revoke(id);
      this.pushWebDevices();
      return;
    }
    if (message.type === 'modelPolicy') {
      // Same rule as settings: a shape no page sends does not get to write,
      // and the catalog then refuses a key or tier it does not know.
      const change = modelPolicyChange(message);
      if (!change || !backend.orchestration) {
        backend.log('preferences: refused a model policy change');
        return;
      }
      void backend.orchestration
        .setPolicy(change)
        .then((ok) => {
          if (!ok) backend.log(`preferences: refused model policy for ${change.key}`);
        })
        .catch((err) => backend.log(`preferences: model policy failed: ${String(err)}`))
        .finally(() => this.pushOrchestration());
      return;
    }
    if (message.type === 'localEndpoint') {
      const change = localEndpointChange((message as { change?: unknown }).change);
      const run = backend.orchestration?.localEndpoint;
      if (!change || !run) {
        backend.log('preferences: refused a local endpoint change');
        return;
      }
      void run(change)
        .then((r) => this.post({ type: 'localEndpointResult', ok: r.ok, lines: r.lines }))
        .catch((err) => this.post({ type: 'localEndpointResult', ok: false, lines: [`✗  ${String(err)}`] }))
        .finally(() => this.pushOrchestration());
      return;
    }
    if (message.type === 'routingPolicy') {
      // Checked again here with the same rules the page used: a shape, a
      // tier or a pin-above-cap it let through does not get to write.
      const orch = backend.orchestration;
      if (!orch?.setRouting) {
        backend.log('preferences: refused routing defaults (orchestration unavailable)');
        return;
      }
      // The gate is read fresh here (#42): the page's copy may be stale, and `auto` over an unmet gate needs an explicit override.
      const view = orch.view();
      const update = routingPolicyUpdate(message, view.catalog, {
        gate: view.routing?.gate,
        stored: view.routing ? { mode: view.routing.mode, autoOverride: view.routing.autoOverride } : undefined,
        now: Date.now(),
      });
      if (!update.ok) {
        backend.log(`preferences: refused routing defaults: ${update.errors.join('; ')}`);
        this.post({ type: 'routingResult', ok: false, errors: update.errors, ...(update.needsOverride ? { needsOverride: true } : {}) });
        return;
      }
      if ((message as { overrideGate?: unknown }).overrideGate === true && !view.routing?.gate?.met) {
        backend.log('preferences: automatic routing enabled over an unmet gate (override, numbers shown)');
      }
      void orch
        .setRouting(update.value)
        .then(() => this.post({ type: 'routingResult', ok: true, errors: [] }))
        .catch((e) => this.post({ type: 'routingResult', ok: false, errors: [String(e)] }))
        .finally(() => this.pushOrchestration());
      return;
    }
    if (message.type === 'action') {
      void this.runAction(message.id);
      return;
    }

    // The rules live in `settingUpdate`, in shared, where they can be tested
    // without a page: only a declared key, only its declared type and range,
    // and reset removes rather than overwrites. Anything else is not a person
    // changing a setting and does not get to write.
    const update = settingUpdate(message, (key) => BY_KEY.get(key));
    if (!update) {
      backend.log(`preferences: refused ${String((message as { key?: unknown }).key).slice(0, 80)}`);
      // The page shows what it asked for; say what is true.
      this.push();
      return;
    }
    backend.settings.update(update.key, update.value).catch((err: unknown) => {
      backend.log(`preferences: could not write ${update.key}: ${String(err)}`);
      this.push();
    });
  }

  /**
   * Run a button and report back into the page.
   *
   * The id is checked against the closed set rather than trusted: this arrives
   * over the same channel as everything else, and "run whatever it says" is not
   * a thing a page should be able to ask for.
   */
  private async runAction(id: unknown): Promise<void> {
    if (!isSettingActionId(id)) {
      this.backend.log(`preferences: refused action ${String(id).slice(0, 40)}`);
      return;
    }
    if (!this.backend.runAction) return;
    this.post({ type: 'actionBusy', id });
    try {
      const result = await this.backend.runAction(id);
      this.post({ type: 'actionResult', id, ok: result.ok, lines: result.lines });
    } catch (err) {
      this.post({ type: 'actionResult', id, ok: false, lines: [`✗  ${String(err)}`] });
    }
    // Connecting or disconnecting changes what the rest of the page should
    // say about itself, and a token is not a setting, so nothing else would.
    this.push();
  }

  private post(message: HostToPreferences): void {
    if (this.disposed) return;
    void this.channel.postMessage(message);
  }

  private push(): void {
    if (!this.active) return;
    const values: Record<string, string | boolean | number> = {};
    for (const spec of SETTINGS) values[spec.key] = this.backend.settings.get(spec.key, spec.default);
    this.post({ type: 'values', values });
  }

  private pushStatus(): void {
    if (!this.active || !this.backend.status) return;
    this.post({ type: 'status', status: this.backend.status.read() });
  }

  private pushWebDevices(): void {
    if (!this.active || !this.backend.webDevices) return;
    this.post({ type: 'webDevices', devices: this.backend.webDevices.list() });
  }

  private pushOrchestration(): void {
    if (!this.active || !this.backend.orchestration) return;
    this.post({ type: 'orchestration', view: this.backend.orchestration.view() });
  }
}
