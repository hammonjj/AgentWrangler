import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCodexBinary } from '../src/codex/binary';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-binary-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function install(version: string, target = 'macos-aarch64', executable = true): string {
  const binary = path.join(root, `openai.chatgpt-${version}-test`, 'bin', target,
    target.startsWith('windows') ? 'codex.exe' : 'codex');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '', { mode: executable ? 0o755 : 0o644 });
  return binary;
}

const resolve = (configured = 'codex') => resolveCodexBinary(configured, {
  extensionsDir: root, platform: 'darwin', arch: 'arm64',
});

describe('Codex executable discovery', () => {
  it('finds the newest bundled executable without relying on PATH', () => {
    install('26.9.0');
    const newest = install('26.10.0');
    expect(resolve()).toBe(newest);
    expect(resolve('  ')).toBe(newest);
  });

  it('preserves explicit paths and custom command names', () => {
    install('26.10.0');
    expect(resolve(' /opt/custom/codex ')).toBe('/opt/custom/codex');
    expect(resolve('codex-dev')).toBe('codex-dev');
  });

  it('skips wrong architectures, incomplete installs and non-executable files', () => {
    const working = install('26.8.0');
    install('26.9.0', 'macos-x86_64');
    install('26.10.0', 'macos-aarch64', false);
    fs.mkdirSync(path.join(root, 'openai.chatgpt-26.11.0-test'));
    expect(resolve()).toBe(working);
  });

  it.each([
    ['linux', 'x64', 'linux-x86_64'],
    ['win32', 'arm64', 'windows-aarch64'],
    ['darwin', 'x64', 'macos-x86_64'],
  ] as const)('selects the native binary for %s/%s', (platform, arch, target) => {
    const binary = install('26.10.0', target);
    expect(resolveCodexBinary('codex', { extensionsDir: root, platform, arch })).toBe(binary);
  });

  it('falls back to PATH when the extension is absent or the platform is unsupported', () => {
    expect(resolve()).toBe('codex');
    expect(resolveCodexBinary('codex', { extensionsDir: path.join(root, 'missing') })).toBe('codex');
    expect(resolveCodexBinary('codex', { extensionsDir: root, arch: 'unsupported' })).toBe('codex');
  });
});
