import { describe, expect, it } from 'vitest';
import { modelPolicyChange, settingUpdate, type PreferencesToHost } from '../src/shared/preferences';
import { dependentParentKeys, RETIRED_SETTING_KEYS, SETTINGS, validateDependencies, type SettingSpec } from '../src/shared/settings';

/**
 * The Preferences window writes straight through to the settings file, so what
 * it is allowed to write matters more than how it looks. These are the rules
 * between the two.
 */

const specFor = (key: string) => SETTINGS.find((s) => s.key === key);

describe('settingUpdate', () => {
  it('passes a declared key with a value of its type', () => {
    expect(settingUpdate({ type: 'set', key: 'showUsage', value: false }, specFor)).toEqual({
      key: 'showUsage',
      value: false,
    });
    expect(settingUpdate({ type: 'set', key: 'autoPause.percent', value: 90 }, specFor)).toEqual({
      key: 'autoPause.percent',
      value: 90,
    });
    expect(settingUpdate({ type: 'set', key: 'runner.model', value: '' }, specFor)).toEqual({
      key: 'runner.model',
      value: '',
    });
  });

  it('refuses a key nothing declares', () => {
    expect(settingUpdate({ type: 'set', key: 'somethingElse', value: true }, specFor)).toBeUndefined();
    // Qualified rather than bare: the window is supposed to send the short form,
    // so this is a sign something else is on the channel.
    expect(settingUpdate({ type: 'set', key: 'agentWrangler.showUsage', value: true }, specFor)).toBeUndefined();
  });

  /**
   * The type is what everything downstream assumes. `pollIntervalSeconds` as a
   * string would be read as a number, come out NaN, and stop the poll — with no
   * error anywhere, because nothing between here and there re-checks.
   */
  it('refuses a value of the wrong type', () => {
    expect(settingUpdate({ type: 'set', key: 'pollIntervalSeconds', value: '5' }, specFor)).toBeUndefined();
    expect(settingUpdate({ type: 'set', key: 'showUsage', value: 'true' }, specFor)).toBeUndefined();
    expect(settingUpdate({ type: 'set', key: 'runner.model', value: 12 }, specFor)).toBeUndefined();
  });

  /**
   * Reset removes the key instead of writing the current default into the file.
   * Written, a default that later changes would never reach anyone who had once
   * pressed Reset — they would be pinned to the old value with no way to tell.
   */
  it('resets by removing the key, not by writing the default', () => {
    expect(settingUpdate({ type: 'reset', key: 'stuckThresholdSeconds' }, specFor)).toEqual({
      key: 'stuckThresholdSeconds',
      value: undefined,
    });
  });

  it('refuses a reset for a key nothing declares', () => {
    expect(settingUpdate({ type: 'reset', key: 'somethingElse' }, specFor)).toBeUndefined();
  });

  it('ignores the messages that are not writes', () => {
    expect(settingUpdate({ type: 'ready' }, specFor)).toBeUndefined();
    expect(settingUpdate({ type: 'close' }, specFor)).toBeUndefined();
    expect(settingUpdate(undefined as unknown as PreferencesToHost, specFor)).toBeUndefined();
  });

  it('accepts every declared setting at its own default', () => {
    for (const spec of SETTINGS) {
      expect(settingUpdate({ type: 'set', key: spec.key, value: spec.default }, specFor), spec.key).toEqual({
        key: spec.key,
        value: spec.default,
      });
    }
  });
});

/**
 * Preferences nests a `dependsOn` setting under its switch and collapses the
 * card the switch governs when it is off (#76). Both rely on the same two
 * facts about the declaration order in `settings.ts`, which is why they are
 * checked here rather than trusted by eye: the switch is a boolean, and it is
 * declared before anything that depends on it.
 */
describe('validateDependencies', () => {
  it('finds nothing wrong with the real settings list', () => {
    expect(validateDependencies(SETTINGS)).toEqual([]);
  });

  const boolSpec = (key: string, extra: Partial<SettingSpec> = {}): SettingSpec => ({
    key,
    label: key,
    group: 'Test',
    type: 'boolean',
    default: false,
    description: '',
    ...extra,
  });
  const stringSpec = (key: string, extra: Partial<SettingSpec> = {}): SettingSpec => ({
    key,
    label: key,
    group: 'Test',
    type: 'string',
    default: '',
    description: '',
    ...extra,
  });

  it('refuses a dependsOn that names no setting', () => {
    expect(validateDependencies([stringSpec('child', { dependsOn: 'nothing.such' })])).toEqual([
      'child depends on nothing.such, which no setting declares',
    ]);
  });

  it('refuses a dependsOn on a non-boolean', () => {
    expect(
      validateDependencies([stringSpec('parent'), stringSpec('child', { dependsOn: 'parent' })]),
    ).toEqual(['child depends on parent, which is not a boolean']);
  });

  it('refuses a dependsOn declared before its switch', () => {
    expect(
      validateDependencies([stringSpec('child', { dependsOn: 'parent' }), boolSpec('parent')]),
    ).toEqual(['child depends on parent, declared later in the list']);
  });

  it('accepts a boolean switch declared before what depends on it', () => {
    expect(validateDependencies([boolSpec('parent'), stringSpec('child', { dependsOn: 'parent' })])).toEqual([]);
  });
});

describe('dependentParentKeys', () => {
  it('lists each switch once, in the order it is first depended on', () => {
    expect(dependentParentKeys(SETTINGS)).toEqual([
      'orchestration.enabled',
      'autoPause.enabled',
      'web.enabled',
      'remote.enabled',
    ]);
  });

  it('the remaining example group from #76 is a switch with a dependent field', () => {
    expect(dependentParentKeys(SETTINGS)).toContain('remote.enabled');
  });
});

describe('session hosts are not optional (#122)', () => {
  it('no setting turns them off: the retired switch is gone and listed for removal', () => {
    expect(RETIRED_SETTING_KEYS).toContain('experimental.sessionHosts');
    const keys = SETTINGS.map((s) => s.key);
    for (const retired of RETIRED_SETTING_KEYS) expect(keys).not.toContain(retired);
    expect(keys.filter((k) => /sessionHost/i.test(k))).toEqual([]);
  });

  it('the idle-orphan rule stays, hanging off nothing: it applies to every conversation', () => {
    const idle = SETTINGS.find((s) => s.key === 'lifecycle.orphanIdleHours');
    expect(idle).toMatchObject({ type: 'number', default: 24, minimum: 0 });
    expect(idle?.dependsOn).toBeUndefined();
  });
});

describe('modelPolicyChange', () => {
  it('accepts the three shapes the tier map sends', () => {
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'anthropic:x', tier: 'basic' } })).toEqual({ key: 'anthropic:x', tier: 'basic' });
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'anthropic:x', tier: null } })).toEqual({ key: 'anthropic:x', tier: null });
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'k', enabled: false } })).toEqual({ key: 'k', enabled: false });
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'k', reset: 'all' } })).toEqual({ key: 'k', reset: 'all' });
  });

  it('refuses anything else', () => {
    expect(modelPolicyChange({ type: 'set', change: { key: 'k', tier: 'basic' } })).toBeUndefined();
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: '', tier: 'basic' } })).toBeUndefined();
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'k' } })).toBeUndefined();
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'k', tier: 3 } })).toBeUndefined();
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'k', enabled: 'yes' } })).toBeUndefined();
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: 'k', reset: 'everything' } })).toBeUndefined();
    expect(modelPolicyChange(null)).toBeUndefined();
  });
});
