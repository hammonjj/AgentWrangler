import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseIdList, readConfig } from '../src/core/config';
import { SETTINGS } from '../src/shared/settings';
import type { HostSettings } from '../src/host/hostServices';

/** Settings backed by a plain object, the way `JsonSettings` behaves. */
function settingsOf(values: Record<string, unknown>): HostSettings {
  return {
    get: <T>(key: string, fallback: T) => (key in values ? (values[key] as T) : fallback),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

describe('remote control settings', () => {
  it('is off, and configured with nothing, by default', () => {
    // Everything here can reach outside the machine. Nothing should be running
    // for someone who has not gone looking for it.
    const cfg = readConfig(settingsOf({}));
    expect(cfg.remoteEnabled).toBe(false);
    expect(cfg.remoteGuildId).toBe('');
    expect(cfg.remoteChannelId).toBe('');
    expect(cfg.remoteAuthorizedUserIds).toEqual([]);
  });

  it('reads what has been set', () => {
    const cfg = readConfig(
      settingsOf({
        'remote.enabled': true,
        'remote.discord.guildId': '111',
        'remote.discord.channelId': '222',
        'remote.discord.authorizedUserIds': '333,444',
      }),
    );
    expect(cfg).toMatchObject({
      remoteEnabled: true,
      remoteGuildId: '111',
      remoteChannelId: '222',
      remoteAuthorizedUserIds: ['333', '444'],
    });
  });

  it('declares the defaults it documents', () => {
    expect(DEFAULT_CONFIG.remoteEnabled).toBe(false);
  });
});

describe('parseIdList', () => {
  it('splits on commas and trims', () => {
    expect(parseIdList('111, 222 ,333')).toEqual(['111', '222', '333']);
  });

  it('drops blanks, so a trailing comma is harmless', () => {
    expect(parseIdList('111,,222,')).toEqual(['111', '222']);
  });

  it('reads an empty setting as nobody, not as everybody', () => {
    // The service refuses to publish with an empty allowlist, so this is the
    // difference between failing closed and failing open.
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList('   ')).toEqual([]);
  });
});

describe('the settings declaration', () => {
  const byKey = new Map(SETTINGS.map((s) => [s.key, s]));

  it('puts everything remote under Experimental', () => {
    const remote = SETTINGS.filter((s) => s.key.startsWith('remote.'));
    expect(remote.length).toBeGreaterThan(0);
    for (const s of remote) expect(s.group).toBe('Experimental');
  });

  it('ships remote control switched off', () => {
    expect(byKey.get('remote.enabled')?.default).toBe(false);
  });

  it('has no setting for the bot token', () => {
    // It lives in the keychain. A credential in settings.json is a credential
    // in a screenshot.
    for (const s of SETTINGS) expect(s.key).not.toMatch(/token|secret|password/i);
  });

  it('gives every setting a label and a description', () => {
    for (const s of SETTINGS) {
      expect(s.label, s.key).toBeTruthy();
      expect(s.description, s.key).toBeTruthy();
    }
  });

  it('has no duplicate keys', () => {
    expect(byKey.size).toBe(SETTINGS.length);
  });

  it('keeps each group contiguous, since the sidebar renders them in order', () => {
    const seen = new Set<string>();
    let previous = '';
    for (const s of SETTINGS) {
      if (s.group === previous) continue;
      expect(seen.has(s.group), `${s.group} appears in two places`).toBe(false);
      seen.add(s.group);
      previous = s.group;
    }
  });
});
