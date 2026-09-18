import { describe, expect, it } from 'vitest';
import { settingUpdate, type PreferencesToHost } from '../src/shared/preferences';
import { SETTINGS } from '../src/shared/settings';

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
