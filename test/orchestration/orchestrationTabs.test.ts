import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORCHESTRATION_TAB,
  OPEN_TAB_MESSAGE,
  ORCHESTRATION_TABS,
  orchestrationTabTarget,
} from '../../src/shared/orchestration/orchestrationTabs';

describe('Orchestration tabs', () => {
  it('are the five sections in order, with short labels for a narrow pane', () => {
    expect(ORCHESTRATION_TABS.map((t) => t.label)).toEqual(['Routing', 'Models', 'Tiers', 'Sources & endpoints', 'Shadow report']);
    expect(ORCHESTRATION_TABS.map((t) => t.short)).toEqual(['Routing', 'Models', 'Tiers', 'Sources', 'Report']);
    expect(DEFAULT_ORCHESTRATION_TAB).toBe('models');
  });

  it('reads an open-tab message, with or without a model to focus', () => {
    expect(orchestrationTabTarget({ type: OPEN_TAB_MESSAGE, tab: 'report' })).toEqual({ tab: 'report' });
    expect(orchestrationTabTarget({ type: OPEN_TAB_MESSAGE, tab: 'models', focusModelKey: 'local:box:qwen' })).toEqual({
      tab: 'models',
      focusModelKey: 'local:box:qwen',
    });
  });

  it('refuses a tab that does not exist and a malformed target', () => {
    expect(orchestrationTabTarget({ type: OPEN_TAB_MESSAGE, tab: 'billing' })).toBeUndefined();
    expect(orchestrationTabTarget({ type: OPEN_TAB_MESSAGE, tab: 'models', focusModelKey: 3 })).toBeUndefined();
    expect(orchestrationTabTarget({ type: 'orchestration', tab: 'models' })).toBeUndefined();
    expect(orchestrationTabTarget(null)).toBeUndefined();
  });
});
