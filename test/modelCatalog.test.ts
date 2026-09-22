import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { ModelCatalogService } from '../src/core/modelCatalog';

function storage(initial: unknown = []): KeyValueStorage & { saved: unknown } {
  const value: KeyValueStorage & { saved: unknown } = {
    saved: initial,
    get<T>(_key: string, fallback: T): T { return (value.saved as T) ?? fallback; },
    update(_key: string, next: unknown) { value.saved = next; },
  };
  return value;
}

describe('ModelCatalogService', () => {
  it('keeps each provider catalog when the other provider reports models', () => {
    const saved = storage();
    const catalog = new ModelCatalogService(saved);
    catalog.remember('anthropic', [{ value: 'opus', label: 'Opus', effortLevels: ['high'] }]);
    catalog.remember('openai', [{ value: 'gpt-5.6', label: 'GPT-5.6', effortLevels: ['medium', 'high'] }]);

    expect(catalog.value).toEqual([
      { value: 'opus', label: 'Opus', provider: 'anthropic', resolved: undefined, effortLevels: ['high'] },
      { value: 'gpt-5.6', label: 'GPT-5.6', provider: 'openai', resolved: undefined, effortLevels: ['medium', 'high'] },
    ]);
    expect(saved.saved).toEqual(catalog.value);
  });

  it('migrates the old unqualified catalog to Anthropic', () => {
    const catalog = new ModelCatalogService(storage([{ value: 'sonnet', label: 'Sonnet' }]));
    expect(catalog.value[0]?.provider).toBe('anthropic');
  });
});
