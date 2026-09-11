import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledClaudeBinary, resolveClaudeBinary } from '../src/claude/binary';

const made: string[] = [];

function extensionsDir(versions: string[], opts: { withBinary?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ext-'));
  made.push(root);
  for (const v of versions) {
    const dir = path.join(root, `anthropic.claude-code-${v}-darwin-arm64`, 'resources', 'native-binary');
    fs.mkdirSync(dir, { recursive: true });
    if (opts.withBinary !== false) fs.writeFileSync(path.join(dir, 'claude'), '');
  }
  // Noise that must be ignored.
  fs.mkdirSync(path.join(root, 'some.other-extension-1.0.0'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundledClaudeBinary', () => {
  it('picks the newest installed Claude Code, by version and not by string', () => {
    // "2.1.9" sorts after "2.1.10" as a string, which would silently pin the
    // runner to an old binary.
    const dir = extensionsDir(['2.1.9', '2.1.10', '2.0.300']);
    expect(bundledClaudeBinary(dir)).toContain('claude-code-2.1.10-');
  });

  it('ignores an extension directory with no binary in it', () => {
    const dir = extensionsDir(['2.1.267'], { withBinary: false });
    expect(bundledClaudeBinary(dir)).toBeUndefined();
  });

  it('returns nothing when there is no extensions directory at all', () => {
    expect(bundledClaudeBinary(path.join(os.tmpdir(), 'aw-does-not-exist'))).toBeUndefined();
  });
});

describe('resolveClaudeBinary', () => {
  it('prefers the bundled binary over PATH, since that is what the panel runs', () => {
    const dir = extensionsDir(['2.1.267']);
    expect(resolveClaudeBinary('claude', dir)).toContain('claude-code-2.1.267-');
  });

  it('an explicit setting wins outright', () => {
    const dir = extensionsDir(['2.1.267']);
    expect(resolveClaudeBinary('/opt/homebrew/bin/claude', dir)).toBe('/opt/homebrew/bin/claude');
  });

  it('falls back to PATH when nothing is bundled', () => {
    expect(resolveClaudeBinary('claude', path.join(os.tmpdir(), 'aw-does-not-exist'))).toBe('claude');
    expect(resolveClaudeBinary('  ', path.join(os.tmpdir(), 'aw-does-not-exist'))).toBe('claude');
  });
});
