/**
 * How a new session is launched when nobody says otherwise: one typed reader
 * for the launch settings, instead of `runner.*` / `codexRunner.*` reads
 * scattered through `createApp` (`docs/plans/intelligent-orchestration.md`
 * §2.4 item 2, #26). Orchestration overrides these per attempt; the launcher
 * uses them as they are.
 *
 * Read on every call, so a changed setting applies to the next launch without
 * a restart, exactly as the ad hoc reads did.
 */
import type { PermissionModeName } from '../shared/conversation';
import type { LaunchRequest, SessionProvider } from './session/sessionHandle';
import type { LaunchOptionsRecord } from './session/sessionRegistry';

export interface SettingsReader {
  get<T>(key: string, defaultValue: T): T;
}

export interface LaunchOptions {
  model?: string;
  effort?: string;
  permissionMode?: PermissionModeName;
}

/** The app's default permission mode for sessions it starts (`runner.defaultPermissionMode`). */
export const DEFAULT_PERMISSION_MODE: PermissionModeName = 'auto';

/** A trimmed string setting, with empty meaning "the CLI's own default". */
function optional(settings: SettingsReader, key: string): string | undefined {
  const v = settings.get<string>(key, '');
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export class LaunchDefaults {
  constructor(private readonly settings: SettingsReader) {}

  /**
   * The defaults for one provider. Codex takes its permission policy from its
   * own configuration, so it has no permission mode here.
   */
  for(provider: SessionProvider): LaunchOptions {
    if (provider === 'codex') {
      return { model: optional(this.settings, 'codexRunner.model'), effort: optional(this.settings, 'codexRunner.effort') };
    }
    return {
      model: optional(this.settings, 'runner.model'),
      effort: optional(this.settings, 'runner.effort'),
      permissionMode: this.settings.get<PermissionModeName>('runner.defaultPermissionMode', DEFAULT_PERMISSION_MODE),
    };
  }

  /**
   * How to start a session again: the way it was started before, where the
   * registry remembers (a resume comes back on the same model, mode and
   * effort), otherwise the current defaults, field by field.
   */
  resumed(provider: SessionProvider, previous?: LaunchOptionsRecord): LaunchOptions {
    const now = this.for(provider);
    const out: LaunchOptions = {
      model: previous?.model ?? now.model,
      effort: previous?.effort ?? now.effort,
    };
    if (provider === 'claude') out.permissionMode = (previous?.permissionMode as PermissionModeName | undefined) ?? now.permissionMode;
    return out;
  }

  /** A launch request for a new session in `cwd`, on the defaults, with `overrides` on top. */
  request(provider: SessionProvider, cwd: string, overrides: Partial<Omit<LaunchRequest, 'provider' | 'cwd'>> = {}): LaunchRequest {
    return { provider, cwd, ...this.for(provider), ...overrides };
  }
}
