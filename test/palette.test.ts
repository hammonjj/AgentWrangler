import { describe, expect, it } from 'vitest';
import { paletteMatches, stripCodicons, type PaletteRow } from '../src/shared/palette';

/**
 * The palette is the app's `showQuickPick`. Its window is hard to assert
 * against; the two things that decide whether it is usable are not — what a row
 * reads as, and whether typing finds it.
 */

const row = (over: Partial<PaletteRow> = {}): PaletteRow => ({
  label: 'BulkSource-Tracker#16312',
  description: 'BulkSource-frontend · Busy',
  detail: 'Re-run QA after fix',
  ...over,
});

describe('stripCodicons', () => {
  /**
   * VSCode renders `$(bell)` as an icon from a font nothing else has, so the
   * source would show through as literal text in the app's list.
   */
  it('removes the icon markers the session picker puts in its labels', () => {
    expect(stripCodicons('$(bell) Patrick’s question')).toBe('Patrick’s question');
    expect(stripCodicons('$(circle-slash) Tools UI with icons')).toBe('Tools UI with icons');
    expect(stripCodicons('$(folder-opened) Browse…')).toBe('Browse…');
  });

  it('leaves a label that has none alone', () => {
    expect(stripCodicons('Caterpillar site ID update')).toBe('Caterpillar site ID update');
  });

  /** A dollar sign in a session title is not a marker. */
  it('keeps text that merely looks similar', () => {
    expect(stripCodicons('Fix the $(( arithmetic in deploy.sh')).toBe('Fix the $(( arithmetic in deploy.sh');
    expect(stripCodicons('Costs $5 per run')).toBe('Costs $5 per run');
  });
});

describe('paletteMatches', () => {
  it('matches everything on an empty query', () => {
    expect(paletteMatches(row(), '')).toBe(true);
    expect(paletteMatches(row(), '   ')).toBe(true);
  });

  /** The thing a palette is judged on: initials, not substrings. */
  it('matches a subsequence, not just a substring', () => {
    expect(paletteMatches(row({ label: 'BulkSource-frontend' }), 'bsf')).toBe(true);
    expect(paletteMatches(row({ label: 'Scrub Marine water rendering audit' }), 'water')).toBe(true);
    expect(paletteMatches(row({ label: 'Scrub Marine water rendering audit' }), 'smwra')).toBe(true);
  });

  it('is case-insensitive and ignores spaces in the query', () => {
    expect(paletteMatches(row({ label: 'Blender game asset modeler' }), 'BGAM')).toBe(true);
    expect(paletteMatches(row({ label: 'Blender game asset modeler' }), 'b g a m')).toBe(true);
  });

  it('refuses when the letters are not there in order', () => {
    expect(paletteMatches(row({ label: 'Blender game asset modeler' }), 'zebra')).toBe(false);
    // Right letters, wrong order.
    expect(paletteMatches(row({ label: 'abc' }), 'cba')).toBe(false);
  });

  /** The icon is not typeable, so it must not be matchable either. */
  it('matches against the label the user can actually see', () => {
    expect(paletteMatches(row({ label: '$(bell) Patrick’s question' }), 'patrick')).toBe(true);
    expect(paletteMatches(row({ label: '$(bell) Patrick’s question' }), 'bell')).toBe(false);
  });

  /**
   * Opt-in per caller: a folder picker matching on its own path is useful, a
   * session picker matching every row on the word "Busy" is noise.
   */
  it('searches the description and detail only when asked to', () => {
    expect(paletteMatches(row(), 'frontend')).toBe(false);
    expect(paletteMatches(row(), 'frontend', { matchOnDescription: true })).toBe(true);

    expect(paletteMatches(row(), 'qa')).toBe(false);
    expect(paletteMatches(row(), 'qa', { matchOnDetail: true })).toBe(true);
  });

  it('copes with a row that has neither', () => {
    const bare: PaletteRow = { label: 'Just a label' };
    expect(paletteMatches(bare, 'label', { matchOnDescription: true, matchOnDetail: true })).toBe(true);
    expect(paletteMatches(bare, 'zzz', { matchOnDescription: true, matchOnDetail: true })).toBe(false);
  });
});
