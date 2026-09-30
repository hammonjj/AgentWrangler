import { describe, expect, it } from 'vitest';
import { buildCatalog, type ReportedModels } from '../../src/shared/orchestration/catalog';
import { needsTierBadge, needsTierCount } from '../../src/shared/orchestration/tierBoard';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Invented models: two with shipped defaults, two that no default names. */
const REPORTED: ReportedModels[] = [
  {
    source: 'anthropic',
    models: [
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: LEVELS },
      { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
      { value: 'claude-newfamily-1', label: 'Newfamily 1', resolved: 'claude-newfamily-1', effortLevels: LEVELS },
    ],
  },
  {
    source: 'openai',
    models: [{ value: 'gpt-9-test', label: 'GPT-9 Test', resolved: 'gpt-9-test', effortLevels: LEVELS }],
  },
];

describe('Models badge', () => {
  it('counts enabled models nothing ever gave a tier', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    expect(needsTierCount(catalog.entries)).toBe(2);
  });

  it('leaves out a model unassigned on purpose, a disabled one, and one on an undefined tier', () => {
    const catalog = buildCatalog({
      reported: REPORTED,
      policy: {
        'anthropic:claude-haiku-4-5-20251001': { tier: null },
        'anthropic:claude-newfamily-1': { enabled: false },
        'openai:gpt-9-test': { tier: 'legendary' },
      },
    });
    expect(needsTierCount(catalog.entries)).toBe(0);
  });

  it('counts a model whose default tier the list no longer has', () => {
    const catalog = buildCatalog({ reported: REPORTED, tiers: [{ name: 'basic', reachableBy: 'route' }] });
    // Sonnet defaults to standard, which this list does not have; the two new ones have nothing.
    expect(needsTierCount(catalog.entries)).toBe(3);
  });

  it('is hidden at 0 and says what it counts to a screen reader', () => {
    expect(needsTierBadge(0)).toBeUndefined();
    expect(needsTierBadge(4)).toEqual({ text: '4', srText: '4 need a tier' });
    expect(needsTierBadge(1)).toEqual({ text: '1', srText: '1 needs a tier' });
  });
});
