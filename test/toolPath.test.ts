import { describe, expect, it } from 'vitest';
import { toolPath } from '../src/electron/toolPath';

describe('toolPath', () => {
  it('makes Homebrew tools visible to a macOS GUI process', () => {
    expect(toolPath('/usr/bin:/bin', 'darwin')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin',
    );
  });

  it('does not duplicate paths already supplied by a shell', () => {
    expect(toolPath('/opt/homebrew/bin:/usr/bin', 'darwin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/usr/local/bin:/opt/local/bin',
    );
  });

  it('leaves other platforms alone', () => {
    expect(toolPath('/usr/bin', 'linux')).toBe('/usr/bin');
  });
});
