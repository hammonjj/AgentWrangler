import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS, qualifiedKey, settingsFor, vscodeProperty } from '../src/shared/settings';

/**
 * A setting is declared once, in `src/shared/settings.ts`, and read twice:
 * VSCode reads `contributes.configuration` in `package.json`, and the app's
 * Preferences window renders the declaration directly.
 *
 * Nothing forces those to agree. A setting added to `package.json` and not to
 * the declaration simply never appears in the app; one added to the
 * declaration and not to `package.json` has no default in VSCode and no entry
 * in its settings UI. Neither fails loudly — which is what this test is for.
 */

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as { contributes: { configuration: { properties: Record<string, unknown> } } };

const properties = pkg.contributes.configuration.properties;

describe('settings declaration', () => {
  it('covers exactly the settings package.json contributes', () => {
    expect(SETTINGS.map((s) => qualifiedKey(s.key)).sort()).toEqual(Object.keys(properties).sort());
  });

  it('matches package.json field for field', () => {
    for (const spec of SETTINGS) {
      expect(properties[qualifiedKey(spec.key)], spec.key).toEqual(vscodeProperty(spec));
    }
  });

  it('gives every enum setting a description per choice', () => {
    for (const spec of SETTINGS) {
      if (!spec.enum) continue;
      expect(spec.enumDescriptions, spec.key).toHaveLength(spec.enum.length);
      expect(spec.enum, spec.key).toContain(spec.default);
    }
  });

  it('gives every default a value of its declared type', () => {
    for (const spec of SETTINGS) {
      expect(typeof spec.default, spec.key).toBe(spec.type);
    }
  });

  it('keeps every numeric default inside its own bounds', () => {
    for (const spec of SETTINGS) {
      if (spec.type !== 'number') continue;
      if (spec.minimum !== undefined) expect(spec.default, spec.key).toBeGreaterThanOrEqual(spec.minimum);
      if (spec.maximum !== undefined) expect(spec.default, spec.key).toBeLessThanOrEqual(spec.maximum);
    }
  });

  it('offers a setting in at least one front end', () => {
    for (const spec of SETTINGS) {
      expect(spec.hosts ?? ['vscode', 'app'], spec.key).not.toHaveLength(0);
    }
  });

  /**
   * The app's list is allowed to be shorter — `openOnStartup` means nothing to
   * a window that always opens — but only deliberately, and only by a little.
   * A big gap means someone excluded a batch rather than one.
   */
  it('shows all but a named few in the app', () => {
    const hidden = SETTINGS.filter((s) => !(s.hosts ?? ['vscode', 'app']).includes('app')).map((s) => s.key);
    expect(hidden).toEqual(['openOnStartup']);
    expect(settingsFor('app').length).toBe(SETTINGS.length - 1);
  });
});
