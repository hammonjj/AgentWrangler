/**
 * The last model list the CLI gave us, kept so something other than a live
 * conversation can offer it.
 *
 * The composer's model dropdown is filled by asking a running session
 * `supportedModels()` — which is the honest source, and useless to the
 * launcher, because the launcher's whole job is starting a session that does
 * not exist yet. Rather than hardcode a list that goes stale the week a model
 * ships, the answer from the last runner is remembered and offered again.
 *
 * Global state, not per-window: which models an account can use is a fact about
 * the account. It is allowed to be a little old — a model added since the last
 * conversation will not appear until the next one runs — which is why the
 * launcher always keeps a "Default" row that means "whatever the CLI picks".
 */

import { Emitter, type Disposable, type Listener } from './events';
import type { KeyValueStorage } from './archive';
import type { ModelChoice } from '../shared/conversation';

const STORAGE_KEY = 'agentWrangler.modelCatalog';

export class ModelCatalogService {
  private models: ModelChoice[];
  private emitter = new Emitter<void>();

  constructor(private storage: KeyValueStorage) {
    this.models = sane(storage.get<unknown>(STORAGE_KEY, []));
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get value(): ModelChoice[] {
    return this.models;
  }

  /**
   * Record what a runner just reported. Ignores an empty list — a CLI too old
   * to answer, or one that has not answered yet, must not erase a good list
   * from the last conversation.
   */
  remember(models: ModelChoice[] | undefined): void {
    const next = sane(models);
    if (next.length === 0 || same(next, this.models)) return;
    this.models = next;
    void this.storage.update(STORAGE_KEY, next);
    this.emitter.fire();
  }
}

/** Trust nothing off disk: this is JSON that an older version wrote. */
function sane(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const m = entry as Partial<ModelChoice>;
    if (typeof m.value !== 'string' || m.value === '' || typeof m.label !== 'string') return [];
    return [
      {
        value: m.value,
        label: m.label,
        resolved: typeof m.resolved === 'string' ? m.resolved : undefined,
        effortLevels: Array.isArray(m.effortLevels)
          ? m.effortLevels.filter((l): l is string => typeof l === 'string')
          : undefined,
      },
    ];
  });
}

function same(a: ModelChoice[], b: ModelChoice[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.value === b[i].value && m.label === b[i].label && m.resolved === b[i].resolved &&
    (m.effortLevels ?? []).join() === (b[i].effortLevels ?? []).join());
}
